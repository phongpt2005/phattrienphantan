import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { registryApi } from '../services/api';

export interface DepartmentInfo {
  code: string;
  name: string;
  available: boolean;
}

// Tên phòng ban lấy từ Registry; dùng được ở ngoài React (không cần hook).
let nameCache: Record<string, string> = {};
export const deptName = (code?: string): string => (code ? nameCache[code] || `Phòng ${code}` : '');

export interface DeptTone {
  badge: string; // pill: nền + chữ + viền
  dot: string;
  text: string;
}

// Bảng màu doanh nghiệp (slate/navy/amber...). HR & ACC giữ màu quen thuộc, phòng ban mới tự lấy màu theo mã.
const TONES: DeptTone[] = [
  { badge: 'bg-blue-50 text-blue-800 border-blue-200', dot: 'bg-blue-500', text: 'text-blue-700' },
  { badge: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-500', text: 'text-amber-700' },
  { badge: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  { badge: 'bg-violet-50 text-violet-800 border-violet-200', dot: 'bg-violet-500', text: 'text-violet-700' },
  { badge: 'bg-rose-50 text-rose-800 border-rose-200', dot: 'bg-rose-500', text: 'text-rose-700' },
  { badge: 'bg-cyan-50 text-cyan-800 border-cyan-200', dot: 'bg-cyan-500', text: 'text-cyan-700' },
];
const FIXED: Record<string, number> = { HR: 0, ACC: 1 };
export const deptTone = (code?: string): DeptTone => {
  if (!code) return TONES[0];
  if (code in FIXED) return TONES[FIXED[code]];
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[2 + (h % (TONES.length - 2))];
};

/** Quy ước tài khoản demo: <mã>_staff, <mã>_manager (xem department-service/SeedService). */
export const demoUsername = (code: string, kind: 'staff' | 'manager') => `${code.toLowerCase()}_${kind}`;

interface DepartmentContextType {
  departments: DepartmentInfo[];
  /** Các phòng ban khác phòng hiện tại (đang khả dụng trước) */
  others: (currentCode: string) => string[];
  refresh: () => Promise<void>;
}

const DepartmentContext = createContext<DepartmentContextType>({
  departments: [],
  others: () => [],
  refresh: async () => {},
});

export const DepartmentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [departments, setDepartments] = useState<DepartmentInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await registryApi.listPublic();
      nameCache = Object.fromEntries(list.map((d) => [d.code, d.name]));
      setDepartments(list);
    } catch {
      /* Registry chưa sẵn sàng: giữ danh sách cũ, thử lại ở lần sau */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15000); // phòng ban mới xuất hiện không cần tải lại trang
    return () => clearInterval(t);
  }, [refresh]);

  const value = useMemo<DepartmentContextType>(
    () => ({
      departments,
      others: (currentCode) =>
        departments
          .filter((d) => d.code !== currentCode)
          .sort((a, b) => Number(b.available) - Number(a.available))
          .map((d) => d.code),
      refresh,
    }),
    [departments, refresh],
  );

  return <DepartmentContext.Provider value={value}>{children}</DepartmentContext.Provider>;
};

export const useDepartments = () => useContext(DepartmentContext);
