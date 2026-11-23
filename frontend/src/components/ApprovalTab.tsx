import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Eye, RefreshCw, Send, ShieldOff, Trash2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { deptName } from '../context/DepartmentContext';
import { documentApi, searchApi } from '../services/api';
import { AccessRequestItem, DocumentItem, SharedDocumentItem } from '../types';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';
import { RequestAccessModal } from './RequestAccessModal';
import {
  AccessPill,
  Button,
  DeptBadge,
  EmptyState,
  LoadingRows,
  PageHeader,
  Panel,
  PermissionPill,
  Pill,
  RequestStatusPill,
  ROW,
  Td,
  Th,
  daysUntil,
  fmtDateTime,
} from './ui';

type View = 'drafts' | 'incoming' | 'outgoing' | 'shares';

/**
 * Trung tâm phê duyệt (Trưởng phòng và Ban Giám đốc).
 *  - Bản nháp nội bộ: nhân viên lập, Trưởng phòng ký ban hành hoặc trả lại.
 *  - Yêu cầu đến: phòng khác xin quyền xem/tải tài liệu của phòng mình. Người duyệt chọn mức quyền cấp.
 *  - Yêu cầu đã gửi: phòng mình xin tài liệu của phòng khác, theo dõi kết quả.
 *  - Đang chia sẻ: lượt chia sẻ còn hiệu lực, thu hồi trước hạn.
 * Quyền thật do API kiểm tra theo JWT (chỉ Trưởng phòng của phòng SỞ HỮU tài liệu, hoặc Ban Giám đốc, được duyệt).
 */
