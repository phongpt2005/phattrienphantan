import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@dms/database';
import { comparePassword, hashPassword, JwtPayload, sanitizeBigInt, requireEnv } from '@dms/common';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwtService: JwtService,
  ) {}

  async login(username: string, plainTextPassword: string) {
    const user = await this.prisma.localUser.findUnique({
      where: { username },
    });

    if (!user) {
      throw new UnauthorizedException('Tên đăng nhập hoặc mật khẩu không chính xác');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Tài khoản người dùng đã bị khóa');
    }

    // Tài khoản chưa được đặt mật khẩu thì KHÔNG đăng nhập được
    // (trước đây có mật khẩu mặc định ngầm cho mọi tài khoản hash rỗng).
    const isPasswordValid = user.passwordHash
      ? await comparePassword(plainTextPassword, user.passwordHash)
      : false;

    if (!isPasswordValid) {
      throw new UnauthorizedException('Tên đăng nhập hoặc mật khẩu không chính xác');
    }

    const deptCode = requireEnv('DEPT_CODE');

    const payload: JwtPayload = {
      userId: Number(user.userId),
      username: user.username,
      fullName: user.fullName,
      role: user.role as any,
      departmentCode: deptCode,
    };

    const token = this.jwtService.sign(payload);
    this.logger.log(`User "${username}" logged in successfully at department [${deptCode}]`);

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: '8h',
      user: {
        userId: Number(user.userId),
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        departmentCode: deptCode,
      },
    };
  }

  async register(data: {
    username: string;
    password: string;
    fullName: string;
    email?: string;
    role?: 'ADMIN' | 'MANAGER' | 'STAFF';
  }) {
    const existing = await this.prisma.localUser.findUnique({
      where: { username: data.username },
    });

    if (existing) {
      throw new BadRequestException(`Tên đăng nhập "${data.username}" đã tồn tại`);
    }

    const hashedPassword = await hashPassword(data.password);

    const newUser = await this.prisma.localUser.create({
      data: {
        username: data.username,
        passwordHash: hashedPassword,
        fullName: data.fullName,
        email: data.email,
        role: data.role || 'STAFF',
        status: 'ACTIVE',
      },
    });

    return sanitizeBigInt({
      message: 'Tạo tài khoản thành công',
      user: {
        userId: newUser.userId,
        username: newUser.username,
        fullName: newUser.fullName,
        role: newUser.role,
      },
    });
  }

  async getProfile(userId: number) {
    const user = await this.prisma.localUser.findUnique({
      where: { userId: BigInt(userId) },
      select: {
        userId: true,
        username: true,
        fullName: true,
        email: true,
        role: true,
        status: true,
      },
    });
    return sanitizeBigInt(user);
  }
}
