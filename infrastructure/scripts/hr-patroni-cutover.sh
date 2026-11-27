#!/usr/bin/env bash
# ============================================================
# P2 N2: chuyển CSDL phòng HR từ máy chủ đơn (postgres-hr-primary + bản sao bất đồng bộ) sang cụm Patroni
# (hr-pg-1, hr-pg-2, HAProxy hr-db 2 bản).
#   bash infrastructure/scripts/hr-patroni-cutover.sh
#
# Cách làm: chép nguyên thư mục dữ liệu (cùng system id, cùng vị trí WAL, giữ slot dbz_hr_outbox) rồi để Patroni
# nhận lại. Debezium đọc tiếp đúng offset đã lưu, không phải chụp lại dữ liệu, không phát lại sự kiện.
#   1. Dừng ghi: dừng dept-hr, dept-hr-2; chờ Debezium đọc hết slot; tạm dừng connector outbox-hr.
#   2. Băm từng bảng ở CSDL cũ; dừng sạch CSDL cũ (checkpoint, lưu vị trí slot).
#   3. Chép volume cũ (gắn chỉ đọc) sang volume hr-pg-1; volume cũ giữ nguyên để quay lui.
#   4. Khởi động hr-pg-1 (Patroni nhận dữ liệu), so băm; khác thì dừng và hướng dẫn quay lui.
#   5. hr-pg-2 (sao chép cơ sở từ hr-pg-1, đồng bộ), HAProxy hr-db và hr-db-2.
#   6. Đổi connector sang hr-db, chạy lại; tạo lại dept-hr, dept-hr-2 với DATABASE_URL mới.
# Thời gian HR không ghi được: từ bước 1 tới bước 6 (đo và in ra).
# Quay lui (trước khi có ghi mới trên cụm mới): docs/11, mục quay lui N2.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
export MSYS_NO_PATHCONV=1
OLD=postgres-hr-primary
OLD_VOL=dms-pgdata-hr-primary
NEW_VOL=dms-hr-pg-1-data
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
step() { echo; echo "== $* =="; }
die()  { echo "DỪNG: $*"; exit 1; }
CW() { # Kafka Connect: worker đang sống
  local h; for h in debezium debezium-2; do docker exec "$h" curl -s -m 3 -o /dev/null http://localhost:8083/ 2>/dev/null && { echo "$h"; return; }; done; }
conn() { docker exec "$(CW)" curl -s -m 10 "$@"; }
psqlc() { docker exec "$1" psql -U "$POSTGRES_HR_USER" -d "$POSTGRES_HR_DB" -tAc "$2"; }
digest() { # băm theo từng bảng của schema public: tên|số dòng|md5 nội dung
  local c=$1 tb
  for tb in $(psqlc "$c" "select tablename from pg_tables where schemaname='public' order by 1"); do
    echo "$tb|$(psqlc "$c" "select count(*)||'|'||coalesce(md5(string_agg(x::text,'|' order by x::text)),'') from public.\"$tb\" x")"
  done; }
