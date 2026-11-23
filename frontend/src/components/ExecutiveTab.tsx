import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, UploadCloud } from 'lucide-react';
import { searchApi } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useDepartments } from '../context/DepartmentContext';
import { AccessRequestItem, AuditStreamItem, ExecutiveStats } from '../types';
import { UploadModal } from './UploadModal';
import {
  Bar,
  Button,
  DeptBadge,
  DocStatusPill,
  EmptyState,
  Kpi,
  LoadingRows,
  PageHeader,
  Panel,
  PermissionPill,
  Pill,
  ROW,
  SELECT,
  Td,
  Th,
  daysUntil,
  fmtDateTime,
  fmtNumber,
  mimeLabel,
} from './ui';

interface ActiveShare {
  central_doc_id: number | string;
  title: string;
  shared_by_dept: string;
  shared_with_dept: string;
  permission: string;
  created_at: string;
  expires_at: string | null;
}

const EVENT_LABEL: Record<string, { label: string; tone: 'success' | 'info' | 'danger' }> = {
  INSERT: { label: 'TẠO MỚI', tone: 'success' },
  UPDATE: { label: 'CẬP NHẬT', tone: 'info' },
  DELETE: { label: 'XÓA', tone: 'danger' },
};

const SYNC_STATUS: Record<string, { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  DONE: { label: 'ĐÃ ÁP', tone: 'success' },
  SKIPPED: { label: 'TRÙNG, BỎ QUA', tone: 'neutral' },
  DLQ: { label: 'LỖI (DLQ)', tone: 'danger' },
  FAILED: { label: 'LỖI', tone: 'danger' },
};

/**
 * Báo cáo điều hành cho Ban Giám đốc: số liệu NGHIỆP VỤ toàn doanh nghiệp, đọc từ chỉ mục trung tâm.
 * Tình trạng hạ tầng (node sống/sập, sự cố) nằm ở màn hình "Giám sát hệ thống".
 */
