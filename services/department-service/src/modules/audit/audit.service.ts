import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@dms/database';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaClient) {}

  async log(params: {
    userId?: number | bigint;
    docId?: number | bigint;
    action: 'CREATE' | 'VIEW' | 'DOWNLOAD' | 'UPDATE' | 'DELETE';
    detail?: string;
    ipAddress?: string;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: params.userId ? BigInt(params.userId) : null,
          docId: params.docId ? BigInt(params.docId) : null,
          action: params.action,
          detail: params.detail,
          ipAddress: params.ipAddress || '127.0.0.1',
        },
      });
    } catch (error) {
      this.logger.error(`Failed to record audit log: ${error.message}`, error.stack);
    }
  }
}
