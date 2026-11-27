import { Controller, Get } from '@nestjs/common';
import { PrismaClient } from '@dms/database';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get()
  async check() {
    let dbStatus = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    return {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      service: 'department-service',
      department: process.env.DEPT_CODE,
      instance: process.env.HOSTNAME, // bản nào (trong các bản của phòng) đã trả lời
      database: dbStatus,
      timestamp: new Date().toISOString(),
    };
  }
}
