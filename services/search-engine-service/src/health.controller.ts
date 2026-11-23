import { Controller, Get } from '@nestjs/common';
import { Pool } from 'pg';
import { ProjectorService } from './modules/projector/projector.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly pool: Pool,
    private readonly projector: ProjectorService,
  ) {}

  @Get()
  async check() {
    let database = 'ok';
    try {
      await this.pool.query('SELECT 1');
    } catch {
      database = 'error';
    }
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'search-engine-service',
      instance: process.env.HOSTNAME, // bản nào (trong nhiều bản) đã trả lời
      database,
      projector: this.projector.status,
      timestamp: new Date().toISOString(),
    };
  }
}
