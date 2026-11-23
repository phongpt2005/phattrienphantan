import { deptName } from '../context/DepartmentContext';
import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { documentApi } from '../services/api';
import { DocumentDetail, DocumentAuditLogEntry } from '../types';
import { useToast } from '../context/ToastContext';
import {
  X,
  FileText,
  ShieldCheck,
  Copy,
  Check,
  Download,
  Share2,
  Calendar,
  User,
  HardDrive,
  Layers,
  Tag,
  Loader2,
  Plus,
  Trash2,
  UploadCloud,
  AlertTriangle,
  Eye,
  FileCheck,
  Edit3,
  Clock,
  ShieldAlert,
  Save,
  History,
  Activity,
  RefreshCw,
} from 'lucide-react';

interface DocumentDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  docId: number | null;
  dept: string;
  onDownload: (docId: number) => void;
  onShare: (docId: number, title: string) => void;
  onRefresh?: () => void;
}

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
  const [activeTab, setActiveTab] = useState<'METADATA' | 'VERSIONS' | 'AUDIT' | 'PREVIEW' | 'GOVERNANCE'>('METADATA');

  // Audit Logs
  const [auditLogs, setAuditLogs] = useState<DocumentAuditLogEntry[]>([]);
  const [isLoadingAudit, setIsLoadingAudit] = useState(false);

  // Thêm phiên bản mới (Version Control)
  const [showAddVersion, setShowAddVersion] = useState(false);
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [isSubmittingVersion, setIsSubmittingVersion] = useState(false);

  // Chỉnh sửa thông tin tài liệu
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editStatus, setEditStatus] = useState('PUBLISHED');
  const [isSavingMeta, setIsSavingMeta] = useState(false);

  // Xóa tài liệu
  const [isDeleting, setIsDeleting] = useState(false);

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

  useEffect(() => {
    if (isOpen && docId) {
      fetchDetail();
      setShowAddVersion(false);
      setIsEditingMeta(false);
      setVersionFile(null);
      setChangeNote('');
      setActiveTab('METADATA');
    } else {
      setDetail(null);
      setAuditLogs([]);
    }
  }, [isOpen, docId, dept]);

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
      formData.append(
        'changeNote',
        changeNote.trim() || `Cập nhật phiên bản v${(detail?.currentVersion || 1) + 1}.0`,
      );

      await documentApi.addVersion(dept, docId, formData);
      toast.success('Đã phát hành phiên bản mới thành công!');
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
      setIsEditingMeta(false);
      fetchDetail();
      if (onRefresh) onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message, 'Lỗi cập nhật hồ sơ');
    } finally {
      setIsSavingMeta(false);
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

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/40 transition-opacity" onClick={onClose} />

      <div className="fixed inset-y-0 right-0 pl-10 max-w-full flex">
        <div className="w-screen max-w-2xl bg-white shadow-xl flex flex-col border-l border-slate-200">
          {/* Header */}
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-slate-900 text-white">
                  #DOC-{docId}
                </span>
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                    detail?.accessLevel === 'COMPANY'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : detail?.accessLevel === 'CONFIDENTIAL'
                      ? 'bg-purple-50 text-purple-800 border-purple-200'
                      : 'bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  {detail?.accessLevel === 'COMPANY'
                    ? 'TOÀN DOANH NGHIỆP'
                    : detail?.accessLevel === 'CONFIDENTIAL'
                    ? 'BẢO MẬT CAO'
                    : 'NỘI BỘ PHÒNG BAN'}
                </span>
                <span className="font-mono text-xs px-2 py-0.5 rounded font-bold bg-slate-200 text-slate-800">
                  v{detail?.currentVersion || 1}.0
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-900 truncate">
                {detail?.title || 'Đang tải thông tin...'}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-200 transition-colors shrink-0"
              aria-label="Đóng"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tab Navigation */}
          <div className="flex border-b border-slate-200 bg-white px-4 text-xs font-bold text-slate-600">
            <button
              onClick={() => setActiveTab('METADATA')}
              className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'METADATA'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <FileText className="w-3.5 h-3.5" /> Tổng Quan
            </button>
            <button
              onClick={() => setActiveTab('VERSIONS')}
              className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'VERSIONS'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Layers className="w-3.5 h-3.5" /> Phiên Bản ({detail?.versions?.length || 0})
            </button>
            <button
              onClick={() => {
                setActiveTab('AUDIT');
                fetchAuditLogs();
              }}
              className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'AUDIT'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <History className="w-3.5 h-3.5 text-indigo-600" /> Vết Kiểm Toán ({auditLogs.length})
            </button>
            <button
              onClick={() => setActiveTab('PREVIEW')}
              className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'PREVIEW'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Eye className="w-3.5 h-3.5 text-blue-600" /> Xem Trước DLP
            </button>
            <button
              onClick={() => setActiveTab('GOVERNANCE')}
              className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'GOVERNANCE'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5 text-amber-600" /> Quản Trị & Phân Quyền
            </button>
          </div>

          {/* Drawer Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {isLoading ? (
              <div className="py-20 text-center text-slate-400">
                <Loader2 className="w-7 h-7 animate-spin mx-auto mb-2 text-brand-600" />
                <span className="text-xs font-semibold">Đang tải thông tin tài liệu...</span>
              </div>
            ) : !detail ? (
              <div className="py-20 text-center text-slate-400 text-xs">Không tìm thấy thông tin tài liệu.</div>
            ) : (
              <>
                {/* ========================================================================= */}
                {/* 1. TAB METADATA */}
                {/* ========================================================================= */}
                {activeTab === 'METADATA' && (
                  <div className="space-y-4 text-xs">
                    {/* Draft Notice & Approval Banner */}
                    {detail.status === 'DRAFT' && (
                      <div className="p-3 bg-amber-50 border border-amber-300 rounded flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 text-amber-900">
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-amber-600 shrink-0" />
                          <div>
                            <span className="font-bold text-xs uppercase tracking-wider">HỒ SƠ BẢN THẢO (CHƯA BAN HÀNH)</span>
                            <p className="text-[11px] text-amber-800 mt-0.5">
                              Hồ sơ do nhân viên lập, đang chờ Trưởng phòng thẩm định và ký duyệt ban hành.
                            </p>
                          </div>
                        </div>
                        {isManagerOrExec && (
                          <button
                            onClick={async () => {
                              try {
                                await documentApi.approveDocument(dept, detail.docId);
                                toast.success(`Đã KÝ DUYỆT BAN HÀNH văn bản "${detail.title}"!`);
                                fetchDetail();
                                if (onRefresh) onRefresh();
                              } catch (err: any) {
                                toast.error(err.response?.data?.message || err.message, 'Lỗi phê duyệt');
                              }
                            }}
                            className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded font-bold text-xs flex items-center gap-1.5 transition-colors shrink-0 shadow-xs"
                          >
                            <FileCheck className="w-3.5 h-3.5" /> Ký Duyệt Ban Hành
                          </button>
                        )}
                      </div>
                    )}

                    {/* File Verification Card (SHA-256) */}
                    {latestVersion?.file && (
                      <div className="bg-slate-50 p-3.5 rounded border border-slate-200 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                            Toàn Vẹn Dữ Liệu SHA-256 Checksum
                          </span>
                          <span className="text-[10px] font-bold font-mono px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded">
                            VERIFIED
                          </span>
                        </div>
                        <div className="flex items-center gap-2 bg-white p-2 rounded border border-slate-200">
                          <code className="text-[11px] font-mono text-slate-700 truncate flex-1 select-all">
                            {latestVersion.file.checksumSha256}
                          </code>
                          <button
                            onClick={() => handleCopySha(latestVersion.file?.checksumSha256 || '')}
                            className="p-1 hover:bg-slate-100 rounded text-slate-500 hover:text-slate-800 transition-colors shrink-0"
                            title="Sao chép mã SHA-256"
                          >
                            {copiedSha ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                          <span>Kích thước: {Math.round(Number(latestVersion.file.sizeBytes) / 1024)} KB</span>
                          <span>Định dạng: {latestVersion.file.mimeType}</span>
                        </div>
                      </div>
                    )}

                    {/* Meta Fields Grid */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 bg-white rounded border border-slate-200">
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Người Khởi Tạo</div>
                        <div className="font-semibold text-slate-900 mt-1 flex items-center gap-1.5">
                          <User className="w-3.5 h-3.5 text-slate-500" />
                          {detail.creator?.fullName || detail.creator?.username || 'Hệ thống'}
                        </div>
                      </div>

                      <div className="p-3 bg-white rounded border border-slate-200">
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Ngày Khởi Tạo</div>
                        <div className="font-semibold text-slate-900 mt-1 flex items-center gap-1.5 font-mono">
                          <Calendar className="w-3.5 h-3.5 text-slate-500" />
                          {new Date(detail.createdAt).toLocaleDateString('vi-VN')}
                        </div>
                      </div>

                      <div className="p-3 bg-white rounded border border-slate-200">
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Danh Mục Nghiệp Vụ</div>
                        <div className="font-semibold text-slate-900 mt-1 flex items-center gap-1.5">
                          <Tag className="w-3.5 h-3.5 text-slate-500" />
                          {detail.category?.name || 'Hồ sơ chung'}
                        </div>
                      </div>

                      <div className="p-3 bg-white rounded border border-slate-200">
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Kho Lưu Trữ</div>
                        <div className="font-semibold text-slate-900 mt-1 flex items-center gap-1.5">
                          <HardDrive className="w-3.5 h-3.5 text-slate-500" />
                          {`Kho ${deptName(dept).replace(/^Phòng\s+/i, '')}`}
                        </div>
                      </div>
                    </div>

                    {/* Description Box */}
                    <div className="p-3.5 bg-slate-50 rounded border border-slate-200">
                      <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                        Mô Tả Trích Yếu Nội Dung
                      </div>
                      <p className="text-slate-700 leading-relaxed whitespace-pre-wrap">
                        {detail.description || 'Không có mô tả chi tiết cho văn bản này.'}
                      </p>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center gap-2 pt-2">
                      <button
                        onClick={() => onDownload(detail.docId)}
                        className="flex-1 py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white rounded font-bold text-xs flex items-center justify-center gap-2 transition-colors shadow-xs"
                      >
                        <Download className="w-4 h-4" /> Tải Xuống Bản Mới Nhất (v{detail.currentVersion}.0)
                      </button>
                      {isManagerOrExec && (
                        <button
                          onClick={() => onShare(detail.docId, detail.title)}
                          className="py-2 px-3 bg-blue-50 hover:bg-blue-100 text-blue-800 border border-blue-200 rounded font-bold text-xs flex items-center gap-1.5 transition-colors"
                        >
                          <Share2 className="w-4 h-4 text-blue-600" /> Chia Sẻ Chéo
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* ========================================================================= */}
                {/* 2. TAB VERSIONS (LỊCH SỬ PHIÊN BẢN) */}
                {/* ========================================================================= */}
                {activeTab === 'VERSIONS' && (
                  <div className="space-y-4 text-xs">
                    {/* Add Version Button & Form */}
                    <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                      <div>
                        <h4 className="font-bold text-slate-900">Kiểm Soát Phiên Bản (Version Control)</h4>
                        <p className="text-[11px] text-slate-500">Mọi nhân viên trong phòng đều có quyền phát hành bản sửa đổi.</p>
                      </div>
                      <button
                        onClick={() => setShowAddVersion(!showAddVersion)}
                        className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded font-bold text-[11px] flex items-center gap-1.5 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" /> Tải Phiên Bản Mới
                      </button>
                    </div>

                    {showAddVersion && (
                      <form onSubmit={handleUploadVersion} className="p-3.5 bg-slate-50 rounded border border-slate-300 space-y-3">
                        <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                          <UploadCloud className="w-4 h-4 text-brand-600" />
                          Phát Hành Phiên Bản v{(detail.currentVersion || 1) + 1}.0
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                            Chọn tệp thay thế *
                          </label>
                          <input
                            type="file"
                            required
                            onChange={(e) => setVersionFile(e.target.files ? e.target.files[0] : null)}
                            className="block w-full text-xs text-slate-500 file:mr-3 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-slate-200 file:text-slate-700 hover:file:bg-slate-300 cursor-pointer"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                            Ghi chú thay đổi (Change Summary)
                          </label>
                          <input
                            type="text"
                            value={changeNote}
                            onChange={(e) => setChangeNote(e.target.value)}
                            placeholder="Ví dụ: Cập nhật điều khoản thanh toán..."
                            className="w-full px-2.5 py-1.5 rounded border border-slate-300 text-xs text-slate-900"
                          />
                        </div>
                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setShowAddVersion(false)}
                            className="px-2.5 py-1 bg-white border border-slate-300 rounded text-slate-600 hover:bg-slate-100"
                          >
                            Hủy bỏ
                          </button>
                          <button
                            type="submit"
                            disabled={isSubmittingVersion}
                            className="px-3 py-1 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded flex items-center gap-1.5 disabled:opacity-50"
                          >
                            {isSubmittingVersion ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Lưu Phiên Bản'}
                          </button>
                        </div>
                      </form>
                    )}

                    {/* Version History List */}
                    <div className="space-y-2.5">
                      {detail.versions?.map((ver, idx) => {
                        const isLatest = idx === 0;
                        return (
                          <div
                            key={ver.versionNo}
                            className={`p-3 rounded border transition-colors ${
                              isLatest ? 'bg-blue-50/40 border-blue-200' : 'bg-white border-slate-200'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`px-2 py-0.5 rounded font-mono font-bold text-[11px] ${
                                    isLatest
                                      ? 'bg-blue-600 text-white'
                                      : 'bg-slate-100 text-slate-700 border border-slate-200'
                                  }`}
                                >
                                  v{ver.versionNo}.0
                                </span>
                                {isLatest && (
                                  <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.2 rounded uppercase">
                                    Hiện Hành
                                  </span>
                                )}
                                <span className="font-semibold text-slate-900">
                                  {ver.changeSummary || 'Khởi tạo tài liệu'}
                                </span>
                              </div>
                              <button
                                onClick={() => handleDownloadSpecificVersion(ver.versionNo)}
                                className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-white hover:bg-slate-100 rounded border border-slate-300 flex items-center gap-1 shadow-xs"
                                title="Tải phiên bản này"
                              >
                                <Download className="w-3 h-3 text-slate-500" /> Tải v{ver.versionNo}
                              </button>
                            </div>

                            <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-500 font-mono flex-wrap">
                              <span>Người sửa: {ver.creator?.fullName || ver.creator?.username || 'Hệ thống'}</span>
                              <span>|</span>
                              <span>Ngày: {new Date(ver.createdAt).toLocaleString('vi-VN')}</span>
                              {ver.file && (
                                <>
                                  <span>|</span>
                                  <span>{Math.round(Number(ver.file.sizeBytes) / 1024)} KB</span>
                                  <span>|</span>
                                  <span className="truncate max-w-[150px]" title={ver.file.checksumSha256}>
                                    SHA: {ver.file.checksumSha256.substring(0, 10)}...
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ========================================================================= */}
                {/* 3. TAB AUDIT (VẾT KIỂM TOÁN NỘI BỘ BẢO MẬT) */}
                {/* ========================================================================= */}
                {activeTab === 'AUDIT' && (
                  <div className="space-y-3 text-xs">
                    <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded">
                      <div>
                        <div className="font-bold text-slate-900 flex items-center gap-1.5">
                          <History className="w-4 h-4 text-indigo-600" />
                          Sổ Nhật Ký Kiểm Toán (Immutable Audit Ledger)
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Ghi nhận minh bạch mọi thao tác: Tạo lập, Duyệt ban hành, Cập nhật phiên bản, Xem và Tải về.
                        </p>
                      </div>
                      <button
                        onClick={fetchAuditLogs}
                        disabled={isLoadingAudit}
                        className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-white hover:bg-slate-100 rounded border border-slate-300 flex items-center gap-1 shadow-xs transition-colors"
                        title="Tải lại nhật ký kiểm toán"
                      >
                        <RefreshCw className={`w-3 h-3 text-slate-500 ${isLoadingAudit ? 'animate-spin' : ''}`} />
                        Làm Mới
                      </button>
                    </div>

                    {isLoadingAudit ? (
                      <div className="py-8 text-center text-slate-400">
                        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-600" />
                        <span className="text-xs">Đang truy vấn vết kiểm toán từ cơ sở dữ liệu phân tán...</span>
                      </div>
                    ) : auditLogs.length === 0 ? (
                      <div className="py-8 text-center text-slate-400">
                        <Activity className="w-6 h-6 mx-auto mb-1 opacity-50" />
                        Chưa có lịch sử kiểm toán nào được ghi nhận cho tài liệu này.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {auditLogs.map((log) => {
                          const isApprove = log.detail?.includes('phê duyệt') || log.detail?.includes('ban hành');
                          let badgeClass = 'bg-slate-100 text-slate-800 border-slate-200';
                          let badgeText = log.action;

                          if (isApprove) {
                            badgeClass = 'bg-emerald-100 text-emerald-800 border-emerald-300 font-bold';
                            badgeText = 'KÝ DUYỆT';
                          } else if (log.action === 'CREATE') {
                            badgeClass = 'bg-emerald-50 text-emerald-800 border-emerald-200';
                            badgeText = 'TẠO MỚI';
                          } else if (log.action === 'UPDATE') {
                            badgeClass = 'bg-blue-50 text-blue-800 border-blue-200';
                            badgeText = 'CẬP NHẬT';
                          } else if (log.action === 'DOWNLOAD') {
                            badgeClass = 'bg-purple-50 text-purple-800 border-purple-200';
                            badgeText = 'TẢI VỀ';
                          } else if (log.action === 'VIEW') {
                            badgeClass = 'bg-sky-50 text-sky-800 border-sky-200';
                            badgeText = 'TRUY CẬP';
                          } else if (log.action === 'DELETE') {
                            badgeClass = 'bg-red-50 text-red-800 border-red-200';
                            badgeText = 'THU HỒI';
                          }

                          return (
                            <div
                              key={log.logId}
                              className="p-3 bg-white rounded border border-slate-200 hover:border-slate-300 transition-colors shadow-2xs space-y-1.5"
                            >
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div className="flex items-center gap-2">
                                  <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold border ${badgeClass}`}>
                                    {badgeText}
                                  </span>
                                  <span className="font-semibold text-slate-900">
                                    {log.user?.fullName || log.user?.username || 'Hệ thống'}
                                  </span>
                                  {log.user?.role && (
                                    <span className="px-1.5 py-0.2 rounded text-[10px] bg-slate-100 text-slate-600 font-mono">
                                      {log.user.role}
                                    </span>
                                  )}
                                </div>
                                <span className="font-mono text-[11px] text-slate-500">
                                  {new Date(log.createdAt).toLocaleString('vi-VN')}
                                </span>
                              </div>

                              <p className="text-slate-700 leading-snug">
                                {log.detail || `Thực thi thao tác ${log.action} trên hồ sơ`}
                              </p>

                              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                                <span>Mã vết: #{log.logId}</span>
                                <span>|</span>
                                <span>Địa chỉ IP: {log.ipAddress || '127.0.0.1'}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* ========================================================================= */}
                {/* 4. TAB PREVIEW (XEM TRƯỚC AN TOÀN DLP) */}
                {/* ========================================================================= */}
                {activeTab === 'PREVIEW' && (
                  <div className="space-y-3 text-xs">
                    <div className="p-2.5 bg-blue-50 border border-blue-200 rounded text-blue-800 text-[11px] flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
                      <span>
                        Chế độ xem trước tài liệu nội bộ phòng ban. Mọi hành vi truy xuất đều được ghi nhật ký kiểm toán (Audit Log).
                      </span>
                    </div>

                    {/* Secure Preview Box with DLP Watermark */}
                    <div className="relative border border-slate-300 rounded bg-white p-6 min-h-[320px] overflow-hidden select-none">
                      {/* Watermark overlay */}
                      <div className="absolute inset-0 pointer-events-none opacity-5 flex flex-col justify-around rotate-[-25deg] select-none">
                        <div className="text-2xl font-bold font-mono text-center">
                          {user?.fullName} | {user?.username} | CONFIDENTIAL
                        </div>
                        <div className="text-2xl font-bold font-mono text-center">
                          PHÒNG {dept} | {new Date().toLocaleDateString('vi-VN')}
                        </div>
                        <div className="text-2xl font-bold font-mono text-center">
                          LƯU HÀNH NỘI BỘ PHÒNG {dept}
                        </div>
                      </div>

                      {/* Content representation */}
                      <div className="relative z-10 space-y-4">
                        <div className="border-b border-slate-200 pb-3">
                          <h3 className="text-sm font-bold text-slate-900">{detail.title}</h3>
                          <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                            Mã số: #DOC-{detail.docId} | Phiên bản: v{detail.currentVersion}.0 | Trạng thái: {detail.status}
                          </div>
                        </div>

                        <div>
                          <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                            Tóm tắt nội dung văn bản
                          </h4>
                          <p className="text-slate-800 leading-relaxed whitespace-pre-wrap">
                            {detail.description || 'Không có mô tả chi tiết kèm theo.'}
                          </p>
                        </div>

                        {latestVersion?.file && (
                          <div className="p-3 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] space-y-1">
                            <div>Tên tệp gốc: <strong>{latestVersion.file.fileName}</strong></div>
                            <div>Đường dẫn lưu trữ: <code>{latestVersion.file.storagePath}</code></div>
                            <div>Dung lượng: {Number(latestVersion.file.sizeBytes).toLocaleString()} bytes</div>
                            <div>Mã băm toàn vẹn: <code className="text-slate-600">{latestVersion.file.checksumSha256}</code></div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* ========================================================================= */}
                {/* 4. TAB GOVERNANCE (QUẢN TRỊ & PHÂN QUYỀN NỘI BỘ) */}
                {/* ========================================================================= */}
                {activeTab === 'GOVERNANCE' && (
                  <div className="space-y-4 text-xs">
                    {/* Role & Ownership Notice */}
                    <div className="p-3 bg-slate-50 rounded border border-slate-200 space-y-1.5">
                      <div className="font-bold text-slate-900 flex items-center gap-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 text-slate-600" />
                        Quy Chế Phân Quyền Nội Bộ (Intra-Department Governance)
                      </div>
                      <div className="text-[11px] text-slate-600 space-y-1">
                        <div>
                          | <strong>Nhân viên (Staff):</strong> Chỉ được chỉnh sửa tiêu đề/mô tả của hồ sơ do chính mình tạo; không có quyền xóa.
                        </div>
                        <div>
                          | <strong>Trưởng phòng (Manager) / Ban Giám Đốc:</strong> Toàn quyền chỉnh sửa, chuyển trạng thái và xóa hồ sơ khỏi danh mục.
                        </div>
                      </div>
                    </div>

                    {/* Edit Metadata Form */}
                    {canEditMeta ? (
                      <form onSubmit={handleSaveMetadata} className="p-4 bg-white rounded border border-slate-200 space-y-3">
                        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                          <h4 className="font-bold text-slate-900 flex items-center gap-1.5">
                            <Edit3 className="w-3.5 h-3.5 text-brand-600" />
                            Cập Nhật Thông Tin Văn Bản
                          </h4>
                          <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                            QUYỀN HẠN HỢP LỆ
                          </span>
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                            Tiêu đề văn bản *
                          </label>
                          <input
                            type="text"
                            required
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            className="w-full px-2.5 py-1.5 rounded border border-slate-300 text-xs font-semibold text-slate-900"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                            Mô tả trích yếu
                          </label>
                          <textarea
                            rows={3}
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            className="w-full px-2.5 py-1.5 rounded border border-slate-300 text-xs text-slate-900"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                            Trạng thái vòng đời hồ sơ
                          </label>
                          <select
                            value={editStatus}
                            onChange={(e) => setEditStatus(e.target.value)}
                            className="text-xs px-2.5 py-1.5 rounded border border-slate-300 bg-white font-medium"
                          >
                            <option value="PUBLISHED">Đang lưu hành (PUBLISHED)</option>
                            <option value="DRAFT">Bản nháp (DRAFT)</option>
                            <option value="ARCHIVED">Lưu trữ lịch sử (ARCHIVED)</option>
                          </select>
                        </div>

                        <div className="pt-2 flex justify-end">
                          <button
                            type="submit"
                            disabled={isSavingMeta}
                            className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                          >
                            {isSavingMeta ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            Lưu Thay Đổi
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-xs flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>Bạn không phải là người tạo hồ sơ này. Chỉ người tạo hoặc Trưởng phòng mới có quyền chỉnh sửa.</span>
                      </div>
                    )}

                    {/* Delete Action (Manager/Exec Only) */}
                    {isManagerOrExec && (
                      <div className="p-4 bg-red-50/50 rounded border border-red-200 space-y-2">
                        <div className="font-bold text-red-900 flex items-center gap-1.5">
                          <Trash2 className="w-3.5 h-3.5 text-red-600" />
                          Thu Hồi & Vô Hiệu Hóa Hồ Sơ (Trưởng Phòng)
                        </div>
                        <p className="text-[11px] text-red-700">
                          Hành động này sẽ chuyển trạng thái văn bản sang DELETED và ngừng hiển thị trong toàn bộ danh mục hoạt động.
                        </p>
                        <button
                          onClick={handleDelete}
                          disabled={isDeleting}
                          className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded flex items-center gap-1.5 transition-colors disabled:opacity-50"
                        >
                          {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          Xác Nhận Xóa Hồ Sơ Khỏi Lưu Hành
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
