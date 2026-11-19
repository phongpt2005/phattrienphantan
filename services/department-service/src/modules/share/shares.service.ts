import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@dms/database';
import { AuthenticatedUser, SERVICE_TOKEN_HEADER, requireEnv, sanitizeBigInt } from '@dms/common';
import { OutboxService } from '../outbox/outbox.service';
import { AuditService } from '../audit/audit.service';
import { CreateShareDto } from '../../dto/create-share.dto';

export type SharePermission = 'VIEW' | 'DOWNLOAD';

export interface ShareRow {
  share_id: number;
  doc_id: number;
  shared_with_dept: string;
  permission: SharePermission;
  reason: string | null;
  expires_at: string | null;
  is_revoked: boolean;
  revoked_at: string | null;
  revoked_by: string | null;
  created_by: string | null;
  source: string;
  access_request_id: number | null;
  legacy_share_id: number | null;
  created_at: string;
}

export interface GrantInput {
  docId: number;
  sharedWithDept: string;
  permission: SharePermission;
  expiresAt: Date | null;
  reason: string;
  createdBy: string;
  source: 'DIRECT' | 'REQUEST' | 'MIGRATED';
  accessRequestId?: number;
  legacyShareId?: number;
  createdAt?: Date;
  /** Chỉ dùng khi chuyển dữ liệu cũ: giữ nguyên lịch sử các lượt đã thu hồi */
  isRevoked?: boolean;
}

/**
 * SỔ CHIA SẺ của phòng ban: mọi lượt chia sẻ tài liệu CỦA PHÒNG NÀY cho phòng khác nằm ở ĐÂY, trong DB của node.
 *
 * Vì sao ở node (không ở trung tâm):
 *  - Người bảo vệ nằm cạnh thứ được bảo vệ: thu hồi có hiệu lực NGAY, tại chính nơi giữ tài liệu, kể cả khi
 *    CSDL trung tâm đang sập. Node sập thì tài liệu cũng không với tới được nên không có khoảng "tài liệu còn
 *    truy cập được mà không thu hồi được".
 *  - Node tự kiểm tra quyền khi tìm kiếm và khi tải file, không phụ thuộc danh sách do Gateway gửi.
 *  - Bán kính hỏng nhỏ: một node sập chỉ ảnh hưởng chia sẻ của chính phòng đó.
 *
 * Trung tâm chỉ nhận BẢN SAO (qua Outbox, trường `shares` của sự kiện document) cho chỉ mục dự phòng và báo cáo.
 */
