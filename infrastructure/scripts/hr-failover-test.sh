#!/usr/bin/env bash
# ============================================================
# P2 N2: kiểm CSDL phòng HR tự chuyển máy chính (Patroni 2 node + HAProxy hr-db 2 bản) và CDC không mất sự kiện.
#   bash infrastructure/scripts/hr-failover-test.sh
#
# Hai phía được đo cùng lúc:
#   - Ghi thẳng qua HAProxy (tiến trình nền trong hr-db): RTO, và mọi dòng đã xác nhận còn sau khi chuyển (RPO 0).
#   - Tạo tài liệu qua API (cổng 8000) liên tục: mọi tài liệu đã được trả 201 phải lên chỉ mục trung tâm.
#     Đây là kiểm tra slot logic dbz_hr_outbox có sẵn trên máy chính mới (Patroni chép slot sang bản sao).
# Ca kiểm:
#   1. Hiện trạng: một máy chính, bản sao đồng bộ, slot Debezium có trên CẢ HAI node, connector RUNNING.
#   2. Máy chính sập đột ngột (kill) giữa lúc đang tạo tài liệu.
#   3. Máy chính cũ bật lại: thành bản sao đồng bộ, có lại bản chép của slot.
#   4. Bản sao sập: ghi không dừng.
#   5. Một bản HAProxy sập: node HR vẫn tạo được tài liệu.
# Bài kiểm tạo bảng n2_probe rồi xóa ở cuối. Container đã dừng luôn được bật lại, kể cả khi lỗi.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
export MSYS_NO_PATHCONV=1
export PGPASSWORD="$POSTGRES_HR_PASSWORD"
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
RTO_MAX=30
TMP=$(mktemp -d); W="$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")"
STAMP=$(date +%s)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
NODES="hr-pg-1 hr-pg-2"; STOPPED=""
cleanup() {
  [ -n "$STOPPED" ] && docker start $STOPPED >/dev/null 2>&1
  touch "$TMP/stop"; docker exec hr-db sh -c 'touch /tmp/n2_stop' >/dev/null 2>&1
  local l; l=$(hr_leader); [ -n "$l" ] && lsql "$l" 'drop table if exists n2_probe' >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
is_primary() { docker exec "$1" wget -q -T 3 -O /dev/null http://127.0.0.1:8008/primary 2>/dev/null; }
leaders() { local n=0 c; for c in $NODES; do is_primary "$c" && n=$((n+1)); done; echo $n; }
other()   { [ "$1" = hr-pg-1 ] && echo hr-pg-2 || echo hr-pg-1; }
lsql()    { docker exec "$1" psql -U "$POSTGRES_HR_USER" -d "$POSTGRES_HR_DB" -tAc "$2" 2>&1; }
CEN()     { docker exec "$(central_leader)" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
psql_hap(){ docker exec -e PGPASSWORD hr-db psql "host=127.0.0.1 port=5432 user=$POSTGRES_HR_USER dbname=$POSTGRES_HR_DB connect_timeout=3" -qtAc "$1" 2>&1; }
wait_leader(){ local t0; t0=$(date +%s); while [ $(( $(date +%s)-t0 )) -lt "${1:-90}" ]; do [ "$(leaders)" = 1 ] && return 0; sleep 1; done; return 1; }
wait_sync() { local t0; t0=$(date +%s); while [ $(( $(date +%s)-t0 )) -lt "$2" ]; do
  [ "$(lsql "$1" "select count(*) from pg_stat_replication where application_name like 'hr-pg-%' and state='streaming' and sync_state in ('sync','quorum')")" = 1 ] && return 0; sleep 2; done; return 1; }
has_slot() { lsql "$1" "select count(*) from pg_replication_slots where slot_name='dbz_hr_outbox' and slot_type='logical'"; }
# Bản chép slot DÙNG ĐƯỢC: đoạn WAL cần cho restart_lsn còn trên node đó. Chỉ "có slot" là chưa đủ: lượt 1 (2026-11-26)
# bản chép trỏ vào đoạn WAL bản sao không có, Patroni vẫn báo an toàn, chuyển máy chính xong Debezium kẹt.
slot_usable() { lsql "$1" "select case when (pg_wal_lsn_diff(s.restart_lsn,'0/0')::bigint / w.seg) >= (('x'||substr(o.n,9,8))::bit(32)::bigint*256 + ('x'||substr(o.n,17,8))::bit(32)::bigint) then 1 else 0 end
  from pg_replication_slots s, (select setting::bigint seg from pg_settings where name='wal_segment_size') w,
       (select min(name) n from pg_ls_waldir() where name ~ '^[0-9A-F]{24}\$') o where s.slot_name='dbz_hr_outbox'"; }
wait_slot() { local t0; t0=$(date +%s); while [ $(( $(date +%s)-t0 )) -lt "$2" ]; do [ "$(has_slot "$1")" = 1 ] && [ "$(slot_usable "$1")" = 1 ] && return 0; sleep 3; done; return 1; }
guard_state() { docker exec "$1" sh -c 'cat /tmp/slot-guard.json 2>/dev/null' | python -I -X utf8 -c 'import sys,json; print(json.load(sys.stdin).get("slots",{}).get("dbz_hr_outbox",""))' 2>/dev/null; }
CW() { local h; for h in debezium debezium-2; do docker exec "$h" curl -s -m 3 -o /dev/null http://localhost:8083/ 2>/dev/null && { echo "$h"; return; }; done; }
conn_state() { docker exec "$(CW)" curl -s -m 10 http://localhost:8083/connectors/outbox-hr/status | python -I -X utf8 -c 'import sys,json; d=json.load(sys.stdin); print(d["connector"]["state"]+"/"+",".join(t["state"] for t in d["tasks"]))' 2>/dev/null; }

# Ghi nền qua HAProxy: 'ack <id> <giây>' hoặc 'err <id> <giây>'
writer_start() {
  docker exec hr-db rm -f /tmp/n2_stop
  docker exec -e PGPASSWORD -e U="$POSTGRES_HR_USER" -e D="$POSTGRES_HR_DB" hr-db sh -c '
    i='"$1"'; while [ ! -f /tmp/n2_stop ]; do i=$((i+1))
      if psql "host=127.0.0.1 port=5432 user=$U dbname=$D connect_timeout=2" -qtAc "insert into n2_probe(v) values ($i)" >/dev/null 2>&1
      then echo "ack $i $(date +%s)"; else echo "err $i $(date +%s)"; fi; sleep 0.3
    done' > "$TMP/w.txt" 2>/dev/null &
  WPID=$!; sleep 3; }
writer_stop() { docker exec hr-db sh -c 'touch /tmp/n2_stop' >/dev/null; wait "$WPID" 2>/dev/null; }
rto()  { awk '$1=="err"{if(!f)f=$3; e=1; next} $1=="ack"&&e&&!d{d=$3} END{ if(!f)print "khong-loi"; else if(!d)print "chua"; else print d-f }' "$TMP/w.txt"; }
lost() { awk '$1=="ack"{print $2}' "$TMP/w.txt" | sort > "$TMP/acks"; lsql "$(hr_leader)" 'select v from n2_probe' | sort > "$TMP/rows"
  [ -s "$TMP/acks" ] || { echo "khong-co-ack"; return; }; comm -23 "$TMP/acks" "$TMP/rows" | grep -c . ; }

# Tạo tài liệu qua API liên tục: 'ack <số> <docId>' khi được 201, 'err <số> <mã>' khi lỗi
login() { curl -s -m 15 -X POST "$BASE/api/dept/hr/auth/login" -H 'content-type: application/json' -d "{\"username\":\"hr_manager\",\"password\":\"$DEMO_MANAGER_PASSWORD\"}" | python -I -X utf8 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))"; }
docs_start() {
  rm -f "$TMP/docs_stop"; printf 'noi dung kiem thu N2\n' > "$TMP/f.txt"
  ( i=0; while [ ! -f "$TMP/docs_stop" ]; do i=$((i+1))
      c=$(curl -s -m 15 -o "$W/r$i.json" -w '%{http_code}' -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $TK" \
          -F "title=HRFO-$STAMP-$i" -F "description=kiem thu N2" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain")
      if [ "$c" = 201 ] || [ "$c" = 200 ]; then echo "ack $i $(date +%s)"; else echo "err $i $c $(date +%s)"; fi
      sleep 1
    done ) > "$TMP/docs.txt" 2>/dev/null &
  DPID=$!; }
docs_stop() { touch "$TMP/docs_stop"; wait "$DPID" 2>/dev/null; }

[ "$(hr_mode)" = patroni ] || { echo "Node HR chưa dùng cụm Patroni (dept-hr chưa trỏ hr-db). Dừng."; exit 2; }
TK=$(login); [ -n "$TK" ] || { echo "Không đăng nhập được hr_manager"; exit 2; }

echo "== 1. Hiện trạng =="
check "đúng một máy chính" "$(leaders)" 1
L=$(hr_leader); O=$(other "$L"); echo "  máy chính: $L; bản sao: $O"
wait_sync "$L" 60 && ok "bản sao streaming và đồng bộ" || bad "bản sao chưa đồng bộ"
check "slot dbz_hr_outbox có trên máy chính" "$(has_slot "$L")" 1
wait_slot "$O" 90 && ok "bản sao $O có bản chép slot dbz_hr_outbox và DÙNG ĐƯỢC (còn đủ WAL)" || bad "bản sao $O chưa có bản chép slot dùng được (có: $(has_slot "$O"), dùng được: $(slot_usable "$O"))"
for i in $(seq 1 20); do [ "$(guard_state "$O")" = ok ] && break; sleep 3; done
check "bộ canh slot trên $O báo ok" "$(guard_state "$O")" ok
check "connector outbox-hr chạy" "$(conn_state)" RUNNING/RUNNING
psql_hap 'create table if not exists n2_probe(v bigint, at timestamptz default now()); truncate n2_probe' >/dev/null
check "ghi được qua HAProxy hr-db" "$(psql_hap 'insert into n2_probe(v) values (0) returning v')" 0

echo "== 2. Máy chính $L sập đột ngột giữa lúc đang tạo tài liệu =="
D0=$(lsql "$L" 'select count(*) from document')
writer_start 1000; docs_start; sleep 6
docker kill "$L" >/dev/null; STOPPED="$L"
wait_leader 120
t0=$(date +%s); while [ $(( $(date +%s)-t0 )) -lt 60 ]; do
  awk '$1=="err"{e=NR} $1=="ack"&&e&&NR>e{ok=1} END{exit !ok}' "$TMP/w.txt" && break; sleep 1; done
sleep 12; writer_stop; docs_stop
N=$(hr_leader); echo "  máy chính mới: ${N:-không có}; ghi thẳng: $(grep -c '^ack' "$TMP/w.txt") được, $(grep -c '^err' "$TMP/w.txt") lỗi; tài liệu qua API: $(grep -c '^ack' "$TMP/docs.txt") được, $(grep -c '^err' "$TMP/docs.txt") lỗi"
R=$(rto); case "$R" in khong-loi) bad "RTO: không ghi nhận lần ghi lỗi nào";; chua) bad "không ghi lại được sau sự cố";;
  *) [ "$R" -le $RTO_MAX ] && ok "RTO $R giây (<= $RTO_MAX)" || bad "RTO $R giây, vượt $RTO_MAX";; esac
check "không mất dòng nào đã xác nhận (ghi thẳng)" "$(lost)" 0
check "đúng một máy chính" "$(leaders)" 1
ACKED=$(awk '$1=="ack"{print "HRFO-'"$STAMP"'-"$2}' "$TMP/docs.txt" | sort)
NA=$(echo "$ACKED" | grep -c .)
check "slot dbz_hr_outbox có trên máy chính mới $N" "$(has_slot "$N")" 1
for i in $(seq 1 45); do [ "$(conn_state)" = RUNNING/RUNNING ] && [ "$(lsql "$N" "select active from pg_replication_slots where slot_name='dbz_hr_outbox'")" = t ] && break; sleep 2; done
check "Debezium đọc slot trên máy chính mới" "$(lsql "$N" "select active from pg_replication_slots where slot_name='dbz_hr_outbox'")" t
check "connector outbox-hr chạy sau chuyển" "$(conn_state)" RUNNING/RUNNING
for i in $(seq 1 60); do
  CENTRAL=$(CEN "select s.title from search_document s join department d using(department_id) where d.dept_code='HR' and s.title like 'HRFO-$STAMP-%'" | sort)
  MISS=$(comm -23 <(echo "$ACKED") <(echo "$CENTRAL") | grep -c .)
  [ "$MISS" = 0 ] && break; sleep 2
done
echo "  tài liệu đã được trả 201: $NA; thiếu ở chỉ mục trung tâm: $MISS"
[ "$NA" -ge 5 ] && check "mọi tài liệu đã xác nhận đều lên chỉ mục trung tâm (CDC không mất sự kiện)" "$MISS" 0 || bad "quá ít tài liệu được tạo ($NA) để kết luận"
check "số tài liệu ở CSDL HR tăng đúng số đã xác nhận" "$(lsql "$N" 'select count(*) from document')" "$((D0 + NA))"

echo "== 3. Máy chính cũ $L bật lại =="
docker start "$L" >/dev/null; STOPPED=""
wait_sync "$N" 180 && ok "$L thành bản sao streaming và đồng bộ" || bad "$L chưa theo kịp"
# Node có thể đang khởi động lại (Patroni chép slot logic cần khởi động lại PostgreSQL của bản sao): chờ câu trả lời dứt khoát.
# Ghi thành công ở bất kỳ lần nào là lỗi ngay.
RO=""; for i in $(seq 1 20); do r=$(lsql "$L" 'insert into n2_probe(v) values (-1)')
  case "$r" in *read-only*) RO=1; break;; *"starting up"*|*"shutting down"*|*"could not connect"*|*"No such file"*|*"not yet accepting"*) sleep 2;; *) RO="ghi-duoc: $r"; break;; esac; done
