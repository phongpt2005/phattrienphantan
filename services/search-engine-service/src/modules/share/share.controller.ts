import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser, JwtAuthGuard, Roles, RolesGuard, isExecutive } from '@dms/common';
import { ShareService } from './share.service';

/**
 * Quy trình xin quyền liên phòng ban + danh sách "Được chia sẻ với tôi". Danh tính lấy từ JWT.
 *
 * Việc TẠO / THU HỒI / LIỆT KÊ chia sẻ đi KHÔNG còn ở đây: chúng nằm ở node của phòng sở hữu tài liệu
 * (`/api/dept/<mã>/shares`), vì sổ chia sẻ thuộc về phòng sở hữu. Xem docs/05-adr/ADR-010.
 */
@Controller('search/shares')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShareController {
  constructor(private readonly shareService: ShareService) {}

  /** Tài liệu của phòng khác đang được chia sẻ cho phòng của tôi (gom từ các node). */
  @Get('shared-with-me')
  async getSharesWithDept(@Req() req: Request) {
    const user = req.user as AuthenticatedUser;
    return this.shareService.getSharesWithDept(user.departmentCode);
  }

  /** Mọi nhân viên đều được gửi yêu cầu xin quyền. */
  @Post('requests')
  async createAccessRequest(@Body() body: any, @Req() req: Request) {
    return this.shareService.createAccessRequest(
      {
        centralDocId: body?.centralDocId ? Number(body.centralDocId) : undefined,
        sourceDocId: body?.sourceDocId ? Number(body.sourceDocId) : undefined,
        targetDept: body?.targetDept,
        requestedDays: body?.requestedDays ? Number(body.requestedDays) : undefined,
        requestedPermission: body?.requestedPermission === 'DOWNLOAD' ? 'DOWNLOAD' : 'VIEW',
        reason: String(body?.reason ?? ''),
      },
      req.user as AuthenticatedUser,
    );
  }

  @Get('requests')
  async getAccessRequests(@Req() req: Request) {
    const user = req.user as AuthenticatedUser;
    return this.shareService.getAccessRequests(user.departmentCode, isExecutive(user));
  }

  @Post('requests/:id/approve')
  @Roles('ADMIN', 'MANAGER')
  async approveAccessRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body('permission') permission: 'VIEW' | 'DOWNLOAD' | undefined,
    @Req() req: Request,
  ) {
    return this.shareService.approveAccessRequest(id, req.user as AuthenticatedUser, permission);
  }

  @Post('requests/:id/reject')
  @Roles('ADMIN', 'MANAGER')
  async rejectAccessRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body('rejectReason') rejectReason: string | undefined,
    @Req() req: Request,
  ) {
    return this.shareService.rejectAccessRequest(id, req.user as AuthenticatedUser, rejectReason);
  }
}
