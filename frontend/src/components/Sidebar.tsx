import React from 'react';
import {
  Activity,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  FolderKanban,
  LineChart,
  LogOut,
  Search,
  UserCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { deptName, useDepartments } from '../context/DepartmentContext';
import { demoAccounts } from '../demo';
import { APP_NAME } from '../theme';
import { AppTab } from '../types';
import { Avatar, StatusDot } from './ui';

interface SidebarProps {
  currentTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

interface NavItem {
  tab: AppTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  visible: boolean;
}

const ROLE_LABEL: Record<string, string> = { STAFF: 'Nhân viên', MANAGER: 'Trưởng phòng', EXECUTIVE: 'Ban Giám đốc' };

/** Thanh điều hướng theo mẫu Shadcn Admin: khối tên hệ thống, nhóm menu, thẻ người dùng ở chân. */
export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onTabChange, isCollapsed, onToggleCollapse }) => {
  const { user, logout, login } = useAuth();
  const { departments } = useDepartments();

  if (!user) return null;

  const isExecutive = user.role === 'EXECUTIVE' || !!user.isExecutive;
  const isManagerOrExec = user.role === 'MANAGER' || isExecutive;

  const allGroups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: 'Hồ sơ',
      items: [
        { tab: 'workspace', label: 'Kho hồ sơ phòng ban', icon: FolderKanban, visible: true },
        { tab: 'search', label: 'Tra cứu toàn doanh nghiệp', icon: Search, visible: true },
      ],
    },
    {
      title: 'Phê duyệt',
      items: [{ tab: 'approvals', label: 'Trung tâm phê duyệt', icon: UserCheck, visible: isManagerOrExec }],
    },
    {
      title: 'Quản trị',
      items: [
        { tab: 'system', label: 'Giám sát hệ thống', icon: Activity, visible: isExecutive },
        { tab: 'executive', label: 'Báo cáo điều hành', icon: LineChart, visible: isExecutive },
      ],
    },
  ];
  const groups = allGroups.map((g) => ({ ...g, items: g.items.filter((i) => i.visible) })).filter((g) => g.items.length > 0);

  // Tình trạng node lấy từ Registry (DepartmentContext tự làm mới 15 giây): mọi vai trò đều thấy
  const upCount = departments.filter((d) => d.available).length;
  const allUp = departments.length > 0 && upCount === departments.length;
  const downCodes = departments.filter((d) => !d.available).map((d) => d.code);

  const accounts = demoAccounts(departments);
  const currentAccount = accounts.find((a) => a.username === user.username && (a.role === 'EXECUTIVE' || a.dept === user.departmentCode));

  const switchTo = async (key: string) => {
    const acc = accounts.find((a) => a.key === key);
    if (!acc) return;
    const result = await login(acc.dept, acc.username, acc.password);
    if (result.success) onTabChange('workspace');
  };

  return (
    <aside
      className={`bg-sidebar border-r border-slate-200 flex flex-col shrink-0 select-none z-20 transition-[width] duration-200 ${
        isCollapsed ? 'w-[60px]' : 'w-64'
      }`}
    >
      {/* Khối tên hệ thống */}
      <div className={`h-16 flex items-center shrink-0 ${isCollapsed ? 'justify-center px-2' : 'px-3'}`}>
        <div className={`flex items-center gap-3 min-w-0 rounded-lg ${isCollapsed ? '' : 'w-full p-2 hover:bg-slate-100'}`}>
          <span className="w-9 h-9 rounded-lg bg-brand-500 text-white flex items-center justify-center shrink-0 shadow-sm">
            <Building2 className="w-[18px] h-[18px]" />
          </span>
          {!isCollapsed && (
            <div className="leading-tight min-w-0">
              <div className="text-[13px] font-semibold text-slate-900 leading-snug">{APP_NAME}</div>
              <div className="text-xs text-slate-500 truncate">{isExecutive ? 'Ban Giám đốc' : deptName(user.departmentCode)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Điều hướng */}
      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-5">
        {groups.map((g) => (
          <div key={g.title}>
            {!isCollapsed && <div className="px-2 pb-1.5 text-xs font-medium text-slate-500">{g.title}</div>}
            <div className="space-y-1">
              {g.items.map(({ tab, label, icon: Icon }) => {
                const active = currentTab === tab;
                return (
                  <button
                    key={tab}
                    onClick={() => onTabChange(tab)}
                    title={label}
                    aria-current={active ? 'page' : undefined}
                    className={`w-full h-9 flex items-center gap-2.5 rounded-md text-sm text-left transition-colors ${
                      isCollapsed ? 'justify-center px-0' : 'px-2.5'
                    } ${active ? 'bg-slate-200/70 text-slate-900 font-medium' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
                  >
                    <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-brand-600' : ''}`} />
                    {!isCollapsed && <span className="truncate">{label}</span>}
                    {!isCollapsed && tab === 'system' && !allUp && departments.length > 0 && <StatusDot tone="danger" className="ml-auto" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Chân: tình trạng node, đổi vai trò (chỉ demo), người dùng, thu gọn */}
      <div className="p-3 space-y-2.5 shrink-0">
        {departments.length > 0 && (
          <button
            onClick={() => isExecutive && onTabChange('system')}
            title={
              allUp
                ? 'Mọi node phòng ban đang phục vụ'
                : `Node không phục vụ: ${downCodes.join(', ')}. Tìm kiếm cho các phòng này lấy từ chỉ mục trung tâm.`
            }
            className={`w-full h-9 flex items-center gap-2 rounded-lg border text-xs font-medium ${isCollapsed ? 'justify-center px-0' : 'px-3'} ${
              allUp ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'
            } ${isExecutive ? 'hover:opacity-90 cursor-pointer' : 'cursor-default'}`}
          >
            <StatusDot tone={allUp ? 'success' : 'danger'} />
            {!isCollapsed && (
              <span className="truncate">
                {upCount}/{departments.length} phòng ban đang hoạt động
              </span>
            )}
          </button>
        )}

        {!isCollapsed && accounts.length > 0 && (
          <label className="block">
            <span className="block px-0.5 pb-1 text-xs font-medium text-slate-500">Đổi vai trò (demo)</span>
            <select
              value={currentAccount?.key ?? ''}
              onChange={(e) => void switchTo(e.target.value)}
              className="w-full h-9 px-2.5 rounded-md border border-slate-200 bg-card text-sm text-slate-700 shadow-sm focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/20"
            >
              {!currentAccount && <option value="">{user.username}</option>}
              {accounts.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className={`flex items-center gap-2.5 rounded-lg ${isCollapsed ? 'flex-col' : 'p-2 hover:bg-slate-100'}`}>
          <Avatar name={user.fullName || user.username} />
          {!isCollapsed && (
            <div className="leading-tight min-w-0 flex-1">
              <div className="text-sm font-semibold text-slate-900 truncate">{user.fullName || user.username}</div>
              <div className="text-xs text-slate-500 truncate">{ROLE_LABEL[user.role] ?? user.role} · {user.username}</div>
            </div>
          )}
          <button
            onClick={logout}
            title="Đăng xuất"
            className="p-1.5 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50 shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={onToggleCollapse}
          title={isCollapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'}
          className={`w-full h-8 flex items-center gap-2 rounded-md text-xs text-slate-500 hover:text-slate-900 hover:bg-slate-100 ${
            isCollapsed ? 'justify-center' : 'px-2.5'
          }`}
        >
          {isCollapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
          {!isCollapsed && 'Thu gọn'}
        </button>
      </div>
    </aside>
  );
};
