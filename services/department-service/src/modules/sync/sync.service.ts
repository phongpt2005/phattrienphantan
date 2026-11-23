import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, ResilientDatabaseService } from '@dms/database';
import { requireEnv } from '@dms/common';
import { RegistryClientService } from '../registry/registry-client.service';

/** Ngưỡng: quá khoảng này không có liên lạc thành công với trung tâm thì coi là OFFLINE. */
const OFFLINE_AFTER_MS = 30000;

export interface SyncStatus {
  department: string;
  mode: 'ONLINE' | 'OFFLINE';
  centralReachable: boolean;
  lastCentralOkAt: string | null;
  offlineForSeconds: number | null;
  outbox: {
    rowsTotal: number;
    rowsLast15m: number;
    /** Dung lượng WAL chưa được Debezium đọc (chờ gửi lên trung tâm). Đo bằng replication slot. */
    backlogBytes: number | null;
    slotActive: boolean | null;
  };
  checkedAt: string;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly registry: RegistryClientService,
  ) {}

  /** Thăm dò trực tiếp trung tâm (không tin hoàn toàn vào ký ức), tối đa 2 giây. */
  private async probeCentral(): Promise<boolean> {
    const url = process.env.REGISTRY_URL;
    if (!url) return false;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async status(): Promise<SyncStatus> {
    const now = Date.now();
    const reachable = await this.probeCentral();
    if (reachable) this.registry.lastCentralOkAt = now;
    const last = this.registry.lastCentralOkAt;
    const offline = !reachable || last === null || now - last > OFFLINE_AFTER_MS;

    const counts = await this.prisma.$queryRaw<Array<{ total: bigint; recent: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '15 minutes')::bigint AS recent
        FROM outbox`);
    let backlogBytes: number | null = null;
    let slotActive: boolean | null = null;
    try {
      const slot = await this.prisma.$queryRaw<Array<{ active: boolean; backlog: bigint }>>(Prisma.sql`
        SELECT active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint AS backlog
          FROM pg_replication_slots
         WHERE slot_name LIKE 'dbz\_%\_outbox' ESCAPE '\'
         LIMIT 1`);
      if (slot.length) {
        backlogBytes = Number(slot[0].backlog);
        slotActive = slot[0].active;
      }
    } catch {
      /* không đọc được slot: để null, không đoán */
    }

    return {
      department: requireEnv('DEPT_CODE'),
      mode: offline ? 'OFFLINE' : 'ONLINE',
      centralReachable: reachable,
      lastCentralOkAt: last ? new Date(last).toISOString() : null,
      offlineForSeconds: offline && last ? Math.round((now - last) / 1000) : null,
      outbox: {
        rowsTotal: Number(counts[0]?.total ?? 0),
        rowsLast15m: Number(counts[0]?.recent ?? 0),
        backlogBytes,
        slotActive,
      },
      checkedAt: new Date(now).toISOString(),
    };
  }
}
