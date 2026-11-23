import { useDepartments, deptName, deptTone, demoUsername } from '../context/DepartmentContext';
import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { searchApi } from '../services/api';
import { SearchResultItem } from '../types';
import { useToast } from '../context/ToastContext';
import { Send, X, Check, Loader2, Clock, ShieldAlert, FileText, Building2 } from 'lucide-react';

interface RequestAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  centralDocId?: number;
  sourceDocId?: number;
  docTitle?: string;
  targetDept?: string;
  onSuccess?: () => void;
}

export const RequestAccessModal: React.FC<RequestAccessModalProps> = ({
  isOpen,
  onClose,
  centralDocId: initialCentralDocId,
  sourceDocId: initialSourceDocId,
  docTitle: initialDocTitle,
  targetDept: initialTargetDept,
  onSuccess,
}) => {
  const { user } = useAuth();
  const toast = useToast();
  const currentDept = user?.departmentCode ?? '';
  const { others } = useDepartments();
  const defaultTargetDept = others(currentDept)[0] ?? '';

  const [selectedCentralDocId, setSelectedCentralDocId] = useState<number | undefined>(initialCentralDocId);
  const [selectedTargetDept, setSelectedTargetDept] = useState<string>(initialTargetDept || defaultTargetDept);
  const [selectedTitle, setSelectedTitle] = useState<string>(initialDocTitle || '');

  // Danh mục tài liệu phòng đối tác để chọn nếu chưa chỉ định sẵn tài liệu
  const [catalog, setCatalog] = useState<SearchResultItem[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);

  const [requestedDays, setRequestedDays] = useState(7);
  const [requestedPermission, setRequestedPermission] = useState<'VIEW' | 'DOWNLOAD'>('VIEW');
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedCentralDocId(initialCentralDocId);
      setSelectedTargetDept(initialTargetDept || defaultTargetDept);
      setSelectedTitle(initialDocTitle || '');
      setErrorMessage(null);
      setReason('');

      // Nếu chưa có tài liệu chỉ định sẵn, nạp danh mục văn bản của phòng đối tác
      if (!initialCentralDocId) {
        setIsLoadingCatalog(true);
        searchApi
          .getCatalog(currentDept)
          .then((items) => {
            setCatalog(items || []);
            if (items && items.length > 0) {
              setSelectedCentralDocId(items[0].central_doc_id);
              setSelectedTitle(items[0].title);
              setSelectedTargetDept(items[0].dept_code);
            }
          })
          .catch((err) => {
            console.error('Lỗi nạp danh mục đối tác:', err);
          })
          .finally(() => {
            setIsLoadingCatalog(false);
          });
      }
    }
  }, [isOpen, initialCentralDocId, initialDocTitle, initialTargetDept, currentDept, defaultTargetDept]);

  if (!isOpen) return null;

  const handleSelectCatalogDoc = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = Number(e.target.value);
    const item = catalog.find((c) => c.central_doc_id === id);
    if (item) {
      setSelectedCentralDocId(item.central_doc_id);
      setSelectedTitle(item.title);
      setSelectedTargetDept(item.dept_code);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCentralDocId) {
      setErrorMessage('Vui lòng chọn tài liệu bạn muốn xin cấp quyền.');
      toast.warning('Vui lòng chọn tài liệu');
      return;
    }

    if (!reason.trim()) {
      setErrorMessage('Vui lòng nhập lý do xin cấp quyền xem tài liệu.');
      toast.warning('Vui lòng nhập lý do xin cấp quyền');
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      await searchApi.createAccessRequest({
        centralDocId: selectedCentralDocId,
        sourceDocId: initialSourceDocId,
        targetDept: selectedTargetDept,
        requesterDept: currentDept,
        requesterUsername: user?.fullName || user?.username || 'Staff',
        requestedDays,
        requestedPermission,
        reason: reason.trim(),
      });

      toast.success(
        `Đã gửi đơn xin cấp quyền [${requestedPermission === 'DOWNLOAD' ? 'Xem & Tải Về' : 'Chỉ Xem Online'}] tới Trưởng Phòng ${selectedTargetDept}!`,
      );
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Lỗi gửi yêu cầu xin cấp quyền.';
      const text = Array.isArray(msg) ? msg.join(', ') : msg;
      setErrorMessage(text);
      toast.error(text, 'Lỗi gửi yêu cầu');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded max-w-lg w-full p-5 shadow-xl border border-slate-200 space-y-4 animate-in fade-in duration-150">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-blue-50 text-blue-700 flex items-center justify-center">
              <Send className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-slate-900">Gửi Đơn Xin Cấp Quyền Truy Cập</h3>
              <p className="text-[11px] text-slate-500 font-mono">
                Từ Phòng {currentDept} &rarr; Trình Trưởng Phòng {selectedTargetDept} phê chuẩn
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Notice */}
        <div className="p-3 bg-blue-50/60 border border-blue-200 rounded text-xs text-blue-800 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
          <span className="text-[11px] leading-relaxed">
            Bạn đang yêu cầu quyền truy cập tài liệu thuộc thẩm quyền quản lý của{' '}
            <strong>Phòng {selectedTargetDept}</strong>. Sau khi gửi, đơn sẽ được gửi đến Trưởng phòng {selectedTargetDept} để duyệt cấp quyền trực tuyến.
          </span>
        </div>

        {/* Error */}
        {errorMessage && (
          <div className="p-2.5 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
            {errorMessage}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          {/* Document Selection */}
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Tài liệu phòng bên cạnh yêu cầu xem *
            </label>
            {initialDocTitle ? (
              <div className="p-2.5 bg-slate-50 rounded border border-slate-200 font-semibold text-slate-800 leading-snug">
                {initialDocTitle}
                <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                  Phòng sở hữu: {selectedTargetDept} | Mã chỉ mục: #CENTRAL-{selectedCentralDocId}
                </div>
              </div>
            ) : isLoadingCatalog ? (
              <div className="p-2.5 bg-slate-50 rounded border border-slate-200 text-slate-400 text-center flex items-center justify-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang nạp danh mục tài liệu Phòng {selectedTargetDept}...
              </div>
            ) : catalog.length === 0 ? (
              <div className="p-2.5 bg-amber-50 rounded border border-amber-200 text-amber-800 text-[11px]">
                Phòng {selectedTargetDept} hiện chưa có tài liệu nào được đồng bộ lên trung tâm.
              </div>
            ) : (
              <select
                value={selectedCentralDocId}
                onChange={handleSelectCatalogDoc}
                className="w-full px-2.5 py-2 rounded border border-slate-300 bg-white font-semibold text-slate-900"
              >
                {catalog.map((doc) => (
                  <option key={doc.central_doc_id} value={doc.central_doc_id}>
                    [{doc.dept_code}] {doc.title} (#CENTRAL-{doc.central_doc_id})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Thời hạn xin xem
              </label>
              <select
                value={requestedDays}
                onChange={(e) => setRequestedDays(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 rounded border border-slate-300 bg-white font-medium text-slate-800 font-mono"
              >
                <option value={3}>3 ngày</option>
                <option value={7}>7 ngày (Mặc định)</option>
                <option value={14}>14 ngày</option>
                <option value={30}>30 ngày</option>
                <option value={90}>90 ngày</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Mức quyền đề xuất
              </label>
              <select
                value={requestedPermission}
                onChange={(e) => setRequestedPermission(e.target.value as any)}
                className="w-full px-2.5 py-1.5 rounded border border-slate-300 bg-white font-bold text-slate-800"
              >
                <option value="VIEW">Chỉ xem trực tuyến (DLP)</option>
                <option value="DOWNLOAD">Xem và tải tệp về máy</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Lý do công tác / Căn cứ xin cấp quyền *
            </label>
            <textarea
              rows={3}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Nêu rõ mục đích nghiệp vụ (Ví dụ: Đối soát hóa đơn với phòng Kế toán, tổng hợp số liệu báo cáo quý...)"
              className="w-full px-2.5 py-1.5 rounded border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-white border border-slate-300 rounded text-slate-700 hover:bg-slate-50 font-medium"
            >
              Hủy bỏ
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !selectedCentralDocId}
              className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded flex items-center gap-1.5 disabled:opacity-50 transition-colors shadow-xs"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Đang gửi đơn...
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  Gửi Yêu Cầu Xin Cấp Quyền
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
