import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleAlert, Clock, Crown, Cpu, Loader2, MemoryStick, RefreshCw, Server } from 'lucide-react';
import { searchApi } from '../services/api';
import { ClusterComponent, ClusterEvent, ClusterMap } from '../types';
import { Button, EmptyState, Kpi, LoadingRows, PageHeader, Panel, Pill, StatusDot, Td, Th, ROW } from './ui';

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDur = (s: number) => (s < 60 ? `${s} giây` : `${Math.floor(s / 60)} phút ${s % 60} giây`);

/** Một quy trình chuyển đổi/phục hồi của một thành phần: từ lúc có thành viên ngừng trả lời tới khi đủ thành viên trở lại. */
interface Process {
  id: string;
  component: string;
  startedAt: string;
  endedAt: string | null;
  steps: Array<{ at: string; label: string; tone: 'danger' | 'warning' | 'success' | 'info'; offset: number }>;
  failoverSeconds: number | null;
  state: 'running' | 'switched' | 'recovered';
}

const STEP: Record<ClusterEvent['kind'], { tone: Process['steps'][number]['tone'] }> = {
  MACHINE_DOWN: { tone: 'danger' },
  MACHINE_UP: { tone: 'success' },
  MEMBER_DOWN: { tone: 'danger' },
  LEADER_LOST: { tone: 'warning' },
  LEADER_CHANGED: { tone: 'info' },
  MEMBER_UP: { tone: 'success' },
};

function buildProcesses(events: ClusterEvent[]): Process[] {
  const asc = [...events].filter((e) => e.component).sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const open = new Map<string, Process & { down: Set<string>; leaderPending: boolean }>();
  const done: Process[] = [];
  for (const e of asc) {
    const key = e.component as string;
    let p = open.get(key);
    if (!p) {
      // Quy trình bắt đầu khi có thành viên ngừng trả lời hoặc mất vai trò chính; sự kiện lẻ khác không mở quy trình
      if (e.kind !== 'MEMBER_DOWN' && e.kind !== 'LEADER_LOST') continue;
      p = { id: `${key}-${e.id}`, component: key, startedAt: e.at, endedAt: null, steps: [], failoverSeconds: null, state: 'running', down: new Set(), leaderPending: false };
      open.set(key, p);
    }
    const offset = Math.round((+new Date(e.at) - +new Date(p.startedAt)) / 1000);
    let label = e.message;
    if (e.kind === 'MEMBER_DOWN') {
      if (e.member) p.down.add(e.member);
      label = `Phát hiện ${e.member} ngừng trả lời`;
    } else if (e.kind === 'MEMBER_UP') {
      if (e.member) p.down.delete(e.member);
      label = `${e.member} trả lời trở lại${p.state === 'switched' ? ', vào làm dự phòng' : ''}`;
    } else if (e.kind === 'LEADER_LOST') {
      p.leaderPending = true;
      label = `Mất vai trò chính (trước đó ${e.fromValue ?? '?'}), đang bầu lại`;
    } else if (e.kind === 'LEADER_CHANGED') {
      p.leaderPending = false;
      p.state = 'switched';
      p.failoverSeconds = e.seconds ?? offset;
      label = `${e.toValue} lên thay${e.fromValue ? ` ${e.fromValue}` : ''}, phục vụ trở lại`;
    }
    p.steps.push({ at: e.at, label, tone: STEP[e.kind].tone, offset });
    if (p.down.size === 0 && !p.leaderPending) {
      p.state = 'recovered';
      p.endedAt = e.at;
      done.push(p);
      open.delete(key);
    }
  }
  return [...open.values(), ...done].sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
}

const STATE_PILL: Record<Process['state'], { tone: 'danger' | 'warning' | 'success'; label: string }> = {
  running: { tone: 'danger', label: 'Đang xử lý' },
  switched: { tone: 'warning', label: 'Đã chuyển, chờ node cũ trở lại' },
  recovered: { tone: 'success', label: 'Đã phục hồi đầy đủ' },
};