check "$L từ chối ghi trực tiếp (chỉ đọc)" "$RO" 1
wait_slot "$L" 120 && ok "$L có lại bản chép slot dbz_hr_outbox và dùng được" || bad "$L chưa có bản chép slot dùng được (có: $(has_slot "$L"), dùng được: $(slot_usable "$L"))"

echo "== 3b. Bản sao dựng lại lúc Debezium đang dừng (đúng điều kiện gây lỗi ở lượt 1): bộ canh tự sửa =="
# Tạm dừng connector; cho máy chính sang vài đoạn WAL mới (slot đứng yên ở đoạn cũ); dựng lại bản sao từ đầu (reinit):
# WAL của bản sao mới bắt đầu SAU restart_lsn của slot, nên bản chép slot không dùng được. Chạy lại connector:
# slot trên máy chính đi tiếp, bộ canh phải phát hiện và cho Patroni chép lại.
L=$(hr_leader); O=$(other "$L")
docker exec "$(CW)" curl -s -m 10 -o /dev/null -X PUT http://localhost:8083/connectors/outbox-hr/pause
sleep 3
for i in 1 2 3; do psql_hap "insert into n2_probe(v) select g from generate_series(1,2000) g" >/dev/null; lsql "$L" "select pg_switch_wal()" >/dev/null; done
lsql "$L" "checkpoint" >/dev/null
docker exec "$O" patronictl -c /etc/patroni/patroni.yml reinit dms-hr "$O" --force --wait >/dev/null 2>&1
wait_sync "$L" 240 && ok "bản sao $O dựng lại xong, đồng bộ" || bad "bản sao $O chưa đồng bộ lại sau reinit"
for i in $(seq 1 30); do [ "$(has_slot "$O")" = 1 ] && break; sleep 3; done
echo "  ngay sau reinit: bản chép slot trên $O dùng được = $(slot_usable "$O") (0 = đúng điều kiện lỗi lượt 1)"
docker exec "$(CW)" curl -s -m 10 -o /dev/null -X PUT http://localhost:8083/connectors/outbox-hr/resume
SEEN=""; for i in $(seq 1 60); do s=$(guard_state "$O"); case "$s" in recopy|UNSAFE) SEEN="$SEEN $s";; esac
  [ "$(slot_usable "$O")" = 1 ] && [ "$s" = ok ] && break; sleep 3; done