@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  private get dept(): string {
    return requireEnv('DEPT_CODE');
  }

  // ------------------------------------------------------------------ ghi
  /** Chia sẻ do người dùng của phòng này thực hiện (Trưởng phòng hoặc Ban Giám đốc). */
  async createByUser(actor: AuthenticatedUser, dto: CreateShareDto) {
    if (dto.sharedWithDept === this.dept) {
      throw new BadRequestException('Không thể chia sẻ tài liệu cho chính phòng ban của mình');
    }
    if (dto.sharedWithDept === '*' && actor.role !== 'ADMIN') {
      throw new ForbiddenException('Chỉ Ban Giám đốc mới được chia sẻ cho toàn công ty');
    }
    await this.assertDepartmentExists(dto.sharedWithDept);

    let expiresAt: Date;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw new BadRequestException('expiresAt không phải ngày hợp lệ');
    } else {
      expiresAt = new Date(Date.now() + (dto.expiresInDays || 7) * 86400000);
    }
    if (expiresAt.getTime() <= Date.now()) throw new BadRequestException('Thời điểm hết hạn phải ở tương lai');

    const { share, action } = await this.grantWithAction({
      docId: dto.docId,
      sharedWithDept: dto.sharedWithDept,
      permission: dto.permission || 'VIEW',
      expiresAt,
      reason: dto.reason || `Chia sẻ phối hợp công việc giữa ${this.dept} và ${dto.sharedWithDept}`,
      createdBy: actor.username,
      source: 'DIRECT',
    });
    const target = dto.sharedWithDept === '*' ? 'toàn công ty' : dto.sharedWithDept;
    return {
      success: true,
      action,
      message:
        action === 'CREATED'
          ? `Đã cấp quyền truy cập cho phòng ban ${target}`
          : action === 'EXTENDED'
            ? `Đã gia hạn và cập nhật quyền truy cập cho phòng ban ${target}`
            : `Lượt chia sẻ cho phòng ban ${target} đã tồn tại`,
      share,
    };
  }

  /** Lỗi vi phạm ràng buộc duy nhất: mã Postgres 23505 (Prisma raw bọc thành P2010 hoặc P2002). */
  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string; message?: string }; message?: string };
    return e?.code === 'P2002' || e?.meta?.code === '23505' || /23505|duplicate key/i.test(`${e?.message ?? ''}${e?.meta?.message ?? ''}`);
  }

  /**
   * Cấp một lượt chia sẻ. Dùng chung cho chia sẻ trực tiếp, duyệt yêu cầu xin quyền (do Gateway gọi) và chuyển dữ liệu cũ.
   * IDEMPOTENT theo accessRequestId và legacyShareId: gọi lại không tạo bản ghi thứ hai.
   */
  async grant(p: GrantInput): Promise<ShareRow> {
    return (await this.grantWithAction(p)).share;
  }

  /** Như grant() nhưng cho biết kết quả: CREATED (dòng mới), EXTENDED (đã có lượt đang hiệu lực: đổi quyền/gia hạn), EXISTING (gọi lại idempotent). */
  async grantWithAction(p: GrantInput): Promise<{ share: ShareRow; action: 'CREATED' | 'EXTENDED' | 'EXISTING' | 'SUPERSEDED' }> {
    if (p.accessRequestId) {
      // Sổ idempotent = lịch sử (không phụ thuộc việc access_request_id trên lượt có còn là yêu cầu này hay không)
      const hit = await this.prisma.$queryRaw<Array<{ share_id: bigint | number }>>(Prisma.sql`
        SELECT share_id FROM document_share_history
         WHERE access_request_id = ${BigInt(p.accessRequestId)} AND action IN ('GRANTED', 'RENEWED')
         ORDER BY history_id LIMIT 1`);
      if (hit.length) {
        const byHistory = await this.findOne(Prisma.sql`share_id = ${Number(hit[0].share_id)}`);
        if (byHistory) return { share: byHistory, action: 'EXISTING' };
      }
      // Dữ liệu trước khi có lịch sử: vẫn tra theo access_request_id như cũ
      const existed = await this.findOne(Prisma.sql`access_request_id = ${p.accessRequestId}`);
      if (existed) return { share: existed, action: 'EXISTING' };
    }
    if (p.legacyShareId) {
      const existed = await this.findOne(Prisma.sql`legacy_share_id = ${p.legacyShareId}`);
      if (existed) return { share: existed, action: 'EXISTING' };
    }

    const doc = await this.prisma.document.findUnique({ where: { docId: BigInt(p.docId) }, select: { docId: true, title: true, status: true } });
    if (!doc) throw new NotFoundException(`Không tìm thấy tài liệu #${p.docId} của phòng ${this.dept}`);
    if (doc.status === 'DELETED' && !p.isRevoked) throw new BadRequestException('Tài liệu đã bị xóa, không thể chia sẻ');

    // CHỐNG ĐUA: chỉ mục duy nhất từng phần idx_unique_active_share (doc_id, shared_with_dept) WHERE NOT is_revoked
    // bảo đảm ở mức CSDL chỉ có một lượt đang hiệu lực. Hai yêu cầu đồng thời (nhấp đúp, hai Trưởng phòng) không
    // sinh hai dòng: yêu cầu đến sau CẬP NHẬT lượt đang có (đổi VIEW/DOWNLOAD, gia hạn) thay vì chèn dòng mới.
    // Chuyển dữ liệu cũ thì KHÔNG ghi đè lượt hiện có (giữ nguyên quyết định mới hơn).
    const onConflict =
      p.source === 'MIGRATED'
        ? Prisma.sql`DO UPDATE SET updated_at = document_share.updated_at`
        : Prisma.sql`DO UPDATE SET permission = EXCLUDED.permission, expires_at = EXCLUDED.expires_at,
                                   reason = EXCLUDED.reason, updated_at = NOW(),
                                   access_request_id = COALESCE(EXCLUDED.access_request_id, document_share.access_request_id)
                     WHERE EXCLUDED.access_request_id IS NULL OR document_share.access_request_id IS NULL
                        OR EXCLUDED.access_request_id > document_share.access_request_id`;
    let row: ShareRow;
    let renewed = false;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<ShareRow & { was_updated: boolean }>>(Prisma.sql`
          INSERT INTO document_share (doc_id, shared_with_dept, permission, reason, expires_at, is_revoked, revoked_at,
                                      created_by, source, access_request_id, legacy_share_id, created_at, updated_at)
          VALUES (${BigInt(p.docId)}, ${p.sharedWithDept}, ${p.permission}, ${p.reason.slice(0, 255)}, ${p.expiresAt},
                  ${p.isRevoked === true}, ${p.isRevoked === true ? new Date() : null},
                  ${p.createdBy}, ${p.source}, ${p.accessRequestId ?? null}, ${p.legacyShareId ?? null},
                  ${p.createdAt ?? new Date()}, NOW())
          ON CONFLICT (doc_id, shared_with_dept) WHERE NOT is_revoked ${onConflict}
          RETURNING *, (xmax <> 0) AS was_updated`);
        if (rows.length === 0) {
          // Yêu cầu CŨ hơn quyết định đang hiệu lực: không đổi quyền, chỉ ghi vết
          const cur = sanitizeBigInt(await tx.$queryRaw<ShareRow[]>(Prisma.sql`
            SELECT * FROM document_share WHERE doc_id = ${BigInt(p.docId)} AND shared_with_dept = ${p.sharedWithDept} AND NOT is_revoked`))[0] as ShareRow;
          await this.writeHistory(tx, {
            shareId: cur.share_id, docId: p.docId, dept: p.sharedWithDept, permission: p.permission,
            expiresAt: p.expiresAt, action: 'SUPERSEDED', accessRequestId: p.accessRequestId ?? null, actor: p.createdBy,
          });
          return { superseded: true as const, share: cur };
        }
        const cur = sanitizeBigInt(rows)[0] as ShareRow & { was_updated: boolean };
        // Dữ liệu chuyển từ bản cũ không được coi là cấp mới: chỉ ghi GRANTED khi là dòng mới
        const action = p.source === 'MIGRATED' ? (cur.was_updated ? null : 'GRANTED') : (cur.was_updated ? 'RENEWED' : 'GRANTED');
        if (action) {
          await this.writeHistory(tx, {
            shareId: cur.share_id, docId: p.docId, dept: p.sharedWithDept, permission: cur.permission,
            expiresAt: p.expiresAt, action, accessRequestId: p.accessRequestId ?? null, actor: p.createdBy,
          });
        }
        await this.touchDocumentAndEmit(tx, p.docId);
        return { superseded: false as const, share: cur };
      });
      if (result.superseded) {
        this.logger.warn(`Yêu cầu ${p.accessRequestId ?? '-'} cũ hơn quyết định đang có tại ${p.sharedWithDept}: không đổi quyền`);
        return { share: result.share, action: 'SUPERSEDED' };
      }
      const { was_updated, ...clean } = result.share as ShareRow & { was_updated: boolean };
      row = clean as ShareRow;
      renewed = was_updated === true;
    } catch (err) {
      // Hai lệnh gọi lại CÙNG accessRequestId/legacyShareId đồng thời: chỉ mục duy nhất thứ hai thắng, trả lượt đã có
      if (this.isUniqueViolation(err)) {
        const existed = p.accessRequestId
          ? await this.findOne(Prisma.sql`access_request_id = ${p.accessRequestId}`)
          : p.legacyShareId
            ? await this.findOne(Prisma.sql`legacy_share_id = ${p.legacyShareId}`)
            : null;
        if (existed) return { share: existed, action: 'EXISTING' };
        throw new ConflictException('Tài liệu này hiện đã được cấp quyền cho phòng ban đích và quyền vẫn đang có hiệu lực.');
      }
      throw err;
    }

    await this.audit.log({
      docId: p.docId,
      action: 'UPDATE',
      detail: `${renewed ? 'Cập nhật/gia hạn chia sẻ' : 'Chia sẻ'} cho ${p.sharedWithDept === '*' ? 'toàn công ty' : `phòng ${p.sharedWithDept}`} (${p.permission === 'DOWNLOAD' ? 'xem và tải' : 'chỉ xem'}) bởi ${p.createdBy}`,
    });
    // Duyệt yêu cầu: Gateway tự gửi ACCESS_APPROVED riêng cho người xin, nên không báo thêm SHARE_GRANTED cho cả phòng
    if (p.source === 'DIRECT') {
      void this.notifyGateway({
        type: 'SHARE_GRANTED',
        title: 'Có tài liệu được chia sẻ cho phòng bạn',
        message: `Phòng ${this.dept} chia sẻ "${doc.title}" (${p.permission === 'DOWNLOAD' ? 'xem và tải về' : 'chỉ xem'}).`,
        targetDept: p.sharedWithDept,
      });
    }
    return { share: row, action: renewed ? 'EXTENDED' : 'CREATED' };
  }

  /** Thu hồi một lượt chia sẻ: có hiệu lực ngay ở node này. Idempotent. */
  async revoke(actor: AuthenticatedUser, shareId: number) {
    const share = await this.findOne(Prisma.sql`share_id = ${shareId}`);
    if (!share) throw new NotFoundException(`Không tìm thấy lượt chia sẻ #${shareId} của phòng ${this.dept}`);
    if (share.is_revoked) return { message: 'Lượt chia sẻ này đã được thu hồi trước đó', share };

    const row = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ShareRow[]>`
        UPDATE document_share
           SET is_revoked = TRUE, revoked_at = NOW(), revoked_by = ${actor.username}, updated_at = NOW()
         WHERE share_id = ${BigInt(shareId)} AND is_revoked = FALSE
        RETURNING *`;
      if (rows.length) {
        const r = sanitizeBigInt(rows)[0] as ShareRow;
        await this.writeHistory(tx, {
          shareId: r.share_id, docId: Number(r.doc_id), dept: r.shared_with_dept, permission: r.permission,
          expiresAt: r.expires_at, action: 'REVOKED', accessRequestId: r.access_request_id ?? null, actor: actor.username,
        });
      }
      await this.touchDocumentAndEmit(tx, Number(share.doc_id));
      return rows.length ? (sanitizeBigInt(rows)[0] as ShareRow) : share;
    });

    const doc = await this.prisma.document.findUnique({ where: { docId: BigInt(share.doc_id) }, select: { title: true } });
    await this.audit.log({
      docId: share.doc_id,
      action: 'UPDATE',
      detail: `Thu hồi chia sẻ cho ${share.shared_with_dept === '*' ? 'toàn công ty' : `phòng ${share.shared_with_dept}`} bởi ${actor.username}`,
    });
    void this.notifyGateway({
      type: 'SHARE_REVOKED',
      title: 'Một tài liệu không còn được chia sẻ cho phòng bạn',
      message: `Phòng ${this.dept} đã thu hồi quyền truy cập "${doc?.title ?? `#${share.doc_id}`}".`,
      targetDept: share.shared_with_dept,
    });
    return { message: 'Thu hồi quyền chia sẻ tài liệu thành công', share: row };
  }

  // ------------------------------------------------------------------ đọc
  /** Tài liệu của phòng này đang chia sẻ ra ngoài (chưa thu hồi; lượt đã quá hạn vẫn liệt kê để thấy là HẾT HẠN). */
  async listGranted() {
    return this.listRows(Prisma.sql`NOT s.is_revoked AND d.status <> 'DELETED'`, 200);
  }

  /** Tài liệu của phòng này đang được chia sẻ CHO một phòng khác (còn hiệu lực). Gateway gọi để dựng "Được chia sẻ với tôi". */
  async listSharedWith(viewerDept: string) {
    return this.listRows(
      Prisma.sql`NOT s.is_revoked AND (s.expires_at IS NULL OR s.expires_at > NOW()) AND d.status <> 'DELETED'
                 AND s.shared_with_dept IN (${viewerDept}, '*')`,
      200,
    );
  }

  /**
   * Quyền cao nhất mà một phòng đang có với tài liệu này qua chia sẻ còn hiệu lực. null = không có.
   * ĐÂY là nơi duy nhất quyết định "phòng khác có được tải tài liệu này không".
   */
  async permissionFor(docId: number, viewerDept: string): Promise<SharePermission | null> {
    const rows = await this.prisma.$queryRaw<Array<{ perm: SharePermission }>>`
      SELECT CASE WHEN bool_or(permission = 'DOWNLOAD') THEN 'DOWNLOAD' ELSE 'VIEW' END AS perm
        FROM document_share
       WHERE doc_id = ${BigInt(docId)} AND NOT is_revoked AND (expires_at IS NULL OR expires_at > NOW())
         AND shared_with_dept IN (${viewerDept}, '*')
      HAVING COUNT(*) > 0`;
    return rows[0]?.perm ?? null;
  }

  // ------------------------------------------------------------------ nội bộ
  private async listRows(where: Prisma.Sql, limit: number) {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT s.share_id,
             NULL::bigint            AS central_doc_id,
             s.doc_id                AS source_doc_id,
             ${this.dept}::varchar   AS shared_by_dept,
             s.shared_with_dept, s.permission, s.reason, s.expires_at, s.created_at,
             d.title, d.description, f.file_name, c.name AS category_name, f.mime_type,
             d.current_version       AS version_no,
             u.full_name             AS owner_name,
             (SELECT string_agg(t.tag_name, ', ') FROM document_tag dt JOIN tag t ON t.tag_id = dt.tag_id WHERE dt.doc_id = d.doc_id) AS tags
        FROM document_share s
        JOIN document d              ON d.doc_id = s.doc_id
        LEFT JOIN category c         ON c.category_id = d.category_id
        LEFT JOIN local_user u       ON u.user_id = d.created_by
        LEFT JOIN document_version v ON v.doc_id = d.doc_id AND v.version_no = d.current_version
        LEFT JOIN file_object f      ON f.file_id = v.file_id
       WHERE ${where}
       ORDER BY s.created_at DESC
       LIMIT ${limit}`);
    return sanitizeBigInt(rows);
  }

  private async findOne(where: Prisma.Sql): Promise<ShareRow | null> {
    const rows = await this.prisma.$queryRaw<ShareRow[]>(Prisma.sql`SELECT * FROM document_share WHERE ${where} LIMIT 1`);
    return rows.length ? (sanitizeBigInt(rows)[0] as ShareRow) : null;
  }

  /**
   * Tăng row_version của tài liệu (trigger fn_update_timestamp) và ghi sự kiện Outbox TRONG CÙNG transaction với
   * thay đổi chia sẻ: Central Index cập nhật bản sao quyền, không bị bỏ qua vì "phiên bản không mới hơn".
   */
  /** Ghi một dòng lịch sử. Gọi TRONG transaction của thay đổi lượt chia sẻ để hai bên không bao giờ lệch nhau. */
  private async writeHistory(
    tx: Prisma.TransactionClient,
    h: { shareId: number; docId: number; dept: string; permission: string; expiresAt: unknown; action: 'GRANTED' | 'RENEWED' | 'REVOKED' | 'SUPERSEDED'; accessRequestId: number | null; actor: string | null },
  ) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO document_share_history (share_id, doc_id, shared_with_dept, permission, expires_at, action, access_request_id, actor)
      VALUES (${BigInt(h.shareId)}, ${BigInt(h.docId)}, ${h.dept}, ${h.permission}, CAST(${h.expiresAt as any} AS TIMESTAMPTZ), ${h.action},
              ${h.accessRequestId === null ? null : BigInt(h.accessRequestId)}, ${h.actor})`);
  }

  private async touchDocumentAndEmit(tx: Prisma.TransactionClient, docId: number) {
    await tx.$executeRaw`UPDATE document SET updated_at = NOW() WHERE doc_id = ${BigInt(docId)}`;
    await this.outbox.emitDocumentChanged(tx, docId, 'DocumentUpdated');
  }

  /** Chặn lỗi gõ nhầm mã phòng ban nhận. Registry không trả lời được thì bỏ qua (không chặn việc chia sẻ). */
  private async assertDepartmentExists(code: string) {
    if (code === '*' || !process.env.REGISTRY_URL) return;
    try {
      const res = await fetch(`${process.env.REGISTRY_URL}/registry/internal/departments`, {
        headers: { [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return;
      const list = (await res.json()) as Array<{ code: string }>;
      if (!list.some((d) => d.code === code)) throw new BadRequestException(`Không có phòng ban "${code}" trong hệ thống`);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`Không kiểm tra được phòng ban nhận qua Registry (bỏ qua): ${(err as Error).message}`);
    }
  }

  /**
   * Báo Search Gateway để (1) đẩy thông báo thời gian thực cho phòng nhận, (2) xóa cache kết quả tìm kiếm.
   * Best-effort: Gateway không trả lời thì quyền VẪN đúng (node tự kiểm tra), chỉ chậm hiện thông báo/cache tối đa 30 giây.
   */
  private async notifyGateway(notice: { type: string; title: string; message: string; targetDept: string }) {
    if (!process.env.REGISTRY_URL) return;
    try {
      await fetch(`${process.env.REGISTRY_URL}/search/internal/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') },
        body: JSON.stringify({ ...notice, invalidateSearchCache: true }),
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      this.logger.warn(`Không báo được cho Search Gateway (${notice.type}): ${(err as Error).message}`);
    }
  }
}