export const ExecutiveTab: React.FC = () => {
  const toast = useToast();
  const { departments } = useDepartments();
  const [stats, setStats] = useState<ExecutiveStats | null>(null);
  const [events, setEvents] = useState<AuditStreamItem[]>([]);
  const [fileTypes, setFileTypes] = useState<Array<{ mime_type: string; count: string | number }>>([]);
  const [shares, setShares] = useState<ActiveShare[]>([]);
  const [requests, setRequests] = useState<AccessRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, audit, analytics, reqs] = await Promise.all([
        searchApi.getExecutiveDashboard(),
        searchApi.getAuditStream(80),
        searchApi.getAnalytics(),
        searchApi.getAccessRequests().catch(() => [] as AccessRequestItem[]),
      ]);
      setStats(dash);
      setEvents(audit.events || []);
      setFileTypes(analytics.fileTypes || []);
      setShares((analytics.activeShares || []) as ActiveShare[]);
      setRequests(reqs || []);
      setLoadedAt(new Date());
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Không tải được báo cáo điều hành', 'Lỗi tải dữ liệu');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deptRows = useMemo(
    () =>
      (stats?.departments || []).map((d) => ({
        code: d.dept_code,
        name: d.dept_name,
        docs: Number(d.active_documents || 0),
        lastSynced: d.last_synced_at ?? null,
      })),
    [stats],
  );
  const totalDocs = stats?.overview?.totalActiveDocuments ?? deptRows.reduce((s, d) => s + d.docs, 0);
  const maxDocs = Math.max(1, ...deptRows.map((d) => d.docs));

  const statusRows = (stats?.documentStatusBreakdown || []).map((s) => ({ status: s.status, count: Number(s.count) })).filter((s) => s.status !== 'DELETED');
  const statusTotal = Math.max(1, statusRows.reduce((s, r) => s + r.count, 0));
  const typeRows = fileTypes.map((f) => ({ label: mimeLabel(f.mime_type), mime: f.mime_type, count: Number(f.count) }));
  const typeTotal = Math.max(1, typeRows.reduce((s, r) => s + r.count, 0));

  const sharing = stats?.crossDepartmentSharing;
  const sync = stats?.cdcPipelineHealth as (ExecutiveStats['cdcPipelineHealth'] & { skipped_events?: string | number }) | undefined;
  const pending = requests.filter((r) => r.status === 'PENDING');
  const failed = Number(sync?.failed_events || 0);

  const filteredEvents = events.filter(
    (e) => (deptFilter === 'ALL' || e.dept_code === deptFilter) && (typeFilter === 'ALL' || e.event_type === typeFilter),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Báo cáo điều hành"
        description="Số liệu tài liệu, chia sẻ liên phòng ban và đồng bộ trên toàn doanh nghiệp, tổng hợp từ chỉ mục trung tâm."
        actions={
          <>
            {loadedAt && <span className="text-[11px] text-slate-500 font-mono">Số liệu lúc {loadedAt.toLocaleTimeString('vi-VN')}</span>}
            <Button icon={RefreshCw} onClick={() => void load()} disabled={loading}>
              Làm mới
            </Button>
            <Button variant="primary" icon={UploadCloud} onClick={() => setUploadOpen(true)}>
              Ban hành văn bản toàn công ty
            </Button>
          </>
        }
      />

      {/* Chỉ số chính */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Tài liệu đang lưu hành" value={fmtNumber(totalDocs)} hint={`${deptRows.length} phòng ban`} />
        <Kpi
          label="Chia sẻ đang hiệu lực"
          value={fmtNumber(sharing?.active_shares)}
          hint={`trên ${fmtNumber(sharing?.total_shares_created)} lượt đã cấp · ${fmtNumber(sharing?.expired_or_revoked_shares)} đã hết hạn/thu hồi`}
        />
        <Kpi
          label="Yêu cầu xin quyền chờ duyệt"
          value={fmtNumber(pending.length)}
          tone={pending.length > 0 ? 'warning' : 'default'}
          hint={pending.length > 0 ? `Phòng cần duyệt: ${Array.from(new Set(pending.map((p) => p.target_dept))).join(', ')}` : 'Không có yêu cầu tồn'}
        />
        <Kpi
          label="Sự kiện đồng bộ lỗi"
          value={fmtNumber(failed)}
          tone={failed > 0 ? 'danger' : 'default'}
          hint={`${fmtNumber(sync?.successful_events)} đã áp · ${fmtNumber(sync?.skipped_events)} trùng bị bỏ qua`}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Tài liệu theo phòng ban */}
        <Panel title="Tài liệu theo phòng ban" note="Mỗi phòng ban lưu dữ liệu ở node riêng" className="xl:col-span-2">
          {loading && !stats ? (
            <LoadingRows />
          ) : deptRows.length === 0 ? (
            <EmptyState title="Chưa có phòng ban nào" />
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <Th>Phòng ban</Th>
                  <Th className="text-right">Tài liệu</Th>
                  <Th className="w-[38%]">Tỉ trọng</Th>
                  <Th className="text-right">Đồng bộ gần nhất</Th>
                </tr>
              </thead>
              <tbody>
                {deptRows.map((d) => (
                  <tr key={d.code} className={ROW}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <DeptBadge code={d.code} />
                        <span className="font-semibold text-slate-900">{d.name}</span>
                      </span>
                    </Td>
                    <Td className="text-right font-mono text-slate-900">{fmtNumber(d.docs)}</Td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <Bar value={d.docs} max={maxDocs} />
                        <span className="font-mono text-[11px] text-slate-500 w-10 text-right shrink-0">
                          {totalDocs > 0 ? Math.round((d.docs / totalDocs) * 100) : 0}%
                        </span>
                      </span>
                    </Td>
                    <Td className="text-right font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(d.lastSynced)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {/* Cơ cấu */}
        <div className="space-y-4">
          <Panel title="Trạng thái tài liệu">
            <div className="p-3.5 space-y-2.5">
              {statusRows.length === 0 && <div className="text-xs text-slate-500">Chưa có dữ liệu.</div>}
              {statusRows.map((s) => (
                <div key={s.status}>
                  <div className="flex items-center justify-between mb-1">
                    <DocStatusPill status={s.status} />
                    <span className="font-mono text-xs text-slate-700">
                      {fmtNumber(s.count)} <span className="text-slate-400">({Math.round((s.count / statusTotal) * 100)}%)</span>
                    </span>
                  </div>
                  <Bar value={s.count} max={statusTotal} className={s.status === 'PUBLISHED' ? 'bg-emerald-600' : s.status === 'DRAFT' ? 'bg-amber-500' : 'bg-slate-400'} />
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Định dạng tệp">
            <div className="p-3.5 space-y-2.5">
              {typeRows.length === 0 && <div className="text-xs text-slate-500">Chưa có dữ liệu.</div>}
              {typeRows.slice(0, 6).map((t) => (
                <div key={t.mime}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-slate-800" title={t.mime}>
                      {t.label}
                    </span>
                    <span className="font-mono text-xs text-slate-700">
                      {fmtNumber(t.count)} <span className="text-slate-400">({Math.round((t.count / typeTotal) * 100)}%)</span>
                    </span>
                  </div>
                  <Bar value={t.count} max={typeTotal} />
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      {/* Chia sẻ đang hiệu lực */}
      <Panel title="Chia sẻ liên phòng ban đang hiệu lực" note="10 lượt mới nhất">
        {shares.length === 0 ? (
          <EmptyState title="Không có chia sẻ nào đang hiệu lực" hint="Trưởng phòng chia sẻ tài liệu hoặc duyệt yêu cầu xin quyền thì lượt chia sẻ sẽ hiện ở đây." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <Th>Tài liệu</Th>
                  <Th>Từ</Th>
                  <Th>Đến</Th>
                  <Th>Quyền</Th>
                  <Th>Cấp lúc</Th>
                  <Th className="text-right">Còn hiệu lực</Th>
                </tr>
              </thead>
              <tbody>
                {shares.map((s, i) => {
                  const left = daysUntil(s.expires_at);
                  return (
                    <tr key={`${s.central_doc_id}-${i}`} className={ROW}>
                      <Td>
                        <span className="font-mono text-[11px] text-slate-400 mr-2">#{s.central_doc_id}</span>
                        <span className="font-semibold text-slate-900">{s.title}</span>
                      </Td>
                      <Td>
                        <DeptBadge code={s.shared_by_dept} />
                      </Td>
                      <Td>
                        <DeptBadge code={s.shared_with_dept} />
                      </Td>
                      <Td>
                        <PermissionPill permission={s.permission} />
                      </Td>
                      <Td className="font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(s.created_at)}</Td>
                      <Td className={`text-right font-mono whitespace-nowrap ${left !== null && left <= 2 ? 'text-amber-700 font-bold' : 'text-slate-600'}`}>
                        {left === null ? 'Không thời hạn' : `${left} ngày`}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Dòng sự kiện đồng bộ */}
      <Panel
        title="Dòng sự kiện đồng bộ"
        note="Mỗi thay đổi tài liệu ở node được phát qua Outbox và Kafka về chỉ mục trung tâm"
        actions={
          <>
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className={SELECT} aria-label="Lọc theo phòng ban">
              <option value="ALL">Mọi phòng ban</option>
              {departments.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={SELECT} aria-label="Lọc theo thao tác">
              <option value="ALL">Mọi thao tác</option>
              <option value="INSERT">Tạo mới</option>
              <option value="UPDATE">Cập nhật</option>
              <option value="DELETE">Xóa</option>
            </select>
          </>
        }
      >
        {loading && events.length === 0 ? (
          <LoadingRows />
        ) : filteredEvents.length === 0 ? (
          <EmptyState title="Không có sự kiện nào khớp bộ lọc" />
        ) : (
          <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-200">
                  <Th>Thời điểm</Th>
                  <Th>Phòng ban</Th>
                  <Th>Thao tác</Th>
                  <Th>Tài liệu</Th>
                  <Th>Người sở hữu</Th>
                  <Th className="text-right">Kết quả đồng bộ</Th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((e) => {
                  const ev = EVENT_LABEL[e.event_type ?? ''] ?? { label: e.event_type ?? '—', tone: 'info' as const };
                  const st = SYNC_STATUS[e.process_status ?? ''] ?? { label: e.process_status ?? '—', tone: 'neutral' as const };
                  return (
                    <tr key={e.event_id} className={ROW}>
                      <Td className="font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(e.received_at)}</Td>
                      <Td>
                        <DeptBadge code={e.dept_code} />
                      </Td>
                      <Td>
                        <Pill tone={ev.tone}>{ev.label}</Pill>
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] text-slate-400 mr-2">#DOC-{e.source_doc_id ?? '—'}</span>
                        <span className="font-semibold text-slate-900">{e.document_title}</span>
                      </Td>
                      <Td className="text-slate-600">{e.actor || '—'}</Td>
                      <Td className="text-right">
                        <Pill tone={st.tone}>{st.label}</Pill>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {uploadOpen && (
        <UploadModal
          isOpen={uploadOpen}
          onClose={() => setUploadOpen(false)}
          onSuccess={() => {
            setUploadOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
};
