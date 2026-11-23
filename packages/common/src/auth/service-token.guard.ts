import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { requireEnv } from '../config/env';

export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * Bảo vệ các endpoint nội bộ (/internal/*, /registry/*) giữa các service của nền tảng.
 * Dùng khóa dùng chung INTERNAL_SERVICE_TOKEN (so sánh hằng thời gian).
 * Môi trường production nên thay bằng client-credentials của Keycloak / mTLS.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly expected = Buffer.from(requireEnv('INTERNAL_SERVICE_TOKEN'));

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const provided = request.headers?.[SERVICE_TOKEN_HEADER];
    if (typeof provided !== 'string') {
      throw new ForbiddenException('Endpoint nội bộ: thiếu service token');
    }
    const given = Buffer.from(provided);
    if (given.length !== this.expected.length || !crypto.timingSafeEqual(given, this.expected)) {
      throw new ForbiddenException('Endpoint nội bộ: service token không hợp lệ');
    }
    return true;
  }
}
