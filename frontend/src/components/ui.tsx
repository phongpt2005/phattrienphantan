/**
 * Bộ thành phần giao diện dùng chung, theo AGENTS.md:
 * mật độ cao (hàng bảng 40px, tiêu đề bảng 36px), nền slate, điểm nhấn navy (brand),
 * viền 1px, góc bo 6–8px, chữ mono cho mã, ngày và băm; không gradient, không bóng lớn, không biểu tượng trang trí.
 * Mọi màn hình nghiệp vụ dùng chung các thành phần này để nhất quán.
 */
import React, { useEffect } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { deptTone } from '../context/DepartmentContext';

export type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 border-slate-200',
  success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  info: 'bg-blue-50 text-blue-800 border-blue-200',
  warning: 'bg-amber-50 text-amber-800 border-amber-200',
  danger: 'bg-red-50 text-red-800 border-red-200',
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
    className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-md border text-micro font-semibold whitespace-nowrap ${TONE[tone]} ${className}`}
  >
    {children}
  </span>
);

/** Mã phòng ban, màu cố định theo mã (HR xanh, ACC hổ phách, phòng mới tự có màu). */
export const DeptBadge: React.FC<{ code?: string | null; className?: string }> = ({ code, className = '' }) =>
  code ? (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded-md border font-mono text-micro font-semibold whitespace-nowrap ${
        code === '*' ? TONE.neutral : deptTone(code).badge
      } ${className}`}
    >
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

export const StatusDot: React.FC<{ tone?: Tone; className?: string }> = ({ tone = 'neutral', className = '' }) => (
  <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT[tone]} ${className}`} />
);

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-flex items-center h-5 px-1.5 rounded border border-slate-300 bg-white font-mono text-micro text-slate-500">
    {children}
  </kbd>
);

/** Ô chữ cái đầu của tên (hai chữ đầu và cuối), không dùng ảnh đại diện. */
export const Avatar: React.FC<{ name?: string | null; size?: 'sm' | 'md'; tone?: 'light' | 'dark'; className?: string }> = ({
  name,
  size = 'sm',
  tone = 'light',
  className = '',
}) => {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  const initials = (first + last).toUpperCase();
  const palette = tone === 'dark' ? 'bg-white/10 border-white/10 text-white' : 'bg-slate-100 border-slate-200 text-slate-700';
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md border font-semibold shrink-0 ${palette} ${
        size === 'md' ? 'w-8 h-8 text-data' : 'w-7 h-7 text-micro'
      } ${className}`}
    >
      {initials}
    </span>
  );
};

