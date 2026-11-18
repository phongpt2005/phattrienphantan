import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
}

/**
 * Quản lý kết nối High-Availability (HA) với cơ chế tự động chuyển vùng đọc (Read Failover)
 * sang PostgreSQL Replica khi máy chủ Primary bị gián đoạn hoặc sập nguồn.
 */
export class ResilientDatabaseService {
  private primary: PrismaClient;
  private replica: PrismaClient;
  private isPrimaryUp = true;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(primaryUrl: string, replicaUrl?: string) {
    this.primary = createPrismaClient(primaryUrl);
    this.replica = replicaUrl ? createPrismaClient(replicaUrl) : this.primary;
    this.startHeartbeat();
  }

  private startHeartbeat() {
    // Fast Heartbeat kiểm tra sức khỏe Primary mỗi 2.5s
    this.checkInterval = setInterval(async () => {
      try {
        await this.primary.$queryRaw`SELECT 1`;
        if (!this.isPrimaryUp) {
          console.log('[HA Database] Primary DB đã phục hồi! Tự động khôi phục chế độ bình thường.');
          this.isPrimaryUp = true;
        }
      } catch (err) {
        if (this.isPrimaryUp) {
          console.warn('[HA Database] CẢNH BÁO: Primary DB không phản hồi! Tự động chuyển toàn bộ luồng đọc sang Replica.');
          this.isPrimaryUp = false;
        }
      }
    }, 2500);
  }

  get writeClient(): PrismaClient {
    return this.primary;
  }

  get readClient(): PrismaClient {
    return this.isPrimaryUp ? this.primary : this.replica;
  }

  get isPrimaryHealthy(): boolean {
    return this.isPrimaryUp;
  }

  destroy() {
    if (this.checkInterval) clearInterval(this.checkInterval);
  }
}
