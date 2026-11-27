import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Upload } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { documentApi } from '../services/api';
import { useToast } from '../context/ToastContext';
import { deptName } from '../context/DepartmentContext';
import { Button, Field, INPUT, Modal, SELECT, TEXTAREA } from './ui';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/** Khóa ngẫu nhiên 128 bit dạng hex. Không dùng crypto.randomUUID: hàm này chỉ có khi trang chạy trong ngữ cảnh an toàn (HTTPS). */
function newIdempotencyKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return 'up-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Lưu tài liệu mới vào kho riêng của phòng (băm SHA-256 phía server). */
export const UploadModal: React.FC<UploadModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const { user } = useAuth();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  // Danh mục lấy từ CSDL của phòng (trước đây gắn cứng 5 nhãn không khớp mã trong CSDL: chọn một nhãn nhưng lưu
  // thành danh mục khác, và có mã không tồn tại)
  const [categories, setCategories] = useState<Array<{ categoryId: number; name: string }>>([]);
  const [categoryError, setCategoryError] = useState(false);
  useEffect(() => {
    if (!isOpen || !user?.departmentCode) return;
    let alive = true;
    documentApi
      .getCategories(user.departmentCode)
      .then((list) => {
        if (!alive) return;
        setCategories(list);
        setCategoryError(false);
        setCategoryId((cur) => (cur && list.some((c) => String(c.categoryId) === cur) ? cur : list[0] ? String(list[0].categoryId) : ''));
      })
      .catch(() => alive && setCategoryError(true));
    return () => {
      alive = false;
    };
  }, [isOpen, user?.departmentCode]);
  const [accessLevel, setAccessLevel] = useState<'DEPARTMENT' | 'COMPANY' | 'CONFIDENTIAL'>('DEPARTMENT');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Một khóa cho một nội dung tải lên: gửi lại (lỗi mạng, 503, bấm lại) dùng lại khóa; sửa nội dung thì cấp khóa mới
  const idemKey = useRef<string | null>(null);
  useEffect(() => {
    idemKey.current = null;
  }, [title, description, categoryId, accessLevel, selectedFile]);

  const isExecutive = !!user?.isExecutive || user?.role === 'EXECUTIVE';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      if (!title) {
        // Tự động điền tên tệp làm tiêu đề mặc định
        setTitle(file.name.replace(/\.[^/.]+$/, ''));
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      toast.warning('Vui lòng chọn tệp tài liệu để lưu trữ');
      return;
    }

    setIsSubmitting(true);
    const formData = new FormData();
    formData.append('title', title.trim());
    formData.append('description', description.trim());
    if (categoryId) formData.append('categoryId', categoryId);
    formData.append('accessLevel', accessLevel);
    formData.append('file', selectedFile);

    try {
      const dept = user?.departmentCode ?? '';
      if (!idemKey.current) idemKey.current = newIdempotencyKey();
      await documentApi.uploadDocument(dept, formData, idemKey.current);
      idemKey.current = null;
      toast.success(`Đã lưu trữ văn bản "${title}" vào kho của phòng`);
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message, 'Lỗi lưu trữ văn bản');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={`Tải lên hồ sơ · ${deptName(user?.departmentCode)}`}
      description="Lưu vào kho riêng của phòng ban, tách biệt với dữ liệu của các phòng khác."
      width="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Tiêu đề văn bản" htmlFor="upload-title">
          <input
            id="upload-title"
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ví dụ: Báo cáo quyết toán thuế quý 3"
            className={INPUT}
          />
        </Field>

        <Field label="Trích yếu tóm tắt" htmlFor="upload-desc">
          <textarea
            id="upload-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tóm tắt nội dung chính để phục vụ tra cứu"
            className={TEXTAREA}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Danh mục nghiệp vụ" htmlFor="upload-category">
            <select
              id="upload-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={categories.length === 0}
              className={`${SELECT} w-full`}
            >
              {categories.length === 0 && <option value="">{categoryError ? 'Không tải được danh mục' : 'Đang tải danh mục...'}</option>}
              {categories.map((c) => (
                <option key={c.categoryId} value={String(c.categoryId)}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Phạm vi bảo mật" htmlFor="upload-level">
            {isExecutive ? (
              <select
                id="upload-level"
                value={accessLevel}
                onChange={(e) => setAccessLevel(e.target.value as 'DEPARTMENT' | 'COMPANY' | 'CONFIDENTIAL')}
                className={`${SELECT} w-full`}
              >
                <option value="DEPARTMENT">Nội bộ phòng ban</option>
                <option value="COMPANY">Toàn doanh nghiệp</option>
                <option value="CONFIDENTIAL">Bảo mật cao (chỉ Ban Giám đốc)</option>
              </select>
            ) : (
              <div className="h-8 px-2.5 flex items-center rounded-md border border-slate-200 bg-slate-50 text-data text-slate-700">
                Nội bộ phòng ban (mặc định)
              </div>
            )}
          </Field>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500">Tệp tài liệu</span>
          <label
            htmlFor="file-upload"
            className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-6 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50/40 transition-colors"
          >
            <Upload className="w-5 h-5 text-slate-400" />
            <span className="text-data font-semibold text-slate-800 break-all">
              {selectedFile ? selectedFile.name : 'Nhấp để chọn tệp từ máy tính'}
            </span>
            <span className="font-mono text-micro text-slate-500">
              {selectedFile ? `${Math.round(selectedFile.size / 1024)} KB · sẵn sàng băm SHA-256` : 'PDF, DOCX, XLSX, CSV, JSON, PNG, JPG · tối đa 50 MB'}
            </span>
          </label>
          <input id="file-upload" type="file" required onChange={handleFileChange} className="sr-only" />
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
          <Button type="button" onClick={onClose}>
            Hủy bỏ
          </Button>
          <Button type="submit" variant="primary" disabled={isSubmitting} icon={isSubmitting ? Loader2 : Check}>
            {isSubmitting ? 'Đang băm SHA-256 và lưu trữ...' : 'Lưu trữ văn bản'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
