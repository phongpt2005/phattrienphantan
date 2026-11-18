import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '@dms/common';
import { RedisCacheService } from '../cache/redis-cache.service';

export interface Loaded<T> {
  value: T;
  /** true: không đọc được nguồn gốc (CSDL trung tâm), đang dùng bản chụp cũ */
  stale: boolean;
  /** Tuổi của bản chụp đang dùng (0 khi vừa đọc từ nguồn gốc) */
  ageMs: number;
}

/**
 * Bản chụp "đọc được lần cuối" của dữ liệu mà Search Gateway cần cho MỌI truy vấn
 * (danh bạ phòng ban: phòng nào, địa chỉ nào). Mục đích: CSDL trung tâm sập thì tìm kiếm liên phòng vẫn chạy,
 * vì dữ liệu của tài liệu nằm ở các node chứ không nằm ở trung tâm.
 *
 * Quy tắc:
 *  - Luôn thử đọc nguồn gốc trước (ngữ nghĩa khi bình thường không đổi: không có độ trễ cập nhật mới).
 *  - Đọc được thì ghi bản chụp (bộ nhớ + Redis, tối đa 5 giây một lần cho mỗi khóa).
 *  - Đọc lỗi thì dùng bản chụp trong bộ nhớ; bản này vừa khởi động lại thì lấy từ Redis (dùng chung các bản).
 *  - Không có bản chụp nào thì ném lỗi gốc ra.
 *
 * Quyền chia sẻ KHÔNG nằm trong bản chụp: mỗi node tự kiểm tra sổ chia sẻ của nó (xem ADR-010).
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);
  private readonly mem = new Map<string, { value: unknown; at: number }>();
  private readonly lastWrite = new Map<string, number>();
  private readonly redisTtlSec = 24 * 3600;
  /**
   * Mạch ngắt cho nguồn gốc (CSDL trung tâm). Khi nguồn lỗi mà vẫn thử kết nối trong MỌI yêu cầu thì:
   *  - mỗi yêu cầu chờ vài giây cho tới khi hết thời gian kết nối;
   *  - các lần phân giải tên máy bị treo chiếm hết hàng đợi luồng của Node, kéo theo cả lệnh gọi tới các node
   *    khỏe mạnh bị trễ (đã đo: tìm kiếm mất 5–7 giây và cả ba node bị coi là quá 800 ms).
   * Nên: lỗi một lần là ngừng thử trong `cooldownMs`, dùng bản chụp ngay; hết thời gian chỉ MỘT yêu cầu thăm dò lại.
   */
  private downUntil = 0;
  private readonly cooldownMs = Number(process.env.CENTRAL_COOLDOWN_MS || 4000);

  /**
   * true nếu nguồn gốc đang bị coi là sập: từ lúc lỗi cho tới khi một lần THĂM DÒ thành công. Hết thời gian nghỉ cũng
   * KHÔNG cho truy vấn của người dùng tự thử kết nối (mỗi lần như vậy tốn ~1,2 giây chờ kết nối): chỉ `load()` thăm dò, và
   * thăm dò chạy ngầm khi đã có bản chụp.
   */
  get sourceDown(): boolean {
    return this.downUntil > 0;
  }

  /** Các truy cập CSDL trung tâm ngoài SnapshotService gọi hàm này khi gặp lỗi để mọi nơi cùng ngừng thử. */
  markDown(): void {
    this.downUntil = Date.now() + this.cooldownMs;
  }

  constructor(
    private readonly cache: RedisCacheService,
    private readonly metrics: MetricsService,
  ) {}

  async load<T>(key: string, loader: () => Promise<T>): Promise<Loaded<T>> {
    if (this.downUntil > 0) {
      if (Date.now() < this.downUntil) return this.fromSnapshot<T>(key, new Error('nguồn gốc đang nghỉ (mạch ngắt)'));
      this.downUntil = Date.now() + this.cooldownMs; // giành quyền thăm dò: các yêu cầu khác vẫn dùng bản chụp
      if (this.mem.has(key)) {
        // Đã có bản chụp: THĂM DÒ NGẦM. Yêu cầu của người dùng không phải trả giá chờ hết thời gian kết nối (~1,2 giây)
        // mỗi chu kỳ nghỉ; nếu nguồn đã hồi phục thì yêu cầu kế tiếp đọc nguồn gốc bình thường.
        void loader().then(
          (value) => {
            this.downUntil = 0;
            this.remember(key, value);
          },
          () => {
            this.downUntil = Date.now() + this.cooldownMs;
          },
        );
        return this.fromSnapshot<T>(key, new Error('đang thăm dò lại nguồn gốc'));
      }
    }
    try {
      const value = await loader();
      this.downUntil = 0;
      this.remember(key, value);
      return { value, stale: false, ageMs: 0 };
    } catch (err: any) {
      this.downUntil = Date.now() + this.cooldownMs;
      return this.fromSnapshot<T>(key, err);
    }
  }

  private async fromSnapshot<T>(key: string, err: Error): Promise<Loaded<T>> {
    const kind = key.split(':')[0];
    const local = this.mem.get(key);
    if (local) {
      this.metrics.snapshotServedTotal.inc({ kind, source: 'memory' });
      return { value: local.value as T, stale: true, ageMs: Date.now() - local.at };
    }
    const shared = await this.cache.get<{ value: T; at: number }>(`snapshot:${key}`);
    if (shared) {
      this.mem.set(key, { value: shared.value, at: shared.at });
      this.metrics.snapshotServedTotal.inc({ kind, source: 'redis' });
      this.logger.warn(`Dùng bản chụp "${key}" từ Redis (${Math.round((Date.now() - shared.at) / 1000)} giây tuổi): ${err.message}`);
      return { value: shared.value, stale: true, ageMs: Date.now() - shared.at };
    }
    throw err;
  }

  private remember(key: string, value: unknown) {
    const now = Date.now();
    this.mem.set(key, { value, at: now });
    if (now - (this.lastWrite.get(key) ?? 0) > 5000) {
      this.lastWrite.set(key, now);
      void this.cache.set(`snapshot:${key}`, { value, at: now }, this.redisTtlSec);
    }
  }
}
