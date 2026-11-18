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

  /** Ném lỗi nếu Redis không nhận khóa: người gọi phải báo thất bại, không báo thu hồi thành công. */
  async publish(dept: string, userId: number, minValidVersion: number): Promise<void> {
    await this.redis().eval(MONOTONIC_SET, 1, revocationKey(dept, userId), String(minValidVersion));
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => undefined);
  }
}
