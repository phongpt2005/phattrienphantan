import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { keepRedisAlive, redisConnectionOptions } from '@dms/common';

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private client: Redis;
  private defaultTtl: number;

  private isAvailable = false;
  private keepAlive?: { markClosing: () => void };

  onModuleInit() {
    this.defaultTtl = parseInt(process.env.REDIS_CACHE_TTL || '300', 10);
    this.client = new Redis({
      ...redisConnectionOptions(),
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1500,
      commandTimeout: 800,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 100, 2000),
    });
    this.keepAlive = keepRedisAlive(this.client);
    this.client.on('end', () => (this.isAvailable = false));

    this.client.on('connect', () => {
      this.isAvailable = true;
      this.logger.log('Redis Cache connected successfully');
    });

    this.client.on('error', (err) => {
      this.isAvailable = false;
      this.logger.warn(`Redis connection error (fallback mode enabled): ${err.message}`);
    });

    this.client.connect().catch((err) => {
      this.isAvailable = false;
      this.logger.warn(`Redis initial connection deferred: ${err.message}`);
    });
  }

  /** Kiểm tra Redis có thật sự trả lời không (dùng cho trang giám sát). */
  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable) return null;
    try {
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (error) {
      this.logger.warn(`Redis get fallback: ${error.message}`);
      return null;
    }
  }

  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    if (!this.isAvailable) return;
    try {
      const ttl = ttlSeconds || this.defaultTtl;
      await this.client.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      this.logger.warn(`Redis set fallback: ${error.message}`);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.isAvailable) return;
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.warn(`Redis del fallback: ${error.message}`);
    }
  }

  /**
   * Xóa tất cả các cache search bằng SCAN (không dùng KEYS để tránh block server Redis)
   */
  async invalidateSearchCache(pattern = 'search:*'): Promise<void> {
    if (!this.isAvailable) return;
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.client.del(...keys);
          this.logger.log(`Invalidated ${keys.length} search cache keys matching ${pattern}`);
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.error(`Failed to invalidate search cache: ${error.message}`);
    }
  }

  onModuleDestroy() {
    this.keepAlive?.markClosing();
    this.client?.disconnect();
  }
}
