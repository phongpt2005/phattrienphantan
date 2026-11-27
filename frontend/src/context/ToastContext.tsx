import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  duration?: number;
}

interface ToastContextValue {
  toasts: ToastItem[];
  addToast: (type: ToastType, message: string, title?: string, duration?: number) => void;
  removeToast: (id: string) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const TOAST_STYLE: Record<ToastType, { bar: string; icon: React.ReactNode; title: string }> = {
  success: { bar: 'bg-emerald-500', icon: <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-px" />, title: 'text-emerald-800' },
  error: { bar: 'bg-red-500', icon: <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-px" />, title: 'text-red-800' },
  warning: { bar: 'bg-amber-500', icon: <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-px" />, title: 'text-amber-800' },
  info: { bar: 'bg-brand-500', icon: <Info className="w-4 h-4 text-brand-600 shrink-0 mt-px" />, title: 'text-slate-900' },
};

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (type: ToastType, message: string, title?: string, duration = 4000) => {
      const id = Math.random().toString(36).substring(2, 9);
      setToasts((prev) => [...prev, { id, type, message, title, duration }]);

      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }
    },
    [removeToast],
  );

  const success = useCallback((message: string, title?: string) => addToast('success', message, title || 'Thành công'), [addToast]);
  const error = useCallback((message: string, title?: string) => addToast('error', message, title || 'Lỗi thao tác'), [addToast]);
  const warning = useCallback((message: string, title?: string) => addToast('warning', message, title || 'Cảnh báo'), [addToast]);
  const info = useCallback((message: string, title?: string) => addToast('info', message, title || 'Thông báo hệ thống'), [addToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, success, error, warning, info }}>
      {children}
      {/* Vùng hiện thông báo nhanh: góc dưới bên phải, không chặn thao tác phía sau */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-full max-w-sm pointer-events-none">
        {toasts.map((toast) => {
          const style = TOAST_STYLE[toast.type];
          return (
            <div
              key={toast.id}
              role={toast.type === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto relative overflow-hidden bg-card border border-slate-200 rounded-xl shadow-menu pl-4 pr-3 py-2.5 flex items-start gap-2.5 animate-slide-right"
            >
              <span aria-hidden="true" className={`absolute left-0 top-0 bottom-0 w-1 ${style.bar}`} />
              {style.icon}
              <div className="flex-1 min-w-0">
                {toast.title && <div className={`text-xs font-medium ${style.title}`}>{toast.title}</div>}
                <p className="text-data text-slate-700 leading-snug mt-0.5">{toast.message}</p>
              </div>
              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                className="text-slate-400 hover:text-slate-700 p-0.5 rounded"
                aria-label="Đóng"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
