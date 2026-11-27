#!/usr/bin/env bash
# ============================================================
# P1 B2: kiểm CSDL trung tâm tự chuyển máy chính (Patroni 2 node + etcd 3 nút + HAProxy 2 bản)
#   bash infrastructure/scripts/central-failover-test.sh
#
# Một tiến trình ghi liên tục qua HAProxy (central-db:5432), ghi lại từng dòng ĐÃ ĐƯỢC XÁC NHẬN. Từ đó đo:
#   - RTO: từ lần ghi lỗi đầu tiên tới lần ghi được trở lại (mục tiêu <= 30 giây);
#   - RPO: mọi dòng đã xác nhận phải còn sau khi chuyển (ghi đồng bộ).
# Ca kiểm:
#   1. Hiện trạng: một máy chính, một bản sao đồng bộ.
#   2. Máy chính sập đột ngột (kill). Bật lại: nó vào làm bản sao, theo kịp.
#   3. Máy chính bị treo (pause) lâu hơn ttl rồi tỉnh lại: không được có hai máy chính; máy cũ từ chối ghi.
#   3b. Bản sao sập khi máy chính còn sống: vẫn ghi được, sau đó đồng bộ lại.
#   4. Một nút etcd (nút leader của etcd) sập: còn quorum 2/3, ghi không gián đoạn, máy chính không đổi.
#   4b. Mất quorum etcd (2/3 nút dừng 35 giây): máy chính vẫn ghi được (failsafe_mode).
#   5. Một bản HAProxy sập: tên central-db vẫn tới bản còn lại, ghi được, search vẫn nối CSDL.
#   5b. Cả hai bản HAProxy sập: tìm kiếm vẫn HTTP 200 (đọc từ các node phòng ban); bật lại thì ghi được.
# Bài kiểm tạo bảng b2_probe rồi xóa ở cuối. Mọi container đã dừng/treo luôn được bật lại, kể cả khi lỗi.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
export MSYS_NO_PATHCONV=1
export PGPASSWORD="$POSTGRES_CENTRAL_PASSWORD"     # docker exec -e PGPASSWORD lấy giá trị từ môi trường, không hiện trên dòng lệnh
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
RTO_MAX=30
TMP=$(mktemp -d)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }

