import type Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

/**
 * Cấu hình kết nối Redis dùng chung cho mọi dịch vụ (thu hồi token, cache, thông báo).
 *
 * Có REDIS_SENTINELS ("redis-sentinel-1:26379,redis-sentinel-2:26379,...") thì kết nối qua Sentinel: ioredis hỏi
 * Sentinel xem bản chính đang ở đâu, và nối lại bản chính mới khi Sentinel chuyển (P3, bổ sung thành phần).
 * Không có REDIS_SENTINELS thì nối thẳng REDIS_HOST:REDIS_PORT như trước, hành vi không đổi.
 */
export function redisConnectionOptions(): RedisOptions {
  const password = process.env.REDIS_PASSWORD || undefined;
  const sentinels = (process.env.REDIS_SENTINELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [host, port] = s.split(':');
      return { host, port: Number(port || 26379) };
    });
  if (sentinels.length > 0) {
    return {
      sentinels,
      name: process.env.REDIS_SENTINEL_NAME || 'dms-redis',
      role: 'master',
      password,
      sentinelPassword: password,
      // KHÔNG bật failoverDetector: khi Sentinel báo đổi bản chính đúng lúc client đang kết nối, nó hủy lần kết nối đó,
      // Redis.connect() của ioredis 5.11 chuyển client sang 'end' và không thử lại nữa (gặp 2026-11-27: một bản search
      // mất Redis vĩnh viễn sau lần chuyển, cảnh báo cho Ban Giám đốc không tới). Không có nó, client vẫn theo bản chính
      // mới: mất kết nối thì nối lại và hỏi Sentinel.
      // Lỡ nối vào bản chính cũ vừa bị hạ thành bản sao: lệnh ghi bị từ chối READONLY, nối lại để hỏi Sentinel
      reconnectOnError: (err: Error) => err.message.includes('READONLY'),
    };
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password,
  };
}

/**
 * Lớp giữ sống: client rơi vào trạng thái 'end' (ioredis ngừng tự nối lại, vì bất kỳ lý do gì) thì nối lại sau 2 giây.
 * Không áp cho client đang được đóng chủ động khi dịch vụ tắt (gọi markClosing trước khi disconnect).
 */
export function keepRedisAlive(client: Redis): { markClosing: () => void } {
  let closing = false;
  client.on('end', () => {
    if (closing) return;
    setTimeout(() => {
      if (!closing && client.status === 'end') client.connect().catch(() => undefined);
    }, 2000).unref();
  });
  return { markClosing: () => (closing = true) };
}
