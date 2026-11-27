#!/usr/bin/env bash
# ============================================================
# P3 (bổ sung thành phần): kiểm lớp vào bên trong mạng: 2 gateway nginx, 2 bộ cân bằng (HAProxy + Keepalived)
# giữ địa chỉ ảo VIP 172.28.255.10.
#   bash infrastructure/scripts/keepalived-test.sh
# Ca kiểm (gọi liên tục qua VIP từ một container khác trong mạng, đo khoảng ngắt dài nhất):
#   1. Hiện trạng: đúng một bộ cân bằng giữ VIP; /health và tìm kiếm có token qua VIP; cổng 8000 của máy như cũ.
#   2. Gateway nginx sập: VIP không cần đổi chỗ, HAProxy chuyển yêu cầu sang nginx-2.
#   3. Bộ cân bằng đang giữ VIP sập: VIP sang bộ còn lại.
#   4. Bật lại: vẫn đúng một bên giữ VIP, gọi qua VIP vẫn được.
#   5. HAProxy trong một bộ cân bằng chết: container tự thoát, restart policy bật lại, khỏe lại và không kẹt vòng lặp.
# Giới hạn (ghi rõ trong báo cáo): cổng 8000 của máy gắn vào container nginx; VIP chỉ dùng được bên trong mạng.
# Container đã dừng luôn được bật lại, kể cả khi lỗi.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
export MSYS_NO_PATHCONV=1
G="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
VIP=172.28.255.10
CLIENT=debezium            # container trong dms-network có curl, dùng làm "client bên trong"
PASS=0; FAIL=0; STOPPED=""
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
cleanup() { [ -n "$STOPPED" ] && docker start $STOPPED >/dev/null 2>&1; docker exec "$CLIENT" sh -c 'touch /tmp/vip_stop' >/dev/null 2>&1; }
trap cleanup EXIT
# In "<số bên giữ VIP>:<container giữ VIP>"
holder() { local c n=0 h=""; for c in keepalived-1 keepalived-2; do
             [ "$(docker exec "$c" ip -o -4 addr show 2>/dev/null | grep -c " $VIP/")" = 1 ] && { n=$((n+1)); h="$c"; }; done; echo "$n:$h"; }
