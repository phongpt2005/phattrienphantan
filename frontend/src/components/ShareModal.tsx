import React, { useEffect, useState } from 'react';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { searchApi } from '../services/api';
import { useToast } from '../context/ToastContext';
import { useDepartments, deptName } from '../context/DepartmentContext';
import { Button, Field, INPUT, Modal, SELECT } from './ui';

interface ShareModalProps {
  isOpen: boolean;
  docId: number | null;
  docTitle: string;
  onClose: () => void;
  onSuccess?: () => void;
}

/** Ủy quyền chia sẻ liên phòng: quyền có thời hạn, mức DLP (chỉ xem hoặc cho tải về), ghi vào sổ chia sẻ của phòng chủ. */
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docId) return;
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
      // Server báo rõ: CREATED (cấp mới) hay EXTENDED (đã có lượt đang hiệu lực: đổi quyền hoặc gia hạn)
      if (result?.action === 'EXTENDED') {
        toast.success(
          `Đã gia hạn và cập nhật quyền truy cập cho "${target}" (${permission === 'DOWNLOAD' ? 'xem và tải' : 'chỉ xem'}, ${days} ngày)`,
          'Đã gia hạn chia sẻ',
        );
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
    <Modal
      open={isOpen && !!docId}
      onClose={onClose}
      title="Ủy quyền chia sẻ liên phòng ban"
      description="Quyền cấp cho phòng khác có thời hạn và được ghi vào sổ chia sẻ của phòng bạn."
      width="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-micro text-amber-900">
          <ShieldCheck className="w-4 h-4 text-amber-700 shrink-0 mt-px" />
          <span>
            <strong>Quy chế bảo mật:</strong> quyền chỉ có hiệu lực trong thời hạn đã chọn. Hết hạn, quyền của phòng đối tác tự thu hồi.
          </span>
        </div>

        <Field label="Tài liệu ủy quyền">
          <div className="h-8 px-2.5 flex items-center rounded-md border border-slate-200 bg-slate-50 text-data font-medium text-slate-900 truncate">
            {docTitle}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Phòng ban thụ hưởng" htmlFor="share-target">
            <select id="share-target" value={targetDept} onChange={(e) => setTargetDept(e.target.value)} className={`${SELECT} w-full`}>
              {others(currentDept).map((code) => (
                <option key={code} value={code}>
                  {deptName(code)} ({code})
                </option>
              ))}
              {user?.isExecutive && <option value="*">Toàn doanh nghiệp (*)</option>}
            </select>
          </Field>

          <Field label="Thời hạn" htmlFor="share-days">
            <select id="share-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${SELECT} w-full font-mono`}>
              <option value={3}>3 ngày</option>
              <option value={7}>7 ngày (mặc định)</option>
              <option value={14}>14 ngày</option>
              <option value={30}>30 ngày</option>
              <option value={90}>90 ngày</option>
            </select>
          </Field>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-micro font-semibold uppercase tracking-wider text-slate-500">Quyền hạn (chính sách DLP)</span>
          <div className="grid grid-cols-2 gap-2">
            <label
              className={`p-2.5 rounded-md border cursor-pointer flex flex-col gap-0.5 transition-colors ${
                permission === 'VIEW' ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/15' : 'border-slate-300 hover:border-slate-400'
              }`}
            >
              <span className="flex items-center gap-2 text-data font-semibold text-slate-900">
                <input
                  type="radio"
                  name="permission"
                  checked={permission === 'VIEW'}
                  onChange={() => setPermission('VIEW')}
                  className="accent-brand-600"
                />
                Chỉ xem trực tuyến
              </span>
              <span className="pl-6 text-micro text-slate-500">Khóa chức năng tải về</span>
            </label>

            <label
              className={`p-2.5 rounded-md border cursor-pointer flex flex-col gap-0.5 transition-colors ${
                permission === 'DOWNLOAD' ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/15' : 'border-slate-300 hover:border-slate-400'
              }`}
            >
              <span className="flex items-center gap-2 text-data font-semibold text-slate-900">
                <input
                  type="radio"
                  name="permission"
                  checked={permission === 'DOWNLOAD'}
                  onChange={() => setPermission('DOWNLOAD')}
                  className="accent-emerald-600"
                />
                Cho phép tải về
              </span>
              <span className="pl-6 text-micro text-slate-500">Tải bản sao về máy</span>
            </label>
          </div>
        </div>

        <Field label="Mục đích, căn cứ chia sẻ" htmlFor="share-reason">
          <input
            id="share-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: phối hợp thẩm định ngân sách tuyển dụng"
            className={INPUT}
          />
        </Field>

        {errorMessage && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-data text-red-800">{errorMessage}</div>}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
          <Button type="button" onClick={onClose}>
            Hủy bỏ
          </Button>
          <Button type="submit" variant="primary" disabled={isSubmitting} icon={isSubmitting ? Loader2 : Check}>
            {isSubmitting ? 'Đang ghi vào sổ chia sẻ...' : 'Xác nhận cấp quyền'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