wait_primary() { local t0; t0=$(date +%s)
  while [ $(( $(date +%s)-t0 )) -lt "$2" ]; do docker exec "$1" wget -q -T 3 -O /dev/null http://127.0.0.1:8008/primary 2>/dev/null && return 0; sleep 2; done; return 1; }
wait_sync() { local t0; t0=$(date +%s)
  while [ $(( $(date +%s)-t0 )) -lt "$3" ]; do
    [ "$(psqlc "$1" "select count(*) from pg_stat_replication where application_name='$2' and state='streaming' and sync_state in ('sync','quorum')")" = 1 ] && return 0; sleep 2
  done; return 1; }
wait_healthy() { local t0; t0=$(date +%s)
  while [ $(( $(date +%s)-t0 )) -lt "$2" ]; do [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ] && return 0; sleep 2; done; return 1; }

step "0. Điều kiện ban đầu"
[ "$(hr_mode)" = legacy ] || die "dept-hr đã trỏ hr-db (đã chuyển rồi)"
docker volume inspect "$NEW_VOL" >/dev/null 2>&1 && die "volume $NEW_VOL đã có. Kiểm tra rồi xóa nó nếu là bản thử dở dang."
[ "$(docker inspect -f '{{.State.Running}}' $OLD)" = true ] || die "$OLD không chạy"
n=0; for e in central-etcd central-etcd-2 central-etcd-3; do docker exec "$e" etcdctl endpoint health >/dev/null 2>&1 && n=$((n+1)); done
[ "$n" = 3 ] || die "etcd chưa đủ 3 nút khỏe ($n)"
[ -n "$(CW)" ] || die "không có worker Kafka Connect nào sống"
echo "  connector outbox-hr: $(conn http://localhost:8083/connectors/outbox-hr/status | python -I -X utf8 -c 'import sys,json; d=json.load(sys.stdin); print(d["connector"]["state"], [t["state"] for t in d["tasks"]])')"
DOCS0=$(psqlc $OLD "select count(*) from document")
echo "  tài liệu ở CSDL HR cũ: $DOCS0"

step "1. Dừng ghi vào CSDL HR"
T_DOWN=$(date +%s)
docker stop -t 30 dept-hr dept-hr-2 >/dev/null
for i in $(seq 1 45); do
  LAG=$(psqlc $OLD "select pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint from pg_replication_slots where slot_name='dbz_hr_outbox'")
  [ "${LAG:-1}" -le 0 ] && break; sleep 2
done
echo "  slot dbz_hr_outbox còn chưa đọc: ${LAG} byte (0 = Debezium đã đọc hết)"
conn -o /dev/null -w '  tạm dừng connector: HTTP %{http_code}\n' -X PUT http://localhost:8083/connectors/outbox-hr/pause
sleep 3
SLOT_OLD=$(psqlc $OLD "select confirmed_flush_lsn from pg_replication_slots where slot_name='dbz_hr_outbox'")
SYSID_OLD=$(psqlc $OLD "select system_identifier from pg_control_system()")
echo "  slot confirmed_flush_lsn: $SLOT_OLD; system id: $SYSID_OLD"

step "2. Băm từng bảng ở CSDL cũ rồi dừng sạch"
digest $OLD > "$TMP/old.txt"
echo "  $(wc -l < "$TMP/old.txt") bảng"
docker stop -t 60 postgres-hr-replica >/dev/null 2>&1 || true
docker stop -t 90 $OLD >/dev/null

step "3. Chép dữ liệu sang volume $NEW_VOL (volume cũ gắn chỉ đọc)"
# Gắn nhãn như volume do compose tạo, để compose không cảnh báo "volume already exists but was not created by Docker Compose"
docker volume create --label com.docker.compose.project="$(docker compose config --format json | python -I -c 'import sys,json; print(json.load(sys.stdin)["name"])')" --label com.docker.compose.volume=hr-pg-1-data "$NEW_VOL" >/dev/null
docker run --rm -v "$OLD_VOL":/src:ro -v "$NEW_VOL":/dst alpine:3.20 sh -c '
  set -e
  [ ! -f /src/postmaster.pid ] || { echo "CSDL cũ chưa dừng sạch (còn postmaster.pid)"; exit 1; }
  mkdir /dst/pgroot && cp -a /src/. /dst/pgroot/
  chown 70:70 /dst /dst/pgroot && chmod 700 /dst/pgroot
  du -sh /dst/pgroot | cut -f1'

step "4. Khởi động hr-pg-1: Patroni nhận lại dữ liệu"
docker compose up -d --no-build --no-deps hr-pg-1
wait_primary hr-pg-1 180 || die "hr-pg-1 chưa thành máy chính sau 180 giây (docker logs hr-pg-1). Quay lui: docs/11."
for i in $(seq 1 30); do psqlc hr-pg-1 "select 1" >/dev/null 2>&1 && break; sleep 2; done
check_eq() { if [ "$2" = "$3" ]; then echo "  KHỚP $1"; else echo "  KHÁC $1: '$2' khác '$3'"; return 1; fi; }
check_eq "system id" "$(psqlc hr-pg-1 "select system_identifier from pg_control_system()")" "$SYSID_OLD"
check_eq "slot dbz_hr_outbox (confirmed_flush_lsn)" "$(psqlc hr-pg-1 "select confirmed_flush_lsn from pg_replication_slots where slot_name='dbz_hr_outbox'")" "$SLOT_OLD"
digest hr-pg-1 > "$TMP/new.txt"
if diff -q "$TMP/old.txt" "$TMP/new.txt" >/dev/null; then echo "  KHỚP băm $(wc -l < "$TMP/new.txt") bảng"; else
  diff "$TMP/old.txt" "$TMP/new.txt" | cut -c1-120; die "dữ liệu khác nhau. Dừng hr-pg-1 và quay lui."; fi
psqlc hr-pg-1 "show wal_level; show hot_standby_feedback" | tr '\n' ' '; echo

step "5. hr-pg-2 (sao chép cơ sở, đồng bộ) và HAProxy"
docker compose up -d --no-build --no-deps hr-pg-2
wait_sync hr-pg-1 hr-pg-2 240 || die "hr-pg-2 chưa streaming và đồng bộ sau 240 giây"
echo "  hr-pg-2 streaming và đồng bộ"
docker compose up -d --no-build --no-deps hr-db hr-db-2
wait_healthy hr-db 60 && wait_healthy hr-db-2 60 || die "HAProxy hr-db chưa khỏe"

step "6. Debezium sang hr-db; node HR sang cụm mới"
# Sửa đúng một khóa của cấu hình (có mật khẩu) qua đường ống, không in ra
conn http://localhost:8083/connectors/outbox-hr/config \
  | python -I -X utf8 -c 'import sys,json; c=json.load(sys.stdin); c["database.hostname"]="hr-db"; sys.stdout.write(json.dumps(c))' \
  | docker exec -i "$(CW)" curl -s -m 10 -o /dev/null -w '  cập nhật connector: HTTP %{http_code}\n' -X PUT -H 'Content-Type: application/json' --data-binary @- http://localhost:8083/connectors/outbox-hr/config
conn -o /dev/null -w '  chạy lại connector: HTTP %{http_code}\n' -X PUT http://localhost:8083/connectors/outbox-hr/resume
docker compose up -d --no-build --no-deps --force-recreate dept-hr dept-hr-2
wait_healthy dept-hr 180 || die "dept-hr chưa khỏe"
T_UP=$(date +%s)
for i in $(seq 1 30); do
  ST=$(conn http://localhost:8083/connectors/outbox-hr/status | python -I -X utf8 -c 'import sys,json; d=json.load(sys.stdin); print(d["connector"]["state"]+"/"+",".join(t["state"] for t in d["tasks"]))')
  A=$(psqlc hr-pg-1 "select active from pg_replication_slots where slot_name='dbz_hr_outbox'")
  [ "$ST" = RUNNING/RUNNING ] && [ "$A" = t ] && break; sleep 2
done
echo "  connector: $ST; slot đang được đọc: $A"
echo "  tài liệu ở cụm mới: $(psqlc hr-pg-1 "select count(*) from document") (trước khi chuyển: $DOCS0)"
echo "  hr_mode: $(hr_mode); máy chính: $(hr_leader)"
echo
echo "== XONG. HR không ghi được trong $((T_UP - T_DOWN)) giây =="
