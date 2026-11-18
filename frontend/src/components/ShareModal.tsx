import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { searchApi } from '../services/api';
import { useToast } from '../context/ToastContext';
import { Share2, X, Check, Loader2, Calendar, ShieldCheck } from 'lucide-react';
import { useDepartments, deptName, deptTone, demoUsername } from '../context/DepartmentContext';

interface ShareModalProps {
  isOpen: boolean;
  docId: number | null;
  docTitle: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({ isOpen, docId, docTitle, onClose, onSuccess }) => {
  const { user } = useAuth();
  const toast = useToast();
  const currentDept = user?.departmentCode ?? '';
  const { others } = useDepartments();
  const oppositeDept = others(currentDept)[0] ?? '';

  const [targetDept, setTargetDept] = useState<string>(oppositeDept);
  const [days, setDays] = useState(7);
  const [permission, setPermission] = useState<'VIEW' | 'DOWNLOAD'>('VIEW');
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setTargetDept(oppositeDept);
    setErrorMessage(null);
  }, [currentDept, oppositeDept, isOpen]);

  if (!isOpen || !docId) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      // Sổ chia sẻ nằm tại node của CHÍNH phòng chủ tài liệu (không đi qua CSDL trung tâm)
      const result = await searchApi.createShare(currentDept, {
        docId,
        sharedWithDept: targetDept,
        permission,
        reason: reason || `Chia sẻ phối hợp công tác giữa ${currentDept} và ${targetDept}`,
        expiresInDays: days,
      });

      const target = targetDept === '*' ? 'Toàn công ty' : targetDept;
      // Server báo rõ: CREATED (cấp mới) hay EXTENDED (đã có lượt đang hiệu lực: đổi quyền/gia hạn)
      if (result?.action === 'EXTENDED') {
        toast.success(`Đã gia hạn và cập nhật quyền truy cập cho "${target}" (${permission === 'DOWNLOAD' ? 'xem và tải' : 'chỉ xem'}, ${days} ngày)`, 'Đã gia hạn chia sẻ');
      } else {
        toast.success(`Đã cấp quyền truy cập cho "${target}" (${days} ngày)`, 'Đã cấp quyền');
      }
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Lỗi cấp quyền chia sẻ';
      const text = Array.isArray(msg) ? msg.join(', ') : msg;
      setErrorMessage(text);
      toast.error(text, 'Lỗi chia sẻ');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded max-w-md w-full p-5 shadow-xl border border-slate-200 space-y-4 animate-in fade-in duration-150">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-blue-50 text-blue-700 flex items-center justify-center">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-slate-900">Ủy Quyền Chia Sẻ Liên Phòng Ban</h3>
              <p className="text-[11px] text-slate-500 font-mono">Thẩm quyền Trưởng Phòng / Ban Giám Đốc</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Policy notice */}
        <div className="p-3 bg-amber-50/70 border border-amber-200 rounded text-[11px] text-amber-800 flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <span>
            <strong>Quy chế bảo mật:</strong> Quyền chia sẻ chỉ có hiệu lực tạm thời trong thời hạn nhất định. Hết thời gian này, quyền xem của phòng ban đối tác sẽ tự động thu hồi.
          </span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Tài liệu ủy quyền
            </label>
            <div className="text-xs font-bold text-slate-800 p-2.5 bg-slate-50 rounded border border-slate-200 leading-snug">
              {docTitle}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Phòng ban thụ hưởng
              </label>
              <select
                value={targetDept}
                onChange={(e) => setTargetDept(e.target.value as any)}
                className="w-full px-2.5 py-1.5 rounded border border-slate-300 bg-white font-bold text-slate-800"
              >
                {others(currentDept).map((code) => (
                  <option key={code} value={code}>
                    {deptName(code)} ({code})
                  </option>
                ))}
                {user?.isExecutive && <option value="*">Toàn doanh nghiệp (*)</option>}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Thời hạn cấp quyền
              </label>
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 rounded border border-slate-300 bg-white font-medium text-slate-800 font-mono"
              >
                <option value={3}>3 ngày</option>
                <option value={7}>7 ngày (Mặc định)</option>
                <option value={14}>14 ngày</option>
                <option value={30}>30 ngày</option>
                <option value={90}>90 ngày</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Cấp độ quyền hạn (DLP Policy)
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`p-2.5 rounded border cursor-pointer flex flex-col gap-0.5 ${
                  permission === 'VIEW'
                    ? 'border-blue-600 bg-blue-50/50 text-blue-900'
                    : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                }`}
              >
                <div className="flex items-center gap-1.5 font-bold text-xs">
                  <input
                    type="radio"
                    name="permission"
                    checked={permission === 'VIEW'}
                    onChange={() => setPermission('VIEW')}
                    className="text-blue-600"
                  />
                  <span>Chỉ Xem Online (DLP)</span>
                </div>
                <span className="text-[10px] text-slate-500 pl-4">Khóa chức năng tải về</span>
              </label>

              <label
                className={`p-2.5 rounded border cursor-pointer flex flex-col gap-0.5 ${
                  permission === 'DOWNLOAD'
                    ? 'border-emerald-600 bg-emerald-50/50 text-emerald-900'
                    : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                }`}
              >
                <div className="flex items-center gap-1.5 font-bold text-xs">
                  <input
                    type="radio"
                    name="permission"
                    checked={permission === 'DOWNLOAD'}
                    onChange={() => setPermission('DOWNLOAD')}
                    className="text-emerald-600"
                  />
                  <span>Cho Phép Tải Về</span>
                </div>
                <span className="text-[10px] text-slate-500 pl-4">Tải tệp bản sao về máy</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Mục đích / Căn cứ chia sẻ
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ví dụ: Phối hợp thẩm định ngân sách tuyển dụng..."
              className="w-full px-2.5 py-1.5 rounded border border-slate-300 text-xs text-slate-900"
            />
          </div>

          {errorMessage && (
            <div className="p-2.5 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
              {errorMessage}
            </div>
          )}

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
              disabled={isSubmitting}
              className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded flex items-center gap-1.5 disabled:opacity-50 transition-colors shadow-xs"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Đang ghi vào sổ chia sẻ của phòng...
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Xác Nhận Cấp Quyền
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
