#!/bin/sh
# Khởi động một bản Redis trong nhóm Sentinel "dms-redis".
#   ME_IP=<IP cố định của bản này>  DEFAULT_MASTER_IP=<bản chính khi chưa có Sentinel nào trả lời>  REDIS_PASSWORD
# Trước khi chạy, hỏi Sentinel bản chính hiện tại là ai: bản bị khởi động lại sau khi Sentinel đã chuyển bản chính
# phải vào làm bản sao của bản chính mới, không được tự nhận là bản chính (hai bản chính = mất ghi).
# Nhóm làm việc bằng IP cố định (lý do: xem start-sentinel.sh). Sentinel được hỏi bằng IP, không cần DNS.
# Chạy qua docker-entrypoint.sh của image: chỉnh quyền /data và chạy dưới user redis, như Redis trước đây.
set -eu
M=""
for s in 172.28.250.21 172.28.250.22 172.28.250.23; do
  M=$(redis-cli -h "$s" -p 26379 -a "$REDIS_PASSWORD" --no-auth-warning \
        SENTINEL get-master-addr-by-name dms-redis 2>/dev/null | head -1 || true)
  [ -n "$M" ] && break
done
[ -n "$M" ] || M="$DEFAULT_MASTER_IP"
# Cùng tham số với Redis trước đây (lưu RDB mặc định), chỉ thêm masterauth và địa chỉ công bố cho nhóm Sentinel
set -- --requirepass "$REDIS_PASSWORD" --masterauth "$REDIS_PASSWORD" \
       --replica-announce-ip "$ME_IP" --maxmemory 128mb --maxmemory-policy allkeys-lru
if [ "$M" = "$ME_IP" ]; then
  echo "start-redis: $ME_IP là bản chính"
  exec docker-entrypoint.sh redis-server "$@"
fi
echo "start-redis: $ME_IP là bản sao của $M"
exec docker-entrypoint.sh redis-server "$@" --replicaof "$M" 6379
