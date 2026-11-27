#!/bin/sh
# Cụm 3 máy (Swarm): một Sentinel giám sát nhóm "dms-redis" (bản chính ban đầu: redis-1). Làm việc bằng tên service
# (luôn phân giải được trên Swarm). resolve-hostnames phải đứng TRƯỚC dòng monitor.
#   ME=<tên service của Sentinel này>  REDIS_PASSWORD
# Cấu hình chỉ tạo khi chưa có (Sentinel tự ghi lại trạng thái sau mỗi lần chuyển bản chính).
set -eu
CONF=/data/sentinel.conf
if [ ! -s "$CONF" ] || ! grep -q '^# dms-sentinel-swarm-v1' "$CONF"; then
  cat > "$CONF" <<EOF
# dms-sentinel-swarm-v1
port 26379
dir /data
sentinel resolve-hostnames yes
sentinel announce-hostnames yes
sentinel announce-ip $ME
requirepass $REDIS_PASSWORD
sentinel sentinel-pass $REDIS_PASSWORD
sentinel monitor dms-redis redis-1 6379 2
sentinel auth-pass dms-redis $REDIS_PASSWORD
sentinel down-after-milliseconds dms-redis 5000
sentinel failover-timeout dms-redis 20000
sentinel parallel-syncs dms-redis 1
EOF
  echo "start-sentinel: tạo cấu hình cho $ME"
fi
exec docker-entrypoint.sh redis-server "$CONF" --sentinel
