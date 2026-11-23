import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { AuthenticatedUser, DepartmentGuard, Roles, RolesGuard } from '@dms/common';
import { CreateShareDto } from '../../dto/create-share.dto';
import { SharesService } from './shares.service';

/**
 * Sổ chia sẻ của phòng ban: chỉ người của CHÍNH phòng này (DepartmentGuard) và là Trưởng phòng trở lên mới tạo,
 * thu hồi, xem được. Nhân viên không có quyền (theo AGENTS.md: nhân viên không có nút chia sẻ).
 */
@Controller('shares')
@UseGuards(AuthGuard('jwt'), DepartmentGuard, RolesGuard)
@Roles('ADMIN', 'MANAGER')
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Post()
  create(@Body(new ValidationPipe({ transform: true, whitelist: true })) dto: CreateShareDto, @Req() req: Request) {
    return this.shares.createByUser(req.user as AuthenticatedUser, dto);
  }

  @Delete(':id')
  revoke(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.shares.revoke(req.user as AuthenticatedUser, id);
  }

  /** Tài liệu phòng mình đang chia sẻ ra ngoài */
  @Get()
  list() {
    return this.shares.listGranted();
  }
}
