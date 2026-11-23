import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaClient } from '@dms/database';
import { hashPassword, requireEnv } from '@dms/common';

/**
 * Tạo tài khoản DEMO cho node (chỉ khi SEED_DEMO_USERS=true).
 * Mật khẩu lấy từ biến môi trường, KHÔNG nằm trong mã nguồn. Tài khoản đã có mật khẩu
 * thì giữ nguyên (trừ khi SEED_RESET_PASSWORDS=true).
 *   admin (ADMIN, Ban Giám đốc) · <code>_manager (MANAGER) · <code>_staff (STAFF)
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(private readonly prisma: PrismaClient) {}

  async onApplicationBootstrap() {
    if (process.env.SEED_DEMO_USERS !== 'true') return;
    const code = requireEnv('DEPT_CODE');
    const lc = code.toLowerCase();
    const reset = process.env.SEED_RESET_PASSWORDS === 'true';

    const users: Array<{ username: string; fullName: string; role: 'ADMIN' | 'MANAGER' | 'STAFF'; passwordEnv: string }> = [
      { username: 'admin', fullName: 'Administrator', role: 'ADMIN', passwordEnv: 'DEMO_ADMIN_PASSWORD' },
      { username: `${lc}_manager`, fullName: `Trưởng phòng ${code}`, role: 'MANAGER', passwordEnv: 'DEMO_MANAGER_PASSWORD' },
      { username: `${lc}_staff`, fullName: `Nhân viên ${code}`, role: 'STAFF', passwordEnv: 'DEMO_STAFF_PASSWORD' },
    ];

    for (const u of users) {
      const password = process.env[u.passwordEnv];
      if (!password) {
        this.logger.warn(`Bỏ qua tài khoản ${u.username}: chưa đặt ${u.passwordEnv}`);
        continue;
      }
      const existing = await this.prisma.localUser.findUnique({ where: { username: u.username } });
      if (!existing) {
        await this.prisma.localUser.create({
          data: {
            username: u.username,
            fullName: u.fullName,
            email: `${u.username}@${lc}.local`,
            role: u.role,
            status: 'ACTIVE',
            passwordHash: await hashPassword(password),
          },
        });
        this.logger.log(`Đã tạo tài khoản demo ${u.username} (${u.role})`);
      } else {
        // Mật khẩu: chỉ đặt khi chưa có (hoặc SEED_RESET_PASSWORDS=true). Vai trò: luôn đồng bộ
        // theo bảng demo, vì Ban Giám đốc nay suy ra từ vai trò ADMIN trong token.
        const data: { passwordHash?: string; role?: 'ADMIN' | 'MANAGER' | 'STAFF' } = {};
        if (!existing.passwordHash || reset) data.passwordHash = await hashPassword(password);
        if (existing.role !== u.role) data.role = u.role;
        if (Object.keys(data).length > 0) {
          await this.prisma.localUser.update({ where: { username: u.username }, data });
          this.logger.log(`Đã cập nhật tài khoản demo ${u.username}: ${Object.keys(data).join(', ')}`);
        }
      }
    }
  }
}
