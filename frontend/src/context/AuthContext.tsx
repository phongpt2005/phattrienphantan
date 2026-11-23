import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserSession, UserRole } from '../types';
import { authApi, setAuthToken } from '../services/api';

interface AuthContextType {
  user: UserSession | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (dept: string, username: string, password: string, isExecutive?: boolean) => Promise<{ success: boolean; message?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  login: async () => ({ success: false }),
  logout: () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserSession | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Khôi phục session từ localStorage khi reload trang
  useEffect(() => {
    try {
      const savedToken = localStorage.getItem('dms_token');
      const savedSessionStr = localStorage.getItem('dms_session');
      if (savedToken && savedSessionStr) {
        const savedSession = JSON.parse(savedSessionStr) as UserSession;
        setAuthToken(savedToken);
        setUser(savedSession);
      }
    } catch (e) {
      console.warn('Không thể khôi phục phiên đăng nhập cũ:', e);
      localStorage.removeItem('dms_token');
      localStorage.removeItem('dms_session');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const login = async (
    dept: string,
    username: string,
    password: string,
    isExecutive = false,
  ): Promise<{ success: boolean; message?: string }> => {
    setIsLoading(true);
    try {
      const res = await authApi.login(dept, { username, password });
      const token = res.accessToken || res.token;

      if (!token) {
        throw new Error('Không nhận được mã xác thực token từ máy chủ.');
      }

      // Ban Giám đốc (EXECUTIVE) = vai trò ADMIN do server xác nhận trong token,
      // KHÔNG còn phụ thuộc nút bấm ở giao diện (tham số isExecutive bị bỏ qua).
      const executive = res.user?.role === 'ADMIN';
      let finalRole: UserRole = 'STAFF';
      if (executive) {
        finalRole = 'EXECUTIVE';
      } else if (res.user?.role === 'MANAGER' || res.user?.role === 'ADMIN') {
        finalRole = 'MANAGER';
      } else {
        finalRole = 'STAFF';
      }

      const session: UserSession = {
        userId: res.user?.userId ? Number(res.user.userId) : undefined,
        username: res.user?.username || username,
        fullName: executive
          ? 'Ban Giám Đốc Điều Hành'
          : res.user?.fullName || (finalRole === 'MANAGER' ? 'Trưởng Phòng' : 'Nhân Viên'),
        departmentCode: res.user?.departmentCode || dept,
        role: finalRole,
        token,
        isExecutive: executive,
      };

      setAuthToken(token);
      localStorage.setItem('dms_session', JSON.stringify(session));
      setUser(session);
      return { success: true };
    } catch (err: any) {
      const errorMsg =
        err.response?.data?.message ||
        (typeof err.response?.data === 'string' ? err.response.data : null) ||
        err.message ||
        'Đăng nhập không thành công. Vui lòng kiểm tra lại thông tin.';
      return { success: false, message: errorMsg };
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    setAuthToken(null);
    localStorage.removeItem('dms_session');
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user && !!user.token,
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
