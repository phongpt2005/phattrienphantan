import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from './jwt-payload.interface';

@Injectable()
export class DepartmentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;

    if (!user) {
      return false;
    }

    // DEPT_CODE do Helm/compose cấp cho từng node; không có giá trị mặc định
    // (trước đây mặc định 'HR' khiến phòng ban cấu hình thiếu bị coi là HR).
    const currentDept = process.env.DEPT_CODE;
    if (!currentDept) {
      return false;
    }

    // Chặn đứng hành vi gọi chéo API giữa các phòng ban -> HTTP 403 Forbidden
    return user.departmentCode === currentDept;
  }
}
