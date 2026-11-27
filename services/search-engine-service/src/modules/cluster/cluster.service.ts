import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as dns } from 'dns';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Admin, Kafka, logLevel } from 'kafkajs';

/**
 * Bản đồ cụm: máy nào sống, thành phần nào đang giữ vai trò chính ở máy nào, và diễn biến khi có sự cố
 * (máy chết lúc nào, ai lên thay, mất bao lâu). Dùng cho trang "Bản đồ cụm" của Ban Giám đốc.
 *
 * Mọi số liệu đọc trực tiếp từ thành phần (REST của Patroni, /metrics của etcd, Kafka admin, Sentinel, REST của
 * Kafka Connect, /health của từng bản dịch vụ). Nguồn không trả lời thì báo "không trả lời", không đoán.
 *
 * Cấu hình (đều tùy chọn; thiếu thì coi mọi thứ chạy trên một máy):
 *  CLUSTER_MACHINES   "may-1|Máy Phong|10.0.0.11;may-2|Máy An|10.0.0.12;may-3|Máy Bình|10.0.0.13"
 *                     (mã|tên hiển thị|địa chỉ; địa chỉ dùng để hỏi node-exporter cổng 9100)
 *  CLUSTER_PLACEMENT  "may-1=central-pg-1,hr-pg-1,kafka-1;may-2=central-pg-2,..." (thành viên nằm ở máy nào)
 *  CLUSTER_HTTP       "Node HR=dept-hr:3001,dept-hr-2:3001;Gateway=nginx:80,nginx-2:80" (bản dịch vụ, hỏi /health)
 *  CLUSTER_VIP        "172.28.255.10:8404" (bộ cân bằng đang giữ địa chỉ ảo trả tên mình ở cổng này)
 *  REDIS_NODE_NAMES   "172.28.250.11=redis,172.28.250.12=redis-2"
 */

export type MemberStatus = 'up' | 'down';
export interface Member {
  name: string;
  machine: string;
  status: MemberStatus;
  /** Vai trò hiển thị: "Chính", "Bản sao đồng bộ", "Bản sao", "Leader", "Controller", ... */
  role: string;
  primary: boolean;
  detail?: string;
}
export interface ComponentView {
  key: string;
  label: string;
  kind: string;
  /** Thành viên đang giữ vai trò chính (null: không có ai, hoặc thành phần không có vai trò chính) */
  leader: string | null;
  leaderMachine: string | null;
  hasLeaderRole: boolean;
  status: 'ok' | 'warn' | 'down';
  detail: string;
  members: Member[];
}
export interface ClusterEvent {
  id: string;
  at: string;
  kind: 'MACHINE_DOWN' | 'MACHINE_UP' | 'MEMBER_DOWN' | 'MEMBER_UP' | 'LEADER_CHANGED' | 'LEADER_LOST';
  component: string | null;
  member: string | null;
  machine: string | null;
  fromValue: string | null;
  toValue: string | null;
  seconds: number | null;
  message: string;
}

interface MachineDef {
  id: string;
  label: string;
  address: string | null;
}

const POLL_MS = Number(process.env.CLUSTER_POLL_MS || 3000);
const LOCK_KEY = 72_031_101; // khóa tư vấn: chỉ một bản search ghi diễn biến vào CSDL

