/**
 * Bộ thành phần giao diện dùng chung, theo mẫu Shadcn Admin:
 * thẻ bo góc có viền mảnh và bóng nhẹ, tab dạng viên, nút và ô nhập cao 36px, bảng thoáng, có chế độ sáng/tối
 * (màu lấy từ biến CSS trong index.css). Chữ mono cho mã, ngày và băm.
 * Mọi màn hình nghiệp vụ dùng chung các thành phần này để nhất quán.
 */
import React, { useEffect } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { deptTone } from '../context/DepartmentContext';

export type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 border-slate-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  warning: 'bg-amber-50 text-amber-800 border-amber-200',
  danger: 'bg-red-50 text-red-700 border-red-200',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-slate-400',
  success: 'bg-emerald-500',
  info: 'bg-blue-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
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

// ---------------------------------------------------------------- nhãn và trạng thái
export const Pill: React.FC<{ tone?: Tone; children: React.ReactNode; title?: string; className?: string }> = ({
  tone = 'neutral',
  children,
  title,
  className = '',
}) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1 h-5 px-2 rounded-full border text-[11px] font-semibold whitespace-nowrap ${TONE[tone]} ${className}`}
  >
    {children}
  </span>
);

/** Mã phòng ban, màu cố định theo mã (HR xanh, ACC hổ phách, phòng mới tự có màu). */
export const DeptBadge: React.FC<{ code?: string | null; className?: string }> = ({ code, className = '' }) =>
  code ? (
    <span
      className={`inline-flex items-center h-5 px-2 rounded-full border font-mono text-[11px] font-semibold whitespace-nowrap ${
        code === '*' ? TONE.neutral : deptTone(code).badge
      } ${className}`}
    >
      {code === '*' ? 'TOÀN CÔNG TY' : code}
    </span>
  ) : null;

const DOC_STATUS: Record<string, { label: string; tone: Tone }> = {
  PUBLISHED: { label: 'Đã ban hành', tone: 'success' },
  DRAFT: { label: 'Bản nháp', tone: 'warning' },
  ARCHIVED: { label: 'Lưu trữ', tone: 'neutral' },
  DELETED: { label: 'Đã xóa', tone: 'danger' },
};
export const DocStatusPill: React.FC<{ status?: string | null }> = ({ status }) => {
  const s = DOC_STATUS[status ?? ''] ?? { label: status ?? '—', tone: 'neutral' as Tone };
  return (
    <Pill tone={s.tone}>
      <span className={`w-1.5 h-1.5 rounded-full ${DOT[s.tone]}`} />
      {s.label}
    </Pill>
  );
};

// Phân loại bảo mật (DLP). Backend dùng PUBLIC / DEPARTMENT / PRIVATE; bản cũ của giao diện dùng COMPANY / CONFIDENTIAL.
const ACCESS: Record<string, { label: string; tone: Tone; hint: string }> = {
  PUBLIC: { label: 'Toàn doanh nghiệp', tone: 'info', hint: 'Mọi phòng ban đều tìm và xem được' },
  COMPANY: { label: 'Toàn doanh nghiệp', tone: 'info', hint: 'Mọi phòng ban đều tìm và xem được' },
  DEPARTMENT: { label: 'Nội bộ phòng ban', tone: 'neutral', hint: 'Chỉ phòng ban sở hữu; phòng khác phải được chia sẻ' },
  PRIVATE: { label: 'Mật', tone: 'danger', hint: 'Chỉ phòng ban sở hữu, không hiện trong danh mục xin quyền' },
  CONFIDENTIAL: { label: 'Mật', tone: 'danger', hint: 'Chỉ phòng ban sở hữu, không hiện trong danh mục xin quyền' },
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
      Được tải về
    </Pill>
  ) : (
    <Pill tone="info" title="Chỉ xem trực tuyến, không tải về (chính sách chống thất thoát dữ liệu)">
      Chỉ xem
    </Pill>
  );

const REQUEST_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Chờ duyệt', tone: 'warning' },
  APPROVED: { label: 'Đã duyệt', tone: 'success' },
  REJECTED: { label: 'Từ chối', tone: 'danger' },
};
export const RequestStatusPill: React.FC<{ status?: string | null }> = ({ status }) => {
  const s = REQUEST_STATUS[status ?? ''] ?? { label: status ?? '—', tone: 'neutral' as Tone };
  return (
    <Pill tone={s.tone}>
      <span className={`w-1.5 h-1.5 rounded-full ${DOT[s.tone]}`} />
      {s.label}
    </Pill>
  );
};

export const StatusDot: React.FC<{ tone?: Tone; className?: string }> = ({ tone = 'neutral', className = '' }) => (
  <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT[tone]} ${className}`} />
);

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-flex items-center h-5 px-1.5 rounded border border-slate-200 bg-slate-100 font-mono text-[10px] font-medium text-slate-500">
    {children}
  </kbd>
);