// ---------------------------------------------------------------- khung trang và panel
export const PageHeader: React.FC<{ title: string; description?: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode }> = ({
  title,
  description,
  meta,
  actions,
}) => (
  <header className="flex flex-col md:flex-row md:items-end justify-between gap-3 pb-4">
    <div className="min-w-0">
      {meta && <div className="flex items-center gap-2 mb-1.5 text-micro font-semibold uppercase tracking-wider text-slate-500">{meta}</div>}
      <h1 className="text-xl font-semibold text-slate-900 tracking-tight">{title}</h1>
      {description && <p className="text-data text-slate-500 mt-1 max-w-3xl">{description}</p>}
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
  <section className={`bg-white border border-slate-200 rounded-lg overflow-hidden ${className}`}>
    {(title || actions) && (
      <div className="h-10 px-3.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5 min-w-0">
          {title && <h2 className="text-data font-semibold text-slate-900 whitespace-nowrap">{title}</h2>}
          {note && <span className="text-micro text-slate-500 truncate">{note}</span>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);

const KPI_ACCENT: Record<'default' | 'danger' | 'warning', string> = {
  default: 'bg-brand-500',
  danger: 'bg-red-500',
  warning: 'bg-amber-500',
};
const KPI_VALUE: Record<'default' | 'danger' | 'warning', string> = {
  default: 'text-slate-900',
  danger: 'text-red-700',
  warning: 'text-amber-700',
};
export const Kpi: React.FC<{ label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'default' | 'danger' | 'warning' }> = ({
  label,
  value,
  hint,
  tone = 'default',
}) => (
  <div className="relative bg-white border border-slate-200 rounded-lg px-4 py-3 overflow-hidden">
    <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-0.5 ${KPI_ACCENT[tone]}`} />
    <div className="text-micro font-semibold uppercase tracking-wider text-slate-500 truncate">{label}</div>
    <div className={`mt-1.5 text-2xl font-semibold tabular-nums leading-none ${KPI_VALUE[tone]}`}>{value}</div>
    {hint && <div className="mt-1.5 text-micro text-slate-500 truncate">{hint}</div>}
  </div>
);

// ---------------------------------------------------------------- bảng
export const Th: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <th
    className={`h-9 px-3 text-micro font-semibold uppercase tracking-wider text-slate-500 text-left whitespace-nowrap bg-slate-50 border-b border-slate-200 ${className}`}
  >
    {children}
  </th>
);
export const Td: React.FC<{ children?: React.ReactNode; className?: string; colSpan?: number }> = ({ children, className = '', colSpan }) => (
  <td colSpan={colSpan} className={`px-3 text-data text-slate-700 align-middle ${className}`}>
    {children}
  </td>
);
export const ROW = 'h-10 border-b border-slate-100 last:border-0 hover:bg-brand-50/50 transition-colors';

export const EmptyState: React.FC<{ title: string; hint?: React.ReactNode; action?: React.ReactNode }> = ({ title, hint, action }) => (
  <div className="px-4 py-12 text-center">
    <div className="text-data font-semibold text-slate-800">{title}</div>
    {hint && <div className="text-data text-slate-500 mt-1 max-w-md mx-auto">{hint}</div>}
    {action && <div className="mt-3 flex justify-center">{action}</div>}
  </div>
);

export const LoadingRows: React.FC<{ label?: string }> = ({ label = 'Đang tải dữ liệu...' }) => (
  <div className="px-4 py-10 flex items-center justify-center gap-2 text-data text-slate-500">
    <Loader2 className="w-4 h-4 animate-spin" /> {label}
  </div>
);

/** Thanh tỉ lệ ngang cho bảng phân bổ. */
export const Bar: React.FC<{ value: number; max: number; className?: string }> = ({ value, max, className = 'bg-brand-500' }) => (
  <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
    <div
      className={`h-full rounded-full ${className}`}
      style={{ width: `${max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0}%` }}
    />
  </div>
);

// ---------------------------------------------------------------- form
export const INPUT =
  'h-8 w-full px-2.5 rounded-md border border-slate-300 bg-white text-data text-slate-900 placeholder:text-slate-400 hover:border-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20';
export const SELECT =
  'h-8 px-2.5 rounded-md border border-slate-300 bg-white text-data font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20';

export const TEXTAREA =
  'w-full px-2.5 py-2 rounded-md border border-slate-300 bg-white text-data text-slate-900 placeholder:text-slate-400 hover:border-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 resize-none';

export const SearchField: React.FC<React.InputHTMLAttributes<HTMLInputElement> & { wrapperClassName?: string }> = ({
  wrapperClassName = '',
  className = '',
  ...rest
}) => (
  <label className={`relative flex items-center ${wrapperClassName}`}>
    <Search aria-hidden="true" className="absolute left-2.5 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
    <input type="search" {...rest} className={`${INPUT} pl-8 ${className}`} />
  </label>
);

export const Field: React.FC<{ label: string; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode; className?: string }> = ({
  label,
  hint,
  htmlFor,
  children,
  className = '',
}) => (
  <div className={`flex flex-col gap-1 ${className}`}>
    <label htmlFor={htmlFor} className="text-micro font-semibold uppercase tracking-wider text-slate-500">
      {label}
    </label>
    {children}
    {hint && <span className="text-micro text-slate-500">{hint}</span>}
  </div>
);

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
const BTN: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 hover:bg-brand-600 text-white border-brand-500 hover:border-brand-600 shadow-sm',
  secondary: 'bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 border-slate-300 shadow-sm',
  danger: 'bg-white hover:bg-red-50 text-red-700 border-red-200 hover:border-red-300',
  ghost: 'bg-transparent hover:bg-slate-100 text-slate-600 hover:text-slate-900 border-transparent',
};
export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; icon?: React.ComponentType<{ className?: string }> }
> = ({ variant = 'secondary', size = 'md', icon: Icon, children, className = '', ...rest }) => (
  <button
    {...rest}
    className={`inline-flex items-center justify-center gap-1.5 rounded-md border font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-50 disabled:cursor-not-allowed ${
      size === 'sm' ? 'h-7 px-2.5 text-micro' : 'h-8 px-3 text-data'
    } ${BTN[variant]} ${className}`}
  >
    {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
    {children}
  </button>
);

/** Nhóm nút chọn một trong vài giá trị (bộ lọc nhanh). */
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
    <div role="group" className={`inline-flex items-center h-7 p-0.5 rounded-md bg-slate-100 border border-slate-200 ${className}`}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`h-6 px-2.5 rounded text-micro font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
              active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
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
    className={`inline-flex items-center justify-center rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
      size === 'sm' ? 'h-7 w-7' : 'h-8 w-8'
    } ${
      active
        ? 'bg-brand-50 border-brand-200 text-brand-700'
        : ghost
        ? 'border-transparent bg-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100'
        : 'bg-white border-slate-300 text-slate-600 hover:text-slate-900 hover:bg-slate-50'
    } ${className}`}
  >
    {children}
  </button>
);

/** Tab dạng gạch chân, dùng cho các nhóm nội dung trong cùng một màn hình. */
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
    <div role="tablist" className={`flex items-end gap-5 border-b border-slate-200 ${className}`}>
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={`-mb-px h-9 border-b-2 text-data whitespace-nowrap transition-colors ${
              active ? 'border-brand-500 text-brand-700 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800 font-medium'
            }`}
          >
            {it.label}
            {it.count !== undefined && (
              <span
                className={`ml-1.5 inline-flex items-center h-4 px-1.5 rounded font-mono text-micro ${
                  active ? 'bg-brand-50 text-brand-700' : it.attention ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
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
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${width} max-h-[88vh] bg-white rounded-lg border border-slate-200 shadow-menu flex flex-col`}
      >
        <div className="h-11 px-4 flex items-center justify-between border-b border-slate-200 shrink-0">
          <h2 className="text-data font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Đóng"
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {description && <div className="px-4 pt-3 text-data text-slate-500">{description}</div>}
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 flex items-center justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
};

/**
 * Ngăn chi tiết trượt từ bên phải (AGENTS.md): danh sách phía sau vẫn giữ vị trí cuộn, bộ lọc và ngữ cảnh.
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
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        className={`relative w-full ${maxW} h-full bg-white border-l border-slate-200 shadow-drawer flex flex-col animate-slide-right`}
      >
        <div className="h-12 px-4 border-b border-slate-200 flex items-center gap-3 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-900 truncate">{title}</div>
            {subtitle && <div className="text-micro text-slate-500 truncate">{subtitle}</div>}
          </div>
          {actions}
          <button
            onClick={onClose}
            aria-label="Đóng"
            className="p-1.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 shrink-0 flex items-center gap-2">{footer}</div>}
      </aside>
    </div>
  );
};
