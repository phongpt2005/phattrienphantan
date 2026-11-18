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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
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
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white">
        <Loader2 className="w-6 h-6 animate-spin mb-3" />
        <div className="text-xs font-semibold">Đang kết nối hệ thống...</div>
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

        <main
          key={currentTab}
          className={`flex-1 overflow-hidden flex flex-col ${currentTab === 'workspace' ? 'bg-white' : 'overflow-y-auto p-4 sm:p-5 bg-slate-50'}`}
        >
          {currentTab === 'workspace' ? (
            <WorkspaceTab />
          ) : (
            <div className="max-w-[1400px] mx-auto w-full">
              {currentTab === 'search' && <SearchTab />}
              {currentTab === 'approvals' && isManagerOrExec && <ApprovalTab />}
              {currentTab === 'system' && isExecutive && <SystemStatusTab />}
              {currentTab === 'executive' && isExecutive && <ExecutiveTab />}
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
