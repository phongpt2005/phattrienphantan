import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { SERVICE_TOKEN_HEADER, requireEnv } from '@dms/common';
import { RegisteredDepartment, RegistryService } from '../registry/registry.service';

/** Khóa咨询 của đối soát: chỉ một bản search chạy đối soát tại một thời điểm. */
const RECONCILE_LOCK = 728310;

interface Digest {
  count: number;
  digest: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Đối soát tự động (N3). Mỗi chu kỳ so dấu vân tay tập tài liệu của từng phòng ở node với Central Index:
 *  - Lệch: đợi một nhịp rồi kiểm lại, để loại trừ sự kiện đang nằm trong Kafka. Vẫn lệch thì yêu cầu node
 *    phát lại tài liệu (resync) qua đường sự kiện có sẵn. Projector áp dụng theo source_version nên lặp lại không gây hại.
 *  - Mỗi phòng tối đa một lần sửa trong RECONCILE_MIN_REPAIR_GAP_MS, để không sửa dồn dập.
 *  - Node không trả lời, hoặc CSDL trung tâm đang sập: bỏ qua, không kết luận là lệch.
 */
@Injectable()
export class ReconcileService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconcileService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly lastRepair = new Map<string, number>();
  private readonly intervalMs = Number(process.env.RECONCILE_INTERVAL_MS || 300000);
  private readonly minRepairGapMs = Number(process.env.RECONCILE_MIN_REPAIR_GAP_MS || 900000);
  private readonly recheckMs = Number(process.env.RECONCILE_RECHECK_MS || 20000);

  constructor(
    private readonly pool: Pool,
    private readonly registry: RegistryService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.RECONCILE_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Một vòng đối soát. Chạy định kỳ, và có thể gọi tay. Trả null nếu bỏ qua vòng này. */
  async runOnce(): Promise<{ checked: number; mismatched: number; repaired: number } | null> {
    if (this.running) return null;
    this.running = true;
    const out = { checked: 0, mismatched: 0, repaired: 0 };
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      // Khóa phiên gắn với đúng kết nối này. Khóa không lấy được thì một bản khác đang đối soát.
      const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [RECONCILE_LOCK]);
      if (!lock.rows[0].ok) return null;
      try {
        const depts = await this.registry.listForSearch();
        for (const d of depts) {
          const r = await this.checkDept(d);
          out.checked++;
          if (r.mismatched) out.mismatched++;
          if (r.repaired) out.repaired++;
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [RECONCILE_LOCK]).catch(() => undefined);
      }
      this.logger.log(`Đối soát: ${out.checked} phòng, lệch ${out.mismatched}, đã yêu cầu node phát lại ${out.repaired}`);
      return out;
    } catch (err) {
      this.logger.warn(`Đối soát bỏ qua vòng này (${(err as Error).message})`);
      return null;
    } finally {
      client?.release();
      this.running = false;
    }
  }

  private async checkDept(d: RegisteredDepartment): Promise<{ mismatched: boolean; repaired: boolean }> {
    const first = await this.compare(d);
    if (!first || first.equal) return { mismatched: false, repaired: false };
    // Đợi một nhịp rồi kiểm lại: sự kiện đang bay trong Kafka có thể làm lệch tạm thời
    await sleep(this.recheckMs);
    const second = await this.compare(d);
    if (!second || second.equal) return { mismatched: false, repaired: false };
    this.logger.warn(
      `Đối soát ${d.dept_code}: LỆCH. Node ${second.node.count} tài liệu (dấu vân tay ${second.node.digest.slice(0, 8)}), ` +
        `Central Index ${second.central.count} (${second.central.digest.slice(0, 8)}).`,
    );
    const last = this.lastRepair.get(d.dept_code) ?? 0;
    if (Date.now() - last < this.minRepairGapMs) {
      this.logger.warn(`Đối soát ${d.dept_code}: vừa phát lại tài liệu, chưa sửa lần nữa cho tới khi hết khoảng chờ.`);
      return { mismatched: true, repaired: false };
    }
    this.lastRepair.set(d.dept_code, Date.now());
    const ok = await this.requestResync(d);
    if (ok) this.logger.warn(`Đối soát ${d.dept_code}: đã yêu cầu node phát lại tài liệu (resync). Kiểm lại ở chu kỳ sau.`);
    return { mismatched: true, repaired: ok };
  }

  private async compare(d: RegisteredDepartment): Promise<{ equal: boolean; node: Digest; central: Digest } | null> {
    const node = await this.nodeDigest(d);
    if (!node) return null;
    const central = await this.centralDigest(d.department_id);
    return { equal: node.count === central.count && node.digest === central.digest, node, central };
  }

  private async nodeDigest(d: RegisteredDepartment): Promise<Digest | null> {
    try {
      const res = await fetch(`${d.node_endpoint}/internal/digest`, {
        headers: { [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return (await res.json()) as Digest;
    } catch {
      return null;
    }
  }

  private async centralDigest(departmentId: number): Promise<Digest> {
    const res = await this.pool.query<Digest>(
      `SELECT COUNT(*)::int AS count,
              COALESCE(md5(string_agg(source_doc_id::text || '|' || source_version::text || '|' || status, ',' ORDER BY source_doc_id)), '') AS digest
         FROM search_document
        WHERE department_id = $1`,
      [departmentId],
    );
    return res.rows[0];
  }

  private async requestResync(d: RegisteredDepartment): Promise<boolean> {
    try {
      const res = await fetch(`${d.node_endpoint}/internal/resync`, {
        method: 'POST',
        headers: { [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') },
        signal: AbortSignal.timeout(60000),
      });
      return res.ok;
    } catch (err) {
      this.logger.warn(`Đối soát ${d.dept_code}: không gọi được resync (${(err as Error).message})`);
      return false;
    }
  }
}