export const ApprovalTab: React.FC = () => {
  const { user } = useAuth();
  const toast = useToast();
  const currentDept = user?.departmentCode ?? '';
  const isExecutive = !!user?.isExecutive || user?.role === 'EXECUTIVE';

  const [view, setView] = useState<View>('incoming');
  const [drafts, setDrafts] = useState<DocumentItem[]>([]);
  const [requests, setRequests] = useState<AccessRequestItem[]>([]);
  const [shares, setShares] = useState<SharedDocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [inspectDocId, setInspectDocId] = useState<number | null>(null);
  const [newRequestOpen, setNewRequestOpen] = useState(false);
  const [rejecting, setRejecting] = useState<AccessRequestItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Mức quyền người duyệt chọn cho từng yêu cầu (mặc định = mức được xin)
  const [grant, setGrant] = useState<Record<number, 'VIEW' | 'DOWNLOAD'>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [draftRes, reqData, shareData] = await Promise.all([
        documentApi.getDocuments(currentDept, 1, 100, undefined, 'DRAFT'),
        searchApi.getAccessRequests(currentDept, isExecutive),
        searchApi.getSharesByDept(currentDept),
      ]);
      setDrafts(draftRes.data || []);
      setRequests(reqData || []);
      setShares(shareData || []);
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Không tải được danh sách phê duyệt', 'Lỗi tải dữ liệu');
    } finally {
      setLoading(false);
    }
  }, [currentDept, isExecutive, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Thông báo thời gian thực (chuông) báo có yêu cầu mới: làm mới ngay
  useEffect(() => {
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  const incoming = useMemo(() => requests.filter((r) => isExecutive || r.target_dept === currentDept), [requests, isExecutive, currentDept]);
  const incomingPending = incoming.filter((r) => r.status === 'PENDING');
  const incomingDone = incoming.filter((r) => r.status !== 'PENDING');
  const outgoing = useMemo(() => requests.filter((r) => r.requester_dept === currentDept), [requests, currentDept]);
  const activeShares = shares.filter((s) => (daysUntil(s.expires_at) ?? 1) > 0);

  const run = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(okMsg);
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message, 'Thao tác thất bại');
    } finally {
      setBusy(null);
    }
  };

  const approveDraft = (d: DocumentItem) =>
    run(`draft-${d.docId}`, () => documentApi.approveDocument(currentDept, d.docId), `Đã ký ban hành "${d.title}"`);

  const returnDraft = (d: DocumentItem) => {
    if (!window.confirm(`Trả lại và hủy bản nháp "${d.title}" (#DOC-${d.docId})?`)) return;
    void run(`draft-${d.docId}`, () => documentApi.deleteDocument(currentDept, d.docId), `Đã trả lại bản nháp #DOC-${d.docId}`);
  };

  const approveRequest = (r: AccessRequestItem) => {
    const perm = grant[r.request_id] ?? r.requested_permission ?? 'VIEW';
    void run(
      `req-${r.request_id}`,
      () => searchApi.approveAccessRequest(r.request_id, user?.username || '', perm),
      `Đã cấp quyền ${perm === 'DOWNLOAD' ? 'xem và tải' : 'chỉ xem'} cho phòng ${r.requester_dept}`,
    );
  };

  const confirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejecting) return;
    const r = rejecting;
    await run(`req-${r.request_id}`, () => searchApi.rejectAccessRequest(r.request_id, user?.username || '', rejectReason.trim() || undefined), 'Đã từ chối yêu cầu');
    setRejecting(null);
    setRejectReason('');
  };

  const revoke = (s: SharedDocumentItem) => {
    if (!window.confirm(`Thu hồi quyền truy cập "${s.title}" của ${s.shared_with_dept === '*' ? 'toàn công ty' : `phòng ${s.shared_with_dept}`} ngay lập tức?`)) return;
    void run(`share-${s.share_id}`, () => searchApi.revokeShare(currentDept, s.share_id), 'Đã thu hồi quyền truy cập');
  };

  const tabs: Array<{ key: View; label: string; count: number; attention?: boolean }> = [
    { key: 'incoming', label: 'Yêu cầu đến', count: incomingPending.length, attention: incomingPending.length > 0 },
    { key: 'drafts', label: 'Bản nháp chờ ký', count: drafts.length, attention: drafts.length > 0 },
    { key: 'outgoing', label: 'Yêu cầu đã gửi', count: outgoing.length },
    { key: 'shares', label: 'Đang chia sẻ', count: activeShares.length },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Trung tâm phê duyệt"
        meta={<DeptBadge code={isExecutive ? '*' : currentDept} />}
        description={
          isExecutive
            ? 'Ban Giám đốc xem và duyệt được yêu cầu của mọi phòng ban.'
            : `Duyệt bản nháp của ${deptName(currentDept)} và quyết định cấp quyền cho phòng ban khác muốn xem tài liệu của phòng.`
        }
        actions={
          <>
            <Button icon={RefreshCw} onClick={() => void load()} disabled={loading}>
              Làm mới
            </Button>
            <Button variant="primary" icon={Send} onClick={() => setNewRequestOpen(true)}>
              Xin quyền tài liệu phòng khác
            </Button>
          </>
        }
      />

      {/* Thanh chọn danh sách */}
      <div className="flex items-center gap-1 border-b border-slate-200" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={view === t.key}
            onClick={() => setView(t.key)}
            className={`h-9 px-3 -mb-px border-b-2 text-xs font-semibold flex items-center gap-2 ${
              view === t.key ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.label}
            <span
              className={`font-mono text-[11px] px-1.5 rounded border ${
                t.attention ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-slate-100 text-slate-600 border-slate-200'
              }`}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {loading && requests.length === 0 && drafts.length === 0 ? (
        <Panel>
          <LoadingRows />
        </Panel>
      ) : (
        <>
          {/* ---------------- YÊU CẦU ĐẾN */}
          {view === 'incoming' && (
            <>
              <Panel title="Chờ quyết định" note="Phòng ban khác xin quyền truy cập tài liệu của phòng bạn">
                {incomingPending.length === 0 ? (
                  <EmptyState title="Không có yêu cầu nào đang chờ" hint="Khi phòng khác gửi yêu cầu, chuông thông báo sẽ báo ngay." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-slate-200">
                          <Th>Tài liệu</Th>
                          <Th>Phòng xin</Th>
                          <Th>Người xin</Th>
                          <Th>Lý do</Th>
                          <Th>Thời hạn</Th>
                          <Th>Gửi lúc</Th>
                          <Th>Cấp quyền</Th>
                          <Th className="text-right">Quyết định</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {incomingPending.map((r) => {
                          const perm = grant[r.request_id] ?? r.requested_permission ?? 'VIEW';
                          const b = busy === `req-${r.request_id}`;
                          return (
                            <tr key={r.request_id} className={ROW}>
                              <Td>
                                <span className="font-mono text-[11px] text-slate-400 mr-2">#{r.central_doc_id}</span>
                                <span className="font-semibold text-slate-900">{r.title}</span>
                                {isExecutive && <DeptBadge code={r.target_dept} className="ml-2" />}
                              </Td>
                              <Td>
                                <DeptBadge code={r.requester_dept} />
                              </Td>
                              <Td className="font-mono text-slate-600">{r.requester_username}</Td>
                              <Td className="text-slate-600 max-w-xs truncate" >
                                <span title={r.reason}>{r.reason}</span>
                              </Td>
                              <Td className="font-mono text-slate-600 whitespace-nowrap">{r.requested_days} ngày</Td>
                              <Td className="font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(r.created_at)}</Td>
                              <Td>
                                <select
                                  value={perm}
                                  onChange={(e) => setGrant((g) => ({ ...g, [r.request_id]: e.target.value as 'VIEW' | 'DOWNLOAD' }))}
                                  className="h-7 px-1.5 rounded border border-slate-300 bg-white text-[11px] font-semibold text-slate-700"
                                  aria-label="Mức quyền cấp"
                                >
                                  <option value="VIEW">Chỉ xem (DLP)</option>
                                  <option value="DOWNLOAD">Xem và tải về</option>
                                </select>
                                {r.requested_permission && perm !== r.requested_permission && (
                                  <div className="text-[10px] text-amber-700 mt-0.5">Khác mức được xin</div>
                                )}
                              </Td>
                              <Td className="text-right whitespace-nowrap">
                                <span className="inline-flex gap-1.5">
                                  <Button size="sm" variant="primary" icon={Check} disabled={b} onClick={() => approveRequest(r)}>
                                    Duyệt
                                  </Button>
                                  <Button size="sm" variant="danger" icon={X} disabled={b} onClick={() => setRejecting(r)}>
                                    Từ chối
                                  </Button>
                                </span>
                              </Td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel title="Đã xử lý" note={`${incomingDone.length} yêu cầu`}>
                {incomingDone.length === 0 ? (
                  <EmptyState title="Chưa có yêu cầu nào được xử lý" />
                ) : (
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-white">
                        <tr className="border-b border-slate-200">
                          <Th>Kết quả</Th>
                          <Th>Tài liệu</Th>
                          <Th>Phòng xin</Th>
                          <Th>Người duyệt</Th>
                          <Th>Duyệt lúc</Th>
                          <Th>Ghi chú</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {incomingDone.map((r) => (
                          <tr key={r.request_id} className={ROW}>
                            <Td>
                              <RequestStatusPill status={r.status} />
                            </Td>
                            <Td className="font-semibold text-slate-900">{r.title}</Td>
                            <Td>
                              <DeptBadge code={r.requester_dept} />
                            </Td>
                            <Td className="font-mono text-slate-600">{r.reviewed_by || '—'}</Td>
                            <Td className="font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(r.reviewed_at)}</Td>
                            <Td className="text-slate-500 max-w-md truncate">
                              <span title={r.reason}>{r.reason}</span>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          )}

          {/* ---------------- BẢN NHÁP */}
          {view === 'drafts' && (
            <Panel title="Bản nháp chờ ký ban hành" note={`Do nhân viên ${deptName(currentDept)} lập`}>
              {drafts.length === 0 ? (
                <EmptyState title="Không có bản nháp nào chờ ký" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <Th>Mã</Th>
                        <Th>Tên văn bản</Th>
                        <Th>Phân loại</Th>
                        <Th>Người lập</Th>
                        <Th>Lập lúc</Th>
                        <Th className="text-right">Quyết định</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {drafts.map((d) => {
                        const b = busy === `draft-${d.docId}`;
                        return (
                          <tr key={d.docId} className={ROW}>
                            <Td className="font-mono text-slate-500 whitespace-nowrap">#DOC-{d.docId}</Td>
                            <Td>
                              <button onClick={() => setInspectDocId(d.docId)} className="font-semibold text-slate-900 hover:underline text-left">
                                {d.title}
                              </button>
                              {d.category && <span className="text-[11px] text-slate-400 ml-2">{d.category.name || d.category.categoryName}</span>}
                            </Td>
                            <Td>
                              <AccessPill level={d.accessLevel} />
                            </Td>
                            <Td className="text-slate-600">{d.creator?.fullName || d.creator?.username || '—'}</Td>
                            <Td className="font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(d.createdAt)}</Td>
                            <Td className="text-right whitespace-nowrap">
                              <span className="inline-flex gap-1.5">
                                <Button size="sm" variant="ghost" icon={Eye} onClick={() => setInspectDocId(d.docId)}>
                                  Xem
                                </Button>
                                <Button size="sm" variant="primary" icon={Check} disabled={b} onClick={() => void approveDraft(d)}>
                                  Ký ban hành
                                </Button>
                                <Button size="sm" variant="danger" icon={Trash2} disabled={b} onClick={() => returnDraft(d)}>
                                  Trả lại
                                </Button>
                              </span>
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          {/* ---------------- YÊU CẦU ĐÃ GỬI */}
          {view === 'outgoing' && (
            <Panel title="Yêu cầu phòng bạn đã gửi đi" note="Khi được duyệt, tài liệu hiện trong mục Được chia sẻ đến của Kho hồ sơ">
              {outgoing.length === 0 ? (
                <EmptyState
                  title="Phòng bạn chưa gửi yêu cầu nào"
                  action={
                    <Button variant="primary" icon={Send} onClick={() => setNewRequestOpen(true)}>
                      Xin quyền tài liệu phòng khác
                    </Button>
                  }
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <Th>Trạng thái</Th>
                        <Th>Tài liệu</Th>
                        <Th>Phòng sở hữu</Th>
                        <Th>Quyền xin</Th>
                        <Th>Người gửi</Th>
                        <Th>Gửi lúc</Th>
                        <Th>Người duyệt</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {outgoing.map((r) => (
                        <tr key={r.request_id} className={ROW}>
                          <Td>
                            <RequestStatusPill status={r.status} />
                          </Td>
                          <Td className="font-semibold text-slate-900">{r.title}</Td>
                          <Td>
                            <DeptBadge code={r.target_dept} />
                          </Td>
                          <Td>
                            <PermissionPill permission={r.requested_permission} />
                          </Td>
                          <Td className="font-mono text-slate-600">{r.requester_username}</Td>
                          <Td className="font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(r.created_at)}</Td>
                          <Td className="font-mono text-slate-600">{r.reviewed_by || '—'}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          {/* ---------------- ĐANG CHIA SẺ */}
          {view === 'shares' && (
            <Panel
              title="Tài liệu phòng bạn đang chia sẻ ra ngoài"
              note="Hết hạn thì quyền tự mất; có thể thu hồi trước hạn"
            >
              {shares.length === 0 ? (
                <EmptyState title="Phòng bạn chưa chia sẻ tài liệu nào" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <Th>Tài liệu</Th>
                        <Th>Cho</Th>
                        <Th>Quyền</Th>
                        <Th>Lý do</Th>
                        <Th>Cấp lúc</Th>
                        <Th className="text-right">Còn hiệu lực</Th>
                        <Th className="text-right">Thao tác</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {shares.map((s) => {
                        const left = daysUntil(s.expires_at);
                        const expired = left !== null && left <= 0;
                        return (
                          <tr key={s.share_id} className={`${ROW} ${expired ? 'opacity-60' : ''}`}>
                            <Td>
                              <span className="font-mono text-[11px] text-slate-400 mr-2">#{s.central_doc_id}</span>
                              <span className="font-semibold text-slate-900">{s.title}</span>
                            </Td>
                            <Td>
                              <DeptBadge code={s.shared_with_dept} />
                            </Td>
                            <Td>
                              <PermissionPill permission={s.permission} />
                            </Td>
                            <Td className="text-slate-500 max-w-xs truncate">
                              <span title={s.reason}>{s.reason}</span>
                            </Td>
                            <Td className="font-mono text-slate-600 whitespace-nowrap">{fmtDateTime(s.created_at)}</Td>
                            <Td className="text-right whitespace-nowrap">
                              {expired ? (
                                <Pill tone="danger">HẾT HẠN</Pill>
                              ) : (
                                <span className={`font-mono ${left !== null && left <= 2 ? 'text-amber-700 font-bold' : 'text-slate-600'}`}>
                                  {left === null ? 'Không thời hạn' : `${left} ngày`}
                                </span>
                              )}
                            </Td>
                            <Td className="text-right">
                              <Button size="sm" variant="danger" icon={ShieldOff} disabled={expired || busy === `share-${s.share_id}`} onClick={() => revoke(s)}>
                                Thu hồi
                              </Button>
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}
        </>
      )}

      {/* Hộp thoại từ chối */}
      {rejecting && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onMouseDown={() => setRejecting(null)}>
          <form
            onSubmit={confirmReject}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded border border-slate-200 shadow-xl"
          >
            <div className="px-4 h-11 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Từ chối yêu cầu xin quyền</h3>
              <button type="button" onClick={() => setRejecting(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 text-xs">
              <div className="text-slate-600">
                <DeptBadge code={rejecting.requester_dept} /> <span className="font-mono">{rejecting.requester_username}</span> xin truy cập{' '}
                <strong className="text-slate-900">{rejecting.title}</strong>.
              </div>
              <label className="block">
                <span className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Lý do từ chối (gửi cho người xin)</span>
                <textarea
                  autoFocus
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  placeholder="Ví dụ: tài liệu chứa thông tin lương cá nhân, đề nghị liên hệ trực tiếp Trưởng phòng."
                  className="w-full px-2.5 py-2 rounded border border-slate-300 text-xs text-slate-800"
                />
              </label>
            </div>
            <div className="px-4 h-12 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <Button type="button" onClick={() => setRejecting(null)}>
                Hủy
              </Button>
              <Button type="submit" variant="danger" icon={X} disabled={busy === `req-${rejecting.request_id}`}>
                Xác nhận từ chối
              </Button>
            </div>
          </form>
        </div>
      )}

      {inspectDocId !== null && (
        <DocumentDetailDrawer
          isOpen
          onClose={() => setInspectDocId(null)}
          docId={inspectDocId}
          dept={currentDept}
          onDownload={(id) => documentApi.download(currentDept, id).catch((e) => toast.error(e.message, 'Lỗi tải tệp'))}
          onShare={() => {}}
          onRefresh={() => void load()}
        />
      )}

      {newRequestOpen && (
        <RequestAccessModal
          isOpen
          onClose={() => setNewRequestOpen(false)}
          onSuccess={() => {
            setNewRequestOpen(false);
            setView('outgoing');
            void load();
          }}
        />
      )}
    </div>
  );
};