NODES="central-pg-1 central-pg-2"
PAUSED=""; STOPPED=""
cleanup() {
  [ -n "$PAUSED" ] && docker unpause $PAUSED >/dev/null 2>&1
  [ -n "$STOPPED" ] && docker start $STOPPED >/dev/null 2>&1
  touch "$TMP/stop"; docker exec central-db sh -c 'touch /tmp/b2_stop' >/dev/null 2>&1
  local l; l=$(leader); [ -n "$l" ] && lsql "$l" 'drop table if exists b2_probe' >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

is_primary() { docker exec "$1" wget -q -T 3 -O /dev/null http://127.0.0.1:8008/primary 2>/dev/null; }
leaders()    { local n=0 c; for c in $NODES; do is_primary "$c" && n=$((n+1)); done; echo $n; }
leader()     { local c; for c in $NODES; do is_primary "$c" && { echo "$c"; return; }; done; }
other()      { [ "$1" = central-pg-1 ] && echo central-pg-2 || echo central-pg-1; }
lsql()       { docker exec "$1" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$2" 2>&1; }      # nối cục bộ trong node
psql_hap()   { docker exec -e PGPASSWORD central-db psql "host=127.0.0.1 port=5432 user=$POSTGRES_CENTRAL_USER dbname=$POSTGRES_CENTRAL_DB connect_timeout=3" -qtAc "$1" 2>&1; }   # -q: không in dòng trạng thái "INSERT 0 1"
wait_leader(){ local t0; t0=$(date +%s); while [ $(( $(date +%s)-t0 )) -lt "${1:-90}" ]; do [ "$(leaders)" = 1 ] && return 0; sleep 1; done; return 1; }
sync_state() { lsql "$1" "select coalesce(string_agg(application_name||':'||state||':'||sync_state, ','), '') from pg_stat_replication where application_name like 'central-pg-%'"; }
wait_sync()  { # chờ node $1 (máy chính) có bản sao streaming và đồng bộ
  local t0; t0=$(date +%s); while [ $(( $(date +%s)-t0 )) -lt "${2:-120}" ]; do case "$(sync_state "$1")" in *streaming:sync*) return 0;; esac; sleep 2; done; return 1; }

# Tiến trình ghi nền trong container central-db: mỗi dòng xác nhận ghi 'ack <id> <giây>', lỗi ghi 'err - <giây>'
writer_start() {
  docker exec central-db rm -f /tmp/b2_stop
  docker exec -e PGPASSWORD -e U="$POSTGRES_CENTRAL_USER" -e D="$POSTGRES_CENTRAL_DB" central-db sh -c '
    i='"$1"'; while [ ! -f /tmp/b2_stop ]; do i=$((i+1))
      if psql "host=127.0.0.1 port=5432 user=$U dbname=$D connect_timeout=2" -qtAc "insert into b2_probe(v) values ($i)" >/dev/null 2>&1
      then echo "ack $i $(date +%s)"; else echo "err $i $(date +%s)"; fi; sleep 0.3
    done' > "$TMP/w.txt" 2>/dev/null &
  WPID=$!; sleep 3; }
writer_stop() { docker exec central-db sh -c 'touch /tmp/b2_stop' >/dev/null; wait "$WPID" 2>/dev/null; }
# "khong-loi" nếu không ghi nhận lần ghi nào bị lỗi: chưa thực sự kiểm được chuyển máy chính, không được tính là RTO 0
rto()  { awk '$1=="err"{if(!f)f=$3; e=1; next} $1=="ack"&&e&&!d{d=$3} END{ if(!f)print "khong-loi"; else if(!d)print "chua"; else print d-f }' "$TMP/w.txt"; }
judge_rto() { case "$1" in khong-loi) bad "RTO: không ghi nhận lần ghi lỗi nào, ca này chưa kiểm được gì";; chua) bad "không ghi lại được sau sự cố";; *) if [ "$1" -le $RTO_MAX ]; then ok "RTO $1 giây (<= $RTO_MAX; $(grep -c '^ack' "$TMP/w.txt") lần ghi được, $(grep -c '^err' "$TMP/w.txt") lần lỗi)"; else bad "RTO $1 giây, vượt $RTO_MAX"; fi;; esac; }
lost() { # số dòng đã xác nhận mà không còn trong bảng
  awk '$1=="ack"{print $2}' "$TMP/w.txt" | sort -n > "$TMP/acks"
  lsql "$(leader)" 'select v from b2_probe' | sort -n > "$TMP/rows"
  [ -s "$TMP/acks" ] || { echo "khong-co-ack"; return; }      # không có dòng xác nhận thì không được tự đạt
  comm -23 <(sort "$TMP/acks") <(sort "$TMP/rows") | grep -c . ; }
wait_ack() { # chờ tới khi có lần ghi được SAU lần lỗi gần nhất (tối đa $1 giây), đọc tệp của tiến trình ghi
  local t0; t0=$(date +%s)
  while [ $(( $(date +%s)-t0 )) -lt "$1" ]; do
    awk '$1=="err"{e=NR} $1=="ack"&&e&&NR>e{ok=1} END{exit !ok}' "$TMP/w.txt" && { sleep 2; return 0; }
    sleep 1
  done; return 1; }
probe_lag() { psql_hap 'select 1' >/dev/null; }

[ "$(central_mode)" = patroni ] || { echo "Hệ thống chưa dùng cụm Patroni (search chưa trỏ central-db). Dừng."; exit 2; }

echo "== 1. Hiện trạng =="
check "đúng một máy chính" "$(leaders)" 1
L=$(leader); echo "  máy chính: $L; bản sao: $(sync_state "$L")"
wait_sync "$L" 60 && ok "bản sao đang streaming và đồng bộ" || bad "bản sao chưa đồng bộ ($(sync_state "$L"))"
psql_hap 'create table if not exists b2_probe(v bigint, at timestamptz default now()); truncate b2_probe' >/dev/null
check "ghi được qua HAProxy" "$(psql_hap 'insert into b2_probe(v) values (0) returning v')" 0

echo "== 2. Máy chính $L sập đột ngột (kill) =="
AR0=$(lsql "$L" 'select count(*) from access_request')
writer_start 1000
docker kill "$L" >/dev/null; STOPPED="$L"
wait_leader 120; wait_ack 60; writer_stop
N=$(leader); echo "  máy chính mới: ${N:-không có}; ghi nhận: $(grep -c '^ack' "$TMP/w.txt") thành công, $(grep -c '^err' "$TMP/w.txt") lỗi"
judge_rto "$(rto)"
check "không mất dòng nào đã xác nhận" "$(lost)" 0
check "yêu cầu xin quyền không mất" "$(lsql "$N" 'select count(*) from access_request')" "$AR0"
check "đúng một máy chính" "$(leaders)" 1
docker start "$L" >/dev/null; STOPPED=""
wait_sync "$N" 150 && ok "$L bật lại thành bản sao, streaming và đồng bộ" || bad "$L chưa theo kịp ($(sync_state "$N"))"
check "$L không còn nhận ghi trực tiếp (chỉ đọc)" "$(lsql "$L" 'insert into b2_probe(v) values (-1)' | grep -c -i 'read-only')" 1

