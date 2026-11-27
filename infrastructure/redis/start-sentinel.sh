#!/bin/sh
# Khởi động một Sentinel giám sát nhóm "dms-redis" (bản chính ban đầu: redis, IP cố định MASTER_IP).
#   ME_IP=<IP cố định của Sentinel này>  MASTER_IP=<IP của bản chính ban đầu>  REDIS_PASSWORD
#
# Sentinel làm việc bằng IP, KHÔNG dùng tên máy: Redis phân giải tên đồng bộ, chặn cả vòng lặp; khi container
# bản chính dừng thì tên của nó không còn, mỗi lần hỏi tên chặn Sentinel khoảng 1 giây và việc chuyển bản chính
# kéo dài vài phút (đo 2026-11-27: 154-284 giây, log "Failed to resolve hostname 'redis'"). Vì vậy nhóm Redis và
# Sentinel có IP cố định trong mạng container.
#
# Sentinel tự ghi lại cấu hình (bản chính hiện tại, các Sentinel khác) vào /data/sentinel.conf: chỉ tạo tệp khi
# chưa có hoặc khác phiên bản cấu hình (dấu "# dms-sentinel-v2"), để giữ đúng trạng thái sau khi đã chuyển bản chính.
set -eu
CONF=/data/sentinel.conf
if [ ! -s "$CONF" ] || ! grep -q '^# dms-sentinel-v2' "$CONF"; then
  cat > "$CONF" <<EOF
# dms-sentinel-v2
port 26379
dir /data
sentinel announce-ip $ME_IP
requirepass $REDIS_PASSWORD
sentinel sentinel-pass $REDIS_PASSWORD
sentinel monitor dms-redis $MASTER_IP 6379 2
sentinel auth-pass dms-redis $REDIS_PASSWORD
sentinel down-after-milliseconds dms-redis 5000
sentinel failover-timeout dms-redis 20000
sentinel parallel-syncs dms-redis 1
EOF
  echo "start-sentinel: tạo cấu hình mới (v2, theo IP) cho $ME_IP"
fi
# Qua docker-entrypoint.sh: chỉnh quyền /data và chạy dưới user redis (Sentinel cần ghi lại tệp cấu hình)
exec docker-entrypoint.sh redis-server "$CONF" --sentinel
