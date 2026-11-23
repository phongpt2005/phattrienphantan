export type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF';

export interface JwtPayload {
  userId: number;
  username: string;
  fullName: string;
  role: UserRole;
  /** Mã phòng ban của node đã cấp token, ví dụ 'HR', 'ACC', 'SALES'... (không còn giới hạn 2 giá trị) */
  departmentCode: string;
  /** Phiên bản thu hồi lúc cấp token (mặc định 0 với token cũ). Xem thu hồi token ở ADR-013. */
  tv?: number;
}

export interface AuthenticatedUser extends JwtPayload {}

/**
 * Ban Giám đốc (Executive) được suy ra từ vai trò ADMIN trong token,
 * KHÔNG nhận từ tham số do client gửi lên.
 */
export function isExecutive(user: Pick<JwtPayload, 'role'> | undefined | null): boolean {
  return user?.role === 'ADMIN';
}

export function isManagerOrAbove(user: Pick<JwtPayload, 'role'> | undefined | null): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}
