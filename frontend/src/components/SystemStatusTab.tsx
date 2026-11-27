import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, CircleSlash, Pause, Play, RefreshCw, XCircle } from 'lucide-react';
import { searchApi } from '../services/api';
import { BucketStatus, ComponentStatus, NodeLifecycle, SystemDepartment, SystemHealth, SystemIncident } from '../types';
import { DeptBadge, IconButton, Kpi, Button, Panel, Pill, ROW, StatusDot, Td, Th } from './ui';
import type { Tone } from './ui';

const REFRESH_MS = 5000;

// ---------------------------------------------------------------- định dạng
const fmtClock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('vi-VN') : '—');
const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export const fmtDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút ${s % 60} giây`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ ${m % 60} phút`;
  return `${Math.floor(h / 24)} ngày ${h % 24} giờ`;
};

// ---------------------------------------------------------------- nhãn và màu trạng thái
const LIFECYCLE: Record<NodeLifecycle, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'HOẠT ĐỘNG', tone: 'success' },
  DEGRADED: { label: 'MẤT KẾT NỐI', tone: 'danger' },
  DRAINING: { label: 'ĐÃ DỪNG', tone: 'warning' },
  PROVISIONING: { label: 'ĐANG KHỞI TẠO', tone: 'info' },
  RETIRED: { label: 'ĐÃ GỠ', tone: 'neutral' },
};

const BUCKET: Record<BucketStatus, { color: string; label: string }> = {
  up: { color: 'bg-emerald-500', label: 'Hoạt động' },
  down: { color: 'bg-red-500', label: 'Mất kết nối' },
  maintenance: { color: 'bg-amber-400', label: 'Dừng có kế hoạch' },
  pending: { color: 'bg-blue-300', label: 'Đang khởi tạo' },
  nodata: { color: 'bg-slate-200', label: 'Chưa theo dõi' },
};

const COMPONENT: Record<ComponentStatus, { label: string; tone: Tone; text: string }> = {
  ok: { label: 'Bình thường', tone: 'success', text: 'text-emerald-700' },
  warn: { label: 'Cần chú ý', tone: 'warning', text: 'text-amber-700' },
  down: { label: 'Ngừng hoạt động', tone: 'danger', text: 'text-red-700' },
  unknown: { label: 'Không rõ', tone: 'neutral', text: 'text-slate-500' },
};

const OVERALL = {
  operational: { title: 'Mọi hệ thống hoạt động bình thường', bar: 'bg-emerald-500', tone: 'text-emerald-800', Icon: CheckCircle2 },
  degraded: { title: 'Hệ thống đang suy giảm một phần', bar: 'bg-amber-500', tone: 'text-amber-800', Icon: AlertTriangle },
  outage: { title: 'Gián đoạn nghiêm trọng', bar: 'bg-red-500', tone: 'text-red-800', Icon: XCircle },
} as const;

