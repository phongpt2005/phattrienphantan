#!/usr/bin/env bash
# ============================================================
# P3 B4: kiểm mỗi phòng có 2 bản node (dept-<code>, dept-<code>-2) cùng alias DNS, qua gateway (cổng 8000).
#   bash infrastructure/scripts/node-replica-test.sh            # acc sales hr
#   bash infrastructure/scripts/node-replica-test.sh acc        # một phòng
# Với mỗi phòng:
#   1. Hai bản đều khỏe; gateway chia yêu cầu cho CẢ HAI bản (trường instance của /health).
#   2. Dừng bản 1: đăng nhập, xem danh sách, tạo tài liệu vẫn được; chỉ bản 2 trả lời; tài liệu lên chỉ mục trung tâm.
#   3. Bật lại bản 1, dừng bản 2: như trên (không phụ thuộc bản nào là "chính").
# Mọi bản đã dừng luôn được bật lại, kể cả khi lỗi.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
export MSYS_NO_PATHCONV=1
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
TMP=$(mktemp -d); W="$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")"
STAMP=$(date +%s)
PASS=0; FAIL=0; STOPPED=""
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
cleanup() { [ -n "$STOPPED" ] && docker start $STOPPED >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
CEN() { docker exec "$(central_leader)" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
wait_healthy() { local i; for i in $(seq 1 60); do healthy "$1" && return 0; sleep 2; done; return 1; }
short_id() { docker inspect -f '{{.Config.Hostname}}' "$1"; }   # HOSTNAME trong container = trường instance của /health
instances_seen() { # $1 phòng, $2 số yêu cầu: in danh sách instance khác nhau đã trả lời
  local i; for i in $(seq 1 "$2"); do curl -s -m 5 "$BASE/api/dept/$1/health" | python -I -X utf8 -c 'import sys,json; print(json.load(sys.stdin).get("instance",""))' 2>/dev/null; sleep 0.4; done | sort -u | grep -v '^$'; }
login() { curl -s -m 15 -X POST "$BASE/api/dept/$1/auth/login" -H 'content-type: application/json' -d "{\"username\":\"$2\",\"password\":\"$3\"}" | python -I -X utf8 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null; }
printf 'noi dung kiem thu B4 %s\n' "$STAMP" > "$TMP/f.txt"

# Một bản dừng: phòng vẫn phục vụ đủ
one_down() { # $1 phòng, $2 bản dừng, $3 bản còn lại, $4 user, $5 mật khẩu
  local d=$1 down=$2 up=$3 tk n code title id
  docker stop "$down" >/dev/null; STOPPED="$down"
  sleep 2
  n=0; for i in $(seq 1 10); do [ -n "$(login "$d" "$4" "$5")" ] && n=$((n+1)); done
  check "$down dừng: 10/10 lần đăng nhập được" "$n" 10
  tk=$(login "$d" "$4" "$5")
  n=0; for i in $(seq 1 10); do [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tk" "$BASE/api/dept/$d/documents")" = 200 ] && n=$((n+1)); done
  check "$down dừng: 10/10 lần xem danh sách tài liệu được" "$n" 10
  title="B4-$STAMP-$d-$down"
  code=$(curl -s -m 20 -o "$W/doc.json" -w '%{http_code}' -X POST "$BASE/api/dept/$d/documents" -H "Authorization: Bearer $tk" -F "title=$title" -F "description=kiem thu B4" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain")
  check "$down dừng: tạo tài liệu được" "$code" 201
  SEEN=$(instances_seen "$d" 8 | tr '\n' ' ')
  check "$down dừng: chỉ $up trả lời" "$SEEN" "$(short_id "$up") "
  for i in $(seq 1 40); do id=$(CEN "select count(*) from search_document s join department d using(department_id) where d.dept_code='$(echo "$d" | tr a-z A-Z)' and s.title='$title'"); [ "$id" = 1 ] && break; sleep 2; done
  check "$down dừng: tài liệu lên chỉ mục trung tâm" "$id" 1
  docker start "$down" >/dev/null; STOPPED=""
  wait_healthy "$down" && ok "$down bật lại khỏe" || bad "$down chưa khỏe sau khi bật lại"
}

DEPTS="${*:-acc sales hr}"
for d in $DEPTS; do
  A="dept-$d"; B="dept-$d-2"
  case "$d" in
    hr)    U=hr_manager;    P="$DEMO_MANAGER_PASSWORD" ;;
    acc)   U=acc_manager;   P="$DEMO_MANAGER_PASSWORD" ;;
    sales) U=sales_staff;   P="$DEMO_STAFF_PASSWORD" ;;
    *)     U="${d}_staff";  P="$DEMO_STAFF_PASSWORD" ;;
  esac
  echo "== Phòng $(echo "$d" | tr a-z A-Z): $A và $B =="
  healthy "$A" && healthy "$B" && ok "hai bản đều khỏe" || { bad "thiếu bản khỏe ($A: $(docker inspect -f '{{.State.Health.Status}}' "$A" 2>&1), $B: $(docker inspect -f '{{.State.Health.Status}}' "$B" 2>&1))"; continue; }
  SEEN=$(instances_seen "$d" 30 | grep -c .)
  check "gateway chia yêu cầu cho cả hai bản (30 yêu cầu)" "$SEEN" 2
  one_down "$d" "$A" "$B" "$U" "$P"
  one_down "$d" "$B" "$A" "$U" "$P"
done

echo
echo "===== KẾT QUẢ NODE REPLICA: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