const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-800',
  'bg-red-100 text-red-700',
  'bg-brand-100 text-brand-700',
];

/** Ô tròn chữ cái đầu của tên, màu theo tên (không dùng ảnh đại diện). */
export const Avatar: React.FC<{ name?: string | null; size?: 'sm' | 'md'; tone?: 'light' | 'dark'; className?: string }> = ({
  name,
  size = 'sm',
  className = '',
}) => {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  const initials = (first + last).toUpperCase();
  const hash = [...(name || '?')].reduce((a, c) => a + c.charCodeAt(0), 0);
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold shrink-0 ${AVATAR_COLORS[hash % AVATAR_COLORS.length]} ${
        size === 'md' ? 'w-9 h-9 text-sm' : 'w-8 h-8 text-xs'
      } ${className}`}
    >
      {initials}
    </span>
  );
};

// ---------------------------------------------------------------- khung trang và thẻ
export const PageHeader: React.FC<{ title: string; description?: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode }> = ({
  title,
  description,
  meta,
  actions,
}) => (
  <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5">
    <div className="min-w-0">
      {meta && <div className="flex items-center gap-2 mb-2 text-xs font-medium text-slate-500">{meta}</div>}
      <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{title}</h1>
      {description && <p className="text-sm text-slate-500 mt-1 max-w-3xl">{description}</p>}
    </div>
    {actions && <div className="flex items-center gap-2 shrink-0 flex-wrap">{actions}</div>}
  </header>
);

export const Panel: React.FC<{ title?: string; note?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title,
  note,
  actions,
  children,
  className = '',
}) => (
  <section className={`bg-card border border-slate-200 rounded-xl shadow-sm overflow-hidden ${className}`}>
    {(title || actions) && (
      <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {title && <h2 className="text-[15px] font-semibold text-slate-900 tracking-tight whitespace-nowrap">{title}</h2>}
          {note && <p className="text-xs text-slate-500 truncate mt-0.5">{note}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);

const KPI_ICON: Record<'default' | 'danger' | 'warning', string> = {
  default: 'bg-brand-50 text-brand-600',
  danger: 'bg-red-50 text-red-600',
  warning: 'bg-amber-50 text-amber-600',
};
const KPI_VALUE: Record<'default' | 'danger' | 'warning', string> = {
  default: 'text-slate-900',
  danger: 'text-red-600',
  warning: 'text-amber-600',
};
export const Kpi: React.FC<{
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'default' | 'danger' | 'warning';
  icon?: React.ComponentType<{ className?: string }>;
}> = ({ label, value, hint, tone = 'default', icon: Icon }) => (
  <div className="bg-card border border-slate-200 rounded-xl shadow-sm p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="text-sm font-medium text-slate-500 truncate">{label}</div>
      {Icon ? (
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${KPI_ICON[tone]}`}>
          <Icon className="w-4 h-4" />
        </span>
      ) : (
        <span className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${tone === 'danger' ? 'bg-red-500' : tone === 'warning' ? 'bg-amber-500' : 'bg-brand-500'}`} />
      )}
    </div>
    <div className={`mt-2 text-[28px] font-bold tracking-tight tabular-nums leading-none ${KPI_VALUE[tone]}`}>{value}</div>
    {hint && <div className="mt-2 text-xs text-slate-500 truncate">{hint}</div>}
  </div>
);

// ---------------------------------------------------------------- bảng
export const Th: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <th className={`h-10 px-3 text-xs font-medium text-slate-500 text-left whitespace-nowrap bg-slate-50 border-y border-slate-200 ${className}`}>
    {children}
  </th>
);
export const Td: React.FC<{ children?: React.ReactNode; className?: string; colSpan?: number }> = ({ children, className = '', colSpan }) => (
  <td colSpan={colSpan} className={`px-3 text-data text-slate-700 align-middle ${className}`}>
    {children}
  </td>
);
export const ROW = 'h-12 border-b border-slate-200 last:border-0 hover:bg-slate-50 transition-colors';

export const EmptyState: React.FC<{ title: string; hint?: React.ReactNode; action?: React.ReactNode }> = ({ title, hint, action }) => (
  <div className="px-4 py-14 text-center">
    <div className="text-sm font-semibold text-slate-800">{title}</div>
    {hint && <div className="text-sm text-slate-500 mt-1 max-w-md mx-auto">{hint}</div>}
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>
);

export const LoadingRows: React.FC<{ label?: string }> = ({ label = 'Đang tải dữ liệu...' }) => (
  <div className="px-4 py-12 flex items-center justify-center gap-2 text-sm text-slate-500">
    <Loader2 className="w-4 h-4 animate-spin" /> {label}
  </div>
);

/** Thanh tỉ lệ ngang cho bảng phân bổ. */
export const Bar: React.FC<{ value: number; max: number; className?: string }> = ({ value, max, className = 'bg-brand-500' }) => (
  <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
    <div
      className={`h-full rounded-full ${className}`}
      style={{ width: `${max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0}%` }}
    />
  </div>
);

// ---------------------------------------------------------------- form
const FOCUS = 'focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/20';
export const INPUT = `h-9 w-full px-3 rounded-md border border-slate-200 bg-card text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition-colors ${FOCUS}`;
export const SELECT = `h-9 px-3 rounded-md border border-slate-200 bg-card text-sm font-medium text-slate-700 shadow-sm transition-colors ${FOCUS}`;
export const TEXTAREA = `w-full px-3 py-2 rounded-md border border-slate-200 bg-card text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition-colors resize-none ${FOCUS}`;

export const SearchField: React.FC<React.InputHTMLAttributes<HTMLInputElement> & { wrapperClassName?: string }> = ({
  wrapperClassName = '',
  className = '',
  ...rest
}) => (
  <label className={`relative flex items-center ${wrapperClassName}`}>
    <Search aria-hidden="true" className="absolute left-3 w-4 h-4 text-slate-400 pointer-events-none" />
    <input type="search" {...rest} className={`${INPUT} pl-9 ${className}`} />
  </label>
);

export const Field: React.FC<{ label: string; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode; className?: string }> = ({
  label,
  hint,
  htmlFor,
  children,
  className = '',
}) => (
  <div className={`flex flex-col gap-1.5 ${className}`}>
    <label htmlFor={htmlFor} className="text-sm font-medium text-slate-900">
      {label}
    </label>
    {children}
    {hint && <span className="text-xs text-slate-500">{hint}</span>}
  </div>
);

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
const BTN: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 hover:bg-brand-600 text-white border-transparent shadow-sm',
  secondary: 'bg-card hover:bg-slate-100 text-slate-900 border-slate-200 shadow-sm',
  danger: 'bg-red-500 hover:bg-red-600 text-white border-transparent shadow-sm',
  ghost: 'bg-transparent hover:bg-slate-100 text-slate-700 hover:text-slate-900 border-transparent',
};
export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; icon?: React.ComponentType<{ className?: string }> }
> = ({ variant = 'secondary', size = 'md', icon: Icon, children, className = '', ...rest }) => (
  <button
    {...rest}
    className={`inline-flex items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-500/30 disabled:opacity-50 disabled:pointer-events-none ${
      size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm'
    } ${BTN[variant]} ${className}`}
  >
    {Icon && <Icon className="w-4 h-4 shrink-0" />}
    {children}
  </button>
);

/** Nhóm nút chọn một trong vài giá trị (bộ lọc nhanh), dạng viên như TabsList của Shadcn. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  className?: string;
}) {
  return (
    <div role="group" className={`inline-flex items-center h-9 p-1 rounded-lg bg-slate-100 ${className}`}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`h-7 px-3 rounded-md text-xs font-medium whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 ${
              active ? 'bg-card text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Nút chỉ có biểu tượng. `ghost` dùng cho thao tác trong hàng bảng. */
export const IconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; size?: 'sm' | 'md'; ghost?: boolean }> = ({
  active = false,
  size = 'md',
  ghost = false,
  className = '',
  children,
  ...rest
}) => (
  <button
    type="button"
    {...rest}
    className={`inline-flex items-center justify-center rounded-md border transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-500/30 ${
      size === 'sm' ? 'h-8 w-8' : 'h-9 w-9'
    } ${
      active
        ? 'bg-brand-50 border-brand-200 text-brand-700'
        : ghost
        ? 'border-transparent bg-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100'
        : 'bg-card border-slate-200 text-slate-600 shadow-sm hover:text-slate-900 hover:bg-slate-100'
    } ${className}`}
  >
    {children}
  </button>
);

/** Tab dạng viên (TabsList của Shadcn), dùng cho các nhóm nội dung trong cùng một màn hình. */
export interface TabItem<T extends string> {
  value: T;
  label: string;
  count?: number | string;
  /** Có việc cần xử lý: số đếm hiện màu hổ phách */
  attention?: boolean;
}
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  className?: string;
}) {
  return (
    <div className={className}>
      <div role="tablist" className="inline-flex items-center h-10 p-1 rounded-lg bg-slate-100 max-w-full overflow-x-auto">
        {items.map((it) => {
          const active = it.value === value;
          return (
            <button
              key={it.value}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(it.value)}
              className={`h-8 px-3 rounded-md text-sm font-medium whitespace-nowrap transition-all inline-flex items-center gap-1.5 ${
                active ? 'bg-card text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {it.label}
              {it.count !== undefined && (
                <span
                  className={`inline-flex items-center h-5 min-w-[20px] justify-center px-1.5 rounded-full text-[11px] font-semibold tabular-nums ${
                    it.attention ? 'bg-amber-100 text-amber-800' : active ? 'bg-brand-500 text-white' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {it.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- lớp phủ: hộp thoại và ngăn trượt
function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

export const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
  children: React.ReactNode;
}> = ({ open, onClose, title, description, footer, width = 'max-w-lg', children }) => {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${width} max-h-[88vh] bg-card rounded-xl border border-slate-200 shadow-menu flex flex-col animate-pop-in`}
      >
        <div className="px-6 pt-5 pb-1 flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900 tracking-tight">{title}</h2>
            {description && <div className="mt-1 text-sm text-slate-500">{description}</div>}
          </div>
          <button
            onClick={onClose}
            aria-label="Đóng"
            className="p-1 -mr-1 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-6 pb-5 pt-2 flex items-center justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
};

/**
 * Ngăn chi tiết trượt từ bên phải: danh sách phía sau vẫn giữ vị trí cuộn, bộ lọc và ngữ cảnh.
 */
export const Drawer: React.FC<{
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'md' | 'lg' | 'xl';
  children: React.ReactNode;
}> = ({ open, onClose, title, subtitle, actions, footer, width = 'lg', children }) => {
  useEscape(open, onClose);
  if (!open) return null;
  const maxW = width === 'md' ? 'max-w-[520px]' : width === 'xl' ? 'max-w-[960px]' : 'max-w-[720px]';
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px] animate-fade-in" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        className={`relative w-full ${maxW} h-full bg-card border-l border-slate-200 shadow-drawer flex flex-col animate-slide-right`}
      >
        <div className="h-14 px-5 border-b border-slate-200 flex items-center gap-3 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold text-slate-900 truncate tracking-tight">{title}</div>
            {subtitle && <div className="text-xs text-slate-500 truncate">{subtitle}</div>}
          </div>
          {actions}
          <button
            onClick={onClose}
            aria-label="Đóng"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 shrink-0 flex items-center gap-2">{footer}</div>}
      </aside>
    </div>
  );
};
