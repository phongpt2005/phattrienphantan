import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { JwtPayload } from './jwt-payload.interface';
import { requireEnv } from '../config/env';

let sharedRedis: Redis | null = null;
function revocationRedis(): Redis {
  if (!sharedRedis) {
    sharedRedis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      connectTimeout: 1000,
      commandTimeout: 300,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    sharedRedis.on('error', () => undefined); // lỗi được xử lý theo từng lần đọc, không làm sập tiến trình
  }
  return sharedRedis;
}

/**
 * Xác thực Bearer JWT cho các service không dùng Passport (search-engine-service).
 * Secret lấy từ JWT_SECRET (bắt buộc), dùng chung với các node phòng ban.
 * Thu hồi token (ADR-013): nếu khóa Redis tv:<phòng>:<userId> lớn hơn phiên bản trong token thì từ chối.
 * Redis lỗi thì CHO QUA (ưu tiên khả dụng tìm kiếm) và ghi cảnh báo; token vẫn hết hạn sau 8 giờ.
 * Gắn payload vào request.user.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly secret = requireEnv('JWT_SECRET');
  private readonly logger = new Logger('JwtAuthGuard');

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Thiếu token xác thực');
    }
    let payload: JwtPayload;
    try {
      payload = jwt.verify(header.slice(7), this.secret) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn');
    }
    if (!payload?.userId || !payload?.departmentCode || !payload?.role) {
      throw new UnauthorizedException('Token không hợp lệ');
    }
    const minValid = await this.minValidVersion(payload);
    if (minValid !== null && (payload.tv ?? 0) < minValid) {
      throw new UnauthorizedException('Phiên đăng nhập đã bị thu hồi, vui lòng đăng nhập lại');
    }
    request.user = payload;
    return true;
  }

  private async minValidVersion(payload: JwtPayload): Promise<number | null> {
    try {
      const v = await revocationRedis().get(`tv:${payload.departmentCode}:${payload.userId}`);
      return v === null ? null : Number(v);
    } catch (err) {
      this.logger.warn(`Không đọc được khóa thu hồi (cho qua): ${err.message}`);
      return null;
    }
  }
}
