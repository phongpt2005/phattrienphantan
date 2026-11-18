import { deptName } from '../context/DepartmentContext';
import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { documentApi } from '../services/api';
import { useToast } from '../context/ToastContext';
import { FilePlus, X, Upload, Check, Loader2, HardDrive, ShieldCheck, AlertCircle } from 'lucide-react';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const UploadModal: React.FC<UploadModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const { user } = useAuth();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('1');
  const [accessLevel, setAccessLevel] = useState<'DEPARTMENT' | 'COMPANY' | 'CONFIDENTIAL'>('DEPARTMENT');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

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
    formData.append('categoryId', categoryId);
    formData.append('accessLevel', accessLevel);
    formData.append('file', selectedFile);

    try {
      const dept = user?.departmentCode ?? '';
      await documentApi.uploadDocument(dept, formData);
      toast.success(`Đã lưu trữ văn bản "${title}" vào kho MinIO S3 thành công!`);
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message, 'Lỗi lưu trữ văn bản');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded max-w-lg w-full p-5 shadow-xl border border-slate-200 space-y-4 animate-in fade-in duration-150">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-slate-900 text-white flex items-center justify-center">
              <FilePlus className="w-4 h-4 text-brand-400" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-slate-900">
                Tải Lên Hồ Sơ - {deptName(user?.departmentCode)}
              </h3>
              <p className="text-[11px] text-slate-500 font-mono">
                Kho lưu trữ riêng của phòng ban (MinIO bucket cô lập)
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

        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
              Tiêu đề văn bản / Hồ sơ *
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ví dụ: Báo cáo quyết toán thuế quý 3"
              className="w-full px-3 py-2 rounded border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-brand-500 font-medium"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
              Trích yếu tóm tắt nội dung
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tóm tắt nội dung chính để phục vụ tra cứu toàn văn..."
              className="w-full px-3 py-2 rounded border border-slate-300 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
                Phân loại danh mục
              </label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full px-2.5 py-2 rounded border border-slate-300 bg-white text-slate-800 font-medium"
              >
                <option value="1">Hồ sơ chung & Quyết định</option>
                <option value="2">Hợp đồng & Văn bản thỏa thuận</option>
                <option value="3">Báo cáo tài chính & Quyết toán</option>
                <option value="4">Hóa đơn & Chứng từ thanh toán</option>
                <option value="5">Chính sách & Quy định nội bộ</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
                Phạm vi bảo mật (DLP Scope)
              </label>
              {isExecutive ? (
                <select
                  value={accessLevel}
                  onChange={(e) => setAccessLevel(e.target.value as any)}
                  className="w-full px-2.5 py-2 rounded border border-purple-300 bg-purple-50 text-purple-900 font-bold"
                >
                  <option value="DEPARTMENT">Nội bộ phòng ban</option>
                  <option value="COMPANY">Toàn doanh nghiệp (Company-wide)</option>
                  <option value="CONFIDENTIAL">Bảo mật cao (C-Level Only)</option>
                </select>
              ) : (
                <div className="px-2.5 py-2 rounded border border-slate-200 bg-slate-50 text-slate-600 font-medium">
                  Nội bộ phòng ban (Mặc định)
                </div>
              )}
            </div>
          </div>

          {/* File Picker */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
              Tệp tài liệu đính kèm *
            </label>
            <div className="border-2 border-dashed border-slate-300 rounded p-4 text-center hover:bg-slate-50 transition-colors">
              <input
                type="file"
                id="file-upload"
                required
                onChange={handleFileChange}
                className="hidden"
              />
              <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center">
                <Upload className="w-6 h-6 text-slate-400 mb-1" />
                <span className="text-xs font-semibold text-slate-700">
                  {selectedFile ? selectedFile.name : 'Nhấp để chọn tệp từ máy tính'}
                </span>
                <span className="text-[10px] text-slate-400 font-mono mt-0.5">
                  {selectedFile
                    ? `${Math.round(selectedFile.size / 1024)} KB - Sẵn sàng băm SHA-256`
                    : 'Hỗ trợ PDF, DOCX, XLSX, CSV, JSON, PNG, JPG (Tối đa 50MB)'}
                </span>
              </label>
            </div>
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
              disabled={isSubmitting}
              className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded flex items-center gap-1.5 disabled:opacity-50 transition-colors shadow-xs"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Đang băm SHA-256 & Lưu trữ S3...
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Lưu Trữ Văn Bản
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
