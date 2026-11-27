import React, { useEffect, useState } from 'react';
import { Check, Loader2, Send } from 'lucide-react';
import { useDepartments, deptName } from '../context/DepartmentContext';
import { useAuth } from '../context/AuthContext';
import { searchApi } from '../services/api';
import { SearchResultItem } from '../types';
import { useToast } from '../context/ToastContext';
import { Button, Field, INPUT, Modal, SELECT, TEXTAREA } from './ui';

interface RequestAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  centralDocId?: number;
  sourceDocId?: number;
  docTitle?: string;
  targetDept?: string;
  onSuccess?: () => void;
}

/** Gửi đơn xin quyền xem/tải tài liệu của phòng khác. Trưởng phòng phòng đó sẽ quyết định. */
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
        `Đã gửi đơn xin cấp quyền [${requestedPermission === 'DOWNLOAD' ? 'xem và tải về' : 'chỉ xem trực tuyến'}] tới Trưởng phòng ${selectedTargetDept}`,
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
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Gửi đơn xin cấp quyền truy cập"
      description={`Từ phòng ${deptName(currentDept) || currentDept} · chờ Trưởng phòng ${selectedTargetDept || '—'} phê duyệt`}
      width="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-micro leading-relaxed text-blue-900">
          Bạn đang xin quyền tài liệu thuộc quyền quản lý của <strong>Phòng {selectedTargetDept || '—'}</strong>. Sau khi gửi, đơn được chuyển tới Trưởng phòng
          {selectedTargetDept ? ` ${selectedTargetDept}` : ''} để duyệt trực tuyến.
        </div>

        {errorMessage && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-data text-red-800">{errorMessage}</div>}

        <Field label="Tài liệu muốn xin xem">
          {initialDocTitle ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
              <div className="text-data font-semibold text-slate-900 break-words">{initialDocTitle}</div>
              <div className="mt-0.5 font-mono text-micro text-slate-500">
                Phòng sở hữu: {selectedTargetDept} · Mã chỉ mục #CENTRAL-{selectedCentralDocId}
              </div>
            </div>
          ) : isLoadingCatalog ? (
            <div className="flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 bg-slate-50 text-data text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Đang nạp danh mục tài liệu Phòng {selectedTargetDept}...
            </div>
          ) : catalog.length === 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-micro text-amber-900">
              Phòng {selectedTargetDept || '—'} hiện chưa có tài liệu nào được đồng bộ lên trung tâm.
            </div>
          ) : (
            <select value={selectedCentralDocId} onChange={handleSelectCatalogDoc} className={`${SELECT} w-full`}>
              {catalog.map((doc) => (
                <option key={doc.central_doc_id} value={doc.central_doc_id}>
                  [{doc.dept_code}] {doc.title} (#CENTRAL-{doc.central_doc_id})
                </option>
              ))}
            </select>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Thời hạn xin xem" htmlFor="request-days">
            <select
              id="request-days"
              value={requestedDays}
              onChange={(e) => setRequestedDays(Number(e.target.value))}
              className={`${SELECT} w-full font-mono`}
            >
              <option value={3}>3 ngày</option>
              <option value={7}>7 ngày (mặc định)</option>
              <option value={14}>14 ngày</option>
              <option value={30}>30 ngày</option>
              <option value={90}>90 ngày</option>
            </select>
          </Field>

          <Field label="Mức quyền đề xuất" htmlFor="request-permission">
            <select
              id="request-permission"
              value={requestedPermission}
              onChange={(e) => setRequestedPermission(e.target.value as 'VIEW' | 'DOWNLOAD')}
              className={`${SELECT} w-full`}
            >
              <option value="VIEW">Chỉ xem trực tuyến (DLP)</option>
              <option value="DOWNLOAD">Xem và tải tệp về máy</option>
            </select>
          </Field>
        </div>

        <Field label="Lý do công tác và căn cứ" htmlFor="request-reason">
          <textarea
            id="request-reason"
            rows={3}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Nêu rõ mục đích nghiệp vụ, ví dụ: đối soát hóa đơn với phòng Kế toán, tổng hợp số liệu báo cáo quý"
            className={TEXTAREA}
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
          <Button type="button" onClick={onClose}>
            Hủy bỏ
          </Button>
          <Button type="submit" variant="primary" disabled={isSubmitting || !selectedCentralDocId} icon={isSubmitting ? Loader2 : Send}>
            {isSubmitting ? 'Đang gửi đơn...' : 'Gửi yêu cầu'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
