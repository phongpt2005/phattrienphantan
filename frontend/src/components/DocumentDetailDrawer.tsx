import React, { useEffect, useState } from 'react';
import { deptName } from '../context/DepartmentContext';
import { useAuth } from '../context/AuthContext';
import { documentApi } from '../services/api';
import { DocumentAuditLogEntry, DocumentDetail } from '../types';
import { useToast } from '../context/ToastContext';
import { AlertTriangle, Check, Clock, Copy, Download, FileCheck, Plus, RefreshCw, Save, Share2, ShieldCheck, Trash2, UploadCloud } from 'lucide-react';
import {
  AccessPill,
  Button,
  DocStatusPill,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  INPUT,
  LoadingRows,
  Panel,
  Pill,
  SELECT,
  TEXTAREA,
  Tabs,
  fmtDate,
  fmtDateTime,
  mimeLabel,
} from './ui';
import type { Tone, TabItem } from './ui';

interface DocumentDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  docId: number | null;
  dept: string;
  onDownload: (docId: number) => void;
  onShare: (docId: number, title: string) => void;
  onRefresh?: () => void;
}

type DrawerTab = 'METADATA' | 'VERSIONS' | 'AUDIT' | 'PREVIEW' | 'GOVERNANCE';

/** Nhãn và màu của từng loại thao tác trong nhật ký kiểm toán. */
const auditBadge = (log: DocumentAuditLogEntry): { tone: Tone; label: string } => {
  if (log.detail?.includes('phê duyệt') || log.detail?.includes('ban hành')) return { tone: 'success', label: 'KÝ DUYỆT' };
  switch (log.action) {
    case 'CREATE':
      return { tone: 'success', label: 'TẠO MỚI' };
    case 'UPDATE':
      return { tone: 'info', label: 'CẬP NHẬT' };
    case 'DOWNLOAD':
      return { tone: 'neutral', label: 'TẢI VỀ' };
    case 'VIEW':
      return { tone: 'neutral', label: 'TRUY CẬP' };
    case 'DELETE':
      return { tone: 'danger', label: 'THU HỒI' };
    default:
      return { tone: 'neutral', label: log.action };
  }
};

/**
 * Ngăn chi tiết tài liệu (trượt từ phải): tổng quan, phiên bản, nhật ký kiểm toán,
 * xem trước có đóng dấu DLP và quản trị. Mọi thao tác và quyền giữ nguyên như trước.
 */
