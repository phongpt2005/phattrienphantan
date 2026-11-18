/**
 * Bộ thành phần giao diện dùng chung, theo quy chuẩn trong AGENTS.md:
 * mật độ thông tin cao (hàng bảng 36–44px), màu doanh nghiệp (slate + navy), viền 1px, góc bo nhỏ,
 * chữ mono cho mã/ngày/băm, không gradient, không bóng đổ lớn, không biểu tượng trang trí.
 * Mọi màn hình nghiệp vụ dùng chung các thành phần này để nhất quán.
 */
import React from 'react';
import { Loader2 } from 'lucide-react';
import { deptTone } from '../context/DepartmentContext';

type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 border-slate-200',
  success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  info: 'bg-blue-50 text-blue-800 border-blue-200',
  warning: 'bg-amber-50 text-amber-800 border-amber-200',
  danger: 'bg-red-50 text-red-800 border-red-200',
};

// ---------------------------------------------------------------- định dạng
export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
export const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtNumber = (n: number | string | null | undefined) => Number(n ?? 0).toLocaleString('vi-VN');

/** Số ngày còn lại tới hạn (âm = đã hết hạn). */
export const daysUntil = (iso?: string | null): number | null =>
  iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000) : null;

const MIME_LABEL: Array<[RegExp, string]> = [
  [/pdf/i, 'PDF'],
  [/wordprocessingml|msword/i, 'Word'],
  [/spreadsheetml|ms-excel/i, 'Excel'],
  [/presentationml|ms-powerpoint/i, 'PowerPoint'],
  [/^text\/plain/i, 'Văn bản thuần'],
  [/^text\//i, 'Văn bản'],
  [/^image\//i, 'Hình ảnh'],
  [/zip|compressed/i, 'Tệp nén'],
  [/json/i, 'JSON'],
];
export const mimeLabel = (mime?: string | null) => {
  if (!mime) return 'Không rõ';
  return MIME_LABEL.find(([re]) => re.test(mime))?.[1] ?? mime.split('/').pop() ?? mime;
};

// ---------------------------------------------------------------- nhãn
export const Pill: React.FC<{ tone?: Tone; children: React.ReactNode; title?: string; className?: string }> = ({
  tone = 'neutral',
  children,
  title,
  className = '',
}) => (
  <span title={title} className={`inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded border whitespace-nowrap ${TONE[tone]} ${className}`}>
    {children}
  </span>
);

/** Mã phòng ban, màu cố định theo mã (HR xanh, ACC hổ phách, phòng mới tự có màu). */
export const DeptBadge: React.FC<{ code?: string | null; className?: string }> = ({ code, className = '' }) =>
  code ? (
    <span className={`inline-block font-mono text-[11px] font-bold px-1.5 py-0.5 rounded border ${code === '*' ? TONE.neutral : deptTone(code).badge} ${className}`}>
      {code === '*' ? 'TOÀN CÔNG TY' : code}
    </span>
  ) : null;

const DOC_STATUS: Record<string, { label: string; tone: Tone }> = {
  PUBLISHED: { label: 'ĐÃ BAN HÀNH', tone: 'success' },
  DRAFT: { label: 'BẢN NHÁP', tone: 'warning' },
  ARCHIVED: { label: 'LƯU TRỮ', tone: 'neutral' },
  DELETED: { label: 'ĐÃ XÓA', tone: 'danger' },
};
export const DocStatusPill: React.FC<{ status?: string | null }> = ({ status }) => {
  const s = DOC_STATUS[status ?? ''] ?? { label: status ?? '—', tone: 'neutral' as Tone };
  return <Pill tone={s.tone}>{s.label}</Pill>;
};

// Phân loại bảo mật (DLP). Backend dùng PUBLIC / DEPARTMENT / PRIVATE; bản cũ của giao diện dùng COMPANY / CONFIDENTIAL.
const ACCESS: Record<string, { label: string; tone: Tone; hint: string }> = {
  PUBLIC: { label: 'TOÀN DOANH NGHIỆP', tone: 'info', hint: 'Mọi phòng ban đều tìm và xem được' },
  COMPANY: { label: 'TOÀN DOANH NGHIỆP', tone: 'info', hint: 'Mọi phòng ban đều tìm và xem được' },
  DEPARTMENT: { label: 'BẢO MẬT PHÒNG BAN', tone: 'neutral', hint: 'Chỉ phòng ban sở hữu; phòng khác phải được chia sẻ' },
  PRIVATE: { label: 'MẬT', tone: 'danger', hint: 'Chỉ phòng ban sở hữu, không hiện trong danh mục xin quyền' },
  CONFIDENTIAL: { label: 'MẬT', tone: 'danger', hint: 'Chỉ phòng ban sở hữu, không hiện trong danh mục xin quyền' },
};
export const AccessPill: React.FC<{ level?: string | null }> = ({ level }) => {
  const a = ACCESS[level ?? ''] ?? { label: level ?? '—', tone: 'neutral' as Tone, hint: '' };
  return (
    <Pill tone={a.tone} title={a.hint}>
      {a.label}
    </Pill>
  );
};

export const PermissionPill: React.FC<{ permission?: string | null }> = ({ permission }) =>
  permission === 'DOWNLOAD' ? (
    <Pill tone="success" title="Được xem và tải bản gốc về máy">
      ĐƯỢC TẢI VỀ
    </Pill>
  ) : (
    <Pill tone="info" title="Chỉ xem trực tuyến, không tải về (chính sách chống thất thoát dữ liệu)">
      CHỈ XEM - DLP
    </Pill>
  );

const REQUEST_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'CHỜ DUYỆT', tone: 'warning' },
  APPROVED: { label: 'ĐÃ DUYỆT', tone: 'success' },
  REJECTED: { label: 'TỪ CHỐI', tone: 'danger' },
};
export const RequestStatusPill: React.FC<{ status?: string | null }> = ({ status }) => {
  const s = REQUEST_STATUS[status ?? ''] ?? { label: status ?? '—', tone: 'neutral' as Tone };
  return <Pill tone={s.tone}>{s.label}</Pill>;
};

