import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { JwtPayload } from './jwt-payload.interface';
import { requireEnv } from '../config/env';

/**
 * Xác thực Bearer JWT cho các service không dùng Passport (search-engine-service).
 * Secret lấy từ JWT_SECRET (bắt buộc), dùng chung với các node phòng ban.
 * Gắn payload vào request.user.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly secret = requireEnv('JWT_SECRET');

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Thiếu token xác thực');
    }
    try {
      const payload = jwt.verify(header.slice(7), this.secret) as JwtPayload;
      if (!payload?.userId || !payload?.departmentCode || !payload?.role) {
        throw new UnauthorizedException('Token không hợp lệ');
      }
      request.user = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn');
    }
  }
}