export const DocumentDetailDrawer: React.FC<DocumentDetailDrawerProps> = ({
  isOpen,
  onClose,
  docId,
  dept,
  onDownload,
  onShare,
  onRefresh,
}) => {
  const { user } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copiedSha, setCopiedSha] = useState(false);
  const [activeTab, setActiveTab] = useState<DrawerTab>('METADATA');

  // Nhật ký kiểm toán
  const [auditLogs, setAuditLogs] = useState<DocumentAuditLogEntry[]>([]);
  const [isLoadingAudit, setIsLoadingAudit] = useState(false);

  // Thêm phiên bản mới
  const [showAddVersion, setShowAddVersion] = useState(false);
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [isSubmittingVersion, setIsSubmittingVersion] = useState(false);

  // Chỉnh sửa thông tin tài liệu
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editStatus, setEditStatus] = useState('PUBLISHED');
  const [isSavingMeta, setIsSavingMeta] = useState(false);

  const [isDeleting, setIsDeleting] = useState(false);
  const [isApprovingDraft, setIsApprovingDraft] = useState(false);

  const fetchAuditLogs = () => {
    if (docId) {
      setIsLoadingAudit(true);
      documentApi
        .getAuditLogs(dept, docId)
        .then((logs) => {
          setAuditLogs(Array.isArray(logs) ? logs : []);
        })
        .catch((err) => {
          console.error('Lỗi tải nhật ký kiểm toán:', err);
        })
        .finally(() => {
          setIsLoadingAudit(false);
        });
    }
  };

  const fetchDetail = () => {
    if (docId) {
      setIsLoading(true);
      documentApi
        .getDocumentDetail(dept, docId)
        .then((data) => {
          setDetail(data);
          setEditTitle(data.title || '');
          setEditDesc(data.description || '');
          setEditStatus(data.status || 'PUBLISHED');
        })
        .catch((err) => {
          console.error('Lỗi tải chi tiết văn bản:', err);
          toast.error('Không thể nạp thông tin chi tiết hồ sơ');
        })
        .finally(() => {
          setIsLoading(false);
        });
      fetchAuditLogs();
    }
  };

  useEffect(() => {
    if (isOpen && docId) {
      fetchDetail();
      setShowAddVersion(false);
      setVersionFile(null);
      setChangeNote('');
      setActiveTab('METADATA');
    } else {
      setDetail(null);
      setAuditLogs([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, docId, dept]);

  const handleTabChange = (tab: DrawerTab) => {
    setActiveTab(tab);
    if (tab === 'AUDIT') fetchAuditLogs();
  };

  const handleCopySha = (sha: string) => {
    navigator.clipboard.writeText(sha);
    setCopiedSha(true);
    toast.success('Đã sao chép mã băm SHA-256 vào bộ nhớ tạm');
    setTimeout(() => setCopiedSha(false), 2000);
  };

  const handleUploadVersion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docId || !versionFile) {
      toast.warning('Vui lòng chọn tệp phiên bản mới');
      return;
    }

    setIsSubmittingVersion(true);
    try {
      const formData = new FormData();
      formData.append('file', versionFile);
      formData.append('changeNote', changeNote.trim() || `Cập nhật phiên bản v${(detail?.currentVersion || 1) + 1}.0`);

      await documentApi.addVersion(dept, docId, formData);
      toast.success('Đã phát hành phiên bản mới thành công');
      setShowAddVersion(false);
      setVersionFile(null);
      setChangeNote('');
      fetchDetail();
      if (onRefresh) onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message, 'Lỗi tải lên phiên bản mới');
    } finally {
      setIsSubmittingVersion(false);
    }
  };

  const handleSaveMetadata = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docId) return;

    setIsSavingMeta(true);
    try {
      await documentApi.updateDocument(dept, docId, {
        title: editTitle.trim(),
        description: editDesc.trim(),
        status: editStatus,
      });
      toast.success('Đã cập nhật thông tin hồ sơ thành công');
      fetchDetail();
      if (onRefresh) onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message, 'Lỗi cập nhật hồ sơ');
    } finally {
      setIsSavingMeta(false);
    }
  };

  const handleApproveDraft = async () => {
    if (!detail) return;
    setIsApprovingDraft(true);
    try {
      await documentApi.approveDocument(dept, detail.docId);
      toast.success(`Đã ký ban hành văn bản "${detail.title}"`);
      fetchDetail();
      if (onRefresh) onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message, 'Lỗi phê duyệt');
    } finally {
      setIsApprovingDraft(false);
    }
  };

  const handleDelete = async () => {
    if (!docId || !detail) return;

    if (
      !window.confirm(
        `Xác nhận XÓA TÀI LIỆU "${detail.title}" (#DOC-${docId})?\nTài liệu sẽ được chuyển sang trạng thái DELETED và thu hồi khỏi lưu hành.`,
      )
    ) {
      return;
    }

    setIsDeleting(true);
    try {
      await documentApi.deleteDocument(dept, docId);
      toast.success(`Đã xóa tài liệu #DOC-${docId} thành công`);
      onClose();
      if (onRefresh) onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message, 'Lỗi xóa tài liệu');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDownloadSpecificVersion = (versionNo: number) => {
    if (!docId) return;
    toast.info(`Đang tải tệp phiên bản v${versionNo}.0`);
    documentApi.download(dept, docId, versionNo).catch((e) => toast.error(e.message, 'Lỗi tải tệp'));
  };

  if (!isOpen) return null;

  const latestVersion = detail?.versions && detail.versions.length > 0 ? detail.versions[0] : null;
  const isManagerOrExec = user?.role === 'MANAGER' || !!user?.isExecutive;
  const isOwner = detail?.creator?.username === user?.username;
  const canEditMeta = isOwner || isManagerOrExec;

  const tabItems: Array<TabItem<DrawerTab>> = [
    { value: 'METADATA', label: 'Tổng quan' },
    { value: 'VERSIONS', label: 'Phiên bản', count: detail?.versions?.length ?? 0 },
    { value: 'AUDIT', label: 'Nhật ký', count: auditLogs.length },
    { value: 'PREVIEW', label: 'Xem trước' },
    { value: 'GOVERNANCE', label: 'Quản trị' },
  ];

  return (
    <Drawer
      open={isOpen}
      onClose={onClose}
      width="lg"
      title={detail?.title || (isLoading ? 'Đang tải thông tin...' : 'Chi tiết hồ sơ')}
      subtitle={`#DOC-${docId ?? ''} · v${detail?.currentVersion ?? 1}.0 · ${deptName(dept) || dept}`}
      actions={
        detail && (
          <div className="hidden sm:flex items-center gap-1.5 shrink-0">
            <DocStatusPill status={detail.status} />
            <AccessPill level={detail.accessLevel} />
          </div>
        )
      }
    >
      <div className="px-4 pt-2">
        <Tabs<DrawerTab> value={activeTab} onChange={handleTabChange} items={tabItems} />
      </div>

      <div className="p-4 space-y-4">
        {isLoading ? (
          <LoadingRows label="Đang tải thông tin tài liệu..." />
        ) : !detail ? (
          <EmptyState title="Không tìm thấy thông tin tài liệu" />
        ) : (
          <>
            {/* ---------------- TỔNG QUAN */}
            {activeTab === 'METADATA' && (
              <>
                {detail.status === 'DRAFT' && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Clock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="text-data font-semibold text-amber-900">Bản nháp, chưa ban hành</div>
                        <div className="text-micro text-amber-800 mt-0.5">
                          Nhân viên lập hồ sơ này, đang chờ Trưởng phòng thẩm định và ký ban hành.
                        </div>
                      </div>
                    </div>
                    {isManagerOrExec && (
                      <Button variant="primary" icon={FileCheck} disabled={isApprovingDraft} onClick={() => void handleApproveDraft()} className="shrink-0">
                        Ký ban hành
                      </Button>
                    )}
                  </div>
                )}

                {latestVersion?.file && (
                  <Panel
                    title="Mã băm SHA-256 của phiên bản mới nhất"
                    note={`${Math.round(Number(latestVersion.file.sizeBytes) / 1024)} KB · ${mimeLabel(latestVersion.file.mimeType)}`}
                  >
                    <div className="p-3.5 flex items-center gap-2">
                      <code className="flex-1 min-w-0 block truncate rounded-md border border-slate-200 bg-slate-50 px-2.5 h-8 leading-8 font-mono text-micro text-slate-700 select-all">
                        {latestVersion.file.checksumSha256}
                      </code>
                      <IconButton
                        title="Sao chép mã băm"
                        aria-label="Sao chép mã băm"
                        onClick={() => handleCopySha(latestVersion.file?.checksumSha256 || '')}
                      >
                        {copiedSha ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      </IconButton>
                    </div>
                  </Panel>
                )}

                <dl className="grid grid-cols-2 gap-px rounded-xl border border-slate-200 bg-slate-200 overflow-hidden">
                  {[
                    { k: 'Người khởi tạo', v: detail.creator?.fullName || detail.creator?.username || 'Hệ thống', mono: false },
                    { k: 'Ngày khởi tạo', v: fmtDate(detail.createdAt), mono: true },
                    { k: 'Danh mục nghiệp vụ', v: detail.category?.name || detail.category?.categoryName || 'Hồ sơ chung', mono: false },
                    { k: 'Kho lưu trữ', v: `Kho ${deptName(dept).replace(/^Phòng\s+/i, '') || dept}`, mono: false },
                  ].map((item) => (
                    <div key={item.k} className="bg-card px-3 py-2.5 min-w-0">
                      <dt className="text-xs font-medium text-slate-500">{item.k}</dt>
                      <dd className={`mt-0.5 text-data font-medium text-slate-900 truncate ${item.mono ? 'font-mono' : ''}`}>{item.v}</dd>
                    </div>
                  ))}
                </dl>

                <Panel title="Mô tả trích yếu">
                  <p className="p-3.5 text-data text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {detail.description || 'Không có mô tả chi tiết cho văn bản này.'}
                  </p>
                </Panel>

                <div className="flex items-center gap-2">
                  <Button variant="primary" icon={Download} className="flex-1" onClick={() => onDownload(detail.docId)}>
                    Tải bản mới nhất (v{detail.currentVersion}.0)
                  </Button>
                  {isManagerOrExec && (
                    <Button icon={Share2} onClick={() => onShare(detail.docId, detail.title)}>
                      Chia sẻ liên phòng
                    </Button>
                  )}
                </div>
              </>
            )}

            {/* ---------------- PHIÊN BẢN */}
            {activeTab === 'VERSIONS' && (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-data font-semibold text-slate-900">Kiểm soát phiên bản</div>
                    <div className="text-micro text-slate-500 mt-0.5">Mọi nhân viên trong phòng đều có quyền phát hành bản sửa đổi.</div>
                  </div>
                  <Button size="sm" variant="primary" icon={Plus} onClick={() => setShowAddVersion((v) => !v)}>
                    Tải phiên bản mới
                  </Button>
                </div>

                {showAddVersion && (
                  <form onSubmit={handleUploadVersion} className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-3">
                    <div className="flex items-center gap-1.5 text-data font-semibold text-slate-900">
                      <UploadCloud className="w-4 h-4 text-brand-600" />
                      Phát hành phiên bản v{(detail.currentVersion || 1) + 1}.0
                    </div>
                    <Field label="Chọn tệp thay thế" htmlFor="version-file">
                      <input
                        id="version-file"
                        type="file"
                        required
                        onChange={(e) => setVersionFile(e.target.files ? e.target.files[0] : null)}
                        className="block w-full text-data text-slate-600 file:mr-3 file:h-7 file:px-2.5 file:rounded-md file:border file:border-slate-300 file:bg-card file:text-micro file:font-semibold file:text-slate-700 hover:file:bg-slate-50 cursor-pointer"
                      />
                    </Field>
                    <Field label="Ghi chú thay đổi" htmlFor="change-note">
                      <input
                        id="change-note"
                        type="text"
                        value={changeNote}
                        onChange={(e) => setChangeNote(e.target.value)}
                        placeholder="Ví dụ: cập nhật điều khoản thanh toán"
                        className={INPUT}
                      />
                    </Field>
                    <div className="flex items-center justify-end gap-2">
                      <Button type="button" onClick={() => setShowAddVersion(false)}>
                        Hủy bỏ
                      </Button>
                      <Button type="submit" variant="primary" disabled={isSubmittingVersion}>
                        {isSubmittingVersion ? 'Đang lưu...' : 'Lưu phiên bản'}
                      </Button>
                    </div>
                  </form>
                )}

                <Panel title="Lịch sử phiên bản" note={`${detail.versions?.length ?? 0} phiên bản`}>
                  {!detail.versions || detail.versions.length === 0 ? (
                    <EmptyState title="Chưa có phiên bản nào" />
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {detail.versions.map((ver, idx) => {
                        const isLatest = idx === 0;
                        return (
                          <li key={ver.versionNo} className="px-3.5 py-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="inline-flex items-center h-5 px-1.5 rounded-md border border-slate-200 bg-slate-100 font-mono text-micro font-semibold text-slate-700 whitespace-nowrap">
                                  v{ver.versionNo}.0
                                </span>
                                {isLatest && <Pill tone="info">HIỆN HÀNH</Pill>}
                                <span className="truncate text-data font-medium text-slate-900">{ver.changeSummary || 'Khởi tạo tài liệu'}</span>
                              </div>
                              <Button size="sm" icon={Download} title="Tải phiên bản này" onClick={() => handleDownloadSpecificVersion(ver.versionNo)}>
                                Tải v{ver.versionNo}
                              </Button>
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-micro text-slate-500">
                              <span>{ver.creator?.fullName || ver.creator?.username || 'Hệ thống'}</span>
                              <span>{fmtDateTime(ver.createdAt)}</span>
                              {ver.file && <span>{Math.round(Number(ver.file.sizeBytes) / 1024)} KB</span>}
                              {ver.file && (
                                <span className="truncate max-w-[200px]" title={ver.file.checksumSha256}>
                                  SHA {ver.file.checksumSha256.substring(0, 12)}…
                                </span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Panel>
              </>
            )}

            {/* ---------------- NHẬT KÝ KIỂM TOÁN */}
            {activeTab === 'AUDIT' && (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-data font-semibold text-slate-900">Nhật ký kiểm toán</div>
                    <div className="text-micro text-slate-500 mt-0.5">
                      Ghi nhận mọi thao tác: tạo lập, ký ban hành, cập nhật phiên bản, xem và tải về.
                    </div>
                  </div>
                  <Button size="sm" icon={RefreshCw} disabled={isLoadingAudit} onClick={fetchAuditLogs}>
                    Làm mới
                  </Button>
                </div>

                {isLoadingAudit ? (
                  <LoadingRows label="Đang truy vấn nhật ký..." />
                ) : auditLogs.length === 0 ? (
                  <EmptyState title="Chưa có nhật ký nào cho tài liệu này" />
                ) : (
                  <ul className="rounded-xl border border-slate-200 bg-card divide-y divide-slate-100">
                    {auditLogs.map((log) => {
                      const badge = auditBadge(log);
                      return (
                        <li key={log.logId} className="px-3.5 py-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Pill tone={badge.tone}>{badge.label}</Pill>
                              <span className="truncate text-data font-semibold text-slate-900">{log.user?.fullName || log.user?.username || 'Hệ thống'}</span>
                              {log.user?.role && <span className="font-mono text-micro text-slate-500">{log.user.role}</span>}
                            </div>
                            <span className="font-mono text-micro text-slate-500 whitespace-nowrap">{fmtDateTime(log.createdAt)}</span>
                          </div>
                          <p className="mt-1 text-data text-slate-700">{log.detail || `Thực hiện thao tác ${log.action} trên hồ sơ`}</p>
                          <div className="mt-1 font-mono text-micro text-slate-400">
                            Mã vết #{log.logId} · IP {log.ipAddress || '—'}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}

            {/* ---------------- XEM TRƯỚC CÓ ĐÓNG DẤU DLP */}
            {activeTab === 'PREVIEW' && (
              <>
                <div className="flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-micro text-blue-800">
                  <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0" />
                  <span>Chế độ xem trước nội bộ. Mọi lần truy xuất đều được ghi vào nhật ký kiểm toán.</span>
                </div>

                <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-card p-5 min-h-[320px] select-none">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 flex flex-col justify-around -rotate-[25deg] opacity-[0.06] font-mono text-data font-bold text-slate-900 whitespace-nowrap"
                  >
                    <span className="text-center">
                      {user?.fullName} · {user?.username} · PHÒNG {dept}
                    </span>
                    <span className="text-center">{new Date().toLocaleDateString('vi-VN')} · LƯU HÀNH NỘI BỘ</span>
                    <span className="text-center">DLP · KHÔNG SAO CHÉP RA NGOÀI</span>
                  </div>

                  <div className="relative space-y-4">
                    <div className="border-b border-slate-200 pb-3">
                      <h3 className="text-base font-semibold text-slate-900">{detail.title}</h3>
                      <div className="mt-1 font-mono text-micro text-slate-500">
                        #DOC-{detail.docId} · v{detail.currentVersion}.0 · {detail.status}
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 text-xs font-medium text-slate-500">Tóm tắt nội dung</div>
                      <p className="text-data text-slate-800 leading-relaxed whitespace-pre-wrap">
                        {detail.description || 'Không có mô tả chi tiết kèm theo.'}
                      </p>
                    </div>

                    {latestVersion?.file && (
                      <dl className="space-y-1 rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-micro text-slate-600">
                        <div>
                          Tên tệp gốc: <span className="text-slate-900">{latestVersion.file.fileName}</span>
                        </div>
                        <div>Dung lượng: {Number(latestVersion.file.sizeBytes).toLocaleString('vi-VN')} byte</div>
                        <div className="break-all">Mã băm: {latestVersion.file.checksumSha256}</div>
                      </dl>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* ---------------- QUẢN TRỊ */}
            {activeTab === 'GOVERNANCE' && (
              <>
                <Panel title="Quy chế phân quyền nội bộ">
                  <div className="p-3.5 space-y-1.5 text-micro text-slate-600">
                    <p>
                      <span className="font-semibold text-slate-800">Nhân viên:</span> chỉ sửa tiêu đề và mô tả hồ sơ do chính mình tạo, không có quyền xóa.
                    </p>
                    <p>
                      <span className="font-semibold text-slate-800">Trưởng phòng và Ban Giám đốc:</span> toàn quyền chỉnh sửa, đổi trạng thái và xóa hồ sơ khỏi danh mục.
                    </p>
                  </div>
                </Panel>

                {canEditMeta ? (
                  <form onSubmit={handleSaveMetadata}>
                    <Panel title="Cập nhật thông tin văn bản">
                      <div className="p-3.5 space-y-3">
                        <Field label="Tiêu đề văn bản" htmlFor="meta-title">
                          <input id="meta-title" type="text" required value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className={INPUT} />
                        </Field>
                        <Field label="Mô tả trích yếu" htmlFor="meta-desc">
                          <textarea id="meta-desc" rows={3} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className={TEXTAREA} />
                        </Field>
                        <Field label="Trạng thái vòng đời" htmlFor="meta-status">
                          <select id="meta-status" value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className={`${SELECT} w-full`}>
                            <option value="PUBLISHED">Đang lưu hành (PUBLISHED)</option>
                            <option value="DRAFT">Bản nháp (DRAFT)</option>
                            <option value="ARCHIVED">Lưu trữ lịch sử (ARCHIVED)</option>
                          </select>
                        </Field>
                        <div className="flex justify-end">
                          <Button type="submit" variant="primary" icon={Save} disabled={isSavingMeta}>
                            Lưu thay đổi
                          </Button>
                        </div>
                      </div>
                    </Panel>
                  </form>
                ) : (
                  <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-micro text-red-800">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>Bạn không phải người tạo hồ sơ này. Chỉ người tạo hoặc Trưởng phòng mới được chỉnh sửa.</span>
                  </div>
                )}

                {isManagerOrExec && (
                  <Panel title="Thu hồi hồ sơ khỏi lưu hành">
                    <div className="p-3.5 space-y-3">
                      <p className="text-micro text-slate-600">
                        Hồ sơ sẽ chuyển sang trạng thái ĐÃ XÓA và không còn hiển thị trong danh mục hoạt động.
                      </p>
                      <div className="flex justify-end">
                        <Button variant="danger" icon={Trash2} disabled={isDeleting} onClick={() => void handleDelete()}>
                          Xác nhận xóa hồ sơ
                        </Button>
                      </div>
                    </div>
                  </Panel>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
};
