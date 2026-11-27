import { useCallback, useEffect, useState } from 'react';

/** Tên hệ thống hiển thị trên giao diện. */
export const APP_NAME = 'Hệ thống quản lý phòng ban';

type Theme = 'light' | 'dark';

const read = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/** Chế độ sáng/tối: lớp `dark` trên <html>, nhớ lựa chọn trong trình duyệt (index.html đặt sẵn khi tải trang). */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* trình duyệt chặn lưu trữ: chỉ áp dụng cho phiên này */
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}
