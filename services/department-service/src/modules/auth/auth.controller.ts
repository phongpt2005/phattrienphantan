import { Controller, Post, Get, Body, Param, Req, UseGuards, ValidationPipe, BadRequestException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from '../../dto/login.dto';
import { RegisterDto } from '../../dto/register.dto';
import { DepartmentGuard, Roles, RolesGuard } from '@dms/common';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body(new ValidationPipe({ transform: true })) dto: LoginDto) {
    return this.authService.login(dto.username, dto.password);
  }

  @Post('register')
  @UseGuards(AuthGuard('jwt'), DepartmentGuard, RolesGuard)
  @Roles('ADMIN')
  async register(@Body(new ValidationPipe({ transform: true })) dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /** Thu hồi token của một người dùng cùng phòng. Trưởng phòng và Ban Giám đốc. */
  @Post('users/:userId/revoke')
  @UseGuards(AuthGuard('jwt'), DepartmentGuard, RolesGuard)
  @Roles('ADMIN', 'MANAGER')
  async revokeUserTokens(@Param('userId') userId: string, @Req() req: Request) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException('userId không hợp lệ');
    return this.authService.revokeTokens(id, req.user as any);
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'), DepartmentGuard)
  async getProfile(@Req() req: Request) {
    const user = req.user as any;
    return this.authService.getProfile(user.userId);
  }
}
