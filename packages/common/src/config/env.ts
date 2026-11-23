/**
 * Đọc biến môi trường bắt buộc. Thiếu là dừng ngay khi khởi động (fail-fast),
 * KHÔNG có giá trị mặc định nằm trong mã nguồn (JWT secret, token nội bộ, DB...).
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  }
  return value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