wait_one() { local i H; for i in $(seq 1 30); do H=$(holder); [ "${H%%:*}" = 1 ] && { echo "$H"; return; }; sleep 1; done; echo "$H"; }
via_vip() { docker exec "$CLIENT" curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$VIP$1" -H "${2:-X-None: 1}"; }
# Gọi /health qua VIP mỗi 0,5 giây trong nền; gap_since <t0>: khoảng ngắt dài nhất (giây) và số lần lỗi từ t0
probe_start() { docker exec "$CLIENT" sh -c 'rm -f /tmp/vip_stop /tmp/vip.log'
  docker exec -d "$CLIENT" sh -c "while [ ! -f /tmp/vip_stop ]; do c=\$(curl -s -m 1 -o /dev/null -w '%{http_code}' http://$VIP/health); echo \"\$(date +%s) \$c\" >> /tmp/vip.log; sleep 0.5; done"; sleep 2; }
probe_stop() { docker exec "$CLIENT" sh -c 'touch /tmp/vip_stop'; sleep 1; }
gap_since() { docker exec "$CLIENT" cat /tmp/vip.log | awk -v t0="$1" '$1>=t0 {if ($2=="200") {if (last && $1-last>m) m=$1-last; last=$1} else e++} END{print m+0, e+0}'; }
TK=$(curl -s -m 15 -X POST "$G/api/dept/hr/auth/login" -H 'content-type: application/json' -d "{\"username\":\"hr_manager\",\"password\":\"$DEMO_MANAGER_PASSWORD\"}" | python -I -X utf8 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")

echo "== 1. Hiện trạng =="
H=$(wait_one); check "đúng một bộ cân bằng giữ VIP" "${H%%:*}" 1
HK=${H#*:}; OK2=$([ "$HK" = keepalived-1 ] && echo keepalived-2 || echo keepalived-1)
echo "  VIP $VIP đang ở $HK"
check "gọi /health qua VIP" "$(via_vip /health)" 200
check "tìm kiếm có token qua VIP" "$(via_vip '/api/search?q=hop%20dong' "Authorization: Bearer $TK")" 200
check "cổng 8000 của máy vẫn chạy như cũ" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$G/health")" 200

echo "== 2. Gateway nginx sập: yêu cầu qua VIP đi sang nginx-2 =="
probe_start; T0=$(date +%s)
docker stop nginx >/dev/null; STOPPED="nginx"
sleep 10
check "VIP vẫn ở $HK (không cần đổi chỗ)" "$(holder)" "1:$HK"
check "gọi /health qua VIP khi nginx sập" "$(via_vip /health)" 200
check "tìm kiếm có token qua VIP khi nginx sập" "$(via_vip '/api/search?q=hop%20dong' "Authorization: Bearer $TK")" 200
probe_stop; read -r GAP ERR <<< "$(gap_since "$T0")"
echo "  gọi liên tục qua VIP: $ERR lần lỗi, khoảng ngắt dài nhất $GAP giây"
[ "$GAP" -le 10 ] && ok "khoảng ngắt dài nhất $GAP giây (<= 10)" || bad "ngắt quá lâu ($GAP giây)"
docker start nginx >/dev/null; STOPPED=""
for i in $(seq 1 30); do [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$G/health")" = 200 ] && break; sleep 2; done
check "nginx bật lại, cổng 8000 chạy lại" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$G/health")" 200

echo "== 3. Bộ cân bằng đang giữ VIP ($HK) sập: VIP chuyển sang $OK2 =="
probe_start; T0=$(date +%s)
docker stop "$HK" >/dev/null; STOPPED="$HK"
for i in $(seq 1 30); do [ "$(docker exec "$OK2" ip -o -4 addr show 2>/dev/null | grep -c " $VIP/")" = 1 ] && break; sleep 1; done
echo "  VIP sang $OK2 sau $(( $(date +%s)-T0 )) giây"
check "VIP chuyển sang $OK2" "$(docker exec "$OK2" ip -o -4 addr show 2>/dev/null | grep -c " $VIP/")" 1
sleep 5
check "tìm kiếm có token qua VIP khi $HK sập" "$(via_vip '/api/search?q=hop%20dong' "Authorization: Bearer $TK")" 200
probe_stop; read -r GAP ERR <<< "$(gap_since "$T0")"
echo "  gọi liên tục qua VIP: $ERR lần lỗi, khoảng ngắt dài nhất $GAP giây"
[ "$GAP" -le 10 ] && ok "khoảng ngắt dài nhất $GAP giây (<= 10)" || bad "ngắt quá lâu ($GAP giây)"

echo "== 4. Bật lại $HK =="
docker start "$HK" >/dev/null; STOPPED=""
for i in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$HK")" = healthy ] && break; sleep 2; done
sleep 4
H=$(wait_one); check "đúng một bộ cân bằng giữ VIP" "${H%%:*}" 1
echo "  VIP đang ở ${H#*:}"
check "gọi /health qua VIP" "$(via_vip /health)" 200

echo "== 5. HAProxy trong keepalived-1 chết: container tự thoát, restart policy bật lại, không kẹt =="
# 2026-11-27: sau khi script tự thoát, tệp pid cũ làm keepalived báo "daemon is already running" và container khởi động
# lại mãi. Ca 4 (docker start) không đi qua đường này, nên không bắt được.
R0=$(docker inspect -f '{{.RestartCount}}' keepalived-1)
docker exec keepalived-1 sh -c 'kill -9 $(cat /run/haproxy.pid)' >/dev/null 2>&1
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.RestartCount}}' keepalived-1)" -gt "$R0" ] && break; sleep 1; done
check "keepalived-1 được restart policy bật lại" "$([ "$(docker inspect -f '{{.RestartCount}}' keepalived-1)" -gt "$R0" ] && echo co)" co
for i in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' keepalived-1)" = healthy ] && break; sleep 2; done
check "keepalived-1 khỏe lại sau khi tự khởi động lại" "$(docker inspect -f '{{.State.Health.Status}}' keepalived-1)" healthy
sleep 10
R1=$(docker inspect -f '{{.RestartCount}}' keepalived-1)
check "keepalived-1 không khởi động lại thêm (không kẹt vòng lặp)" "$([ "$R1" -le $((R0+1)) ] && echo on-dinh || echo "R0=$R0 R1=$R1")" on-dinh
H=$(wait_one); check "đúng một bộ cân bằng giữ VIP" "${H%%:*}" 1
check "gọi /health qua VIP" "$(via_vip /health)" 200

echo
echo "===== KẾT QUẢ KEEPALIVED: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