const DOT_TONE: Record<string, string> = {
  danger: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-brand-500',
  success: 'bg-emerald-500',
};

const memberChip = (m: { name: string; status: 'up' | 'down'; primary: boolean; role: string }) => (
  <span
    key={m.name}
    title={m.role}
    className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-md border text-xs font-medium whitespace-nowrap ${
      m.status === 'down'
        ? 'bg-red-50 border-red-200 text-red-700'
        : m.primary
          ? 'bg-brand-50 border-brand-200 text-brand-700'
          : 'bg-card border-slate-200 text-slate-700'
    }`}
  >
    {m.primary ? <Crown className="w-3 h-3" /> : <span className={`w-1.5 h-1.5 rounded-full ${m.status === 'down' ? 'bg-red-500' : 'bg-emerald-500'}`} />}
    {m.name}
  </span>
);

/** Theo dõi chuyển đổi và phục hồi: máy nào sống, ai đang giữ vai trò chính, từng quy trình chuyển đổi theo các bước. */
export const ClusterTab: React.FC = () => {
  const [data, setData] = useState<ClusterMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await searchApi.getClusterMap());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || 'Không đọc được bản đồ cụm');
    }
  }, []);

  useEffect(() => {
    void load();
    if (!auto) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load, auto]);

  const processes = useMemo(() => (data ? buildProcesses(data.events) : []), [data]);
  const machineLabel = useCallback((id: string | null) => data?.machines.find((m) => m.id === id)?.label ?? id ?? '—', [data]);

  if (!data && !error) return <LoadingRows label="Đang đọc trạng thái cụm..." />;

  const comps = data?.components ?? [];
  const leaderComps = comps.filter((c) => c.hasLeaderRole);
  const serviceComps = comps.filter((c) => !c.hasLeaderRole);
  const membersAll = comps.flatMap((c) => c.members);
  const down = membersAll.filter((m) => m.status === 'down').length;
  const running = processes.filter((p) => p.state !== 'recovered').length;
  const lastFailover = processes.find((p) => p.failoverSeconds !== null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Theo dõi chuyển đổi và phục hồi"
        description="Máy nào đang sống, thành phần nào đang giữ vai trò chính ở máy nào, và từng quy trình chuyển node khi có sự cố, theo thời gian thực."
        meta={
          <>
            <span className={`w-2 h-2 rounded-full ${auto ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
            {auto ? `Tự cập nhật mỗi ${data?.pollSeconds ?? 3} giây` : 'Đã tạm dừng cập nhật'}
            {data?.generatedAt && <span className="font-mono">· {fmtTime(data.generatedAt)}</span>}
          </>
        }
        actions={
          <>
            <Button size="sm" onClick={() => setAuto((v) => !v)} icon={auto ? Clock : RefreshCw}>
              {auto ? 'Tạm dừng' : 'Tiếp tục cập nhật'}
            </Button>
            <Button size="sm" onClick={() => void load()} icon={RefreshCw}>
              Làm mới
            </Button>
          </>
        }
      />

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center gap-2">
          <CircleAlert className="w-4 h-4" /> {error}
        </div>
      )}

      {/* Số liệu tổng */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Máy đang sống" value={`${data?.machines.filter((m) => m.status === 'up').length ?? 0}/${data?.machines.length ?? 0}`} icon={Server} />
        <Kpi label="Thành viên không trả lời" value={down} tone={down ? 'danger' : 'default'} icon={CircleAlert} hint={`trên tổng ${membersAll.length} thành viên`} />
        <Kpi label="Quy trình đang diễn ra" value={running} tone={running ? 'warning' : 'default'} icon={Loader2} />
        <Kpi
          label="Lần chuyển gần nhất"
          value={lastFailover?.failoverSeconds != null ? fmtDur(lastFailover.failoverSeconds) : '—'}
          icon={ArrowRight}
          hint={lastFailover ? `${lastFailover.component} · ${fmtTime(lastFailover.startedAt)}` : 'Chưa có chuyển đổi trong 24 giờ'}
        />
      </div>

      {/* Máy */}
      <div className={`grid gap-4 ${data && data.machines.length > 1 ? 'md:grid-cols-3' : ''}`}>
        {data?.machines.map((m) => (
          <div
            key={m.id}
            className={`rounded-xl border shadow-sm p-5 bg-card ${m.status === 'down' ? 'border-red-300 ring-2 ring-red-500/20' : 'border-slate-200'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`w-10 h-10 rounded-lg flex items-center justify-center ${m.status === 'down' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                  <Server className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <div className="text-base font-semibold text-slate-900 truncate">{m.label}</div>
                  <div className="text-xs text-slate-500 font-mono truncate">{m.address ?? m.id}</div>
                </div>
              </div>
              <Pill tone={m.status === 'down' ? 'danger' : 'success'}>
                <span className={`w-1.5 h-1.5 rounded-full ${m.status === 'down' ? 'bg-red-500' : 'bg-emerald-500'}`} />
                {m.status === 'down' ? 'Mất kết nối' : 'Đang sống'}
              </Pill>
            </div>
            {(m.memoryUsedPct !== null || m.cpus !== null) && (
              <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
                {m.memoryUsedPct !== null && (
                  <span className="inline-flex items-center gap-1">
                    <MemoryStick className="w-3.5 h-3.5" /> RAM {m.memoryUsedPct}%
                  </span>
                )}
                {m.cpus !== null && (
                  <span className="inline-flex items-center gap-1">
                    <Cpu className="w-3.5 h-3.5" /> {m.cpus} luồng
                  </span>
                )}
              </div>
            )}
            <div className="mt-4">
              <div className="text-xs font-medium text-slate-500 mb-1.5">Đang giữ vai trò chính</div>
              <div className="flex flex-wrap gap-1.5">
                {m.leaders.length ? m.leaders.map((l) => <Pill key={l} tone="info">{l}</Pill>) : <span className="text-xs text-slate-400">Không giữ vai trò chính nào</span>}
              </div>
            </div>
            <div className="mt-3">
              <div className="text-xs font-medium text-slate-500 mb-1.5">
                Thành viên ({m.members.filter((x) => x.status === 'up').length}/{m.members.length} sống)
              </div>
              <div className="flex flex-wrap gap-1.5">{m.members.map((x) => memberChip(x))}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid xl:grid-cols-5 gap-5">
        {/* Ai đang giữ vai trò chính */}
        <Panel title="Ai đang giữ vai trò chính" note="Khi một thành viên chết, cột này đổi sang thành viên lên thay" className="xl:col-span-3">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Thành phần</Th>
                <Th>Vai trò chính</Th>
                <Th>Ở máy</Th>
                <Th>Thành viên</Th>
              </tr>
            </thead>
            <tbody>
              {leaderComps.map((c: ClusterComponent) => (
                <tr key={c.key} className={ROW}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <StatusDot tone={c.status === 'ok' ? 'success' : c.status === 'warn' ? 'warning' : 'danger'} />
                      <span className="font-medium text-slate-900">{c.label}</span>
                    </div>
                  </Td>
                  <Td>
                    {c.leader ? (
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-brand-700">
                        <Crown className="w-3.5 h-3.5" /> {c.leader}
                      </span>
                    ) : (
                      <Pill tone="danger">Không có</Pill>
                    )}
                  </Td>
                  <Td className="text-xs">{c.leaderMachine ? machineLabel(c.leaderMachine) : '—'}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1 py-1.5">{c.members.map((m) => memberChip(m))}</div>
                  </Td>
                </tr>
              ))}
              {serviceComps.map((c) => (
                <tr key={c.key} className={ROW}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <StatusDot tone={c.status === 'ok' ? 'success' : c.status === 'warn' ? 'warning' : 'danger'} />
                      <span className="font-medium text-slate-900">{c.label}</span>
                    </div>
                  </Td>
                  <Td className="text-xs text-slate-500">Mọi bản cùng phục vụ</Td>
                  <Td className="text-xs">—</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1 py-1.5">{c.members.map((m) => memberChip(m))}</div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Quy trình chuyển đổi */}
        <Panel title="Quy trình chuyển đổi và phục hồi" note="Mỗi sự cố gồm các bước, thời gian tính từ lúc phát hiện" className="xl:col-span-2">
          {processes.length === 0 ? (
            <EmptyState
              title="Chưa có sự cố nào trong 24 giờ"
              hint="Khi một node, CSDL hay máy chết, quy trình phát hiện, chuyển vai trò chính và phục hồi sẽ hiện ở đây theo từng bước."
            />
          ) : (
            <div className="px-5 pb-5 space-y-4 max-h-[640px] overflow-y-auto">
              {processes.slice(0, 15).map((p) => (
                <div key={p.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate">{p.component}</div>
                      <div className="text-xs text-slate-500 font-mono">
                        {fmtTime(p.startedAt)}
                        {p.endedAt && ` → ${fmtTime(p.endedAt)} · tổng ${fmtDur(Math.round((+new Date(p.endedAt) - +new Date(p.startedAt)) / 1000))}`}
                      </div>
                    </div>
                    <Pill tone={STATE_PILL[p.state].tone}>
                      {p.state === 'recovered' ? <CheckCircle2 className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
                      {STATE_PILL[p.state].label}
                    </Pill>
                  </div>
                  <ol className="mt-3 relative border-l border-slate-200 ml-1.5 space-y-2.5">
                    {p.steps.map((s, i) => (
                      <li key={i} className="pl-4 relative">
                        <span className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-card ${DOT_TONE[s.tone]}`} />
                        <div className="text-sm text-slate-800">{s.label}</div>
                        <div className="text-xs text-slate-500 font-mono">
                          {fmtTime(s.at)} · +{s.offset}s
                        </div>
                      </li>
                    ))}
                  </ol>
                  {p.failoverSeconds !== null && (
                    <div className="mt-3 text-xs text-slate-600">
                      Thời gian không có vai trò chính: <span className="font-semibold text-slate-900">{fmtDur(p.failoverSeconds)}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* Nhật ký diễn biến */}
      <Panel title="Nhật ký diễn biến" note={`${data?.events.length ?? 0} sự kiện trong 24 giờ · bản trả lời: ${data?.answeredBy ?? '?'}`}>
        {data && data.events.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr>
                <Th className="w-28">Thời điểm</Th>
                <Th className="w-36">Loại</Th>
                <Th>Diễn biến</Th>
                <Th className="w-36">Máy</Th>
              </tr>
            </thead>
            <tbody>
              {data.events.slice(0, 60).map((e) => (
                <tr key={e.id} className={ROW}>
                  <Td className="font-mono text-xs">{fmtTime(e.at)}</Td>
                  <Td>
                    <Pill tone={STEP[e.kind].tone}>
                      {
                        {
                          MACHINE_DOWN: 'Máy mất kết nối',
                          MACHINE_UP: 'Máy trở lại',
                          MEMBER_DOWN: 'Ngừng trả lời',
                          MEMBER_UP: 'Trở lại',
                          LEADER_LOST: 'Mất vai trò chính',
                          LEADER_CHANGED: 'Lên thay',
                        }[e.kind]
                      }
                    </Pill>
                  </Td>
                  <Td>{e.message}</Td>
                  <Td className="text-xs">{e.machine ? machineLabel(e.machine) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="Chưa có diễn biến" hint="Trang ghi nhận mọi lần thành viên ngừng trả lời, trở lại, hay đổi vai trò chính." />
        )}
      </Panel>
    </div>
  );
};
