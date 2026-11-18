import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ServiceTokenGuard } from '@dms/common';
import { RedisCacheService } from '../cache/redis-cache.service';
import { NoticeType, NotificationService } from './notification.service';

const NODE_ORIGINATED: NoticeType[] = ['SHARE_GRANTED', 'SHARE_REVOKED'];

/**
 * Node báo cho Gateway khi sổ chia sẻ của nó đổi, để Gateway (1) đẩy thông báo thời gian thực cho phòng nhận,
 * (2) xóa cache kết quả tìm kiếm. Chỉ nhận service token; nginx chặn `/api/search/internal/*` từ bên ngoài.
 * Đây chỉ là TIỆN ÍCH: quyền truy cập luôn do node tự kiểm tra, nên Gateway không nhận được thông báo thì
 * quyền vẫn đúng, chỉ chậm hiện thông báo và cache tối đa theo SEARCH_RESULT_CACHE_TTL (30 giây).
 */
@Controller('search/internal')
@UseGuards(ServiceTokenGuard)
export class InternalNotifyController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly cache: RedisCacheService,
  ) {}

  @Post('notify')
  async notify(@Body() body: { type: NoticeType; title: string; message: string; targetDept: string; invalidateSearchCache?: boolean }) {
    if (!NODE_ORIGINATED.includes(body?.type)) throw new BadRequestException('Loại thông báo không được phép từ node');
    if (typeof body.title !== 'string' || typeof body.message !== 'string' || typeof body.targetDept !== 'string') {
      throw new BadRequestException('Thiếu title, message hoặc targetDept');
    }
    if (body.invalidateSearchCache) await this.cache.invalidateSearchCache();
    this.notifications.publish({ type: body.type, title: body.title.slice(0, 120), message: body.message.slice(0, 400), targetDept: body.targetDept });
    return { ok: true };
  }
}
