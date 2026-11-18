import { Controller, Post, Get, Body, Req, UseGuards, ValidationPipe } from '@nestjs/common';
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

  @Get('profile')
  @UseGuards(AuthGuard('jwt'), DepartmentGuard)
  async getProfile(@Req() req: Request) {
    const user = req.user as any;
    return this.authService.getProfile(user.userId);
  }
}
