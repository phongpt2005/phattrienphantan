import { Controller, Header, Req, Sse, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { AuthenticatedUser, JwtAuthGuard } from '@dms/common';
import { NotificationService } from './notification.service';

@Controller('search/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** Luồng SSE của người dùng hiện tại. Trình duyệt đọc bằng fetch (EventSource không gửi được header Authorization). */
  @Sse('stream')
  @Header('X-Accel-Buffering', 'no') // nginx không đệm luồng sự kiện
  @Header('Cache-Control', 'no-cache')
  stream(@Req() req: Request): Observable<any> {
    return this.notifications.stream(req.user as AuthenticatedUser);
  }
}
