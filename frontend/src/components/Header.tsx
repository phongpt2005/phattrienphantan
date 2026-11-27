import React from 'react';
import { Menu, Moon, Search, Sun } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { deptName } from '../context/DepartmentContext';
import { useTheme } from '../theme';
import { AppTab } from '../types';
import { NotificationBell } from './NotificationBell';
import { DeptBadge, Kbd } from './ui';

export const TAB_LABELS: Record<AppTab, string> = {
  workspace: 'Kho hồ sơ phòng ban',
  search: 'Tra cứu toàn doanh nghiệp',
  approvals: 'Trung tâm phê duyệt',
  system: 'Giám sát hệ thống',
  executive: 'Báo cáo điều hành',
};

const ROLE_LABEL: Record<string, string> = {
  STAFF: 'Nhân viên',
  MANAGER: 'Trưởng phòng',
  EXECUTIVE: 'Ban Giám đốc',
};

interface HeaderProps {
  currentTab: AppTab;
  onToggleSidebar: () => void;
  onOpenCommand: () => void;
}

/** Thanh đầu theo mẫu Shadcn Admin: nút thanh bên, vị trí hiện tại, ô tìm nhanh (Ctrl K), sáng/tối, thông báo. */
export const Header: React.FC<HeaderProps> = ({ currentTab, onToggleSidebar, onOpenCommand }) => {
  const { user } = useAuth();
  const { theme, toggle } = useTheme();
  if (!user) return null;

  const isExecutive = user.role === 'EXECUTIVE' || !!user.isExecutive;

  return (
    <header className="h-16 bg-card/80 backdrop-blur border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0 select-none sticky top-0 z-10">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          title="Ẩn/hiện thanh điều hướng"
          className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-600 hover:text-slate-900 hover:bg-slate-100"
        >
          <Menu className="w-4 h-4" />
        </button>
        <span className="h-5 w-px bg-slate-200 hidden sm:block" />
        <nav aria-label="Vị trí hiện tại" className="flex items-center gap-1.5 text-sm min-w-0">
          <span className="text-slate-500 hidden sm:inline truncate">{isExecutive ? 'Ban Giám đốc' : deptName(user.departmentCode)}</span>
          <span className="text-slate-300 hidden sm:inline">/</span>
          <span className="font-medium text-slate-900 truncate">{TAB_LABELS[currentTab]}</span>
        </nav>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onOpenCommand}
          className="hidden sm:flex h-9 w-48 xl:w-64 items-center justify-between gap-2 pl-3 pr-1.5 text-sm text-slate-500 bg-slate-100/70 hover:bg-slate-100 border border-slate-200 rounded-md"
        >
          <span className="flex items-center gap-2 min-w-0">
            <Search className="w-4 h-4 shrink-0" />
            <span className="truncate">Tìm kiếm...</span>
          </span>
          <Kbd>Ctrl K</Kbd>
        </button>

        <div className="hidden md:flex h-9 items-center gap-2 px-3 rounded-md border border-slate-200 bg-card">
          <DeptBadge code={isExecutive ? '*' : user.departmentCode} />
          <span className="text-xs font-medium text-slate-700 whitespace-nowrap">{ROLE_LABEL[user.role] ?? user.role}</span>
        </div>

        <button
          onClick={toggle}
          title={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
          className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-600 hover:text-slate-900 hover:bg-slate-100"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        <NotificationBell />
      </div>
    </header>
  );
};
