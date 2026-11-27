#!/usr/bin/env bash
# ============================================================
# P2 C2: kiểm bộ tự co giãn content-worker (content-autoscaler.sh) trên hệ thống thật.
#   bash infrastructure/scripts/autoscaler-test.sh
#
# Cách tạo tải có kiểm soát: đưa về 1 bản, giới hạn CPU của bản đó còn 0,02 lõi (worker QUÁ TẢI: vẫn chạy nhưng
# không theo kịp) rồi tạo 30 tài liệu qua API. Sự kiện dồn trong Kafka (lag tăng). Bộ co giãn phải:
#   1. thêm bản khi lag vượt ngưỡng; nhóm consumer chia lại partition cho bản mới; lag về 0;
#   2. bớt bản dần về tối thiểu khi lag bằng 0 đủ lâu (sau khi bản chậm được trả CPU);
#   3. đưa về tối thiểu ngay khi mọi bản đều chết.
# (Lượt đầu dùng docker pause: docker compose --scale từ chối khi có bản paused, nên không phản ánh worker quá tải thật.)
# Cuối bài: dừng bộ co giãn, tạo lại các bản theo đúng cấu hình compose (gỡ giới hạn CPU), trả số bản như lúc đầu.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
export MSYS_NO_PATHCONV=1
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
PROM=http://127.0.0.1:9090
TMP=$(mktemp -d); W="$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")"
STAMP=$(date +%s)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
replicas() { docker compose ps -q content-worker 2>/dev/null | grep -c .; }
lag() { curl -s -m 5 "$PROM/api/v1/query" --data-urlencode 'query=sum(kafka_consumergroup_lag{consumergroup="content-indexer"})' \
        | python -I -X utf8 -c 'import sys,json; d=json.load(sys.stdin)["data"]["result"]; print(int(float(d[0]["value"][1])) if d else "")' 2>/dev/null; }
