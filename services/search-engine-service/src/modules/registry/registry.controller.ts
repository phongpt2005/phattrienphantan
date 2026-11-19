import { Body, Controller, Get, Post, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard, ServiceTokenGuard } from '@dms/common';
import { RETRY_AFTER_SEC, RegisterDepartmentDto, RegistryService } from './registry.service';

@Controller('registry')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  /** Node phòng ban tự đăng ký khi khởi động (service token). */
  @Post('register')
  @UseGuards(ServiceTokenGuard)
  register(@Body() dto: RegisterDepartmentDto, @Res({ passthrough: true }) res: Response) {
    return withRetryAfter(res, () => this.registry.register(dto));
  }

  @Post('heartbeat')
  @UseGuards(ServiceTokenGuard)
  heartbeat(@Body('code') code: string, @Res({ passthrough: true }) res: Response) {
    return withRetryAfter(res, () => this.registry.heartbeat(code));
  }

  @Post('deregister')
  @UseGuards(ServiceTokenGuard)
  deregister(@Body('code') code: string) {
    return this.registry.deregister(code);
  }

  /** Thành phần nền tảng (content-worker) tra endpoint của node. Chỉ nhận service token. */
  @Get('internal/departments')
  @UseGuards(ServiceTokenGuard)
  async listInternal() {
    const rows = await this.registry.listForSearch();
    return rows.map((r) => ({ code: r.dept_code, endpoint: r.node_endpoint, lifecycle: r.lifecycle }));
  }

  /** Frontend lấy danh sách phòng ban động (không còn hardcode HR/ACC). */
  @Get('departments')
  @UseGuards(JwtAuthGuard)
  list() {
    return this.registry.listPublic();
  }

  /** Danh sách công khai tối thiểu cho màn hình đăng nhập (chưa có token): chỉ mã và tên. */
  @Get('departments/public')
  async listForLogin() {
    const all = await this.registry.listPublic();
    return all.map(({ code, name, available }) => ({ code, name, available }));
  }
}

/** Khi CSDL trung tâm tạm thời không sẵn sàng (503): gắn Retry-After để node biết khi nào thử lại. */
async function withRetryAfter<T>(res: Response, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceUnavailableException) res.setHeader('Retry-After', String(RETRY_AFTER_SEC));
    throw err;
  }
}