@Injectable()
export class ClusterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClusterService.name);
  private readonly machines: MachineDef[] = this.parseMachines();
  private readonly placement = this.parsePlacement();
  private readonly httpGroups = this.parseGroups(process.env.CLUSTER_HTTP ?? '');
  private readonly patroniClusters = this.parseGroups(process.env.PATRONI_CLUSTERS ?? '');
  private readonly etcdEndpoints = (process.env.ETCD_ENDPOINTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  private readonly connectUrls = (process.env.DEBEZIUM_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  private readonly kafkaBrokers = (process.env.KAFKA_BROKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  private readonly sentinels = (process.env.REDIS_SENTINELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  private readonly redisNames = new Map(
    (process.env.REDIS_NODE_NAMES || '172.28.250.11=redis,172.28.250.12=redis-2')
      .split(',')
      .map((p) => p.split('=').map((x) => x.trim()) as [string, string]),
  );

  private kafkaAdmin: Admin | null = null;
  private kafkaConnected = false;
  private sentinelClients: Redis[] = [];
  private timer: NodeJS.Timeout | null = null;
  private tableReady = false;
  private polling = false;

  private last: { machines: Map<string, MemberStatus>; members: Map<string, MemberStatus>; leaders: Map<string, string | null> } | null = null;
  /** Lúc thành phần mất vai trò chính (để đo thời gian chuyển) */
  private leaderLostAt = new Map<string, number>();
  private memoryEvents: ClusterEvent[] = [];
  private snapshot: { generatedAt: string; machines: any[]; components: ComponentView[] } | null = null;
  private seq = 0;

  constructor(private readonly pool: Pool) {}

  onModuleInit() {
    if (process.env.CLUSTER_MONITOR === 'off') return;
    if (this.kafkaBrokers.length) {
      this.kafkaAdmin = new Kafka({ clientId: 'dms-cluster-map', brokers: this.kafkaBrokers, logLevel: logLevel.NOTHING, connectionTimeout: 1500, requestTimeout: 2500 }).admin();
    }
    const password = process.env.REDIS_PASSWORD || undefined;
    this.sentinelClients = this.sentinels.map((s) => {
      const [host, port] = s.split(':');
      const c = new Redis({ host, port: Number(port || 26379), password, lazyConnect: true, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 1500, maxRetriesPerRequest: 0, retryStrategy: (t) => Math.min(t * 500, 3000) });
      c.on('error', () => undefined);
      c.connect().catch(() => undefined);
      return c;
    });
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    void this.tick();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.sentinelClients.forEach((c) => c.disconnect());
    await this.kafkaAdmin?.disconnect().catch(() => undefined);
  }

  // ---------------------------------------------------------------- cấu hình
  private parseMachines(): MachineDef[] {
    const raw = (process.env.CLUSTER_MACHINES ?? '').trim();
    if (!raw) return [{ id: 'may-1', label: 'Máy này', address: null }];
    return raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [id, label, address] = s.split('|').map((x) => x.trim());
        return { id, label: label || id, address: address || null };
      });
  }

  private parsePlacement(): Map<string, string> {
    const m = new Map<string, string>();
    for (const part of (process.env.CLUSTER_PLACEMENT ?? '').split(';')) {
      const [machine, list] = part.split('=');
      if (!machine || !list) continue;
      for (const n of list.split(',')) if (n.trim()) m.set(n.trim(), machine.trim());
    }
    return m;
  }

  private parseGroups(raw: string) {
    return raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [label, members] = s.split('=');
        return { label: label.trim(), members: (members ?? '').split(',').map((m) => m.trim()).filter(Boolean) };
      });
  }

  private machineOf(name: string): string {
    const host = name.split(':')[0];
    return this.placement.get(host) ?? this.placement.get(name) ?? this.machines[0].id;
  }

  // ---------------------------------------------------------------- đọc từng thành phần
  private async json(url: string, ms = 2000): Promise<any | null> {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  private async text(url: string, ms = 2000): Promise<string | null> {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  }

  private async patroni(): Promise<ComponentView[]> {
    return Promise.all(
      this.patroniClusters.map(async (c) => {
        const members: Member[] = await Promise.all(
          c.members.map(async (m) => {
            const name = m.split(':')[0];
            const b = await this.json(`http://${m}/patroni`);
            if (!b) return { name, machine: this.machineOf(name), status: 'down' as const, role: 'Không trả lời', primary: false };
            const primary = b.role === 'primary' || b.role === 'master';
            return { name, machine: this.machineOf(name), status: 'up' as const, role: primary ? 'Máy chính' : 'Bản sao', primary, detail: b.state };
          }),
        );
        // Đánh dấu bản sao đồng bộ theo báo cáo của máy chính
        const leader = members.find((m) => m.primary);
        if (leader) {
          const b = await this.json(`http://${c.members.find((m) => m.startsWith(leader.name))}/patroni`);
          const sync = new Set<string>(
            (b?.replication ?? []).filter((r: any) => r.sync_state === 'sync' || r.sync_state === 'quorum').map((r: any) => String(r.application_name)),
          );
          for (const m of members) if (!m.primary && m.status === 'up' && sync.has(m.name)) m.role = 'Bản sao đồng bộ';
        }
        return this.view(`patroni:${c.label}`, `CSDL ${c.label}`, 'Patroni', members, true);
      }),
    );
  }

  private async etcd(): Promise<ComponentView | null> {
    if (!this.etcdEndpoints.length) return null;
    const members: Member[] = await Promise.all(
      this.etcdEndpoints.map(async (e) => {
        const name = e.split(':')[0];
        const metrics = await this.text(`http://${e}/metrics`);
        if (!metrics) return { name, machine: this.machineOf(name), status: 'down' as const, role: 'Không trả lời', primary: false };
        const leader = /^etcd_server_is_leader\s+1(\.0)?\s*$/m.test(metrics);
        return { name, machine: this.machineOf(name), status: 'up' as const, role: leader ? 'Leader' : 'Thành viên', primary: leader };
      }),
    );
    return this.view('etcd', 'etcd (bầu máy chính)', 'etcd', members, true);
  }

  private async kafka(): Promise<ComponentView | null> {
    if (!this.kafkaAdmin) return null;
    let live: Array<{ nodeId: number; host: string }> = [];
    try {
      if (!this.kafkaConnected) {
        await this.kafkaAdmin.connect();
        this.kafkaConnected = true;
      }
      live = (await this.kafkaAdmin.describeCluster()).brokers;
    } catch {
      this.kafkaConnected = false;
      await this.kafkaAdmin.disconnect().catch(() => undefined);
    }
    // KRaft: trường "controller" trong metadata là một broker ngẫu nhiên, không phải bộ điều khiển thật, nên không dùng
    // làm vai trò chính (đã thấy nó đổi mỗi lần hỏi). Mọi broker cùng nhận ghi theo partition: chỉ theo dõi sống/chết.
    const members: Member[] = this.kafkaBrokers.map((b) => {
      const name = b.split(':')[0];
      const hit = live.find((x) => x.host === name);
      if (!hit) return { name, machine: this.machineOf(name), status: 'down' as const, role: live.length ? 'Không có trong cụm' : 'Không đọc được', primary: false };
      return { name, machine: this.machineOf(name), status: 'up' as const, role: 'Broker', primary: false };
    });
    return this.view('kafka', 'Kafka (hàng đợi sự kiện)', 'Kafka', members, false);
  }

  private flat(arr: any[]): Record<string, string> {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < arr.length; i += 2) o[String(arr[i])] = String(arr[i + 1]);
    return o;
  }

  private async redis(): Promise<ComponentView | null> {
    if (!this.sentinelClients.length) return null;
    let master: Record<string, string> | null = null;
    let replicas: Array<Record<string, string>> = [];
    for (const c of this.sentinelClients) {
      try {
        master = this.flat((await c.call('SENTINEL', 'master', 'dms-redis')) as any[]);
        replicas = ((await c.call('SENTINEL', 'replicas', 'dms-redis')) as any[][]).map((r) => this.flat(r));
        break;
      } catch {
        /* sentinel này không trả lời: thử cái khác */
      }
    }
    const sentinelUp = this.sentinelClients.map((c) => c.status === 'ready');
    const name = (ip: string) => this.redisNames.get(ip) ?? ip;
    const members: Member[] = [];
    if (master) {
      const down = /s_down|o_down|disconnected/.test(master.flags ?? '');
      members.push({ name: name(master.ip), machine: this.machineOf(name(master.ip)), status: down ? 'down' : 'up', role: down ? 'Chính (mất kết nối)' : 'Bản chính', primary: !down });
      for (const r of replicas) {
        const rDown = /s_down|o_down|disconnected/.test(r.flags ?? '');
        members.push({ name: name(r.ip), machine: this.machineOf(name(r.ip)), status: rDown ? 'down' : 'up', role: rDown ? 'Không trả lời' : 'Bản sao', primary: false });
      }
    }
    this.sentinels.forEach((s, i) => {
      const n = s.split(':')[0];
      members.push({ name: n, machine: this.machineOf(n), status: sentinelUp[i] ? 'up' : 'down', role: 'Sentinel', primary: false });
    });
    return this.view('redis', 'Redis (cache, thu hồi token)', 'Redis', members, true);
  }

  private async debezium(): Promise<ComponentView | null> {
    if (!this.connectUrls.length) return null;
    const up = await Promise.all(this.connectUrls.map((u) => this.json(`${u}/`).then((x) => !!x)));
    let status: Record<string, any> | null = null;
    for (const u of this.connectUrls) {
      status = await this.json(`${u}/connectors?expand=status`, 2500);
      if (status) break;
    }
    const placementByWorker = new Map<string, string[]>();
    for (const [conn, v] of Object.entries(status ?? {})) {
      for (const t of (v as any)?.status?.tasks ?? []) {
        const w = String(t.worker_id ?? '').split(':')[0];
        if (!w) continue;
        placementByWorker.set(w, [...(placementByWorker.get(w) ?? []), conn.replace(/^outbox-/, '').toUpperCase()]);
      }
    }
    const members: Member[] = this.connectUrls.map((u, i) => {
      const name = new URL(u).hostname;
      const conns = placementByWorker.get(name) ?? [];
      return {
        name,
        machine: this.machineOf(name),
        status: up[i] ? 'up' : 'down',
        role: up[i] ? (conns.length ? `Đang chạy CDC: ${conns.join(', ')}` : 'Dự phòng') : 'Không trả lời',
        primary: false,
      };
    });
    return this.view('debezium', 'Debezium (đồng bộ CDC)', 'Kafka Connect', members, false);
  }

  private async vip(): Promise<ComponentView | null> {
    const addr = process.env.CLUSTER_VIP;
    if (!addr) return null;
    const holder = (await this.text(`http://${addr}/`, 1500))?.trim() || null;
    const names = (process.env.CLUSTER_VIP_MEMBERS || 'keepalived-1,keepalived-2').split(',').map((s) => s.trim());
    const members: Member[] = names.map((n) => ({
      name: n,
      machine: this.machineOf(n),
      status: 'up',
      role: holder === n ? 'Đang giữ địa chỉ ảo' : 'Dự phòng',
      primary: holder === n,
    }));
    const view = this.view('vip', `Địa chỉ ảo ${addr.split(':')[0]}`, 'Keepalived', members, true);
    if (!holder) {
      view.status = 'down';
      view.detail = 'Không ai trả lời ở địa chỉ ảo';
    }
    return view;
  }

  private async ips(name: string): Promise<string[]> {
    try {
      return (await dns.lookup(name, { all: true, family: 4 })).map((a) => a.address);
    } catch {
      return [];
    }
  }

  /**
   * Bản 2 của một node mang luôn tên chung của bản 1 (dept-hr-2 có bí danh dept-hr), nên hỏi "dept-hr" có thể trúng bản 2
   * và báo nhầm bản 1 còn sống. Địa chỉ riêng của một thành viên = địa chỉ dưới tên của nó trừ địa chỉ của các thành viên
   * có tên dài hơn bắt đầu bằng tên đó (dept-hr trừ dept-hr-2). Không còn địa chỉ riêng = bản đó không chạy.
   */
  private async http(): Promise<ComponentView[]> {
    return Promise.all(
      this.httpGroups.map(async (g) => {
        const entries = g.members.map((m) => {
          const [name, port] = m.split(':');
          return { name, port: port || '80' };
        });
        const resolved = new Map(await Promise.all(entries.map(async (e) => [e.name, await this.ips(e.name)] as [string, string[]])));
        const members: Member[] = await Promise.all(
          entries.map(async (e) => {
            const shadow = new Set(entries.filter((o) => o.name !== e.name && o.name.startsWith(`${e.name}-`)).flatMap((o) => resolved.get(o.name) ?? []));
            const own = (resolved.get(e.name) ?? []).filter((ip) => !shadow.has(ip));
            const ok = own.length > 0 && (await Promise.all(own.map((ip) => this.text(`http://${ip}:${e.port}/health`, 1500)))).some((x) => x !== null);
            return { name: e.name, machine: this.machineOf(e.name), status: ok ? ('up' as const) : ('down' as const), role: ok ? 'Đang phục vụ' : 'Không trả lời', primary: false };
          }),
        );
        return this.view(`http:${g.label}`, g.label, 'Dịch vụ', members, false);
      }),
    );
  }

  private view(key: string, label: string, kind: string, members: Member[], hasLeaderRole: boolean): ComponentView {
    const up = members.filter((m) => m.status === 'up').length;
    const leader = members.find((m) => m.primary) ?? null;
    let status: ComponentView['status'] = up === members.length ? 'ok' : up === 0 ? 'down' : 'warn';
    if (hasLeaderRole && !leader) status = 'down';
    const detail = hasLeaderRole
      ? leader
        ? `${leader.role}: ${leader.name} (${this.label(leader.machine)}) · ${up}/${members.length} thành viên sống`
        : `Không có vai trò chính · ${up}/${members.length} thành viên sống`
      : `${up}/${members.length} bản sống`;
    return { key, label, kind, leader: leader?.name ?? null, leaderMachine: leader?.machine ?? null, hasLeaderRole, status, detail, members };
  }

  private label(machineId: string | null) {
    return this.machines.find((m) => m.id === machineId)?.label ?? machineId ?? '?';
  }

  private async machineStatus(components: ComponentView[]) {
    return Promise.all(
      this.machines.map(async (m) => {
        const members = components.flatMap((c) => c.members.filter((x) => x.machine === m.id).map((x) => ({ ...x, component: c.label })));
        let reachable: boolean | null = null;
        let mem: { usedPct: number } | null = null;
        let cpuCount: number | null = null;
        if (m.address) {
          const metrics = await this.text(`http://${m.address}:9100/metrics`, 1500);
          reachable = metrics !== null;
          if (metrics) {
            const num = (re: RegExp) => Number(metrics.match(re)?.[1]);
            const total = num(/^node_memory_MemTotal_bytes\s+(\S+)/m);
            const avail = num(/^node_memory_MemAvailable_bytes\s+(\S+)/m);
            if (total > 0 && avail >= 0) mem = { usedPct: Math.round((1 - avail / total) * 100) };
            cpuCount = new Set([...metrics.matchAll(/node_cpu_seconds_total\{cpu="(\d+)"/g)].map((x) => x[1])).size || null;
          }
        }
        const anyUp = members.some((x) => x.status === 'up');
        // Có địa chỉ để hỏi thì tin node-exporter; không có thì máy sống nếu còn thành phần nào trên nó trả lời
        const status: MemberStatus = reachable === null ? (members.length === 0 || anyUp ? 'up' : 'down') : reachable || anyUp ? 'up' : 'down';
        return {
          id: m.id,
          label: m.label,
          address: m.address,
          status,
          memoryUsedPct: mem?.usedPct ?? null,
          cpus: cpuCount,
          leaders: members.filter((x) => x.primary).map((x) => `${x.component}`),
          members,
        };
      }),
    );
  }

  // ---------------------------------------------------------------- vòng theo dõi và diễn biến
  private async tick() {
    if (this.polling) return;
    this.polling = true;
    try {
      const parts = await Promise.all([this.patroni(), this.etcd(), this.kafka(), this.redis(), this.debezium(), this.vip(), this.http()]);
      const components = parts.flat().filter((x): x is ComponentView => !!x);
      const machines = await this.machineStatus(components);
      this.snapshot = { generatedAt: new Date().toISOString(), machines, components };
      await this.diff(machines, components);
    } catch (err: any) {
      this.logger.warn(`Bản đồ cụm: lỗi khi đọc trạng thái: ${err?.message ?? err}`);
    } finally {
      this.polling = false;
    }
  }

  private async diff(machines: Array<{ id: string; label: string; status: MemberStatus }>, components: ComponentView[]) {
    const now = Date.now();
    const cur = {
      machines: new Map(machines.map((m) => [m.id, m.status])),
      members: new Map(components.flatMap((c) => c.members.map((m) => [`${c.key}|${m.name}`, m.status] as [string, MemberStatus]))),
      leaders: new Map(components.filter((c) => c.hasLeaderRole).map((c) => [c.key, c.leader] as [string, string | null])),
    };
    const prev = this.last;
    this.last = cur;
    if (!prev) return; // lần đầu: chỉ ghi nhận trạng thái
    const events: ClusterEvent[] = [];
    const ev = (e: Omit<ClusterEvent, 'id' | 'at'>) =>
      events.push({ ...e, id: `${process.env.HOSTNAME ?? 'local'}-${now}-${++this.seq}`, at: new Date(now).toISOString() });

    for (const m of machines) {
      const before = prev.machines.get(m.id);
      if (before && before !== m.status) {
        ev({
          kind: m.status === 'down' ? 'MACHINE_DOWN' : 'MACHINE_UP',
          component: null,
          member: null,
          machine: m.id,
          fromValue: before,
          toValue: m.status,
          seconds: null,
          message: m.status === 'down' ? `${m.label} mất kết nối` : `${m.label} hoạt động trở lại`,
        });
      }
    }
    for (const c of components) {
      for (const m of c.members) {
        const before = prev.members.get(`${c.key}|${m.name}`);
        if (before && before !== m.status) {
          ev({
            kind: m.status === 'down' ? 'MEMBER_DOWN' : 'MEMBER_UP',
            component: c.label,
            member: m.name,
            machine: m.machine,
            fromValue: before,
            toValue: m.status,
            seconds: null,
            message: `${c.label}: ${m.name} (${this.label(m.machine)}) ${m.status === 'down' ? 'ngừng trả lời' : 'trả lời trở lại'}`,
          });
        }
      }
      if (!c.hasLeaderRole) continue;
      const before = prev.leaders.get(c.key);
      if (before === undefined || before === c.leader) continue;
      if (!c.leader) {
        this.leaderLostAt.set(c.key, now);
        ev({ kind: 'LEADER_LOST', component: c.label, member: before, machine: null, fromValue: before, toValue: null, seconds: null, message: `${c.label}: mất vai trò chính (trước đó ${before})` });
      } else {
        const lost = this.leaderLostAt.get(c.key);
        this.leaderLostAt.delete(c.key);
        const seconds = lost ? Math.round((now - lost) / 1000) : null;
        ev({
          kind: 'LEADER_CHANGED',
          component: c.label,
          member: c.leader,
          machine: c.leaderMachine,
          fromValue: before,
          toValue: c.leader,
          seconds,
          message: `${c.label}: ${c.leader} (${this.label(c.leaderMachine)}) lên thay${before ? ` ${before}` : ''}${seconds !== null ? `, sau ${seconds} giây không có vai trò chính` : ''}`,
        });
      }
    }
    if (!events.length) return;
    for (const e of events) this.logger.log(`[cụm] ${e.message}`);
    this.memoryEvents = [...events.reverse(), ...this.memoryEvents].slice(0, 300);
    await this.persist(events);
  }

  private async ensureTable() {
    if (this.tableReady) return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS cluster_event (
      event_id    TEXT PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind        TEXT NOT NULL,
      component   TEXT,
      member      TEXT,
      machine     TEXT,
      from_value  TEXT,
      to_value    TEXT,
      seconds     INT,
      message     TEXT NOT NULL)`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_cluster_event_time ON cluster_event (occurred_at DESC)');
    this.tableReady = true;
  }

  /**
   * Chỉ MỘT bản search ghi diễn biến: bản giữ khóa tư vấn trên một kết nối riêng, giữ suốt đời tiến trình. Bản đó chết
   * (hoặc CSDL trung tâm chuyển máy chính) thì phiên đóng, khóa tự nhả, bản khác giành được ở lượt sau. Khóa nhả sau
   * mỗi lần ghi thì hai bản thay nhau giành và cùng ghi một sự kiện (đã gặp: mỗi sự kiện xuất hiện hai lần).
   */
  private lockClient: import('pg').PoolClient | null = null;

  private async holdWriterLock(): Promise<boolean> {
    if (this.lockClient) return true;
    let c: import('pg').PoolClient | null = null;
    try {
      c = await this.pool.connect();
      const r = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
      if (!r.rows[0]?.ok) {
        c.release();
        return false;
      }
      c.on('error', () => {
        this.lockClient = null; // phiên mất: khóa đã nhả phía máy chủ
      });
      this.lockClient = c;
      this.logger.log('Bản này ghi diễn biến của cụm vào CSDL trung tâm');
      return true;
    } catch {
      c?.release(true);
      return false;
    }
  }

  private async persist(events: ClusterEvent[]) {
    if (!(await this.holdWriterLock())) return;
    try {
      await this.ensureTable();
      for (const e of events) {
        await this.lockClient!.query(
          `INSERT INTO cluster_event (event_id, occurred_at, kind, component, member, machine, from_value, to_value, seconds, message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [e.id, e.at, e.kind, e.component, e.member, e.machine, e.fromValue, e.toValue, e.seconds, e.message],
        );
      }
    } catch {
      // CSDL trung tâm không ghi được: bỏ kết nối giữ khóa (nhả khóa), diễn biến vẫn nằm trong bộ nhớ của bản này
      this.lockClient?.release(true);
      this.lockClient = null;
    }
  }

  private async history(): Promise<ClusterEvent[]> {
    try {
      await this.ensureTable();
      const r = await this.pool.query(
        `SELECT event_id, occurred_at, kind, component, member, machine, from_value, to_value, seconds, message
           FROM cluster_event WHERE occurred_at > NOW() - INTERVAL '24 hours' ORDER BY occurred_at DESC LIMIT 200`,
      );
      return r.rows.map((x) => ({
        id: x.event_id,
        at: new Date(x.occurred_at).toISOString(),
        kind: x.kind,
        component: x.component,
        member: x.member,
        machine: x.machine,
        fromValue: x.from_value,
        toValue: x.to_value,
        seconds: x.seconds,
        message: x.message,
      }));
    } catch {
      return this.memoryEvents;
    }
  }

  async getClusterMap() {
    if (!this.snapshot) await this.tick();
    // Đọc được CSDL trung tâm thì dùng diễn biến đã ghi (một bản ghi duy nhất); không đọc được thì dùng bộ nhớ của bản này
    const events = await this.history();
    return {
      ...(this.snapshot ?? { generatedAt: new Date().toISOString(), machines: [], components: [] }),
      pollSeconds: POLL_MS / 1000,
      answeredBy: process.env.HOSTNAME ?? null,
      events,
    };
  }
}
