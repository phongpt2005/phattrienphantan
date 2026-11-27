#!/bin/sh
# Cụm 3 máy (Swarm): một bản Redis trong nhóm Sentinel "dms-redis".
#   ME=<tên service của bản này, vd redis-2>  DEFAULT_MASTER=redis-1  REDIS_PASSWORD
# Trên Swarm, tên service luôn phân giải được (địa chỉ ảo của service còn cả khi bản đó chết), nên nhóm dùng TÊN
# thay cho IP cố định (bản một máy phải dùng IP: tên container chết không phân giải được, Sentinel treo; xem start-sentinel.sh).
# Trước khi chạy, hỏi Sentinel bản chính hiện tại: bản bị khởi động lại sau khi đã chuyển phải vào làm bản sao.
set -eu
M=""
for s in redis-sentinel-1 redis-sentinel-2 redis-sentinel-3; do
  M=$(timeout 3 redis-cli -h "$s" -p 26379 -a "$REDIS_PASSWORD" --no-auth-warning \
        SENTINEL get-master-addr-by-name dms-redis 2>/dev/null | head -1 || true)
  [ -n "$M" ] && break
done
[ -n "$M" ] || M="$DEFAULT_MASTER"
set -- --requirepass "$REDIS_PASSWORD" --masterauth "$REDIS_PASSWORD" \
       --replica-announce-ip "$ME" --maxmemory 128mb --maxmemory-policy allkeys-lru
if [ "$M" = "$ME" ]; then
  echo "start-redis: $ME là bản chính"
  exec docker-entrypoint.sh redis-server "$@"
fi
echo "start-redis: $ME là bản sao của $M"
exec docker-entrypoint.sh redis-server "$@" --replicaof "$M" 6379