// ---------------------------------------------------------------- khung trang
export const PageHeader: React.FC<{ title: string; description?: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode }> = ({
  title,
  description,
  meta,
  actions,
}) => (
  <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
    <div className="min-w-0">
      {meta && <div className="flex items-center gap-2 mb-1">{meta}</div>}
      <h1 className="text-lg font-bold text-slate-900 tracking-tight">{title}</h1>
      {description && <p className="text-xs text-slate-600 mt-0.5 max-w-3xl">{description}</p>}
    </div>
    {actions && <div className="flex items-center gap-2 shrink-0 flex-wrap">{actions}</div>}
  </div>
);

export const Panel: React.FC<{ title?: string; note?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title,
  note,
  actions,
  children,
  className = '',
}) => (
  <section className={`bg-white border border-slate-200 rounded overflow-hidden ${className}`}>
    {(title || actions) && (
      <div className="px-3.5 min-h-10 py-1.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2.5 min-w-0">
          {title && <h2 className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">{title}</h2>}
          {note && <span className="text-[11px] text-slate-500 truncate">{note}</span>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);

export const Kpi: React.FC<{ label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'default' | 'danger' | 'warning' }> = ({
  label,
  value,
  hint,
  tone = 'default',
}) => (
  <div className="bg-white border border-slate-200 rounded px-3.5 py-2.5">
    <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider truncate">{label}</div>
    <div className={`text-xl font-bold font-mono mt-0.5 ${tone === 'danger' ? 'text-red-700' : tone === 'warning' ? 'text-amber-700' : 'text-slate-900'}`}>
      {value}
    </div>
    {hint && <div className="text-[11px] text-slate-500 mt-0.5 truncate">{hint}</div>}
  </div>
);

// ---------------------------------------------------------------- bảng
export const Th: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <th className={`px-3.5 h-9 text-[11px] font-bold text-slate-400 uppercase tracking-wider text-left whitespace-nowrap ${className}`}>{children}</th>
);
export const Td: React.FC<{ children?: React.ReactNode; className?: string; colSpan?: number }> = ({ children, className = '', colSpan }) => (
  <td colSpan={colSpan} className={`px-3.5 text-xs ${className}`}>
    {children}
  </td>
);
export const ROW = 'border-b border-slate-100 last:border-0 h-10 hover:bg-slate-50/70';

export const EmptyState: React.FC<{ title: string; hint?: React.ReactNode; action?: React.ReactNode }> = ({ title, hint, action }) => (
  <div className="px-4 py-8 text-center">
    <div className="text-xs font-semibold text-slate-700">{title}</div>
    {hint && <div className="text-xs text-slate-500 mt-1 max-w-md mx-auto">{hint}</div>}
    {action && <div className="mt-3 flex justify-center">{action}</div>}
  </div>
);

export const LoadingRows: React.FC<{ label?: string }> = ({ label = 'Đang tải dữ liệu...' }) => (
  <div className="px-4 py-8 flex items-center justify-center gap-2 text-xs text-slate-500">
    <Loader2 className="w-4 h-4 animate-spin" /> {label}
  </div>
);

// ---------------------------------------------------------------- nút
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
const BTN: Record<ButtonVariant, string> = {
  primary: 'bg-slate-900 hover:bg-slate-800 text-white border-slate-900',
  secondary: 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300',
  danger: 'bg-white hover:bg-red-50 text-red-700 border-red-200',
  ghost: 'bg-transparent hover:bg-slate-100 text-slate-600 border-transparent',
};
export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; icon?: React.ComponentType<{ className?: string }> }
> = ({ variant = 'secondary', size = 'md', icon: Icon, children, className = '', ...rest }) => (
  <button
    {...rest}
    className={`inline-flex items-center justify-center gap-1.5 rounded border font-semibold whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
      size === 'sm' ? 'h-7 px-2 text-[11px]' : 'h-8 px-3 text-xs'
    } ${BTN[variant]} ${className}`}
  >
    {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
    {children}
  </button>
);

export const SELECT = 'h-8 px-2 rounded border border-slate-300 bg-white text-xs font-medium text-slate-700';

/** Thanh tỉ lệ ngang cho bảng phân bổ. */
export const Bar: React.FC<{ value: number; max: number; className?: string }> = ({ value, max, className = 'bg-slate-700' }) => (
  <div className="h-1.5 w-full bg-slate-100 rounded-sm overflow-hidden">
    <div className={`h-full rounded-sm ${className}`} style={{ width: `${max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0}%` }} />
  </div>
);
