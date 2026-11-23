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

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((type: ToastType, message: string, title?: string, duration = 4000) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, message, title, duration }]);

    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }
  }, [removeToast]);

  const success = useCallback((message: string, title?: string) => addToast('success', message, title || 'Thành công'), [addToast]);
  const error = useCallback((message: string, title?: string) => addToast('error', message, title || 'Lỗi thao tác'), [addToast]);
  const warning = useCallback((message: string, title?: string) => addToast('warning', message, title || 'Cảnh báo'), [addToast]);
  const info = useCallback((message: string, title?: string) => addToast('info', message, title || 'Thông báo hệ thống'), [addToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, success, error, warning, info }}>
      {children}
      {/* Toast Notification Container */}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 max-w-md w-full pointer-events-none">
        {toasts.map((toast) => {
          const typeConfig = {
            success: {
              border: 'border-l-4 border-l-emerald-600 border-slate-200',
              icon: <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />,
              titleColor: 'text-emerald-900',
            },
            error: {
              border: 'border-l-4 border-l-red-600 border-slate-200',
              icon: <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />,
              titleColor: 'text-red-900',
            },
            warning: {
              border: 'border-l-4 border-l-amber-500 border-slate-200',
              icon: <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />,
              titleColor: 'text-amber-900',
            },
            info: {
              border: 'border-l-4 border-l-brand-600 border-slate-200',
              icon: <Info className="w-5 h-5 text-brand-600 shrink-0 mt-0.5" />,
              titleColor: 'text-slate-900',
            },
          }[toast.type];

          return (
            <div
              key={toast.id}
              className={`pointer-events-auto bg-white border ${typeConfig.border} shadow-lg p-3.5 rounded flex items-start gap-3 transition-all duration-200 animate-in slide-in-from-right-4`}
            >
              {typeConfig.icon}
              <div className="flex-1 min-w-0">
                {toast.title && (
                  <h4 className={`text-xs font-bold uppercase tracking-wider ${typeConfig.titleColor}`}>
                    {toast.title}
                  </h4>
                )}
                <p className="text-xs text-slate-700 font-medium mt-0.5 leading-relaxed">{toast.message}</p>
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1"
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
