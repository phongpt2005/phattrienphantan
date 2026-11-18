import React, { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

interface Notice {
  id: string;
  type:
    | 'SHARE_GRANTED'
    | 'SHARE_REVOKED'
    | 'ACCESS_REQUESTED'
    | 'ACCESS_APPROVED'
    | 'ACCESS_REJECTED'
    | 'NODE_DOWN'
    | 'NODE_RECOVERED'
    | 'NODE_JOINED';
  title: string;
  message: string;
  createdAt: string;
}

const TONE: Record<Notice['type'], string> = {
  SHARE_GRANTED: 'bg-blue-50 text-blue-800 border-blue-200',
  SHARE_REVOKED: 'bg-slate-100 text-slate-700 border-slate-200',
  ACCESS_REQUESTED: 'bg-amber-50 text-amber-800 border-amber-200',
  ACCESS_APPROVED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  ACCESS_REJECTED: 'bg-red-50 text-red-800 border-red-200',
  NODE_DOWN: 'bg-red-50 text-red-800 border-red-200',
  NODE_RECOVERED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  NODE_JOINED: 'bg-blue-50 text-blue-800 border-blue-200',
};

/**
 * Thông báo thời gian thực qua Server-Sent Events. Dùng fetch (không phải EventSource) vì phải gửi
 * header Authorization. Tự nối lại với độ trễ tăng dần khi mất kết nối.
 */
export const NotificationBell: React.FC = () => {
  const { user } = useAuth();
  const toast = useToast();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState(false);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    if (!user?.token) return;
    const ctrl = new AbortController();
    let delay = 1000;
    let stopped = false;

    const connect = async () => {
      while (!stopped) {
        try {
          const res = await fetch('/api/search/notifications/stream', {
            headers: { Authorization: `Bearer ${user.token}`, Accept: 'text/event-stream' },
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          setLive(true);
          delay = 1000;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const data = frame
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim())
                .join('');
              if (!data) continue;
              try {
                const n = JSON.parse(data) as Notice;
                if (!n.id) continue; // bỏ qua nhịp tim
                setNotices((prev) => [n, ...prev].slice(0, 30));
                setUnread((c) => c + 1);
                if (n.type === 'NODE_DOWN') toastRef.current.error(n.message, n.title);
                else if (n.type === 'NODE_RECOVERED') toastRef.current.success(n.message, n.title);
                else toastRef.current.info(n.message, n.title);
                if (n.type.startsWith('NODE_')) window.dispatchEvent(new CustomEvent('dms:node-status-changed'));
              } catch {
                /* khung không phải JSON */
              }
            }
          }
        } catch {
          if (stopped) return;
        }
        setLive(false);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [user?.token]);

  if (!user) return null;

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          setUnread(0);
        }}
        title={live ? 'Thông báo thời gian thực: đang kết nối' : 'Thông báo thời gian thực: đang nối lại'}
        className="relative p-1.5 rounded border border-slate-200 hover:bg-slate-50 text-slate-600"
      >
        <Bell className="w-4 h-4" />
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-white ${live ? 'bg-emerald-500' : 'bg-slate-300'}`}
        />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center font-mono">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-80 bg-white rounded shadow-lg border border-slate-200 z-50">
          <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Thông báo</span>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notices.length === 0 ? (
              <div className="p-4 text-xs text-slate-400 text-center">Chưa có thông báo mới.</div>
            ) : (
              notices.map((n) => (
                <div key={n.id} className="px-3 py-2 border-b border-slate-100 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold px-1.5 rounded border ${TONE[n.type]}`}>{n.title}</span>
                    <span className="ml-auto font-mono text-[10px] text-slate-400">
                      {new Date(n.createdAt).toLocaleTimeString('vi-VN')}
                    </span>
                  </div>
                  <div className="text-xs text-slate-700 mt-1 leading-snug">{n.message}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
