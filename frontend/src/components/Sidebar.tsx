import React from 'react';
import {
  Activity,
  Building2,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  LineChart,
  LogOut,
  Search,
  UserCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { deptName, useDepartments } from '../context/DepartmentContext';
import { demoAccounts } from '../demo';
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

/** Thanh điều hướng nền navy: nhóm việc theo nghiệp vụ, mục đang chọn có vạch nhấn màu xanh. */
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
      className={`bg-slate-900 text-slate-300 flex flex-col shrink-0 select-none z-20 transition-[width] duration-150 ${
        isCollapsed ? 'w-14' : 'w-60'
      }`}
    >
      {/* Thương hiệu */}
      <div className="h-12 px-3 border-b border-white/10 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-7 h-7 rounded-md bg-brand-500 flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-white" />
          </span>
          {!isCollapsed && (
            <div className="leading-tight min-w-0">
              <div className="text-data font-semibold text-white truncate">DMS Enterprise</div>
              <div className="text-micro text-slate-400 truncate">{isExecutive ? 'Ban Giám đốc' : deptName(user.departmentCode)}</div>
            </div>
          )}
        </div>
        {!isCollapsed && (
          <button
            onClick={onToggleCollapse}
            title="Thu gọn thanh điều hướng"
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Điều hướng */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {isCollapsed && (
          <button
            onClick={onToggleCollapse}
            title="Mở rộng thanh điều hướng"
            className="w-full h-8 flex items-center justify-center rounded-md text-slate-400 hover:text-white hover:bg-white/10"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
        {groups.map((g) => (
          <div key={g.title}>
            {!isCollapsed && <div className="px-2.5 pb-1.5 text-micro font-semibold uppercase tracking-wider text-slate-500">{g.title}</div>}
            <div className="space-y-0.5">
              {g.items.map(({ tab, label, icon: Icon }) => {
                const active = currentTab === tab;
                return (
                  <button
                    key={tab}
                    onClick={() => onTabChange(tab)}
                    title={label}
                    aria-current={active ? 'page' : undefined}
                    className={`relative w-full h-9 flex items-center gap-2.5 rounded-md text-data text-left transition-colors ${
                      isCollapsed ? 'justify-center px-0' : 'px-2.5'
                    } ${active ? 'bg-white/10 text-white font-semibold' : 'text-slate-300 font-medium hover:bg-white/5 hover:text-white'}`}
                  >
                    {active && <span aria-hidden="true" className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-brand-400" />}
                    <Icon className="w-4 h-4 shrink-0" />
                    {!isCollapsed && <span className="truncate">{label}</span>}
                    {!isCollapsed && tab === 'system' && !allUp && departments.length > 0 && (
                      <StatusDot tone="danger" className="ml-auto" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Chân: tình trạng node, đổi vai trò (chỉ demo), người dùng */}
      <div className="border-t border-white/10 p-2.5 space-y-2.5 shrink-0">
        {departments.length > 0 && (
          <button
            onClick={() => isExecutive && onTabChange('system')}
            title={
              allUp
                ? 'Mọi node phòng ban đang phục vụ'
                : `Node không phục vụ: ${downCodes.join(', ')}. Tìm kiếm cho các phòng này lấy từ chỉ mục trung tâm.`
            }
            className={`w-full h-8 flex items-center gap-2 rounded-md border text-micro font-semibold ${
              isCollapsed ? 'justify-center px-0' : 'px-2.5'
            } ${allUp ? 'border-white/10 bg-white/5 text-slate-200' : 'border-red-400/30 bg-red-500/10 text-red-200'} ${
              isExecutive ? 'hover:bg-white/10 cursor-pointer' : 'cursor-default'
            }`}
          >
            <StatusDot tone={allUp ? 'success' : 'danger'} />
            {!isCollapsed && (
              <span className="truncate font-mono">
                {upCount}/{departments.length} node đang phục vụ
              </span>
            )}
          </button>
        )}

        {!isCollapsed && accounts.length > 0 && (
          <label className="block">
            <span className="block px-0.5 pb-1 text-micro font-semibold uppercase tracking-wider text-slate-500">Đổi vai trò (demo)</span>
            <select
              value={currentAccount?.key ?? ''}
              onChange={(e) => void switchTo(e.target.value)}
              className="w-full h-8 px-2 rounded-md border border-white/10 bg-slate-800 text-data font-medium text-slate-200 focus:outline-none focus:border-brand-400"
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

        <div className={`flex items-center gap-2 ${isCollapsed ? 'justify-center' : ''}`}>
          {!isCollapsed && (
            <>
              <Avatar name={user.fullName || user.username} tone="dark" />
              <div className="leading-tight min-w-0 flex-1">
                <div className="text-data font-semibold text-white truncate">{user.fullName || user.username}</div>
                <div className="text-micro text-slate-400 font-mono truncate">{user.username}</div>
              </div>
            </>
          )}
          <button
            onClick={logout}
            title="Đăng xuất"
            className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-white/10 shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
};
