import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { ProjectorService } from '../projector/projector.service';
import { RedisCacheService } from '../cache/redis-cache.service';
import { SnapshotService } from '../snapshot/snapshot.service';

type Lifecycle = 'PROVISIONING' | 'ACTIVE' | 'DEGRADED' | 'DRAINING' | 'RETIRED';
type BucketStatus = 'up' | 'down' | 'maintenance' | 'pending' | 'nodata';
type ComponentStatus = 'ok' | 'warn' | 'down' | 'unknown';

interface StatusEvent {
  event_id: string;
  dept_code: string;
  from_state: Lifecycle | null;
  to_state: Lifecycle;
  reason: string | null;
  occurred_at: Date;
}

interface PromSample {
  metric: Record<string, string>;
  value: number;
}

const BUCKETS = 48; // 48 ô x 30 phút = 24 giờ
const WINDOW_MS = 24 * 3600 * 1000;
const HISTORY_DAYS = 7;

/**
 * Tổng hợp sức khỏe toàn hệ thống cho trang giám sát của Ban Giám đốc.
 *
 * Nguồn dữ liệu (đều là dữ liệu thật, không có giá trị giả lập):
 *  - Registry (`department`) + lịch sử đổi trạng thái (`department_status_event`): node nào sống, sập lúc nào,
 *    phục hồi lúc nào, sập bao lâu, tỉ lệ sẵn sàng.
 *  - Prometheus: số bản đang sống của từng thành phần, độ trễ p95 và số lần dùng dự phòng của từng node, cảnh báo đang bật.
 *  - Kafka Connect REST: trạng thái connector Debezium của từng phòng ban.
 *  - Central DB: đường ống đồng bộ (sự kiện đã áp, bị bỏ qua, vào DLQ).
 * Nguồn nào không truy cập được thì báo `unknown` chứ không đoán.
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly promUrl = process.env.PROMETHEUS_URL;
  private readonly connectUrl = process.env.DEBEZIUM_URL;

  constructor(
    private readonly pool: Pool,
    private readonly projector: ProjectorService,
    private readonly cache: RedisCacheService,
    private readonly snapshots: SnapshotService,
  ) {}

  // ---------------------------------------------------------------- nguồn ngoài
  private async prom(expr: string): Promise<PromSample[] | null> {
    if (!this.promUrl) return null;
    try {
      const res = await fetch(`${this.promUrl}/api/v1/query?query=${encodeURIComponent(expr)}`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const body: any = await res.json();
      return (body?.data?.result ?? []).map((r: any) => ({ metric: r.metric ?? {}, value: Number(r.value?.[1]) }));
    } catch {
      return null;
    }
  }

  private async firingAlerts() {
    if (!this.promUrl) return null;
    try {
      const res = await fetch(`${this.promUrl}/api/v1/alerts`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const body: any = await res.json();
      return (body?.data?.alerts ?? [])
        .filter((a: any) => a.state === 'firing')
        .map((a: any) => ({
          name: a.labels?.alertname,
          severity: a.labels?.severity ?? 'warning',
          summary: a.annotations?.summary ?? '',
          since: a.activeAt,
        }));
    } catch {
      return null;
    }
  }

  private async connectors(): Promise<Array<{ name: string; state: string; tasks: string[] }> | null> {
    if (!this.connectUrl) return null;
    try {
      const res = await fetch(`${this.connectUrl}/connectors?expand=status`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const body: Record<string, any> = await res.json();
      return Object.entries(body)
        .map(([name, v]) => ({
          name,
          state: v?.status?.connector?.state ?? 'UNKNOWN',
          tasks: (v?.status?.tasks ?? []).map((t: any) => t.state),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- lịch sử trạng thái
  /** Dựng các đoạn [bắt đầu, kết thúc) theo trạng thái cho một phòng ban, từ danh sách sự kiện đã sắp xếp. */
  private segments(events: StatusEvent[], now: number) {
    const segs: Array<{ state: Lifecycle; from: number; to: number }> = [];
    for (let i = 0; i < events.length; i++) {
      const from = events[i].occurred_at.getTime();
      const to = i + 1 < events.length ? events[i + 1].occurred_at.getTime() : now;
      if (to > from) segs.push({ state: events[i].to_state, from, to });
    }
    return segs;
  }

  private timeline(events: StatusEvent[], now: number) {
    const start = now - WINDOW_MS;
    const size = WINDOW_MS / BUCKETS;
    const segs = this.segments(events, now);
    let up = 0;
    let down = 0;
    let maintenance = 0;
    const overlap = (s: { from: number; to: number }, a: number, b: number) => Math.max(0, Math.min(s.to, b) - Math.max(s.from, a));

    const buckets: BucketStatus[] = [];
    for (let i = 0; i < BUCKETS; i++) {
      const a = start + i * size;
      const b = a + size;
      const o = { up: 0, down: 0, maintenance: 0, pending: 0 };
      for (const s of segs) {
        const ms = overlap(s, a, b);
        if (ms <= 0) continue;
        if (s.state === 'ACTIVE') o.up += ms;
        else if (s.state === 'DEGRADED') o.down += ms;
        else if (s.state === 'DRAINING') o.maintenance += ms;
        else o.pending += ms;
      }
      up += o.up;
      down += o.down;
      maintenance += o.maintenance;
      // Ô nào có sập thì tô đỏ, kể cả chỉ sập vài giây: không che sự cố ngắn
      buckets.push(o.down > 0 ? 'down' : o.maintenance > 0 ? 'maintenance' : o.up > 0 ? 'up' : o.pending > 0 ? 'pending' : 'nodata');
    }
    const tracked = up + down + maintenance;
    return {
      buckets,
      bucketMinutes: size / 60000,
      upSeconds: Math.round(up / 1000),
      downSeconds: Math.round(down / 1000),
      maintenanceSeconds: Math.round(maintenance / 1000),
      trackedSeconds: Math.round(tracked / 1000),
      // Tắt có trật tự (bảo trì) cũng tính là không sẵn sàng: người dùng vẫn không dùng được node
      availabilityPct: tracked > 0 ? Math.round((up / tracked) * 10000) / 100 : null,
    };
  }

  /** Sự cố = khoảng thời gian node rời ACTIVE cho tới khi trở lại ACTIVE. */
  private incidents(byDept: Map<string, StatusEvent[]>, now: number) {
    const out: Array<{
      id: string;
      deptCode: string;
      kind: 'UNPLANNED' | 'PLANNED';
      reason: string | null;
      startedAt: string;
      resolvedAt: string | null;
      durationSeconds: number;
      ongoing: boolean;
    }> = [];
    for (const [code, events] of byDept) {
      let open: StatusEvent | null = null;
      for (const e of events) {
        const isDown = e.to_state === 'DEGRADED' || e.to_state === 'DRAINING';
        if (isDown && !open) open = e;
        // RETIRED = gỡ có chủ đích: khép sự cố (node không còn thuộc hệ thống nên không thể "đang sập" mãi mãi)
        else if ((e.to_state === 'ACTIVE' || e.to_state === 'RETIRED') && open) {
          out.push(this.incident(code, open, e.occurred_at.getTime(), false));
          open = null;
        }
      }
      if (open) out.push(this.incident(code, open, now, true));
    }
    return out.sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
  }

  private incident(code: string, start: StatusEvent, endMs: number, ongoing: boolean) {
    return {
      id: `${code}-${start.event_id}`,
      deptCode: code,
      // DEGRADED = mất heartbeat (sập ngoài ý muốn); DRAINING = node tự báo tắt (có kế hoạch)
      kind: start.to_state === 'DEGRADED' ? ('UNPLANNED' as const) : ('PLANNED' as const),
      reason: start.reason,
      startedAt: start.occurred_at.toISOString(),
      resolvedAt: ongoing ? null : new Date(endMs).toISOString(),
      durationSeconds: Math.max(0, Math.round((endMs - start.occurred_at.getTime()) / 1000)),
      ongoing,
    };
  }

  // ---------------------------------------------------------------- API chính
  async getSystemHealth() {
    const now = Date.now();
    // CSDL trung tâm không đọc được thì vẫn trả lời (từ bản chụp danh bạ), để trang giám sát đúng lúc cần nhất vẫn hoạt động
    const probe = await this.timed(() => this.pool.query('SELECT 1'));
    if (!probe.ok) return this.degradedHealth(now);

    const [depts, eventsRes, pipeline, dbPing, redisOk, promUpSearch, promUpWorker, promParts, promP95, promFallback, promNodeUp, promContentDlq, alerts, connectors] =
      await Promise.all([
        this.pool.query(
          `SELECT d.dept_code, d.dept_name, d.lifecycle, d.node_endpoint, d.last_heartbeat_at,
                  EXTRACT(EPOCH FROM (NOW() - d.last_heartbeat_at))::int AS heartbeat_age_s,
                  COUNT(s.central_doc_id) FILTER (WHERE s.status <> 'DELETED')::int AS documents,
                  MAX(s.synced_at) AS last_synced_at
             FROM department d
             LEFT JOIN search_document s ON s.department_id = d.department_id
            WHERE d.lifecycle <> 'RETIRED'
            GROUP BY d.department_id
            ORDER BY d.department_id`,
        ),
        // Sự kiện trong 7 ngày + sự kiện cuối cùng trước đó của mỗi phòng ban (để biết trạng thái tại đầu cửa sổ)
        this.pool.query<StatusEvent>(
          `(SELECT event_id, dept_code, from_state, to_state, reason, occurred_at
              FROM department_status_event WHERE occurred_at > NOW() - ($1::int * INTERVAL '1 day'))
           UNION ALL
           (SELECT DISTINCT ON (dept_code) event_id, dept_code, from_state, to_state, reason, occurred_at
              FROM department_status_event WHERE occurred_at <= NOW() - ($1::int * INTERVAL '1 day')
             ORDER BY dept_code, occurred_at DESC)
           ORDER BY occurred_at ASC, event_id ASC`,
          [HISTORY_DAYS],
        ),
        this.pool.query(
          `SELECT COUNT(*) FILTER (WHERE process_status = 'DONE' AND received_at > NOW() - INTERVAL '15 minutes')::int AS applied_15m,
                  COUNT(*) FILTER (WHERE process_status = 'SKIPPED' AND received_at > NOW() - INTERVAL '15 minutes')::int AS skipped_15m,
                  COUNT(*) FILTER (WHERE process_status IN ('DLQ', 'FAILED') AND received_at > NOW() - INTERVAL '24 hours')::int AS dlq_24h,
                  MAX(received_at) AS last_event_at
             FROM sync_event_log WHERE received_at > NOW() - INTERVAL '24 hours'`,
        ),
        this.timed(() => this.pool.query('SELECT 1')),
        this.cache.ping(),
        this.prom('up{job="dms-search-engine-service"}'),
        this.prom('up{job="dms-content-worker"}'),
        this.prom('dms_content_assigned_partitions'),
        this.prom('histogram_quantile(0.95, sum by (le, node) (rate(dms_search_node_duration_seconds_bucket{status="OK"}[5m])))'),
        this.prom('sum by (node) (increase(dms_search_fallback_total[15m]))'),
        this.prom('up{job="dms-departments"}'),
        this.prom('sum(dms_content_jobs_total{status="dlq"})'),
        this.firingAlerts(),
        this.connectors(),
      ]);

    // --- phòng ban
    const byDept = new Map<string, StatusEvent[]>();
    for (const e of eventsRes.rows) {
      const arr = byDept.get(e.dept_code) ?? [];
      arr.push(e);
      byDept.set(e.dept_code, arr);
    }
    const sample = (rows: PromSample[] | null, label: string, value: string) => rows?.find((r) => r.metric[label] === value)?.value;

    const departments = depts.rows.map((d) => {
      const events = byDept.get(d.dept_code) ?? [];
      const last = events[events.length - 1];
      const p95 = sample(promP95, 'node', d.dept_code);
      const metricsUp = sample(promNodeUp, 'department', d.dept_code);
      return {
        code: d.dept_code,
        name: d.dept_name,
        lifecycle: d.lifecycle as Lifecycle,
        endpoint: d.node_endpoint,
        lastHeartbeatAt: d.last_heartbeat_at,
        heartbeatAgeSeconds: d.heartbeat_age_s,
        // Thời điểm bắt đầu trạng thái hiện tại (vd. sập từ lúc nào)
        stateSince: last ? last.occurred_at.toISOString() : null,
        stateReason: last?.reason ?? null,
        documents: d.documents,
        lastSyncedAt: d.last_synced_at,
        searchP95Ms: p95 !== undefined && Number.isFinite(p95) ? Math.round(p95 * 1000) : null,
        fallbacks15m: promFallback ? Math.round(sample(promFallback, 'node', d.dept_code) ?? 0) : null,
        metricsUp: metricsUp === undefined ? null : metricsUp === 1,
        ...this.timeline(events, now),
      };
    });

    const incidents = this.incidents(byDept, now);

    // --- thành phần nền tảng
    const components: Array<{ key: string; name: string; group: string; status: ComponentStatus; detail: string }> = [];
    const replicas = (rows: PromSample[] | null) => (rows ? { up: rows.filter((r) => r.value === 1).length, total: rows.length } : null);

    components.push({ key: 'gateway', name: 'API Gateway (nginx)', group: 'Cổng vào', status: 'ok', detail: 'Đang chuyển tiếp yêu cầu này' });

    const sr = replicas(promUpSearch);
    components.push({
      key: 'search',
      name: 'Search Gateway + Registry',
      group: 'Tầng dùng chung',
      status: !sr ? 'unknown' : sr.up === 0 ? 'down' : sr.up < 2 || sr.up < sr.total ? 'warn' : 'ok',
      detail: sr ? `${sr.up}/${sr.total} bản đang sống${sr.up === 1 ? ' (mất dự phòng)' : ''} · bản trả lời: ${process.env.HOSTNAME ?? '?'}` : 'Không truy vấn được Prometheus',
    });

    const pj = this.projector.status;
    components.push({
      key: 'projector',
      name: 'Index Projector (Kafka → chỉ mục trung tâm)',
      group: 'Tầng dùng chung',
      status: pj.running ? 'ok' : 'down',
      detail: pj.running ? `Đang đọc ${pj.topics.length} topic phòng ban` : 'Consumer không chạy',
    });

    const wr = replicas(promUpWorker);
    const parts = promParts ? promParts.reduce((s, r) => s + r.value, 0) : null;
    components.push({
      key: 'content-worker',
      name: 'Content Worker (lập chỉ mục nội dung tệp)',
      group: 'Tầng dùng chung',
      status: !wr ? 'unknown' : wr.up === 0 ? 'down' : wr.up < wr.total ? 'warn' : 'ok',
      detail: wr ? `${wr.up}/${wr.total} bản đang sống${parts !== null ? ` · giữ ${parts} partition` : ''}` : 'Không truy vấn được Prometheus',
    });

    if (connectors === null) {
      components.push({ key: 'connect', name: 'Kafka Connect (Debezium)', group: 'Đồng bộ dữ liệu', status: 'unknown', detail: 'Không truy vấn được Kafka Connect' });
    } else if (connectors.length === 0) {
      components.push({ key: 'connect', name: 'Kafka Connect (Debezium)', group: 'Đồng bộ dữ liệu', status: 'warn', detail: 'Chưa có connector nào' });
    } else {
      for (const c of connectors) {
        const tasksRunning = c.tasks.length > 0 && c.tasks.every((t) => t === 'RUNNING');
        const failed = c.state === 'FAILED' || c.tasks.some((t) => t === 'FAILED') || c.tasks.length === 0;
        // RUNNING cả hai: bình thường. Có FAILED hoặc không có task: dữ liệu ngừng chảy. Còn lại (UNASSIGNED, PAUSED,
        // RESTARTING): task có thể vẫn chạy nhưng trạng thái quản lý bất thường -> cần chú ý.
        components.push({
          key: `connector-${c.name}`,
          name: `Connector ${c.name}`,
          group: 'Đồng bộ dữ liệu',
          status: failed ? 'down' : c.state === 'RUNNING' && tasksRunning ? 'ok' : 'warn',
          detail: `connector ${c.state} · task ${c.tasks.join(', ') || 'không có'}`,
        });
      }
    }

    const p = pipeline.rows[0];
    const contentDlq = promContentDlq?.[0]?.value ?? null;
    components.push({
      key: 'pipeline',
      name: 'Đường ống Outbox → Kafka → chỉ mục',
      group: 'Đồng bộ dữ liệu',
      status: p.dlq_24h > 0 ? 'warn' : 'ok',
      detail: `15 phút qua: ${p.applied_15m} sự kiện đã áp, ${p.skipped_15m} trùng bị bỏ qua · DLQ 24 giờ: ${p.dlq_24h}${contentDlq !== null ? ` · DLQ nội dung: ${contentDlq}` : ''}`,
    });

    components.push({
      key: 'central-db',
      name: 'CSDL chỉ mục trung tâm (PostgreSQL)',
      group: 'Lưu trữ',
      status: dbPing.ok ? 'ok' : 'down',
      detail: dbPing.ok ? `Phản hồi trong ${dbPing.ms} ms` : 'Không kết nối được',
    });
    components.push({
      key: 'redis',
      name: 'Redis (cache + kênh thông báo)',
      group: 'Lưu trữ',
      status: redisOk ? 'ok' : 'warn',
      detail: redisOk ? 'Đang hoạt động' : 'Mất kết nối: tìm kiếm vẫn chạy nhưng không có cache, thông báo chỉ trong từng bản',
    });

    // --- trạng thái tổng
    const downDepts = departments.filter((d) => d.lifecycle !== 'ACTIVE');
    const badComponents = components.filter((c) => c.status === 'down');
    const overall =
      !dbPing.ok || (departments.length > 0 && downDepts.length === departments.length)
        ? 'outage'
        : downDepts.length > 0 || badComponents.length > 0 || components.some((c) => c.status === 'warn')
          ? 'degraded'
          : 'operational';

    return {
      generatedAt: new Date(now).toISOString(),
      overall,
      summary: {
        departmentsTotal: departments.length,
        departmentsUp: departments.length - downDepts.length,
        downDepartments: downDepts.map((d) => d.code),
        ongoingIncidents: incidents.filter((i) => i.ongoing).length,
        incidents24h: incidents.filter((i) => now - +new Date(i.startedAt) < WINDOW_MS).length,
      },
      departments,
      incidents: incidents.slice(0, 40),
      // Dòng sự kiện vòng đời thô (mới nhất trước), để đối chiếu với bảng sự cố
      events: eventsRes.rows
        .slice(-60)
        .reverse()
        .map((e) => ({ id: e.event_id, deptCode: e.dept_code, from: e.from_state, to: e.to_state, reason: e.reason, at: e.occurred_at })),
      components,
      alerts,
      sources: { prometheus: promUpSearch !== null, kafkaConnect: connectors !== null },
      window: { hours: 24, buckets: BUCKETS, historyDays: HISTORY_DAYS },
    };
  }

  private async degradedHealth(now: number) {
    const [promUpSearch, promUpWorker, alerts, connectors] = await Promise.all([
      this.prom('up{job="dms-search-engine-service"}'),
      this.prom('up{job="dms-content-worker"}'),
      this.firingAlerts(),
      this.connectors(),
    ]);
    let snapshot: Array<{ dept_code: string; dept_name: string; lifecycle: Lifecycle; node_endpoint: string }> = [];
    try {
      snapshot = (await this.snapshots.load('registry', async () => { throw new Error('central down'); })).value as typeof snapshot;
    } catch {
      /* chưa có bản chụp */
    }
    const rep = (rows: PromSample[] | null) => (rows ? `${rows.filter((r) => r.value === 1).length}/${rows.length} bản đang sống` : 'không truy vấn được Prometheus');
    return {
      generatedAt: new Date(now).toISOString(),
      overall: 'degraded' as const,
      centralDbDown: true,
      summary: { departmentsTotal: snapshot.length, departmentsUp: snapshot.filter((d) => d.lifecycle === 'ACTIVE').length, downDepartments: [], ongoingIncidents: 0, incidents24h: 0 },
      departments: [],
      incidents: [],
      events: [],
      components: [
        { key: 'central-db', name: 'CSDL chỉ mục trung tâm (PostgreSQL)', group: 'Lưu trữ', status: 'down' as ComponentStatus, detail: 'Không kết nối được. Tìm kiếm liên phòng vẫn chạy trực tiếp tại các node (dùng bản chụp danh bạ và quyền chia sẻ); mất dự phòng khi node sập, lịch sử sự cố tạm không đọc được' },
        { key: 'search', name: 'Search Gateway + Registry', group: 'Tầng dùng chung', status: 'warn' as ComponentStatus, detail: `${rep(promUpSearch)} · đang chạy bằng bản chụp` },
        { key: 'content-worker', name: 'Content Worker (lập chỉ mục nội dung tệp)', group: 'Tầng dùng chung', status: 'ok' as ComponentStatus, detail: rep(promUpWorker) },
        ...(connectors ?? []).map((c) => ({ key: `connector-${c.name}`, name: `Connector ${c.name}`, group: 'Đồng bộ dữ liệu', status: (c.state === 'RUNNING' ? 'ok' : 'warn') as ComponentStatus, detail: `connector ${c.state}` })),
      ],
      alerts,
      sources: { prometheus: promUpSearch !== null, kafkaConnect: connectors !== null },
      window: { hours: 24, buckets: BUCKETS, historyDays: HISTORY_DAYS },
    };
  }

  private async timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number }> {
    const t = Date.now();
    try {
      await fn();
      return { ok: true, ms: Date.now() - t };
    } catch {
      return { ok: false, ms: Date.now() - t };
    }
  }
}