// ---------------------------------------------------------------- thành phần con
/** Thanh lịch sử 24 giờ: mỗi ô 30 phút, ô nào có sập thì đỏ. */
const UptimeBar: React.FC<{ dept: SystemDepartment; generatedAt: string }> = ({ dept, generatedAt }) => {
  const end = new Date(generatedAt).getTime();
  const size = dept.bucketMinutes * 60000;
  const start = end - dept.buckets.length * size;
  return (
    <div className="flex items-center gap-px h-5" role="img" aria-label={`Lịch sử 24 giờ của phòng ${dept.code}`}>
      {dept.buckets.map((b, i) => {
        const a = new Date(start + i * size);
        const z = new Date(start + (i + 1) * size);
        const range = `${a.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} – ${z.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
        return <span key={i} title={`${range}: ${BUCKET[b].label}`} className={`flex-1 min-w-[3px] h-full rounded-sm ${BUCKET[b].color}`} />;
      })}
    </div>
  );
};

const IncidentRow: React.FC<{ inc: SystemIncident; nowMs: number }> = ({ inc, nowMs }) => {
  const live = inc.ongoing ? Math.round((nowMs - new Date(inc.startedAt).getTime()) / 1000) : inc.durationSeconds;
  return (
    <tr className={ROW}>
      <Td className="pl-4">
        <Pill tone={inc.ongoing ? 'danger' : 'success'}>{inc.ongoing ? 'ĐANG DIỄN RA' : 'ĐÃ PHỤC HỒI'}</Pill>
      </Td>
      <Td>
        <DeptBadge code={inc.deptCode} />
      </Td>
      <Td className="whitespace-nowrap">{inc.kind === 'UNPLANNED' ? 'Sập ngoài ý muốn' : 'Dừng có kế hoạch'}</Td>
      <Td className="max-w-[280px] text-slate-600">
        <span className="block truncate" title={inc.reason ?? ''}>
          {inc.reason || '—'}
        </span>
      </Td>
      <Td className="font-mono text-micro text-slate-600 whitespace-nowrap">{fmtDateTime(inc.startedAt)}</Td>
      <Td className="font-mono text-micro text-slate-600 whitespace-nowrap">{inc.ongoing ? '—' : fmtDateTime(inc.resolvedAt)}</Td>
      <Td className={`pr-4 text-right font-mono text-micro whitespace-nowrap ${inc.ongoing ? 'text-red-700 font-semibold' : 'text-slate-700'}`}>
        {fmtDuration(live)}
      </Td>
    </tr>
  );
};

// ---------------------------------------------------------------- trang chính
export const SystemStatusTab: React.FC = () => {
  const [data, setData] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      setData(await searchApi.getSystemHealth());
      setError(null);
    } catch (e: any) {
      // Không xóa dữ liệu cũ: vẫn hiện lần đọc gần nhất kèm cảnh báo mất kết nối
      setError(e.response?.data?.message || e.message || 'Không đọc được trạng thái hệ thống');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [paused, load]);

  // Chuông thông báo nhận NODE_DOWN / NODE_RECOVERED qua SSE: làm mới ngay, không chờ chu kỳ
  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener('dms:node-status-changed', onChange);
    return () => window.removeEventListener('dms:node-status-changed', onChange);
  }, [load]);

  // Đồng hồ cho các thời lượng "đang diễn ra"
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!data) {
    return (
      <Panel>
        <div className="p-10 text-center text-data text-slate-500">
          {error ? <span className="font-semibold text-red-700">{error}</span> : 'Đang đọc trạng thái hệ thống...'}
        </div>
      </Panel>
    );
  }

  const o = OVERALL[data.overall];
  const down = data.departments.filter((d) => d.lifecycle !== 'ACTIVE');
  const subtitle =
    data.overall === 'operational'
      ? `${data.summary.departmentsUp}/${data.summary.departmentsTotal} node phòng ban đang phục vụ, các thành phần nền tảng bình thường.`
      : down.length > 0
        ? `Phòng ${down.map((d) => d.code).join(', ')} không phục vụ trực tiếp. Tìm kiếm cho ${down.length > 1 ? 'các phòng này' : 'phòng này'} đang lấy từ chỉ mục trung tâm.`
        : `Có thành phần nền tảng cần chú ý: ${data.components.filter((c) => c.status !== 'ok').map((c) => c.name).join('; ')}.`;

  const groups = Array.from(new Set(data.components.map((c) => c.group)));
  const firing = data.alerts ?? [];

  return (
    <div className="space-y-4">
      {/* 1. Dải trạng thái tổng */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden flex">
        <div className={`w-1 shrink-0 ${o.bar}`} />
        <div className="flex-1 px-4 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <o.Icon className={`w-5 h-5 shrink-0 mt-0.5 ${o.tone}`} />
            <div className="min-w-0">
              <h1 className={`text-base font-semibold ${o.tone}`}>{o.title}</h1>
              <p className="text-data text-slate-600 mt-0.5">{subtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="text-right leading-tight mr-1">
              <div className="text-micro font-semibold uppercase tracking-wider text-slate-500">Cập nhật lúc</div>
              <div className="font-mono text-data text-slate-800">{fmtClock(data.generatedAt)}</div>
            </div>
            <Button
              icon={paused ? Play : Pause}
              onClick={() => setPaused(!paused)}
              title={paused ? 'Tiếp tục tự làm mới' : 'Tạm dừng tự làm mới'}
            >
              {paused ? 'Tiếp tục' : `Tự làm mới ${REFRESH_MS / 1000} giây`}
            </Button>
            <IconButton title="Làm mới ngay" aria-label="Làm mới ngay" onClick={() => void load()}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </IconButton>
          </div>
        </div>
      </section>

      {data.centralDbDown && (
        <div className="px-3.5 py-2 rounded-md border border-blue-200 bg-blue-50 text-data text-blue-900">
          <strong>CSDL chỉ mục trung tâm không đọc được.</strong> Tìm kiếm liên phòng vẫn chạy bằng bản chụp danh bạ và quyền chia sẻ; bảng node, lịch sử và nhật ký sự cố
          tạm thời trống vì chúng lưu ở trung tâm, sẽ hiện lại khi trung tâm trở lại.
        </div>
      )}

      {error && (
        <div className="px-3.5 py-2 rounded-md border border-red-200 bg-red-50 text-data text-red-800">
          <strong>Mất kết nối tới dịch vụ giám sát:</strong> {error}. Đang hiển thị lần đọc gần nhất ({fmtClock(data.generatedAt)}).
        </div>
      )}

      {/* 2. Chỉ số nhanh */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi
          label="Node phòng ban đang sống"
          value={`${data.summary.departmentsUp}/${data.summary.departmentsTotal}`}
          tone={data.summary.departmentsUp < data.summary.departmentsTotal ? 'danger' : 'default'}
        />
        <Kpi label="Sự cố đang diễn ra" value={String(data.summary.ongoingIncidents)} tone={data.summary.ongoingIncidents > 0 ? 'danger' : 'default'} />
        <Kpi label="Sự cố trong 24 giờ" value={String(data.summary.incidents24h)} />
        <Kpi
          label="Cảnh báo đang bật"
          value={data.alerts === null ? '—' : String(firing.length)}
          tone={firing.length > 0 ? 'warning' : 'default'}
        />
      </section>

      {/* 3. Node phòng ban */}
      <Panel
        title="Node phòng ban"
        note={
          <span className="flex items-center gap-3">
            {(['up', 'down', 'maintenance', 'nodata'] as BucketStatus[]).map((b) => (
              <span key={b} className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-sm ${BUCKET[b].color}`} />
                {BUCKET[b].label}
              </span>
            ))}
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className="pl-4">Trạng thái</Th>
                <Th>Phòng ban</Th>
                <Th>Nhịp tim</Th>
                <Th className="w-[30%]">Lịch sử 24 giờ (mỗi ô 30 phút)</Th>
                <Th className="text-right">Sẵn sàng</Th>
                <Th className="text-right">Gián đoạn 24 giờ</Th>
                <Th className="text-right">p95 tìm kiếm</Th>
                <Th className="text-right">Dự phòng 15 phút</Th>
                <Th className="pr-4 text-right">Tài liệu</Th>
              </tr>
            </thead>
            <tbody>
              {data.departments.map((d) => {
                const lc = LIFECYCLE[d.lifecycle];
                const isDown = d.lifecycle !== 'ACTIVE';
                const since = d.stateSince ? Math.round((nowMs - new Date(d.stateSince).getTime()) / 1000) : null;
                const outage = d.downSeconds + d.maintenanceSeconds;
                return (
                  <tr key={d.code} className={`${ROW} ${isDown ? 'bg-red-50/40' : ''}`}>
                    <Td className="pl-4 whitespace-nowrap">
                      <Pill tone={lc.tone}>{lc.label}</Pill>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2 min-w-0">
                        <DeptBadge code={d.code} />
                        <span className="text-data font-semibold text-slate-900 truncate">{d.name}</span>
                      </div>
                      {isDown && since !== null && (
                        <div className="text-micro text-red-700 truncate">
                          {d.stateReason || 'Không phục vụ'} · từ {fmtClock(d.stateSince)} ({fmtDuration(since)})
                        </div>
                      )}
                    </Td>
                    <Td className="font-mono text-micro whitespace-nowrap">
                      {d.heartbeatAgeSeconds === null ? (
                        <span className="text-slate-400">chưa có</span>
                      ) : (
                        <span className={d.heartbeatAgeSeconds > 30 ? 'text-red-700 font-semibold' : 'text-slate-600'}>
                          {fmtDuration(d.heartbeatAgeSeconds)} trước
                        </span>
                      )}
                    </Td>
                    <Td>
                      <UptimeBar dept={d} generatedAt={data.generatedAt} />
                    </Td>
                    <Td className="font-mono text-micro text-right whitespace-nowrap">
                      {d.availabilityPct === null ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <span
                          className={
                            d.availabilityPct >= 99.9 ? 'text-emerald-700 font-semibold' : d.availabilityPct >= 99 ? 'text-amber-700 font-semibold' : 'text-red-700 font-semibold'
                          }
                        >
                          {d.availabilityPct.toFixed(2)}%
                        </span>
                      )}
                    </Td>
                    <Td className={`font-mono text-micro text-right whitespace-nowrap ${outage > 0 ? 'text-slate-900' : 'text-slate-400'}`}>
                      {outage > 0 ? fmtDuration(outage) : '0'}
                    </Td>
                    <Td className="font-mono text-micro text-right text-slate-600 whitespace-nowrap">
                      {d.searchP95Ms === null ? <span className="text-slate-400">—</span> : `${d.searchP95Ms} ms`}
                    </Td>
                    <Td className={`font-mono text-micro text-right ${d.fallbacks15m ? 'text-amber-700 font-semibold' : 'text-slate-400'}`}>
                      {d.fallbacks15m === null ? '—' : d.fallbacks15m}
                    </Td>
                    <Td className="pr-4 font-mono text-micro text-right text-slate-600">{d.documents}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-3.5 py-2 border-t border-slate-200 text-micro text-slate-500">
          Node gửi nhịp tim 10 giây một lần. Quá 30 giây không có nhịp tim thì Registry đánh dấu <strong>mất kết nối</strong>; node tắt có trật tự thì tự báo{' '}
          <strong>đã dừng</strong> ngay. Tỉ lệ sẵn sàng tính trên khoảng thời gian đã theo dõi; dừng có kế hoạch cũng tính là không sẵn sàng.
        </div>
      </Panel>

      {/* 4. Thành phần nền tảng và cảnh báo */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel
          title="Thành phần nền tảng"
          className="xl:col-span-2"
          note={
            <span className="font-mono">
              Prometheus: {data.sources.prometheus ? 'đọc được' : 'không truy cập được'} · Kafka Connect:{' '}
              {data.sources.kafkaConnect ? 'đọc được' : 'không truy cập được'}
            </span>
          }
        >
          <table className="w-full border-collapse">
            <tbody>
              {groups.map((g) => (
                <React.Fragment key={g}>
                  <tr className="bg-slate-50/70 border-b border-slate-100">
                    <td colSpan={3} className="px-3.5 h-8 text-micro font-semibold uppercase tracking-wider text-slate-500">
                      {g}
                    </td>
                  </tr>
                  {data.components
                    .filter((c) => c.group === g)
                    .map((c) => {
                      const cs = COMPONENT[c.status];
                      return (
                        <tr key={c.key} className={ROW}>
                          <td className="px-3.5 w-36 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1.5 text-data font-medium ${cs.text}`}>
                              <StatusDot tone={cs.tone} />
                              {cs.label}
                            </span>
                          </td>
                          <td className="px-3.5 text-data font-semibold text-slate-900 whitespace-nowrap">{c.name}</td>
                          <td className="px-3.5 font-mono text-micro text-slate-600">{c.detail}</td>
                        </tr>
                      );
                    })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Cảnh báo đang bật" note={<span className="font-mono">Prometheus</span>}>
          {data.alerts === null ? (
            <div className="p-4 text-data text-slate-500 flex items-center gap-2">
              <CircleSlash className="w-4 h-4 text-slate-400" /> Không truy vấn được Prometheus.
            </div>
          ) : firing.length === 0 ? (
            <div className="p-4 text-data text-slate-500 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Không có cảnh báo nào đang bật.
            </div>
          ) : (
            <ul>
              {firing.map((a, i) => (
                <li key={`${a.name}-${i}`} className="px-3.5 py-2.5 border-b border-slate-100 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Pill tone={a.severity === 'critical' ? 'danger' : 'warning'}>{a.severity === 'critical' ? 'Nghiêm trọng' : 'Cảnh báo'}</Pill>
                    <span className="font-mono text-micro font-semibold text-slate-900 truncate">{a.name}</span>
                    <span className="ml-auto font-mono text-micro text-slate-500 shrink-0">{fmtClock(a.since)}</span>
                  </div>
                  <div className="text-data text-slate-600 mt-1">{a.summary}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* 5. Nhật ký sự cố */}
      <Panel
        title="Nhật ký sự cố"
        note={`${data.window.historyDays} ngày gần nhất · sự cố là khoảng thời gian node không ở trạng thái hoạt động`}
      >
        {data.incidents.length === 0 ? (
          <div className="p-6 text-data text-slate-500 text-center">Chưa ghi nhận sự cố nào trong {data.window.historyDays} ngày qua.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th className="pl-4">Tình trạng</Th>
                  <Th>Node</Th>
                  <Th>Loại</Th>
                  <Th>Nguyên nhân ghi nhận</Th>
                  <Th>Bắt đầu</Th>
                  <Th>Phục hồi</Th>
                  <Th className="pr-4 text-right">Thời lượng</Th>
                </tr>
              </thead>
              <tbody>
                {data.incidents.map((inc) => (
                  <IncidentRow key={inc.id} inc={inc} nowMs={nowMs} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* 6. Dòng sự kiện vòng đời (dữ liệu gốc của bảng sự cố) */}
      <Panel title="Dòng sự kiện vòng đời" note="Do Registry ghi mỗi khi một node đổi trạng thái">
        <ul className="max-h-64 overflow-y-auto">
          {data.events.map((e) => (
            <li key={e.id} className="px-3.5 h-9 border-b border-slate-100 last:border-0 flex items-center gap-3 text-data">
              <Activity className="w-3.5 h-3.5 text-slate-300 shrink-0" />
              <span className="font-mono text-micro text-slate-500 w-36 shrink-0">{fmtDateTime(e.at)}</span>
              <DeptBadge code={e.deptCode} />
              <span className="font-mono text-micro text-slate-600 shrink-0">
                {e.from ?? '∅'} →{' '}
                <span className={`font-semibold ${e.to === 'ACTIVE' ? 'text-emerald-700' : e.to === 'DEGRADED' ? 'text-red-700' : 'text-amber-700'}`}>{e.to}</span>
              </span>
              <span className="text-slate-500 truncate">{e.reason}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
};
