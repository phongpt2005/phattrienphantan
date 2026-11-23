import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { SharedDocumentItem } from '../types';
import { searchApi } from '../services/api';
import { useToast } from '../context/ToastContext';
import {
  X,
  FileText,
  ShieldCheck,
  ShieldAlert,
  Clock,
  Calendar,
  User,
  HardDrive,
  Download,
  Lock,
  Tag,
  Building2,
  CheckCircle2,
  AlertCircle,
  FileSearch,
  Eye,
  ExternalLink,
} from 'lucide-react';

interface SharedDocDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sharedDoc: SharedDocumentItem | null;
}

export const SharedDocDetailDrawer: React.FC<SharedDocDetailDrawerProps> = ({
  isOpen,
  onClose,
  sharedDoc,
}) => {
  const { user } = useAuth();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<'METADATA' | 'PREVIEW'>('METADATA');
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  if (!isOpen || !sharedDoc) return null;

  const calculateDaysRemaining = (expiresAtStr: string) => {
    const diffMs = new Date(expiresAtStr).getTime() - Date.now();
    const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (days <= 0) return 'Đã hết thời hạn hiệu lực';
    return `Còn lại ${days} ngày hiệu lực`;
  };

  const isDownloadPermitted = sharedDoc.permission === 'DOWNLOAD';

  const handleDownloadClick = () => {
    if (!isDownloadPermitted) {
      toast.warning('Tài liệu này được cấp quyền CHỈ XEM ONLINE (DLP). Không được phép tải về máy.');
      return;
    }

    // Tải tệp THẬT từ node chủ sở hữu qua Search Gateway (kiểm tra quyền DOWNLOAD, node ghi audit)
    searchApi
      .downloadShared(sharedDoc.shared_by_dept, sharedDoc.source_doc_id as number)
      .then(() => {
        toast.success('Đã tải xuống tệp tài liệu được ủy quyền thành công');
        setDownloadSuccess(true);
        setTimeout(() => setDownloadSuccess(false), 3000);
      })
      .catch((e) => toast.error(e.message, 'Không tải được tệp'));
  };
  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/40 transition-opacity" onClick={onClose} />

      <div className="fixed inset-y-0 right-0 pl-10 max-w-full flex">
        <div className="w-screen max-w-xl bg-white shadow-xl flex flex-col border-l border-slate-200">
          {/* Header */}
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200">
                  PHÒNG {sharedDoc.shared_by_dept} CUNG CẤP
                </span>
                <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-slate-200 text-slate-700">
                  #DOC-{sharedDoc.source_doc_id}
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                    isDownloadPermitted
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : 'bg-blue-50 text-blue-800 border-blue-200'
                  }`}
                >
                  {isDownloadPermitted ? 'ĐƯỢC PHÉP TẢI VỀ' : 'CHỈ XEM TRỰC TUYẾN - DLP'}
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-900 truncate">{sharedDoc.title}</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-200 transition-colors shrink-0"
              aria-label="Đóng"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Sub Navigation */}
          <div className="flex border-b border-slate-200 bg-white px-4 text-xs font-bold text-slate-600">
            <button
              onClick={() => setActiveTab('METADATA')}
              className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'METADATA'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <FileText className="w-3.5 h-3.5" /> Thông Tin Cấp Phép
            </button>
            <button
              onClick={() => setActiveTab('PREVIEW')}
              className={`py-2.5 px-3 border-b-2 flex items-center gap-1.5 transition-colors ${
                activeTab === 'PREVIEW'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Eye className="w-3.5 h-3.5 text-blue-600" /> Xem Trước Trực Tuyến
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
            {activeTab === 'METADATA' && (
              <>
                {/* Security DLP Badge Box */}
                <div
                  className={`p-3 rounded border flex items-start gap-2.5 ${
                    isDownloadPermitted
                      ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                      : 'bg-blue-50/60 border-blue-200 text-blue-900'
                  }`}
                >
                  {isDownloadPermitted ? (
                    <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                  )}
                  <div className="text-[11px] leading-relaxed">
                    <strong>Chính sách DLP Doanh nghiệp: </strong>
                    {isDownloadPermitted
                      ? 'Trưởng phòng sở hữu đã cấp quyền tải về bản sao phục vụ phối hợp nghiệp vụ. Mọi hành vi lưu trữ ngoài cần tuân thủ bảo mật nội bộ.'
                      : 'Tài liệu này được cấp quyền CHỈ XEM ONLINE. Hệ thống áp dụng hình mờ điện tử và ngăn chặn tải về máy tính cá nhân.'}
                  </div>
                </div>

                {/* Scope Information Cards */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-white rounded border border-slate-200">
                    <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Đơn Vị Cung Cấp</div>
                    <div className="font-semibold text-slate-900 mt-1 flex items-center gap-1.5 font-mono">
                      <Building2 className="w-3.5 h-3.5 text-slate-500" />
                      Phòng {sharedDoc.shared_by_dept}
                    </div>
                  </div>

                  <div className="p-3 bg-white rounded border border-slate-200">
                    <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Thời Hạn Hiệu Lực</div>
                    <div className="font-semibold text-amber-700 mt-1 flex items-center gap-1.5 font-mono">
                      <Clock className="w-3.5 h-3.5 text-amber-600" />
                      {calculateDaysRemaining(sharedDoc.expires_at)}
                    </div>
                  </div>

                  <div className="p-3 bg-white rounded border border-slate-200">
                    <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Ngày Cấp Quyền</div>
                    <div className="font-semibold text-slate-900 mt-1 flex items-center gap-1.5 font-mono">
                      <Calendar className="w-3.5 h-3.5 text-slate-500" />
                      {new Date(sharedDoc.created_at).toLocaleDateString('vi-VN')}
                    </div>
                  </div>

                  <div className="p-3 bg-white rounded border border-slate-200">
                    <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Chủ Sở Hữu Bản Gốc</div>
                    <div className="font-semibold text-slate-900 mt-1 flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5 text-slate-500" />
                      {sharedDoc.owner_name || `Cán bộ Phòng ${sharedDoc.shared_by_dept}`}
                    </div>
                  </div>
                </div>

                {/* Reason */}
                <div className="p-3.5 bg-slate-50 rounded border border-slate-200">
                  <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                    Lý Do Chia Sẻ Phê Chuẩn
                  </div>
                  <p className="text-slate-700 leading-relaxed">
                    {sharedDoc.reason || 'Chia sẻ phục vụ phối hợp nghiệp vụ giữa các phòng ban theo chỉ đạo.'}
                  </p>
                </div>

                {/* Description */}
                <div className="p-3.5 bg-slate-50 rounded border border-slate-200">
                  <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                    Trích Yếu Nội Dung Tài Liệu
                  </div>
                  <p className="text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {sharedDoc.description || 'Không có mô tả chi tiết kèm theo.'}
                  </p>
                </div>

                {/* Action button */}
                <div className="pt-2">
                  {isDownloadPermitted ? (
                    <button
                      onClick={handleDownloadClick}
                      className="w-full py-2.5 px-4 bg-emerald-700 hover:bg-emerald-800 text-white font-bold rounded flex items-center justify-center gap-2 transition-colors shadow-xs"
                    >
                      <Download className="w-4 h-4" />
                      {downloadSuccess ? 'Đã Tải Tệp Về Máy!' : 'Tải Xuống Bản Gốc Được Ủy Quyền'}
                    </button>
                  ) : (
                    <div className="p-3 bg-slate-100 rounded border border-slate-300 text-center text-slate-600 flex items-center justify-center gap-2 font-medium">
                      <Lock className="w-4 h-4 text-slate-500" />
                      <span>Tài liệu ở chế độ Chỉ Xem Online. Chức năng tải về bị khóa bởi chính sách DLP.</span>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* PREVIEW TAB */}
            {activeTab === 'PREVIEW' && (
              <div className="space-y-3">
                <div className="p-2.5 bg-blue-50 border border-blue-200 rounded text-blue-800 text-[11px] flex items-center gap-2">
                  <Eye className="w-4 h-4 text-blue-600 shrink-0" />
                  <span>Trình xem tài liệu được bảo vệ DLP trực tiếp trong phiên làm việc của bạn.</span>
                </div>

                <div className="relative border border-slate-300 rounded bg-white p-6 min-h-[340px] overflow-hidden select-none">
                  {/* Anti-leak watermark overlay */}
                  <div className="absolute inset-0 pointer-events-none opacity-5 flex flex-col justify-around rotate-[-25deg] select-none">
                    <div className="text-2xl font-bold font-mono text-center">
                      {user?.fullName} | PHÒNG {sharedDoc.shared_with_dept} | BẢO MẬT
                    </div>
                    <div className="text-2xl font-bold font-mono text-center">
                      NGUỒN: PHÒNG {sharedDoc.shared_by_dept} | {new Date().toLocaleDateString('vi-VN')}
                    </div>
                    <div className="text-2xl font-bold font-mono text-center">
                      MÃ HỒ SƠ #{sharedDoc.source_doc_id} | CHỈ XEM TRỰC TUYẾN
                    </div>
                  </div>

                  <div className="relative z-10 space-y-4">
                    <div className="border-b border-slate-200 pb-3">
                      <h3 className="text-sm font-bold text-slate-900">{sharedDoc.title}</h3>
                      <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                        Phòng ban nguồn: {sharedDoc.shared_by_dept} | Quyền hạn: {sharedDoc.permission}
                      </div>
                    </div>

                    <div>
                      <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                        Nội dung trích lược
                      </h4>
                      <p className="text-slate-800 leading-relaxed whitespace-pre-wrap">
                        {sharedDoc.description || 'Nội dung hồ sơ liên phòng ban đã được xác thực toàn vẹn.'}
                      </p>
                    </div>

                    <div className="p-3 bg-slate-50 rounded border border-slate-200 font-mono text-[11px] space-y-1">
                      <div>Tên tệp gốc: {sharedDoc.file_name || 'document_archive.bin'}</div>
                      <div>Mã chỉ mục phân tán: #DOC-{sharedDoc.source_doc_id}</div>
                      <div>Hiệu lực đến: {new Date(sharedDoc.expires_at).toLocaleString('vi-VN')}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
