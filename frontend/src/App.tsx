import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { DepartmentProvider } from './context/DepartmentContext';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { CommandMenu } from './components/CommandMenu';
import { WorkspaceTab } from './components/WorkspaceTab';
import { SearchTab } from './components/SearchTab';
import { ApprovalTab } from './components/ApprovalTab';
import { ExecutiveTab } from './components/ExecutiveTab';
import { SystemStatusTab } from './components/SystemStatusTab';
import { AppTab } from './types';

const AppContent: React.FC = () => {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [currentTab, setCurrentTab] = useState<AppTab>('workspace');
  // Màn hình hẹp (dưới 1280px) mở sẵn thanh điều hướng thu gọn để nhường chỗ cho bảng dữ liệu
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => window.innerWidth < 1280);
  const [isCommandOpen, setIsCommandOpen] = useState(false);

  const isExecutive = user?.role === 'EXECUTIVE' || !!user?.isExecutive;
  const isManagerOrExec = user?.role === 'MANAGER' || isExecutive;

  // Phân quyền màn hình: Nhân viên không vào Phê duyệt; chỉ Ban Giám đốc vào Giám sát và Báo cáo.
  // (Đây chỉ là ẩn giao diện; quyền thật do API kiểm tra theo vai trò trong JWT.)
  useEffect(() => {
    if (!user) return;
    if (currentTab === 'approvals' && !isManagerOrExec) setCurrentTab('workspace');
    if ((currentTab === 'executive' || currentTab === 'system') && !isExecutive) setCurrentTab('workspace');
  }, [user, currentTab, isManagerOrExec, isExecutive]);

  // Ctrl+K / Cmd+K mở và đóng bảng lệnh ở mọi màn hình
  useEffect(() => {
    if (!isAuthenticated) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAuthenticated]);

  const closeCommand = useCallback(() => setIsCommandOpen(false), []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin text-brand-500 mb-3" />
        <div className="text-data font-medium">Đang kết nối hệ thống...</div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <LoginScreen />;
  }

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-slate-50 text-slate-800">
      <Sidebar
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed((v) => !v)}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          currentTab={currentTab}
          onToggleSidebar={() => setIsSidebarCollapsed((v) => !v)}
          onOpenCommand={() => setIsCommandOpen(true)}
        />

        <main key={currentTab} className="flex-1 min-h-0 flex flex-col">
          {currentTab === 'workspace' ? (
            <WorkspaceTab />
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="max-w-[1280px] mx-auto w-full px-5 py-4">
                {currentTab === 'search' && <SearchTab />}
                {currentTab === 'approvals' && isManagerOrExec && <ApprovalTab />}
                {currentTab === 'system' && isExecutive && <SystemStatusTab />}
                {currentTab === 'executive' && isExecutive && <ExecutiveTab />}
              </div>
            </div>
          )}
        </main>
      </div>

      <CommandMenu isOpen={isCommandOpen} onClose={closeCommand} onSelectTab={setCurrentTab} />
    </div>
  );
};

export const App: React.FC = () => (
  <ToastProvider>
    <DepartmentProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </DepartmentProvider>
  </ToastProvider>
);

export default App;
