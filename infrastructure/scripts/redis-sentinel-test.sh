#!/usr/bin/env bash
# ============================================================
# P3 (bổ sung thành phần): kiểm Redis có bản sao và 3 Sentinel, đi qua đường thật của người dùng.
#   bash infrastructure/scripts/redis-sentinel-test.sh
# Ca kiểm:
#   1. Hiện trạng: một bản chính, bản sao online, 3 Sentinel cùng thấy một bản chính và đủ quorum.
#   2. Bản chính sập đột ngột (kill): Sentinel chuyển sang bản sao; dữ liệu ghi trước đó còn nguyên.
#   3. Sau khi chuyển: trưởng phòng thu hồi token nhân viên được (node ghi vào bản chính mới); gateway từ chối
#      token đã thu hồi (đọc từ bản chính mới); token mới vẫn dùng được; mọi bản Search Gateway nghe lại kênh thông báo.
#   4. Bản chính cũ bật lại: tự vào làm bản sao của bản chính mới (không thành hai bản chính).
#   5. Chuyển ngược có kế hoạch (SENTINEL FAILOVER) để trả về cấu hình ban đầu; thu hồi vẫn có hiệu lực.
# Container đã dừng luôn được bật lại, kể cả khi lỗi.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
export MSYS_NO_PATHCONV=1
G="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
PASS=0; FAIL=0; STOPPED=""; STAMP=$(date +%s)
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
cleanup() { [ -n "$STOPPED" ] && docker start $STOPPED >/dev/null 2>&1; }
trap cleanup EXIT
R()  { docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$1" redis-cli "${@:2}" 2>/dev/null | tr -d '\r'; }
S()  { local s; for s in redis-sentinel-1 redis-sentinel-2 redis-sentinel-3; do
         docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$s" redis-cli -p 26379 "$@" 2>/dev/null | tr -d '\r' && return; done; }
# Nhóm Redis làm việc bằng IP cố định (start-sentinel.sh): đổi IP <-> tên container để in và so
name_of() { case "$1" in 172.28.250.11) echo redis;; 172.28.250.12) echo redis-2;; *) echo "$1";; esac; }
ip_of()   { case "$1" in redis) echo 172.28.250.11;; redis-2) echo 172.28.250.12;; *) echo "$1";; esac; }
master_of() { name_of "$(docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$1" redis-cli -p 26379 SENTINEL get-master-addr-by-name dms-redis 2>/dev/null | head -1 | tr -d '\r')"; }
agree()  { local a b c; a=$(master_of redis-sentinel-1); b=$(master_of redis-sentinel-2); c=$(master_of redis-sentinel-3)
           [ -n "$a" ] && [ "$a" = "$b" ] && [ "$b" = "$c" ] && echo "$a" || echo "khong-dong-thuan:$a/$b/$c"; }
