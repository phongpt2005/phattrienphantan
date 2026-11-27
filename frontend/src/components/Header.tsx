import React from 'react';
import { ChevronRight, Menu, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { deptName } from '../context/DepartmentContext';
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

/** Thanh đầu: vị trí hiện tại, tìm nhanh (Ctrl K), phòng và vai trò, thông báo. */
export const Header: React.FC<HeaderProps> = ({ currentTab, onToggleSidebar, onOpenCommand }) => {
  const { user } = useAuth();
  if (!user) return null;

  const isExecutive = user.role === 'EXECUTIVE' || !!user.isExecutive;

  return (
    <header className="h-12 bg-white border-b border-slate-200 px-4 flex items-center justify-between gap-3 shrink-0 select-none">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={onToggleSidebar}
          title="Ẩn/hiện thanh điều hướng"
          className="p-1.5 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 md:hidden"
        >
          <Menu className="w-4 h-4" />
        </button>
        <nav aria-label="Vị trí hiện tại" className="flex items-center gap-1.5 text-data min-w-0">
          <span className="text-slate-500 hidden sm:inline truncate">{isExecutive ? 'Ban Giám đốc' : deptName(user.departmentCode)}</span>
          <ChevronRight className="w-3.5 h-3.5 text-slate-300 hidden sm:inline shrink-0" />
          <span className="font-semibold text-slate-900 truncate">{TAB_LABELS[currentTab]}</span>
        </nav>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onOpenCommand}
          className="hidden sm:flex h-8 w-44 xl:w-60 items-center justify-between gap-2 pl-2.5 pr-1.5 text-data text-slate-500 bg-white hover:bg-slate-50 border border-slate-300 rounded-md"
        >
          <span className="flex items-center gap-2 min-w-0">
            <Search className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Tìm nhanh hoặc chuyển trang</span>
          </span>
          <Kbd>Ctrl K</Kbd>
        </button>

        <div className="hidden md:flex h-8 items-center gap-2 px-2.5 rounded-md border border-slate-200 bg-slate-50">
          <DeptBadge code={isExecutive ? '*' : user.departmentCode} />
          <span className="text-micro font-semibold text-slate-700 whitespace-nowrap">{ROLE_LABEL[user.role] ?? user.role}</span>
        </div>

        <NotificationBell />
      </div>
    </header>
  );
};
