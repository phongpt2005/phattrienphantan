import React, { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { IconButton, Pill } from './ui';
import type { Tone } from './ui';

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

const TONE: Record<Notice['type'], Tone> = {
  SHARE_GRANTED: 'info',
  SHARE_REVOKED: 'neutral',
  ACCESS_REQUESTED: 'warning',
  ACCESS_APPROVED: 'success',
  ACCESS_REJECTED: 'danger',
  NODE_DOWN: 'danger',
  NODE_RECOVERED: 'success',
  NODE_JOINED: 'info',
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
        type="button"
        onClick={() => {
          setOpen(!open);
          setUnread(0);
        }}
        title={live ? 'Thông báo thời gian thực: đang kết nối' : 'Thông báo thời gian thực: đang nối lại'}
        aria-label="Thông báo"
        className="relative inline-flex items-center justify-center h-8 w-8 rounded-md border border-slate-300 bg-card text-slate-600 hover:text-slate-900 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        <Bell className="w-4 h-4" />
        <span
          aria-hidden="true"
          className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-white ${live ? 'bg-emerald-500' : 'bg-slate-300'}`}
        />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-micro font-semibold flex items-center justify-center font-mono">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-card rounded-xl border border-slate-200 shadow-menu z-50 overflow-hidden">
          <div className="h-10 px-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <span className="text-data font-semibold text-slate-900">Thông báo</span>
            <div className="flex items-center gap-2">
              <span className="text-micro text-slate-500">{live ? 'Trực tiếp' : 'Đang nối lại'}</span>
              <IconButton size="sm" ghost aria-label="Đóng thông báo" onClick={() => setOpen(false)}>
                <X className="w-3.5 h-3.5" />
              </IconButton>
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notices.length === 0 ? (
              <div className="p-6 text-data text-slate-500 text-center">Chưa có thông báo mới.</div>
            ) : (
              notices.map((n) => (
                <div key={n.id} className="px-3 py-2.5 border-b border-slate-100 last:border-0">
                  <div className="flex items-center gap-2">
                    <Pill tone={TONE[n.type]}>{n.title}</Pill>
                    <span className="ml-auto font-mono text-micro text-slate-500">{new Date(n.createdAt).toLocaleTimeString('vi-VN')}</span>
                  </div>
                  <div className="mt-1 text-data text-slate-700 leading-snug">{n.message}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
