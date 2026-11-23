import { demoUsername } from './context/DepartmentContext';

/**
 * Tài khoản mẫu cho môi trường demo. Chỉ bật khi build với VITE_DEMO_LOGIN=true (frontend/.env);
 * bản build thật đặt false thì mọi nút đổi vai trò nhanh biến mất.
 * Danh sách sinh từ Registry: phòng ban mới tự có tài khoản mẫu, không viết cứng HR/ACC.
 */
export const DEMO_ENABLED = import.meta.env.VITE_DEMO_LOGIN === 'true';

export interface DemoAccount {
  key: string;
  dept: string;
  username: string;
  password: string;
  label: string;
  role: 'STAFF' | 'MANAGER' | 'EXECUTIVE';
}

export const demoAccounts = (departments: Array<{ code: string; name: string }>): DemoAccount[] => {
  if (!DEMO_ENABLED || departments.length === 0) return [];
  const list: DemoAccount[] = departments.flatMap((d) => [
    { key: `${d.code}-staff`, dept: d.code, username: demoUsername(d.code, 'staff'), password: 'Staff@123', label: `${d.code} · Nhân viên`, role: 'STAFF' as const },
    { key: `${d.code}-manager`, dept: d.code, username: demoUsername(d.code, 'manager'), password: 'Admin@123', label: `${d.code} · Trưởng phòng`, role: 'MANAGER' as const },
  ]);
  list.push({ key: 'executive', dept: departments[0].code, username: 'admin', password: 'Admin@123', label: 'Ban Giám đốc', role: 'EXECUTIVE' });
  return list;
};
