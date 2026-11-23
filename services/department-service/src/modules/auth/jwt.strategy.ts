import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload, AuthenticatedUser, requireEnv } from '@dms/common';
import { RevocationService } from './revocation.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly revocation: RevocationService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload || !payload.userId) {
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn');
    }
    // P0.5.1: thu hồi tức thời cả trên đường nội bộ node (fail-open khi Redis không đọc được)
    if (await this.revocation.isRevoked(payload.departmentCode, payload.userId, payload.tv ?? 0)) {
      throw new UnauthorizedException('Token đã bị thu hồi, vui lòng đăng nhập lại');
    }
    return payload;
  }
}
