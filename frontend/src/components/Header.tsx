import React from 'react';
import { ChevronRight, Menu, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { deptName } from '../context/DepartmentContext';
import { AppTab } from '../types';
import { NotificationBell } from './NotificationBell';

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

export const Header: React.FC<HeaderProps> = ({ currentTab, onToggleSidebar, onOpenCommand }) => {
  const { user } = useAuth();
  if (!user) return null;

  const isExecutive = user.role === 'EXECUTIVE' || !!user.isExecutive;

  return (
    <header className="h-12 bg-white border-b border-slate-200 px-4 flex items-center justify-between shrink-0 select-none">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={onToggleSidebar}
          title="Ẩn/hiện thanh điều hướng"
          className="p-1.5 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 md:hidden"
        >
          <Menu className="w-4 h-4" />
        </button>
        <nav aria-label="Vị trí hiện tại" className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="text-slate-500 hidden sm:inline truncate">{isExecutive ? 'Ban Giám đốc' : deptName(user.departmentCode)}</span>
          <ChevronRight className="w-3.5 h-3.5 text-slate-300 hidden sm:inline shrink-0" />
          <span className="font-bold text-slate-900 truncate">{TAB_LABELS[currentTab]}</span>
        </nav>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onOpenCommand}
          className="hidden sm:flex h-8 items-center gap-2 px-2.5 text-xs text-slate-500 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded"
        >
          <Search className="w-3.5 h-3.5" />
          <span>Đi tới...</span>
          <kbd className="font-mono text-[10px] bg-white px-1.5 py-0.5 border border-slate-200 rounded text-slate-500">Ctrl K</kbd>
        </button>

        <div className="hidden md:flex h-8 items-center gap-1.5 px-2.5 rounded border border-slate-200 bg-slate-50 text-xs">
          <span className="font-mono font-bold text-slate-900">{isExecutive ? 'TOÀN CÔNG TY' : user.departmentCode}</span>
          <span className="text-slate-300">/</span>
          <span className="font-semibold text-slate-600">{ROLE_LABEL[user.role] ?? user.role}</span>
        </div>

        <NotificationBell />
      </div>
    </header>
  );
};