echo "  bộ canh trên $O đã báo:${SEEN:- (không cần sửa)}; trạng thái cuối: $(guard_state "$O")"
check "sau reinit: bản chép slot trên $O dùng được" "$(slot_usable "$O")" 1
check "bộ canh trên $O báo ok" "$(guard_state "$O")" ok
for i in $(seq 1 30); do [ "$(conn_state)" = RUNNING/RUNNING ] && [ "$(lsql "$L" "select active from pg_replication_slots where slot_name='dbz_hr_outbox'")" = t ] && break; sleep 2; done
check "Debezium đọc tiếp slot trên máy chính" "$(lsql "$L" "select active from pg_replication_slots where slot_name='dbz_hr_outbox'")" t

echo "== 4. Bản sao sập: ghi không dừng =="
L=$(hr_leader); O=$(other "$L")
writer_start 8000
docker kill "$O" >/dev/null; STOPPED="$O"
sleep 20; writer_stop
MAXGAP=$(awk '$1=="ack"{if(p && $3-p>m)m=$3-p; p=$3} END{print m+0}' "$TMP/w.txt")
echo "  ghi được $(grep -c '^ack' "$TMP/w.txt") lần, lỗi $(grep -c '^err' "$TMP/w.txt") lần, khoảng ngắt dài nhất $MAXGAP giây"
[ "$(grep -c '^ack' "$TMP/w.txt")" -gt 5 ] && [ "$MAXGAP" -le $RTO_MAX ] && ok "bản sao sập: vẫn ghi được (ngắt dài nhất $MAXGAP giây)" || bad "bản sao sập làm dừng ghi (ngắt dài nhất $MAXGAP giây)"
check "không mất dòng nào đã xác nhận" "$(lost)" 0
docker start "$O" >/dev/null; STOPPED=""
wait_sync "$L" 180 && ok "bản sao bật lại, đồng bộ trở lại" || bad "bản sao chưa đồng bộ lại"

echo "== 5. Một bản HAProxy (hr-db) sập: node HR vẫn tạo được tài liệu =="
docker stop hr-db >/dev/null; STOPPED="hr-db"
sleep 3
OKS=0; for i in 1 2 3 4 5; do
  c=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $TK" -F "title=HRFO-$STAMP-hap$i" -F "description=kiem thu N2" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain")
  { [ "$c" = 201 ] || [ "$c" = 200 ]; } && OKS=$((OKS+1)); sleep 1; done
check "hr-db sập: 5/5 lần tạo tài liệu thành công (qua hr-db-2)" "$OKS" 5
docker start hr-db >/dev/null; STOPPED=""
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' hr-db)" = healthy ] && break; sleep 2; done
check "hr-db bật lại khỏe" "$(docker inspect -f '{{.State.Health.Status}}' hr-db)" healthy

echo
echo "===== KẾT QUẢ HR FAILOVER: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
