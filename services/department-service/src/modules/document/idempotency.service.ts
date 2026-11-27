import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@dms/database';
import { createHash } from 'crypto';

/**
 * P3 N6: khóa idempotency cho thao tác tạo (POST /documents).
 *
 * Client gửi tiêu đề `Idempotency-Key`. Gửi lại cùng khóa với cùng nội dung (mất mạng, hết thời gian chờ, bấm hai lần)
 * thì nhận lại đúng tài liệu đã tạo, không có tài liệu thứ hai. Khóa gắn với người dùng (khóa của hai người không đụng nhau),
 * giữ 24 giờ.
 *
 * Trạng thái của một khóa (bảng idempotency_key trên CSDL của node):
 *   IN_PROGRESS: đang xử lý. Yêu cầu trùng lúc này nhận 409 + Retry-After.
 *                Quá STALE_SECONDS mà chưa xong (tiến trình chết giữa chừng) thì yêu cầu sau được nhận lại khóa.
 *   DONE:        đã tạo xong, có doc_id. Ghi CÙNG transaction với tài liệu, nên không có trạng thái "tạo rồi mà chưa ghi khóa".
 * Cùng khóa nhưng khác nội dung (băm tiêu đề, mô tả, quyền, danh mục, thẻ, SHA-256 của tệp): 422.
 */
export type IdemBegin =
  | { kind: 'new' }
  | { kind: 'replay'; docId: bigint }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' };

export class IdempotencyLostError extends Error {
  constructor() {
    super('Khóa idempotency đã được một yêu cầu khác hoàn tất');
  }
}

@Injectable()
export class IdempotencyService implements OnModuleInit, OnModuleDestroy {
  static readonly STALE_SECONDS = 120;
  private readonly logger = new Logger(IdempotencyService.name);
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  onModuleInit() {
    // Dọn khóa hết hạn mỗi giờ; lỗi dọn không ảnh hưởng đường xử lý chính
    this.purgeTimer = setInterval(() => this.purge().catch((e) => this.logger.warn(`Dọn khóa idempotency lỗi: ${e.message}`)), 3600_000);
    this.purgeTimer.unref();
  }

  onModuleDestroy() {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  /** Khóa hợp lệ: 8-128 ký tự chữ, số và . _ : - (đủ cho UUID, ULID). */
  static validKey(key: string): boolean {
    return /^[A-Za-z0-9._:-]{8,128}$/.test(key);
  }

  static hashRequest(fields: Array<string | number | null | undefined>, fileBuffer?: Buffer): string {
    const h = createHash('sha256');
    for (const f of fields) h.update(`${f ?? ''}\u0000`);
    h.update(fileBuffer ? createHash('sha256').update(fileBuffer).digest('hex') : '-');
    return h.digest('hex');
  }

  async begin(userId: bigint, endpoint: string, key: string, requestHash: string): Promise<IdemBegin> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.prisma.$executeRaw`
        INSERT INTO idempotency_key (user_id, endpoint, idem_key, request_hash)
        VALUES (${userId}, ${endpoint}, ${key}, ${requestHash})
        ON CONFLICT DO NOTHING`;
      if (inserted === 1) return { kind: 'new' };

      const rows = await this.prisma.$queryRaw<
        Array<{ request_hash: string; status: string; doc_id: bigint | null; expired: boolean; stale: boolean }>
      >`
        SELECT request_hash, status, doc_id,
               expires_at < now() AS expired,
               locked_at < now() - make_interval(secs => ${IdempotencyService.STALE_SECONDS}) AS stale
          FROM idempotency_key
         WHERE user_id = ${userId} AND endpoint = ${endpoint} AND idem_key = ${key}`;
      if (rows.length === 0) continue; // vừa bị dọn giữa hai câu lệnh: thử chèn lại
      const r = rows[0];
      if (r.expired) {
        await this.prisma.$executeRaw`
          DELETE FROM idempotency_key
           WHERE user_id = ${userId} AND endpoint = ${endpoint} AND idem_key = ${key} AND expires_at < now()`;
        continue;
      }
      if (r.request_hash !== requestHash) return { kind: 'mismatch' };
      if (r.status === 'DONE' && r.doc_id !== null) return { kind: 'replay', docId: r.doc_id };
      if (r.stale) {
        // Yêu cầu trước chết giữa chừng: nhận lại khóa (so-và-đặt, chỉ một yêu cầu nhận được)
        const taken = await this.prisma.$executeRaw`
          UPDATE idempotency_key SET locked_at = now()
           WHERE user_id = ${userId} AND endpoint = ${endpoint} AND idem_key = ${key}
             AND status = 'IN_PROGRESS'
             AND locked_at < now() - make_interval(secs => ${IdempotencyService.STALE_SECONDS})`;
        if (taken === 1) return { kind: 'new' };
      }
      return { kind: 'in_progress' };
    }
    return { kind: 'in_progress' };
  }

  /**
   * Gọi TRONG transaction tạo tài liệu. Nếu yêu cầu khác đã hoàn tất khóa này (hiếm: yêu cầu cũ chậm quá STALE_SECONDS
   * và bị nhận lại), ném IdempotencyLostError để transaction rollback, không sinh tài liệu thứ hai.
   */
  async complete(tx: any, userId: bigint, endpoint: string, key: string, docId: bigint): Promise<void> {
    const n = await tx.$executeRaw`
      UPDATE idempotency_key SET status = 'DONE', doc_id = ${docId}
       WHERE user_id = ${userId} AND endpoint = ${endpoint} AND idem_key = ${key} AND status = 'IN_PROGRESS'`;
    if (n !== 1) throw new IdempotencyLostError();
  }

  /** Xử lý lỗi: bỏ khóa đang giữ để client thử lại được ngay. */
  async abort(userId: bigint, endpoint: string, key: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        DELETE FROM idempotency_key
         WHERE user_id = ${userId} AND endpoint = ${endpoint} AND idem_key = ${key} AND status = 'IN_PROGRESS'`;
    } catch (e) {
      // CSDL đang lỗi: khóa sẽ tự được nhận lại sau STALE_SECONDS
      this.logger.warn(`Không bỏ được khóa idempotency: ${(e as Error).message}`);
    }
  }

  async purge(): Promise<number> {
    return this.prisma.$executeRaw`DELETE FROM idempotency_key WHERE expires_at < now()`;
  }
}
