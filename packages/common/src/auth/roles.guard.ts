import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { AuthenticatedUser } from './jwt-payload.interface';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest() as { user: AuthenticatedUser };
    if (!user) {
      return false;
    }

    const hasRole = requiredRoles.includes(user.role);
    if (!hasRole) {
      // Role không khớp yêu cầu -> Trả về HTTP 403 Forbidden
      return false;
    }

    return true;
  }
}