other() { [ "$1" = redis ] && echo redis-2 || echo redis; }
jf() { python -I -X utf8 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
login() { curl -s -m 15 -X POST "$G/api/dept/hr/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jf "d.get('accessToken','')+'|'+str(d.get('user',{}).get('userId',''))"; }
code()   { curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "$2"; }
revoke() { curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$G/api/dept/hr/auth/users/$2/revoke" -H "Authorization: Bearer $1"; }
# Mọi bản Search Gateway phải nghe kênh thông báo trên bản chính hiện tại (2026-11-27: một bản mất Redis vĩnh viễn sau
# lần chuyển đầu, cảnh báo cho Ban Giám đốc không tới, mà các ca thu hồi token ở trên vẫn đạt)
SEARCH_N=$(docker ps -q --filter label=com.docker.compose.service=search-engine-service | wc -l | tr -d ' ')
subs() { R "$1" pubsub numsub dms:notices | sed -n 2p; }
wait_subs() { local v=""; for i in $(seq 1 30); do v=$(subs "$1"); [ "$v" = "$SEARCH_N" ] && break; sleep 1; done; echo "$v"; }

echo "== 1. Hiện trạng =="
M=$(agree); echo "  bản chính theo Sentinel: $M"
case "$M" in redis|redis-2) ok "3 Sentinel cùng thấy một bản chính ($M)";; *) bad "Sentinel không đồng thuận ($M)";; esac
O=$(other "$M")
check "bản chính $M có vai trò master" "$(R "$M" role | head -1)" master
check "bản sao $O đang online" "$(R "$O" info replication | grep -c '^master_link_status:up')" 1
check "đủ quorum" "$(S SENTINEL ckquorum dms-redis | grep -c '^OK')" 1
check "cả $SEARCH_N bản Search Gateway nghe kênh thông báo trên $M" "$(wait_subs "$M")" "$SEARCH_N"
R "$M" set "sentinel-probe:$STAMP" "truoc-khi-chuyen" >/dev/null
IFS='|' read -r ST STAFF_ID <<< "$(login hr_staff "$DEMO_STAFF_PASSWORD")"
IFS='|' read -r MT _ <<< "$(login hr_manager "$DEMO_MANAGER_PASSWORD")"
check "token nhân viên dùng được trước sự cố" "$(code "$ST" "$G/api/search?q=tai")" 200

echo "== 2. Bản chính $M sập đột ngột =="
T0=$(date +%s)
docker kill "$M" >/dev/null; STOPPED="$M"
N=""; for i in $(seq 1 45); do N=$(agree); [ "$N" = "$O" ] && break; sleep 1; done
echo "  bản chính mới: $N sau $(( $(date +%s)-T0 )) giây"
check "Sentinel chuyển bản chính sang $O" "$N" "$O"
check "$O có vai trò master" "$(R "$O" role | head -1)" master
check "dữ liệu ghi trước khi chuyển còn trên bản chính mới" "$(R "$O" get "sentinel-probe:$STAMP")" "truoc-khi-chuyen"

echo "== 3. Sau khi chuyển: thu hồi token vẫn có hiệu lực =="
C=""; for i in $(seq 1 20); do C=$(revoke "$MT" "$STAFF_ID"); [ "$C" = 201 ] && break; sleep 1; done
check "trưởng phòng thu hồi token nhân viên (node ghi vào bản chính mới)" "$C" 201
check "khóa thu hồi nằm trên bản chính mới" "$(R "$O" exists "tv:HR:$STAFF_ID")" 1
X=""; for i in $(seq 1 15); do X=$(code "$ST" "$G/api/search?q=tai"); [ "$X" = 401 ] && break; sleep 1; done
check "gateway từ chối token đã thu hồi (đọc từ bản chính mới)" "$X" 401
IFS='|' read -r ST2 _ <<< "$(login hr_staff "$DEMO_STAFF_PASSWORD")"
check "token mới sau khi đăng nhập lại dùng được" "$(code "${ST2:-x}" "$G/api/search?q=tai")" 200
check "cả $SEARCH_N bản Search Gateway nghe lại kênh thông báo trên bản chính mới" "$(wait_subs "$O")" "$SEARCH_N"

echo "== 4. Bản chính cũ $M bật lại =="
docker start "$M" >/dev/null; STOPPED=""
for i in $(seq 1 40); do [ "$(R "$M" info replication | grep -c '^master_link_status:up')" = 1 ] && break; sleep 2; done
check "$M vào làm bản sao" "$(R "$M" role | head -1)" slave
check "$M theo bản chính mới $O" "$(name_of "$(R "$M" info replication | grep '^master_host:' | cut -d: -f2)")" "$O"
check "vẫn đúng một bản chính theo Sentinel" "$(agree)" "$O"

echo "== 5. Chuyển ngược có kế hoạch về $M =="
S SENTINEL failover dms-redis >/dev/null
B=""; for i in $(seq 1 45); do B=$(agree); [ "$B" = "$M" ] && [ "$(R "$M" role | head -1)" = master ] && break; sleep 1; done
check "bản chính trở lại $M" "$B" "$M"
for i in $(seq 1 40); do [ "$(R "$O" info replication | grep -c '^master_link_status:up')" = 1 ] && break; sleep 2; done
check "$O trở lại làm bản sao online" "$(R "$O" info replication | grep -c '^master_link_status:up')" 1
X=""; for i in $(seq 1 15); do X=$(code "$ST" "$G/api/search?q=tai"); [ "$X" = 401 ] && break; sleep 1; done
check "token đã thu hồi vẫn bị từ chối sau khi chuyển ngược" "$X" 401
check "token mới vẫn dùng được sau khi chuyển ngược" "$(code "${ST2:-x}" "$G/api/search?q=tai")" 200
check "cả $SEARCH_N bản Search Gateway nghe kênh thông báo sau khi chuyển ngược" "$(wait_subs "$M")" "$SEARCH_N"
R "$M" del "sentinel-probe:$STAMP" >/dev/null

echo
echo "===== KẾT QUẢ REDIS SENTINEL: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