echo "== 3. Máy chính bị treo 40 giây rồi tỉnh lại (ghi hai nơi) =="
L=$(leader); O=$(other "$L")
writer_start 5000
docker pause "$L" >/dev/null; PAUSED="$L"
for i in $(seq 1 60); do is_primary "$O" && break; sleep 1; done
wait_ack 60; writer_stop
judge_rto "$(rto)"
check "máy phụ $O đã thành máy chính" "$(is_primary "$O" && echo co || echo khong)" co
docker unpause "$L" >/dev/null; PAUSED=""
sleep 12
check "máy cũ tỉnh lại: vẫn chỉ một máy chính" "$(leaders)" 1
check "máy cũ từ chối ghi" "$(lsql "$L" 'insert into b2_probe(v) values (-2)' | grep -c -i 'read-only\|shutting down\|starting up\|could not connect\|No such file')" 1
check "không mất dòng nào đã xác nhận" "$(lost)" 0
wait_sync "$O" 150 && ok "máy cũ quay lại làm bản sao đồng bộ" || bad "máy cũ chưa theo kịp ($(sync_state "$O"))"

echo "== 3b. Bản sao sập khi máy chính còn sống (ghi đồng bộ lùi về bất đồng bộ, không dừng ghi) =="
L=$(leader); O=$(other "$L")
writer_start 8000
docker kill "$O" >/dev/null; STOPPED="$O"
sleep 25; writer_stop
check "máy chính không đổi" "$(leader)" "$L"
LASTACK=$(awk '$1=="ack"{l=$3} END{print l+0}' "$TMP/w.txt"); MAXGAP=$(awk '$1=="ack"{if(p && $3-p>m)m=$3-p; p=$3} END{print m+0}' "$TMP/w.txt")
echo "  ghi được $(grep -c '^ack' "$TMP/w.txt") lần, lỗi $(grep -c '^err' "$TMP/w.txt") lần, khoảng ngắt dài nhất $MAXGAP giây"
if [ "$(grep -c '^ack' "$TMP/w.txt")" -gt 5 ] && [ "$MAXGAP" -le $RTO_MAX ]; then ok "bản sao sập: vẫn ghi được (ngắt dài nhất $MAXGAP giây <= $RTO_MAX)"; else bad "bản sao sập làm dừng ghi quá lâu (ngắt dài nhất $MAXGAP giây)"; fi
check "không mất dòng nào đã xác nhận" "$(lost)" 0
docker start "$O" >/dev/null; STOPPED=""
wait_sync "$L" 150 && ok "bản sao bật lại, đồng bộ trở lại" || bad "bản sao chưa đồng bộ lại ($(sync_state "$L"))"

ETCDS="central-etcd central-etcd-2 central-etcd-3"
etcd_leader() { local n; for n in $ETCDS; do
  docker exec "$n" etcdctl endpoint status -w json 2>/dev/null | python -I -X utf8 -c 'import sys,json; d=json.load(sys.stdin)[0]["Status"]; sys.exit(0 if d["leader"]==d["header"]["member_id"] else 1)' 2>/dev/null && { echo "$n"; return; }
done; }
etcd_healthy() { local n c=0; for n in $ETCDS; do docker exec "$n" etcdctl endpoint health >/dev/null 2>&1 && c=$((c+1)); done; echo $c; }

echo "== 4. Một nút etcd (leader của etcd) sập: còn quorum, ghi không gián đoạn =="
L=$(leader); EL=$(etcd_leader); echo "  leader etcd: ${EL:-không thấy}; máy chính: $L"
check "etcd đủ 3 nút khỏe trước ca" "$(etcd_healthy)" 3
writer_start 9100
docker kill "$EL" >/dev/null; STOPPED="$EL"
sleep 25; writer_stop
MAXGAP=$(awk '$1=="ack"{if(p && $3-p>m)m=$3-p; p=$3} END{print m+0}' "$TMP/w.txt")
echo "  ghi được $(grep -c '^ack' "$TMP/w.txt") lần, lỗi $(grep -c '^err' "$TMP/w.txt") lần, khoảng ngắt dài nhất $MAXGAP giây"
check "không có lần ghi nào lỗi" "$(grep -c '^err' "$TMP/w.txt")" 0
check "máy chính không đổi" "$(leader)" "$L"
check "còn 2 nút etcd khỏe (quorum)" "$(etcd_healthy)" 2
NEL=$(etcd_leader); [ -n "$NEL" ] && [ "$NEL" != "$EL" ] && ok "etcd bầu leader mới: $NEL" || bad "etcd chưa có leader mới (nhận '$NEL')"
check "không mất dòng nào đã xác nhận" "$(lost)" 0
docker start "$EL" >/dev/null; STOPPED=""
for i in $(seq 1 30); do [ "$(etcd_healthy)" = 3 ] && break; sleep 2; done
check "nút etcd bật lại: đủ 3 nút khỏe" "$(etcd_healthy)" 3

