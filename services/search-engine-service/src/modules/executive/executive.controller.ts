import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '@dms/common';
import { ExecutiveService } from './executive.service';
import { MonitoringService } from '../monitoring/monitoring.service';

/** Bảng điều khiển Ban Giám đốc: chỉ vai trò ADMIN (Executive) trong JWT. */
@Controller('search/executive')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class ExecutiveController {
  constructor(
    private readonly executiveService: ExecutiveService,
    private readonly monitoring: MonitoringService,
  ) {}

  /** Sức khỏe toàn hệ thống: node nào sống/sập, lịch sử sự cố, thành phần nền tảng, cảnh báo đang bật. */
  @Get('system')
  async getSystemHealth() {
    return this.monitoring.getSystemHealth();
  }

  @Get('dashboard')
  async getDashboard() {
    return this.executiveService.getDashboard();
  }

  @Get('audit-stream')
  async getAuditStream(@Query('limit') limit?: number) {
    const parsedLimit = limit ? Number(limit) : 20;
    return this.executiveService.getAuditStream(parsedLimit);
  }

  @Get('analytics')
  async getAnalytics() {
    return this.executiveService.getAnalytics();
  }
}
