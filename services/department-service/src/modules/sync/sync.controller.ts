import { Controller, Get, Header } from '@nestjs/common';
import { SyncService } from './sync.service';
import { CONSOLE_HTML } from './console.page';

@Controller()
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /** Trạng thái đồng bộ của node (không cần đăng nhập: chỉ là số liệu hạ tầng, không có dữ liệu tài liệu). */
  @Get('sync/status')
  status() {
    return this.sync.status();
  }

  /** Giao diện tại node: huy hiệu OFFLINE/ONLINE, danh sách tài liệu, đăng nhập cục bộ. */
  @Get('console')
  @Header('Content-Type', 'text/html; charset=utf-8')
  console() {
    return CONSOLE_HTML;
  }
}