echo "== 4b. Mất quorum etcd (2/3 nút dừng 35 giây): máy chính vẫn ghi được (failsafe_mode) =="
L=$(leader)
docker stop central-etcd-2 central-etcd-3 >/dev/null; STOPPED="central-etcd-2 central-etcd-3"
sleep 35
check "ghi được khi etcd mất quorum (lâu hơn ttl 20 giây)" "$(psql_hap 'insert into b2_probe(v) values (9001) returning v')" 9001
check "máy chính vẫn là $L" "$(leader)" "$L"
docker start central-etcd-2 central-etcd-3 >/dev/null; STOPPED=""
for i in $(seq 1 30); do [ "$(etcd_healthy)" = 3 ] && break; sleep 2; done
check "etcd đủ 3 nút khỏe trở lại" "$(etcd_healthy)" 3
wait_leader 90; check "sau khi etcd có quorum lại: đúng một máy chính" "$(leaders)" 1

search_db() { # "ok" chỉ khi MỌI bản search-engine-service đều nối được CSDL
  local c r all=ok n=0
  for c in $(docker ps --format '{{.Names}}' | grep 'search-engine-service'); do n=$((n+1))
    r=$(docker exec "$c" wget -q -T 5 -O - http://127.0.0.1:3003/health 2>/dev/null | python -I -X utf8 -c 'import sys,json; print(json.load(sys.stdin).get("database",""))' 2>/dev/null)
    [ "$r" = ok ] || all="$c:$r"
  done; [ "$n" -gt 0 ] || all=khong-co-search; echo "$all"; }
hap_via_name() { docker exec -e PGPASSWORD "$1" psql "host=central-db port=5432 user=$POSTGRES_CENTRAL_USER dbname=$POSTGRES_CENTRAL_DB connect_timeout=3" -qtAc "$2" 2>&1; }

echo "== 5. Một bản HAProxy (central-db) sập: tên central-db tới bản còn lại =="
docker stop central-db >/dev/null; STOPPED="central-db"
sleep 3
check "ghi được qua tên central-db (bản central-db-2)" "$(hap_via_name central-db-2 'insert into b2_probe(v) values (9003) returning v')" 9003
OKS=0; for i in $(seq 1 10); do [ "$(search_db)" = ok ] && OKS=$((OKS+1)); sleep 1; done
check "search nối CSDL qua tên central-db: 10/10 lần health database=ok" "$OKS" 10
docker start central-db >/dev/null; STOPPED=""
for i in $(seq 1 30); do [ "$(psql_hap 'select 1')" = 1 ] && break; sleep 2; done

echo "== 5b. Cả hai bản HAProxy sập =="
docker stop central-db central-db-2 >/dev/null; STOPPED="central-db central-db-2"
TK=$(curl -s -X POST "$BASE/api/dept/hr/auth/login" -H 'content-type: application/json' -d "{\"username\":\"hr_staff\",\"password\":\"$DEMO_STAFF_PASSWORD\"}" | python -I -X utf8 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")
sleep 6
check "cả hai HAProxy sập: tìm kiếm vẫn HTTP 200" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TK" --get "$BASE/api/search" --data-urlencode 'q=hop dong')" 200
docker start central-db central-db-2 >/dev/null; STOPPED=""
for i in $(seq 1 30); do [ "$(psql_hap 'select 1')" = 1 ] && break; sleep 2; done
check "HAProxy bật lại: ghi được" "$(psql_hap 'insert into b2_probe(v) values (9002) returning v')" 9002
OKS=0; for i in $(seq 1 20); do [ "$(search_db)" = ok ] && break; sleep 2; done
check "search nối lại CSDL sau khi HAProxy bật lại" "$(search_db)" ok

echo
echo "===== KẾT QUẢ CENTRAL FAILOVER: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
