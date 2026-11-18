import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { NotificationService } from '../notification/notification.service';
import { SnapshotService } from '../snapshot/snapshot.service';

export interface RegisterDepartmentDto {
  code: string;
  name?: string;
  endpoint: string;
  topic?: string;
  schemaVersion?: number;
  apiVersion?: string;
  capabilities?: Record<string, unknown>;
}

export interface RegisteredDepartment {
  department_id: number;
  dept_code: string;
  dept_name: string;
  node_endpoint: string;
  kafka_topic: string;
  status: string;
  lifecycle: string;
  last_heartbeat_at: Date | null;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,19}$/;

/**
 * Department Registry: nguồn sự thật duy nhất về các phòng ban (R3).
 * Phòng ban tự đăng ký + heartbeat; Search Gateway chỉ đọc danh sách từ đây,
 * nên thêm phòng ban mới không phải sửa code/cấu hình của node nào khác.
 *
 * Vòng đời: PROVISIONING → ACTIVE → DEGRADED (mất heartbeat) → DRAINING (tắt có trật tự) → RETIRED
 */
@Injectable()
export class RegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistryService.name);
  private sweeper: NodeJS.Timeout | null = null;
  private cache: { at: number; rows: RegisteredDepartment[] } | null = null;
  private readonly cacheMs = 5000;
  private readonly startedAt = Date.now();
  /** Sau khi CSDL trung tâm lỗi, nhịp tim của node không ghi được nên KHÔNG được kết luận node sập cho tới khi họ kịp gửi lại. */
  private quietUntil = 0;
  /** true nếu danh bạ lần gần nhất lấy từ bản chụp (CSDL trung tâm không đọc được) */
  registryStale = false;
  registryAgeMs = 0;

  constructor(
    private readonly pool: Pool,
    private readonly notifications: NotificationService,
    private readonly snapshots: SnapshotService,
  ) {}

  onModuleInit() {
    const timeoutMs = Number(process.env.HEARTBEAT_TIMEOUT_MS || 30000);
    // Mốc bắt đầu theo dõi cho các phòng ban đã có từ trước khi có bảng lịch sử (idempotent, nhiều bản cùng chạy vẫn đúng)
    this.pool
      .query(
        `INSERT INTO department_status_event (dept_code, from_state, to_state, reason)
         SELECT d.dept_code, NULL, d.lifecycle, 'Bắt đầu theo dõi'
           FROM department d
          WHERE d.lifecycle <> 'RETIRED'
            AND NOT EXISTS (SELECT 1 FROM department_status_event e WHERE e.dept_code = d.dept_code)`,
      )
      .catch((err) => this.logger.warn(`Không tạo được mốc theo dõi: ${err.message}`));
    this.sweeper = setInterval(async () => {
      // Khoảng chờ sau khi chính Registry khởi động: trong lúc Registry tắt, node không gửi được nhịp tim,
      // nên nhịp tim cũ KHÔNG có nghĩa là node đã sập. Chờ đủ một chu kỳ timeout rồi mới kết luận.
      // Node đăng ký lại với độ trễ lùi dần tới 15 giây + chu kỳ nhịp tim 10 giây: ân hạn phải dài hơn tổng đó
      if (Date.now() - this.startedAt < timeoutMs + 35000) return;
      if (Date.now() < this.quietUntil) return;
      // Một bản Gateway khác (hoặc đường tìm kiếm) đã thấy CSDL trung tâm lỗi: nhịp tim của node cũng không ghi được trong lúc đó,
      // nên không được kết luận node sập cho tới khi trung tâm được thăm dò thành công và node kịp gửi nhịp tim lại.
      if (this.snapshots.sourceDown) {
        this.quietUntil = Date.now() + timeoutMs + 20000;
        return;
      }
      try {
        // Mất heartbeat quá hạn -> DEGRADED: Search đi thẳng vào Central Index (không chờ timeout)
        const res = await this.pool.query(
          `UPDATE department SET lifecycle = 'DEGRADED'
            WHERE lifecycle = 'ACTIVE' AND last_heartbeat_at IS NOT NULL
              AND last_heartbeat_at < NOW() - ($1::int * INTERVAL '1 millisecond')
          RETURNING dept_code, last_heartbeat_at`,
          [timeoutMs],
        );
        if (res.rowCount) {
          this.cache = null;
          this.logger.warn(`Phòng ban mất heartbeat -> DEGRADED: ${res.rows.map((r) => r.dept_code).join(', ')}`);
          // UPDATE ... RETURNING là nguyên tử: dù chạy nhiều bản, mỗi lần chuyển trạng thái chỉ được ghi một lần
          for (const r of res.rows) {
            // Thời điểm bắt đầu sự cố = nhịp tim cuối cùng còn nhận được (lúc cuối cùng biết chắc node còn sống),
            // không phải lúc phát hiện: nếu không, thời lượng sự cố bị tính thiếu đúng bằng độ trễ phát hiện.
            await this.recordTransition(
              r.dept_code,
              'ACTIVE',
              'DEGRADED',
              `Mất heartbeat quá ${Math.round(timeoutMs / 1000)} giây`,
              r.last_heartbeat_at,
            );
          }
        }
      } catch (err) {
        this.logger.error(`Sweeper lỗi: ${err.message}`);
        this.quietUntil = Date.now() + timeoutMs + 20000; // chờ node đăng ký/heartbeat lại sau khi trung tâm hồi phục
      }
    }, 5000);
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  async register(dto: RegisterDepartmentDto) {
    const code = String(dto.code || '').toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      throw new BadRequestException('Mã phòng ban không hợp lệ (A-Z, 0-9, _; bắt đầu bằng chữ; tối đa 20 ký tự)');
    }
    if (!dto.endpoint || !/^https?:\/\//.test(dto.endpoint)) {
      throw new BadRequestException('endpoint không hợp lệ');
    }
    const topic = dto.topic || `dms.dept.${code.toLowerCase()}.document`;
    const res = await this.pool.query(
      `WITH prev AS (SELECT lifecycle FROM department WHERE dept_code = $1)
       INSERT INTO department (dept_code, dept_name, node_endpoint, kafka_topic, status, lifecycle,
                               last_heartbeat_at, api_version, schema_version, capabilities)
       VALUES ($1, $2, $3, $4, 'ACTIVE', 'ACTIVE', NOW(), $5, $6, $7)
       ON CONFLICT (dept_code) DO UPDATE SET
         dept_name = COALESCE(NULLIF($2, $1), department.dept_name),
         node_endpoint = EXCLUDED.node_endpoint,
         kafka_topic = EXCLUDED.kafka_topic,
         lifecycle = CASE WHEN department.lifecycle = 'RETIRED' THEN 'RETIRED' ELSE 'ACTIVE' END,
         last_heartbeat_at = NOW(),
         api_version = EXCLUDED.api_version,
         schema_version = EXCLUDED.schema_version,
         capabilities = EXCLUDED.capabilities
       RETURNING department_id, dept_code, lifecycle, (xmax = 0) AS inserted, (SELECT lifecycle FROM prev) AS prev_lifecycle`,
      [
        code,
        dto.name || code,
        dto.endpoint,
        topic,
        dto.apiVersion || 'v1',
        dto.schemaVersion || 1,
        JSON.stringify(dto.capabilities || {}),
      ],
    );
    this.cache = null;
    const row = res.rows[0];
    this.logger.log(`${row.inserted ? 'Phòng ban MỚI' : 'Phòng ban'} ${code} đăng ký (${dto.endpoint}) -> ${row.lifecycle}`);
    if ((row.prev_lifecycle ?? null) !== row.lifecycle) {
      await this.recordTransition(code, row.prev_lifecycle ?? null, row.lifecycle, row.inserted ? 'Phòng ban mới đăng ký' : 'Node khởi động và đăng ký lại');
    }
    return { departmentId: row.department_id, code, lifecycle: row.lifecycle, created: row.inserted };
  }

  async heartbeat(code: string) {
    const res = await this.pool.query(
      `UPDATE department d
          SET last_heartbeat_at = NOW(),
              lifecycle = CASE WHEN d.lifecycle IN ('DEGRADED', 'PROVISIONING') THEN 'ACTIVE' ELSE d.lifecycle END
         FROM (SELECT dept_code, lifecycle FROM department WHERE dept_code = $1 FOR UPDATE) o
        WHERE d.dept_code = o.dept_code AND d.lifecycle <> 'RETIRED'
        RETURNING d.lifecycle, o.lifecycle AS prev_lifecycle`,
      [String(code).toUpperCase()],
    );
    if (res.rowCount === 0) {
      // Node cần đăng ký lại (Registry mới khởi tạo lại, hoặc node chưa từng đăng ký)
      throw new NotFoundException('Phòng ban chưa đăng ký');
    }
    const row = res.rows[0];
    if (row.prev_lifecycle !== row.lifecycle) {
      this.cache = null;
      await this.recordTransition(String(code).toUpperCase(), row.prev_lifecycle, row.lifecycle, 'Heartbeat trở lại');
    }
    return { lifecycle: row.lifecycle };
  }

  async deregister(code: string) {
    const upper = String(code).toUpperCase();
    const res = await this.pool.query(
      `UPDATE department d SET lifecycle = 'DRAINING'
         FROM (SELECT dept_code, lifecycle FROM department WHERE dept_code = $1 FOR UPDATE) o
        WHERE d.dept_code = o.dept_code AND o.lifecycle IN ('ACTIVE', 'DEGRADED')
        RETURNING o.lifecycle AS prev_lifecycle`,
      [upper],
    );
    this.cache = null;
    if (res.rowCount) {
      this.logger.log(`Phòng ban ${upper} chuyển sang DRAINING`);
      await this.recordTransition(upper, res.rows[0].prev_lifecycle, 'DRAINING', 'Node tắt có trật tự');
    }
    return { lifecycle: 'DRAINING' };
  }

  /** Ghi lịch sử và báo ngay cho Ban Giám đốc (chuông thông báo, qua Redis pub/sub tới mọi bản). */
  private async recordTransition(code: string, from: string | null, to: string, reason: string, at?: Date | null) {
    try {
      await this.pool.query(
        `INSERT INTO department_status_event (dept_code, from_state, to_state, reason, occurred_at)
         VALUES ($1::varchar, $2::varchar, $3::varchar, $4::varchar,
                 CASE WHEN $5::timestamptz IS NULL THEN NOW()
                      -- không bao giờ lùi trước sự kiện gần nhất của chính phòng ban đó (giữ đúng thứ tự dòng thời gian)
                      ELSE GREATEST($5::timestamptz,
                                    (SELECT MAX(occurred_at) + INTERVAL '1 millisecond'
                                       FROM department_status_event WHERE dept_code = $1::varchar))
                 END)`,
        [code, from, to, reason, at ?? null],
      );
    } catch (err) {
      this.logger.error(`Không ghi được lịch sử trạng thái của ${code}: ${err.message}`);
    }
    const down = to === 'DEGRADED' || to === 'DRAINING';
    const recovered = to === 'ACTIVE' && (from === 'DEGRADED' || from === 'DRAINING');
    if (down) {
      this.notifications.publish({
        type: 'NODE_DOWN',
        title: to === 'DEGRADED' ? 'Node phòng ban mất kết nối' : 'Node phòng ban đã dừng',
        message: `Phòng ${code}: ${reason}. Tìm kiếm chuyển sang chỉ mục trung tâm cho phòng này.`,
        targetDept: '*',
        roles: ['ADMIN'],
      });
    } else if (recovered) {
      this.notifications.publish({
        type: 'NODE_RECOVERED',
        title: 'Node phòng ban đã phục hồi',
        message: `Phòng ${code} hoạt động trở lại (${reason.toLowerCase()}).`,
        targetDept: '*',
        roles: ['ADMIN'],
      });
    } else if (to === 'ACTIVE' && from === null) {
      this.notifications.publish({
        type: 'NODE_JOINED',
        title: 'Phòng ban mới tham gia hệ thống',
        message: `Phòng ${code} vừa đăng ký vào Registry và sẵn sàng phục vụ.`,
        targetDept: '*',
        roles: ['ADMIN'],
      });
    }
  }

  /** Danh sách phòng ban dùng cho fan-out tìm kiếm (cache ngắn trong bộ nhớ). */
  async listForSearch(): Promise<RegisteredDepartment[]> {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.rows;
    const loaded = await this.snapshots.load('registry', async () => {
      const res = await this.pool.query<RegisteredDepartment>(
        `SELECT department_id, dept_code, dept_name, node_endpoint, kafka_topic, status, lifecycle, last_heartbeat_at
           FROM department
          WHERE status = 'ACTIVE' AND lifecycle <> 'RETIRED'
          ORDER BY department_id`,
      );
      return res.rows;
    });
    this.registryStale = loaded.stale;
    this.registryAgeMs = loaded.ageMs;
    // Bản chụp thì chỉ giữ ngắn trong cache để thử lại nguồn gốc ở lần sau
    this.cache = { at: Date.now() - (loaded.stale ? this.cacheMs - 1000 : 0), rows: loaded.value };
    return loaded.value;
  }

  /** Danh sách cho frontend (chọn phòng ban đăng nhập, bộ lọc...). */
  async listPublic() {
    const rows = await this.listForSearch();
    return rows.map((r) => ({
      id: r.department_id,
      code: r.dept_code,
      name: r.dept_name,
      lifecycle: r.lifecycle,
      available: r.lifecycle === 'ACTIVE',
      lastHeartbeatAt: r.last_heartbeat_at,
    }));
  }
}
