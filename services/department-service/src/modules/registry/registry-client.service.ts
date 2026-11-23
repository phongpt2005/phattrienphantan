import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { SERVICE_TOKEN_HEADER, requireEnv } from '@dms/common';

/** Thời gian chờ tối đa giữa hai lần thử đăng ký (ms). Nhỏ để node tự về ACTIVE nhanh sau khi nối lại. */
const MAX_BACKOFF_MS = 5000;

/**
 * Tự đăng ký vào Department Registry khi khởi động và gửi heartbeat định kỳ (R3).
 * Search Gateway chỉ biết phòng ban nào đang tồn tại nhờ Registry: thêm phòng ban mới
 * không cần sửa code/cấu hình của bất kỳ node nào khác.
 *
 * Quy tắc an toàn: tại mọi thời điểm chỉ có TỐI ĐA một vòng đăng ký (single-flight)
 * và TỐI ĐA một heartbeat timer. Tránh tình trạng nhiều vòng chạy song song khi heartbeat lỗi lặp lại.
 */
@Injectable()
export class RegistryClientService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RegistryClientService.name);
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private registered = false;
  /** Đang chạy vòng đăng ký (single-flight). */
  private registering = false;
  /** Lần cuối node liên lạc được với Registry (trung tâm). Dùng cho trạng thái đồng bộ. */
  lastCentralOkAt: number | null = null;
  private stopped = false;

  private get code(): string {
    return requireEnv('DEPT_CODE');
  }
  private get registryUrl(): string | undefined {
    return process.env.REGISTRY_URL;
  }

  private body() {
    const port = Number(process.env.PORT || 3000);
    // Quy ước: container/service tên dept-<code>; ENDPOINT_URL cho phép ghi đè (K8s, v.v.)
    const endpoint = process.env.ENDPOINT_URL || `http://dept-${this.code.toLowerCase()}:${port}`;
    return {
      code: this.code,
      name: process.env.DEPT_NAME || this.code,
      endpoint,
      topic: `dms.dept.${this.code.toLowerCase()}.document`,
      schemaVersion: 1,
      apiVersion: 'v1',
      capabilities: { search: true, download: true },
    };
  }

  private async post(path: string, payload: unknown): Promise<void> {
    const res = await fetch(`${this.registryUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      const err = new Error(`${path} -> HTTP ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
  }

  onApplicationBootstrap() {
    if (!this.registryUrl) {
      this.logger.warn('REGISTRY_URL chưa cấu hình: node chạy độc lập, không tự đăng ký');
      return;
    }
    // Không chặn quá trình khởi động: Registry có thể lên sau node
    void this.registerLoop();
  }

  /**
   * Đăng ký đến khi thành công rồi bật heartbeat. Nếu đang có vòng khác chạy thì bỏ qua
   * (vòng đang chạy sẽ tự bật heartbeat khi thành công).
   */
  private async registerLoop(): Promise<void> {
    if (this.registering || this.stopped) return;
    this.registering = true;
    let delay = 1000;
    try {
      while (!this.stopped && !this.registered) {
        try {
          await this.post('/registry/register', this.body());
          this.registered = true;
          this.lastCentralOkAt = Date.now();
          this.logger.log(`Đã đăng ký phòng ban ${this.code} vào Registry (${this.body().endpoint})`);
        } catch (err) {
          this.logger.warn(`Đăng ký Registry thất bại (${err.message}), thử lại sau ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        }
      }
    } finally {
      this.registering = false;
    }
    this.startHeartbeat();
  }

  /** Luôn thay thế timer cũ, đảm bảo chỉ còn đúng một heartbeat timer. */
  private startHeartbeat(): void {
    if (this.stopped) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const interval = Number(process.env.HEARTBEAT_MS || 10000);
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.post('/registry/heartbeat', { code: this.code });
        this.lastCentralOkAt = Date.now();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 404) {
          // Lỗi tạm thời: CSDL trung tâm lỗi (503), timeout hoặc mất kết nối. Registry vẫn giữ node trong CSDL nên nhịp tim sau sẽ được nhận.
          // CHỈ đăng ký lại khi Registry trả 404 (không còn nhận diện node); đăng ký lại theo lỗi mạng chỉ tạo thêm lượt thử.
          this.logger.warn(`Nhịp tim chưa gửi được (${(err as Error).message}), giữ heartbeat và thử lại sau ${interval / 1000} giây`);
          return;
        }
        // Registry không còn nhận diện node (404): dừng heartbeat và đăng ký lại (một vòng duy nhất)
        this.logger.warn(`Registry không còn nhận diện node (404), đăng ký lại`);
        this.registered = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        void this.registerLoop();
      }
    }, interval);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.registryUrl && this.registered) {
      try {
        await this.post('/registry/deregister', { code: this.code }); // -> DRAINING
      } catch {
        /* best effort */
      }
    }
  }
}
