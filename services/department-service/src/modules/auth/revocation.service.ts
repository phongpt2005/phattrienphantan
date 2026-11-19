import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Khóa thu hồi token: tv:<mã phòng>:<userId> = phiên bản tối thiểu còn hợp lệ.
 * Node CHỈ GHI khóa này khi thu hồi. Gateway (search-engine) đọc khóa khi xác thực token.
 * Ghi đơn điệu bằng Lua: giá trị chỉ tăng, không bao giờ bị ghi đè bởi lần thu hồi cũ hơn.
 */
const MONOTONIC_SET = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > cur then redis.call('SET', KEYS[1], ARGV[1]) end
return redis.call('GET', KEYS[1])
`;

export const revocationKey = (dept: string, userId: number) => `tv:${dept}:${userId}`;

@Injectable()
export class RevocationService implements OnModuleDestroy {
  private readonly logger = new Logger(RevocationService.name);
  private client: Redis | null = null;

  private redis(): Redis {
    if (!this.client) {
      this.client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        connectTimeout: 1500,
        commandTimeout: 1000,
        maxRetriesPerRequest: 1,
      });
      this.client.on('error', (err) => this.logger.warn(`Redis (thu hồi token): ${err.message}`));
    }
    return this.client;
  }

  /**
   * Client ĐỌC dành riêng cho xác thực mỗi request: không xếp hàng khi mất kết nối, timeout ngắn.
   * Nếu không dùng client riêng, khi Redis chết mỗi request sẽ bị treo tới khi hết timeout của client ghi.
   */
  private reader(): Redis {
    if (!this.readClient) {
      this.readClient = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        connectTimeout: 500,
        commandTimeout: 150,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
      });
      this.readClient.on('error', () => undefined); // lỗi được xử lý theo từng lần đọc
    }
    return this.readClient;
  }

  /**
   * FAIL-OPEN (ADR-012/013): đọc khóa thu hồi cho mỗi request. Redis lỗi/timeout thì CHO QUA để node vẫn tự trị;
   * cảnh báo được ghi tối đa mỗi 30 giây để không tràn log.
   * tokenVersion: tv trong JWT (token cũ không có tv được coi là 0).
   */
  async isRevoked(issuerDept: string, userId: number, tokenVersion: number): Promise<boolean> {
    try {
      const v = await this.reader().get(revocationKey(issuerDept, userId));
      return v !== null && tokenVersion < Number(v);
    } catch (err) {
      const now = Date.now();
      if (now - this.lastReadWarn > 30_000) {
        this.lastReadWarn = now;
        this.logger.warn(`Không đọc được khóa thu hồi (cho qua, fail-open): ${err.message}`);
      }
      return false;
    }
  }

  private lastReadWarn = 0;
  private readClient: Redis | null = null;

  /** Ném lỗi nếu Redis không nhận khóa: người gọi phải báo thất bại, không báo thu hồi thành công. */
  async publish(dept: string, userId: number, minValidVersion: number): Promise<void> {
    await this.redis().eval(MONOTONIC_SET, 1, revocationKey(dept, userId), String(minValidVersion));
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => undefined);
    await this.readClient?.quit().catch(() => undefined);
  }
}
