// ============================================================
// BIGINT JSON SERIALIZATION HELPER
// ============================================================
// Tránh lỗi "TypeError: Do not know how to serialize a BigInt"
// khi NestJS trả về response chứa kiểu BIGINT từ PostgreSQL
// ============================================================

export function setupBigIntSerialization(): void {
  if (!(BigInt.prototype as any).toJSON) {
    (BigInt.prototype as any).toJSON = function () {
      return this.toString();
    };
  }
}

/**
 * Chuyển đổi các trường BigInt trong object thành String
 */
export function sanitizeBigInt<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}
