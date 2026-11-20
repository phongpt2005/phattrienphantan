import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@dms/database';
import * as crypto from 'crypto';
import { FileService } from './file.service';

export interface IntegrityMismatch {
  fileId: string;
  fileName: string;
  reason: string;
}

export interface IntegrityRun {
  startedAt: string;
  finishedAt: string | null;
  checked: number;
  ok: number;
  mismatched: number;
  unreadable: number;
  mismatches: IntegrityMismatch[];
}

/**
 * Quét toàn vẹn tệp (N4). Đọc lại từng tệp trong MinIO, băm SHA-256 và so với checksum và kích thước đã lưu khi tải lên.
 * Phát hiện hỏng âm thầm: ghi hỏng, bit rot, tệp bị mất. Không tự sửa: khôi phục cần bản sao lưu ngoài máy (N1).
 * Chạy một lượt tại một thời điểm, giãn I/O giữa các tệp. Kết quả lượt gần nhất giữ trong bộ nhớ và qua endpoint nội bộ.
 */
@Injectable()
export class FileIntegrityService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FileIntegrityService.name);
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private running = false;
  private last: IntegrityRun | null = null;
  private readonly intervalMs = Number(process.env.INTEGRITY_SCAN_INTERVAL_MS || 86400000); // 24 giờ
  private readonly delayMs = Number(process.env.INTEGRITY_SCAN_DELAY_MS || 1800000); // lượt đầu sau 30 phút khởi động

  constructor(
    private readonly prisma: PrismaClient,
    private readonly files: FileService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.INTEGRITY_SCAN_ENABLED === 'false') return;
    this.firstRun = setTimeout(() => void this.start(), this.delayMs);
    this.timer = setInterval(() => void this.start(), this.intervalMs);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.firstRun) clearTimeout(this.firstRun);
  }

  status() {
    return { running: this.running, last: this.last };
  }

  /** Bắt đầu một lượt quét (chạy nền). Trả false nếu đang có lượt chạy. */
  start(): boolean {
    if (this.running) return false;
    void this.scan();
    return true;
  }

  private async scan(): Promise<void> {
    this.running = true;
    const run: IntegrityRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      checked: 0,
      ok: 0,
      mismatched: 0,
      unreadable: 0,
      mismatches: [],
    };
    this.last = run;
    try {
      const rows = await this.prisma.fileObject.findMany({
        select: { fileId: true, fileName: true, checksumSha256: true, sizeBytes: true },
        orderBy: { fileId: 'asc' },
      });
      for (const r of rows) {
        run.checked++;
        const id = String(r.fileId);
        try {
          const { stream } = await this.files.getFileStream(r.fileId);
          const hash = crypto.createHash('sha256');
          let size = 0;
          for await (const chunk of stream) {
            const buf = chunk as Buffer;
            hash.update(buf);
            size += buf.length;
          }
          const got = hash.digest('hex');
          const want = String(r.checksumSha256).trim().toLowerCase();
          if (got === want && BigInt(size) === BigInt(r.sizeBytes)) {
            run.ok++;
          } else {
            run.mismatched++;
            const reason = `SHA-256 đọc được ${got.slice(0, 12)}…, đã lưu ${want.slice(0, 12)}…; kích thước ${size} / ${String(r.sizeBytes)}`;
            run.mismatches.push({ fileId: id, fileName: r.fileName, reason });
            this.logger.warn(`Toàn vẹn: tệp ${id} (${r.fileName}) KHÔNG KHỚP: ${reason}`);
          }
        } catch (err) {
          run.unreadable++;
          const reason = `không đọc được: ${(err as Error).message}`;
          run.mismatches.push({ fileId: id, fileName: r.fileName, reason });
          this.logger.warn(`Toàn vẹn: tệp ${id} (${r.fileName}) ${reason}`);
        }
        await new Promise((res) => setTimeout(res, 20));
      }
    } catch (err) {
      this.logger.error(`Quét toàn vẹn lỗi: ${(err as Error).message}`);
    } finally {
      run.finishedAt = new Date().toISOString();
      this.running = false;
      this.logger.log(
        `Quét toàn vẹn xong: ${run.checked} tệp, khớp ${run.ok}, lệch ${run.mismatched}, không đọc được ${run.unreadable}`,
      );
    }
  }
}
