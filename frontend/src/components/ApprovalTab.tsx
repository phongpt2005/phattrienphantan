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
  Modal,
  PageHeader,
  Panel,
  PermissionPill,
  Pill,
  RequestStatusPill,
  ROW,
  SELECT,
  TEXTAREA,
  Tabs,
  Td,
  Th,
  daysUntil,
  fmtDateTime,
} from './ui';
import type { TabItem } from './ui';

type View = 'incoming' | 'drafts' | 'outgoing' | 'shares';
type Perm = 'VIEW' | 'DOWNLOAD';

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
  const [grant, setGrant] = useState<Record<number, Perm>>({});

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
    await run(
      `req-${r.request_id}`,
      () => searchApi.rejectAccessRequest(r.request_id, user?.username || '', rejectReason.trim() || undefined),
      'Đã từ chối yêu cầu',
    );
    setRejecting(null);
    setRejectReason('');
  };

  const revoke = (s: SharedDocumentItem) => {
    if (!window.confirm(`Thu hồi quyền truy cập "${s.title}" của ${s.shared_with_dept === '*' ? 'toàn công ty' : `phòng ${s.shared_with_dept}`} ngay lập tức?`)) return;
    void run(`share-${s.share_id}`, () => searchApi.revokeShare(currentDept, s.share_id), 'Đã thu hồi quyền truy cập');
  };

  const tabs: Array<TabItem<View>> = [
    { value: 'incoming', label: 'Yêu cầu đến', count: incomingPending.length, attention: incomingPending.length > 0 },
    { value: 'drafts', label: 'Bản nháp chờ ký', count: drafts.length, attention: drafts.length > 0 },
    { value: 'outgoing', label: 'Yêu cầu đã gửi', count: outgoing.length },
    { value: 'shares', label: 'Đang chia sẻ', count: activeShares.length },
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

      <Tabs<View> value={view} onChange={setView} items={tabs} />

      {loading && requests.length === 0 && drafts.length === 0 ? (
        <Panel>
          <LoadingRows />
        </Panel>
      ) : (
        <>
          {/* ---------------- YÊU CẦU ĐẾN */}
          {view === 'incoming' && (
            <>
              <Panel title="Chờ quyết định" note="Phòng khác xin quyền xem hoặc tải tài liệu của phòng bạn">
                {incomingPending.length === 0 ? (
                  <EmptyState title="Không có yêu cầu nào đang chờ" hint="Khi phòng khác gửi yêu cầu, chuông thông báo sẽ báo ngay." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          <Th className="pl-4">Tài liệu</Th>
                          <Th>Phòng xin</Th>
                          <Th className="hidden lg:table-cell">Lý do</Th>
                          <Th className="hidden md:table-cell">Thời hạn</Th>
                          <Th className="hidden xl:table-cell">Gửi lúc</Th>
                          <Th>Mức quyền cấp</Th>
                          <Th className="pr-4 text-right">Quyết định</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {incomingPending.map((r) => {
                          const perm = grant[r.request_id] ?? r.requested_permission ?? 'VIEW';
                          const busyRow = busy === `req-${r.request_id}`;
                          return (
                            <tr key={r.request_id} className={ROW}>
                              <Td className="pl-4 w-full max-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-mono text-micro text-slate-500 whitespace-nowrap">#DOC-{r.central_doc_id}</span>
                                  <span className="truncate font-medium text-slate-900" title={r.title}>
                                    {r.title}
                                  </span>
                                  {isExecutive && <DeptBadge code={r.target_dept} />}
                                </div>
                              </Td>
                              <Td>
                                <div className="flex items-center gap-2 min-w-0">
                                  <DeptBadge code={r.requester_dept} />
                                  <span className="font-mono text-micro text-slate-600 truncate">{r.requester_username}</span>
                                </div>
                              </Td>
                              <Td className="hidden lg:table-cell max-w-[220px]">
                                <span className="block truncate text-slate-600" title={r.reason}>
                                  {r.reason || '—'}
                                </span>
                              </Td>
                              <Td className="hidden md:table-cell font-mono text-micro text-slate-600 whitespace-nowrap">{r.requested_days} ngày</Td>
                              <Td className="hidden xl:table-cell font-mono text-micro text-slate-500 whitespace-nowrap">{fmtDateTime(r.created_at)}</Td>
                              <Td>
                                <select
                                  value={perm}
                                  onChange={(e) => setGrant((g) => ({ ...g, [r.request_id]: e.target.value as Perm }))}
                                  aria-label="Mức quyền cấp"
                                  className={`${SELECT} w-40`}
                                >
                                  <option value="VIEW">Chỉ xem (DLP)</option>
                                  <option value="DOWNLOAD">Xem và tải về</option>
                                </select>
                                {r.requested_permission && perm !== r.requested_permission && (
                                  <div className="mt-0.5 text-micro text-amber-700">Khác mức được xin</div>
                                )}
                              </Td>
                              <Td className="pr-4">
                                <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                                  <Button size="sm" variant="primary" icon={Check} disabled={busyRow} onClick={() => approveRequest(r)}>
                                    Duyệt
                                  </Button>
                                  <Button size="sm" variant="danger" icon={X} disabled={busyRow} onClick={() => setRejecting(r)}>
                                    Từ chối
                                  </Button>
                                </div>
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
                    <table className="w-full border-collapse">
                      <thead className="sticky top-0 z-10">
                        <tr>
                          <Th className="pl-4">Kết quả</Th>
                          <Th>Tài liệu</Th>
                          <Th>Phòng xin</Th>
                          <Th>Người duyệt</Th>
                          <Th>Duyệt lúc</Th>
                          <Th className="pr-4">Ghi chú</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {incomingDone.map((r) => (
                          <tr key={r.request_id} className={ROW}>
                            <Td className="pl-4">
                              <RequestStatusPill status={r.status} />
                            </Td>
                            <Td className="max-w-[260px]">
                              <span className="block truncate font-medium text-slate-900" title={r.title}>
                                {r.title}
                              </span>
                            </Td>
                            <Td>
                              <DeptBadge code={r.requester_dept} />
                            </Td>
                            <Td className="font-mono text-micro text-slate-600">{r.reviewed_by || '—'}</Td>
                            <Td className="font-mono text-micro text-slate-600 whitespace-nowrap">{fmtDateTime(r.reviewed_at)}</Td>
                            <Td className="pr-4 text-slate-500 max-w-md">
                              <span className="block truncate" title={r.reason}>
                                {r.reason}
                              </span>
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
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <Th className="pl-4 w-28">Mã hồ sơ</Th>
                        <Th>Tên văn bản</Th>
                        <Th>Phân loại</Th>
                        <Th>Người lập</Th>
                        <Th>Lập lúc</Th>
                        <Th className="pr-4 text-right">Quyết định</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {drafts.map((d) => {
                        const busyRow = busy === `draft-${d.docId}`;
                        return (
                          <tr key={d.docId} className={ROW}>
                            <Td className="pl-4 font-mono text-micro text-slate-500 whitespace-nowrap">#DOC-{d.docId}</Td>
                            <Td className="w-full max-w-0">
                              <button
                                type="button"
                                onClick={() => setInspectDocId(d.docId)}
                                className="block max-w-full truncate font-medium text-slate-900 hover:text-brand-700 text-left"
                              >
                                {d.title}
                              </button>
                              {d.category && (
                                <span className="block text-micro text-slate-500 truncate">{d.category.name || d.category.categoryName}</span>
                              )}
                            </Td>
                            <Td>
                              <AccessPill level={d.accessLevel} />
                            </Td>
                            <Td className="text-slate-600 whitespace-nowrap">{d.creator?.fullName || d.creator?.username || '—'}</Td>
                            <Td className="font-mono text-micro text-slate-600 whitespace-nowrap">{fmtDateTime(d.createdAt)}</Td>
                            <Td className="pr-4">
                              <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                                <Button size="sm" variant="ghost" icon={Eye} onClick={() => setInspectDocId(d.docId)}>
                                  Xem
                                </Button>
                                <Button size="sm" variant="primary" icon={Check} disabled={busyRow} onClick={() => void approveDraft(d)}>
                                  Ký ban hành
                                </Button>
                                <Button size="sm" variant="danger" icon={Trash2} disabled={busyRow} onClick={() => returnDraft(d)}>
                                  Trả lại
                                </Button>
                              </div>
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
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <Th className="pl-4">Trạng thái</Th>
                        <Th>Tài liệu</Th>
                        <Th>Phòng sở hữu</Th>
                        <Th>Quyền xin</Th>
                        <Th>Người gửi</Th>
                        <Th>Gửi lúc</Th>
                        <Th className="pr-4">Người duyệt</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {outgoing.map((r) => (
                        <tr key={r.request_id} className={ROW}>
                          <Td className="pl-4">
                            <RequestStatusPill status={r.status} />
                          </Td>
                          <Td className="max-w-[260px]">
                            <span className="block truncate font-medium text-slate-900" title={r.title}>
                              {r.title}
                            </span>
                          </Td>
                          <Td>
                            <DeptBadge code={r.target_dept} />
                          </Td>
                          <Td>
                            <PermissionPill permission={r.requested_permission} />
                          </Td>
                          <Td className="font-mono text-micro text-slate-600">{r.requester_username}</Td>
                          <Td className="font-mono text-micro text-slate-600 whitespace-nowrap">{fmtDateTime(r.created_at)}</Td>
                          <Td className="pr-4 font-mono text-micro text-slate-600">{r.reviewed_by || '—'}</Td>
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
            <Panel title="Tài liệu phòng bạn đang chia sẻ ra ngoài" note="Hết hạn thì quyền tự mất; có thể thu hồi trước hạn">
              {shares.length === 0 ? (
                <EmptyState title="Phòng bạn chưa chia sẻ tài liệu nào" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <Th className="pl-4">Tài liệu</Th>
                        <Th>Cho</Th>
                        <Th>Quyền</Th>
                        <Th className="hidden lg:table-cell">Lý do</Th>
                        <Th className="hidden md:table-cell">Cấp lúc</Th>
                        <Th className="text-right">Còn hiệu lực</Th>
                        <Th className="pr-4 text-right">Thao tác</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {shares.map((s) => {
                        const left = daysUntil(s.expires_at);
                        const expired = left !== null && left <= 0;
                        return (
                          <tr key={s.share_id} className={`${ROW} ${expired ? 'opacity-60' : ''}`}>
                            <Td className="pl-4 w-full max-w-0">
                              <span className="block truncate font-medium text-slate-900" title={s.title}>
                                {s.title}
                              </span>
                            </Td>
                            <Td>
                              <DeptBadge code={s.shared_with_dept} />
                            </Td>
                            <Td>
                              <PermissionPill permission={s.permission} />
                            </Td>
                            <Td className="hidden lg:table-cell max-w-[220px]">
                              <span className="block truncate text-slate-500" title={s.reason}>
                                {s.reason}
                              </span>
                            </Td>
                            <Td className="hidden md:table-cell font-mono text-micro text-slate-600 whitespace-nowrap">{fmtDateTime(s.created_at)}</Td>
                            <Td className="text-right whitespace-nowrap">
                              {expired ? (
                                <Pill tone="danger">HẾT HẠN</Pill>
                              ) : (
                                <span className={`font-mono text-micro ${left !== null && left <= 2 ? 'text-amber-700 font-semibold' : 'text-slate-600'}`}>
                                  {left === null ? 'Không thời hạn' : `${left} ngày`}
                                </span>
                              )}
                            </Td>
                            <Td className="pr-4 text-right">
                              <Button
                                size="sm"
                                variant="danger"
                                icon={ShieldOff}
                                disabled={expired || busy === `share-${s.share_id}`}
                                onClick={() => revoke(s)}
                              >
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

      {/* Hộp thoại từ chối: lý do được gửi cho phòng xin quyền */}
      <Modal
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Từ chối yêu cầu xin quyền"
        width="max-w-md"
      >
        {rejecting && (
          <form onSubmit={confirmReject} className="space-y-4">
            <p className="text-data text-slate-600">
              <DeptBadge code={rejecting.requester_dept} />{' '}
              <span className="font-mono text-micro">{rejecting.requester_username}</span> xin truy cập{' '}
              <strong className="text-slate-900">{rejecting.title}</strong>.
            </p>
            <div className="flex flex-col gap-1">
              <label htmlFor="reject-reason" className="text-micro font-semibold uppercase tracking-wider text-slate-500">
                Lý do từ chối (gửi cho người xin)
              </label>
              <textarea
                id="reject-reason"
                autoFocus
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={3}
                placeholder="Ví dụ: tài liệu chứa thông tin lương cá nhân, đề nghị liên hệ trực tiếp Trưởng phòng."
                className={TEXTAREA}
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" onClick={() => setRejecting(null)}>
                Hủy
              </Button>
              <Button type="submit" variant="danger" icon={X} disabled={busy === `req-${rejecting.request_id}`}>
                Xác nhận từ chối
              </Button>
            </div>
          </form>
        )}
      </Modal>

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
