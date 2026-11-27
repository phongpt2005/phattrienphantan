#!/usr/bin/env bash
# ============================================================
# P1 B1 (phần còn lại): kiểm chịu lỗi Kafka Connect 2 worker (debezium, debezium-2, cùng GROUP_ID)
#   bash infrastructure/scripts/debezium-failover-test.sh
#
# 1. Cả 2 worker healthy, 3 connector RUNNING; ghi worker đang giữ task của từng connector.
# 2. Dừng worker đang giữ task outbox-hr: task phải chuyển sang worker còn lại và RUNNING
#    (scheduled.rebalance.max.delay.ms = 30 s); tài liệu mới tạo ở HR vào Central Index.
# 3. Bật lại worker: healthy, 3 connector RUNNING, tài liệu mới vẫn vào Central Index.
# Worker đã dừng luôn được bật lại khi script kết thúc, kể cả khi lỗi.
# Bài kiểm để lại hai tài liệu "Kiem thu failover Debezium ..." ở phòng HR (giống e2e).
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
WORKERS="debezium debezium-2"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
jget() { python -I -X utf8 -c "import sys,json
try:
    d=json.load(sys.stdin)
    for k in '$1'.split('.'):
        d=d[int(k)] if k.isdigit() else d[k]
    print('' if d is None else d)
except Exception:
    print('')"; }

STOPPED=""
restore() { local s; s=$(echo $STOPPED); if [ -n "$s" ]; then docker start $s >/dev/null; echo "  khôi phục: đã bật lại $s"; STOPPED=""; fi; }
trap restore EXIT

wait_healthy() {
  for _ in $(seq 1 40); do
    local all=1
    for w in "$@"; do [ "$(docker inspect -f '{{.State.Health.Status}}' "$w" 2>/dev/null)" = healthy ] || all=0; done
    [ "$all" = 1 ] && return 0; sleep 3
  done; return 1; }

# Trạng thái connector lấy từ worker nào còn sống (REST của worker nào cũng thấy mọi connector)
status_json() {
  local w out
  for w in $WORKERS; do
    out=$(docker exec "$w" curl -s -m 5 'http://localhost:8083/connectors?expand=status' 2>/dev/null) && [ -n "$out" ] && { echo "$out"; return; }
  done; echo '{}'; }
running_count() { status_json | python -I -X utf8 -c "import sys,json
try:
    d=json.load(sys.stdin); print(sum(1 for v in d.values() if v['status']['connector']['state']=='RUNNING' and v['status']['tasks'] and all(t['state']=='RUNNING' for t in v['status']['tasks'])))
except Exception:
    print(0)"; }
task_worker() { status_json | python -I -X utf8 -c "import sys,json
try:
    d=json.load(sys.stdin); t=d['$1']['status']['tasks'][0]; print(t['worker_id'].split(':')[0] if t['state']=='RUNNING' else '')
except Exception:
    print('')"; }
layout() { status_json | python -I -X utf8 -c "import sys,json
try:
    d=json.load(sys.stdin); print(', '.join('%s -> %s' % (k, ','.join(t['worker_id'].split(':')[0] for t in v['status']['tasks'])) for k,v in sorted(d.items())))
except Exception:
    print('?')"; }

search(){ curl -s -H "Authorization: Bearer $1" --get "$BASE/api/search" --data-urlencode "q=$2"; }
HR_MGR=$(curl -s -X POST "$BASE/api/dept/hr/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"hr_manager\",\"password\":\"$DEMO_MANAGER_PASSWORD\"}" | jget accessToken)
[ -n "$HR_MGR" ] || { echo "Không đăng nhập được hr_manager"; exit 2; }

cdc_check() {  # tạo tài liệu ở HR, chờ vào Central Index (outbox -> Debezium -> Kafka -> projector)
  local label=$1 T W TITLE UP DOC t0 t1 found=""
  T=$(mktemp -d); W=$(cygpath -m "$T" 2>/dev/null || echo "$T")
  printf 'kiem thu failover debezium %s\n' "$(date +%s)" > "$W/f.txt"
  TITLE="Kiem thu failover Debezium $(date +%s%N)"
  UP=$(curl -s -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $HR_MGR" \
    -F "title=$TITLE" -F "description=kiem thu chiu loi Kafka Connect" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain")
  DOC=$(echo "$UP" | jget docId)
  if [ -z "$DOC" ]; then bad "$label: tạo tài liệu lỗi"; rm -rf "$T"; return; fi
  t0=$(date +%s)
  for _ in $(seq 1 90); do found=$(search "$HR_MGR" "$TITLE" | jget data.0.central_doc_id); [ -n "$found" ] && break; sleep 1; done
  t1=$(date +%s)
  if [ -n "$found" ]; then ok "$label: tài liệu mới (docId=$DOC) vào Central Index sau $((t1-t0)) s"
  else bad "$label: Central Index chưa có tài liệu docId=$DOC sau 90 s"; fi
  rm -rf "$T"; }

echo "== 1. Hiện trạng =="
wait_healthy $WORKERS && ok "2 worker healthy" || bad "chưa đủ 2 worker healthy"
check "3 connector RUNNING" "$(running_count)" 3
echo "  phân bố task: $(layout)"
VICTIM=$(task_worker outbox-hr)
case "$VICTIM" in debezium) OTHER=debezium-2;; debezium-2) OTHER=debezium;; *) bad "không xác định được worker giữ task outbox-hr ('$VICTIM')"; echo "===== KẾT QUẢ DEBEZIUM FAILOVER: $PASS đạt, $FAIL lỗi ====="; exit 1;; esac

echo "== 2. Dừng worker đang giữ task outbox-hr ($VICTIM) =="
docker stop "$VICTIM" >/dev/null; STOPPED="$VICTIM"; t0=$(date +%s); moved=""
for _ in $(seq 1 60); do
  [ "$(task_worker outbox-hr)" = "$OTHER" ] && [ "$(running_count)" = 3 ] && { moved=1; break; }; sleep 3
done
t1=$(date +%s)
[ -n "$moved" ] && ok "task outbox-hr chuyển sang $OTHER, 3 connector RUNNING sau $((t1-t0)) s" \
                || bad "sau $((t1-t0)) s task chưa chuyển (phân bố: $(layout); RUNNING $(running_count)/3)"
echo "  phân bố task: $(layout)"
cdc_check "khi $VICTIM sập"

echo "== 3. Bật lại $VICTIM =="
docker start "$VICTIM" >/dev/null; STOPPED=""
wait_healthy $WORKERS && ok "2 worker healthy lại" || bad "$VICTIM chưa healthy"
for _ in $(seq 1 30); do [ "$(running_count)" = 3 ] && break; sleep 3; done
check "sau khi bật lại: 3 connector RUNNING" "$(running_count)" 3
echo "  phân bố task: $(layout)"
cdc_check "sau khi bật lại"

echo
echo "===== KẾT QUẢ DEBEZIUM FAILOVER: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
