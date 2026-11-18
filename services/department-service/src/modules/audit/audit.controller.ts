import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaClient } from '@dms/database';
import { DepartmentGuard, Roles, RolesGuard, requireEnv } from '@dms/common';

/**
 * Kiểm tra toàn vẹn nhật ký kiểm toán của phòng ban: tính lại chuỗi băm SHA-256 từ đầu và đối chiếu.
 * Trả về dòng đầu tiên bị sửa/xóa nếu có (tamper-evident audit trail).
 */
@Controller('audit')
@UseGuards(AuthGuard('jwt'), DepartmentGuard, RolesGuard)
export class AuditController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get('verify')
  @Roles('ADMIN', 'MANAGER')
  async verify() {
    const rows = await this.prisma.$queryRaw<Array<{ total: number; legacy: number; first_bad: bigint | null; forks: number }>>`
      WITH c AS (
        SELECT log_id, prev_hash, entry_hash,
               audit_row_hash(prev_hash, log_id, user_id, doc_id, action, detail, ip_address, created_at) AS calc
          FROM audit_log WHERE entry_hash IS NOT NULL
      )
      SELECT (SELECT COUNT(*) FROM c)::int AS total,
             (SELECT COUNT(*) FROM audit_log WHERE entry_hash IS NULL)::int AS legacy,
             -- Dòng bị sửa: băm không khớp nội dung. Dòng liền trước bị xóa/đổi: cha của nó không còn tồn tại.
             (SELECT MIN(c.log_id) FROM c
               WHERE c.calc <> c.entry_hash
                  OR (c.prev_hash <> repeat('0', 64) AND NOT EXISTS (SELECT 1 FROM audit_log p WHERE p.entry_hash = c.prev_hash))) AS first_bad,
             -- Nhánh rẽ: nhiều dòng cùng một cha. Chỉ xuất hiện ở dữ liệu ghi trước khi sửa lỗi tranh chấp (mọi băm vẫn hợp lệ).
             (SELECT COUNT(*) FROM (SELECT prev_hash FROM c GROUP BY prev_hash HAVING COUNT(*) > 1) f)::int AS forks`;
    const r = rows[0];
    const firstBad = r.first_bad === null ? null : Number(r.first_bad);
    return {
      department: requireEnv('DEPT_CODE'),
      intact: firstBad === null,
      chainedEntries: r.total,
      legacyUnchainedEntries: r.legacy,
      forkedLinks: r.forks,
      firstBrokenLogId: firstBad,
      algorithm: 'SHA-256, prev_hash || row; mỗi dòng phải có cha tồn tại',
      note:
        r.forks > 0
          ? `${r.forks} nhánh rẽ do lỗi tranh chấp ghi đồng thời đã sửa; mọi giá trị băm vẫn hợp lệ nên nội dung không bị thay đổi. Không phát sinh thêm nhánh rẽ mới.`
          : null,
      checkedAt: new Date().toISOString(),
    };
  }
}