CEN() { docker exec "$(central_leader)" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
ORIG=$(replicas); SLOW=""; ASPID=""
cleanup() {
  touch "$TMP/stop"; [ -n "$ASPID" ] && wait "$ASPID" 2>/dev/null
  # Tạo lại theo cấu hình compose: gỡ giới hạn CPU đã đặt bằng docker update (docker update --cpus 0 không gỡ được)
  docker compose up -d --no-build --no-deps --force-recreate --scale content-worker="$ORIG" content-worker >/dev/null 2>&1
  cp "$TMP/as.log" "logs/autoscaler-test-$STAMP.log" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
wait_for() { # $1 giây, còn lại là lệnh điều kiện
  local t=$1; shift; local t0; t0=$(date +%s)
  while [ $(( $(date +%s)-t0 )) -lt "$t" ]; do "$@" && return 0; sleep 2; done; return 1; }
lag_ge() { local l; l=$(lag); [ -n "$l" ] && [ "$l" -ge "$1" ]; }
lag_zero() { [ "$(lag)" = 0 ]; }
rep_ge() { [ "$(replicas)" -ge "$1" ]; }
rep_eq() { [ "$(replicas)" = "$1" ]; }
mkdir -p logs

echo "== 0. Chuẩn bị: 1 bản, lag bằng 0 =="
echo "  số bản lúc đầu: $ORIG"
docker compose up -d --no-build --no-deps --scale content-worker=1 content-worker >/dev/null 2>&1
wait_for 60 rep_eq 1; check "còn 1 bản content-worker" "$(replicas)" 1
wait_for 90 lag_zero; check "lag ban đầu bằng 0" "$(lag)" 0

echo "== 1. Bản duy nhất quá tải (giới hạn CPU), tạo 30 tài liệu: lag tăng =="
C1=$(docker compose ps -q content-worker | head -1); C1N=$(docker inspect -f '{{.Name}}' "$C1" | tr -d /)
docker update --cpus 0.02 "$C1N" >/dev/null; SLOW="$C1N"
check "bản duy nhất bị giới hạn 0,02 lõi (vẫn chạy)" "$(docker inspect -f '{{.State.Status}} {{.HostConfig.NanoCpus}}' "$C1N")" "running 20000000"
TK=$(curl -s -m 15 -X POST "$BASE/api/dept/hr/auth/login" -H 'content-type: application/json' -d "{\"username\":\"hr_manager\",\"password\":\"$DEMO_MANAGER_PASSWORD\"}" | python -I -X utf8 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")
printf 'noi dung kiem thu tu co gian\n' > "$TMP/f.txt"
# Gateway giới hạn tải lên 2 yêu cầu/giây (burst 5): giữ nhịp dưới mức đó, gặp 429 thì chờ rồi gửi lại
NOK=0; for i in $(seq 1 30); do
  for try in 1 2 3 4 5; do
    c=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $TK" -F "title=ASCALE-$STAMP-$i" -F "description=kiem thu C2" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain")
    [ "$c" = 429 ] && { sleep 1; continue; }; break
  done
  { [ "$c" = 201 ] || [ "$c" = 200 ]; } && NOK=$((NOK+1)); sleep 0.6; done
check "tạo được 30 tài liệu" "$NOK" 30
wait_for 60 lag_ge 10 && ok "lag tăng tới $(lag) (>= 10) khi bản duy nhất bị treo" || bad "lag không tăng (nhận '$(lag)')"

echo "== 2. Chạy bộ co giãn: thêm bản, lag về 0 =="
T0=$(date +%s)
INTERVAL=5 UP_POLLS=2 DOWN_POLLS=4 COOLDOWN=25 UP_LAG=10 STATE="$TMP/state" LOG="$TMP/as.log" STOP_FILE="$TMP/stop" \
  bash infrastructure/scripts/content-autoscaler.sh > /dev/null 2>&1 &
ASPID=$!
wait_for 90 rep_ge 2 && ok "thêm bản sau $(( $(date +%s)-T0 )) giây (lag $(lag))" || bad "không thêm bản trong 90 giây ($(grep -E 'scale-up|error' "$TMP/as.log" | tail -1))"
# Bản mới đã nhận việc; trả CPU cho bản chậm (hết quá tải) để phần partition nó đang giữ cũng chạy hết
docker update --cpus "$(docker info --format '{{.NCPU}}')" "$SLOW" >/dev/null
wait_for 180 lag_zero && ok "lag về 0 sau $(( $(date +%s)-T0 )) giây với $(replicas) bản" || bad "lag chưa về 0 sau 180 giây (nhận '$(lag)')"
MAXR=$(grep -o 'replicas=[0-9]*->[0-9]*' "$TMP/as.log" | sed 's/.*->//' | sort -n | tail -1)
echo "  số bản lớn nhất: ${MAXR:-?}; số partition: 3"
[ -n "$MAXR" ] && [ "$MAXR" -le 3 ] && ok "không vượt số partition (lớn nhất $MAXR)" || bad "số bản lớn nhất bất thường ($MAXR)"
for i in $(seq 1 40); do
  N=$(CEN "select count(*) from search_document s join department d using(department_id) where d.dept_code='HR' and s.title like 'ASCALE-$STAMP-%'")
  [ "$N" = 30 ] && break; sleep 2; done
check "30/30 tài liệu lên chỉ mục trung tâm" "$N" 30

echo "== 3. Lag bằng 0 đủ lâu: bớt bản về tối thiểu =="
T1=$(date +%s)
wait_for 240 rep_eq 1 && ok "bớt về 1 bản sau $(( $(date +%s)-T1 )) giây" || bad "chưa bớt về 1 bản sau 240 giây (còn $(replicas))"
check "lag vẫn bằng 0" "$(lag)" 0

echo "== 4. Mọi bản chết: đưa về tối thiểu ngay =="
docker compose up -d --no-build --no-deps --scale content-worker=0 content-worker >/dev/null 2>&1
T2=$(date +%s)
wait_for 60 rep_eq 1 && ok "khôi phục 1 bản sau $(( $(date +%s)-T2 )) giây" || bad "không khôi phục bản tối thiểu"

echo "== 5. Nhật ký quyết định =="
grep -E 'scale-up|scale-down|restore' "$TMP/as.log" | sed 's/^/  /'
check "có ghi lần thêm bản" "$(grep -c 'action=scale-up' "$TMP/as.log" | awk '{print ($1>0)?"co":"khong"}')" co
check "có ghi lần bớt bản" "$(grep -c 'action=scale-down' "$TMP/as.log" | awk '{print ($1>0)?"co":"khong"}')" co
check "có ghi lần khôi phục" "$(grep -c 'action=restore' "$TMP/as.log" | awk '{print ($1>0)?"co":"khong"}')" co
check "không có lần đổi số bản nào bị lỗi" "$(grep -c 'action=error' "$TMP/as.log")" 0

echo
echo "===== KẾT QUẢ AUTOSCALER: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
