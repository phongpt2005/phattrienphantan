import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CornerDownLeft, FolderKanban, LineChart, Search, User, UserCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useDepartments } from '../context/DepartmentContext';
import { demoAccounts } from '../demo';
import { AppTab } from '../types';
import { TAB_LABELS } from './Header';
import { Kbd } from './ui';

interface CommandMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTab: (tab: AppTab) => void;
}

interface Command {
  id: string;
  group: string;
  title: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
}

// Bỏ dấu để gõ "giam sat" vẫn khớp "Giám sát"
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

/** Bảng lệnh (Ctrl+K): đi tới màn hình, và đổi vai trò khi ở chế độ demo. Điều khiển được hoàn toàn bằng bàn phím. */
export const CommandMenu: React.FC<CommandMenuProps> = ({ isOpen, onClose, onSelectTab }) => {
  const { user, login } = useAuth();
  const { departments } = useDepartments();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const isExecutive = user?.role === 'EXECUTIVE' || !!user?.isExecutive;
  const isManagerOrExec = user?.role === 'MANAGER' || isExecutive;

  const commands = useMemo<Command[]>(() => {
    const nav: Array<{ tab: AppTab; icon: Command['icon']; hint: string; visible: boolean }> = [
      { tab: 'workspace', icon: FolderKanban, hint: 'Hồ sơ nội bộ, tải lên, phiên bản', visible: true },
      { tab: 'search', icon: Search, hint: 'Tìm trên mọi phòng ban, kể cả nội dung tệp', visible: true },
      { tab: 'approvals', icon: UserCheck, hint: 'Duyệt yêu cầu xin quyền, quản lý chia sẻ', visible: isManagerOrExec },
      { tab: 'system', icon: Activity, hint: 'Node nào đang sống, lịch sử sự cố, cảnh báo', visible: isExecutive },
      { tab: 'executive', icon: LineChart, hint: 'Số liệu tài liệu, chia sẻ, đồng bộ', visible: isExecutive },
    ];
    const list: Command[] = nav
      .filter((n) => n.visible)
      .map((n) => ({
        id: `nav-${n.tab}`,
        group: 'Đi tới',
        title: TAB_LABELS[n.tab],
        hint: n.hint,
        icon: n.icon,
        run: () => onSelectTab(n.tab),
      }));
    for (const a of demoAccounts(departments)) {
      list.push({
        id: `acc-${a.key}`,
        group: 'Đổi vai trò (demo)',
        title: a.label,
        hint: a.username,
        icon: User,
        run: () => {
          void login(a.dept, a.username, a.password).then((r) => r.success && onSelectTab('workspace'));
        },
      });
    }
    return list;
  }, [departments, isExecutive, isManagerOrExec, login, onSelectTab]);

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    return q ? commands.filter((c) => fold(`${c.title} ${c.hint} ${c.group}`).includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setCursor(0);
    }
  }, [isOpen]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!isOpen) return null;

  const runAt = (i: number) => {
    const c = filtered[i];
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(cursor);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/50 animate-fade-in" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Bảng lệnh"
        className="w-full max-w-xl bg-card rounded-xl border border-slate-200 shadow-menu overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 px-3.5 border-b border-slate-200">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm màn hình hoặc đổi vai trò"
            aria-label="Tìm lệnh"
            className="w-full h-11 text-data text-slate-900 placeholder:text-slate-400 bg-transparent outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="py-8 text-center text-data text-slate-500">Không có lệnh nào khớp.</div>}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup;
            lastGroup = c.group;
            const active = i === cursor;
            return (
              <React.Fragment key={c.id}>
                {header && <div className="px-2 pt-2 pb-1 text-xs font-medium text-slate-500">{c.group}</div>}
                <button
                  data-index={i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => runAt(i)}
                  className={`w-full h-9 flex items-center gap-2.5 px-2.5 rounded-md text-left transition-colors ${
                    active ? 'bg-brand-50 text-brand-800' : 'text-slate-700'
                  }`}
                >
                  <c.icon className={`w-4 h-4 shrink-0 ${active ? 'text-brand-600' : 'text-slate-400'}`} />
                  <span className="text-data font-semibold shrink-0">{c.title}</span>
                  <span className="text-micro text-slate-500 truncate">{c.hint}</span>
                  {active && <CornerDownLeft className="w-3.5 h-3.5 ml-auto shrink-0 text-brand-500" />}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div className="px-3.5 h-9 border-t border-slate-200 bg-slate-50 flex items-center gap-4 text-micro text-slate-500">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> chọn
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd> mở
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Ctrl K</Kbd> đóng hoặc mở
          </span>
        </div>
      </div>
    </div>
  );
};
