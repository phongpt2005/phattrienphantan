#!/usr/bin/env bash
# ============================================================
# Kiểm: CSDL của node lỗi tạm thời thì tạo tài liệu trả 503 + Retry-After (không phải 500), không để tệp mồ côi
# trong MinIO, và khóa Idempotency-Key được nhả để client thử lại cùng khóa khi CSDL trở lại.
#   bash infrastructure/scripts/retry-after-test.sh
# Dùng phòng ACC (CSDL máy chủ đơn postgres-acc-primary): dừng CSDL, gửi yêu cầu, bật lại, gửi lại cùng khóa.
# CSDL luôn được bật lại, kể cả khi lỗi.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
export MSYS_NO_PATHCONV=1
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
TMP=$(mktemp -d); W="$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")"
STAMP=$(date +%s); DB=postgres-acc-primary
PASS=0; FAIL=0; STOPPED=""
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
cleanup() { [ -n "$STOPPED" ] && docker start $STOPPED >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
AQ() { docker exec "$DB" psql -U "$POSTGRES_ACC_USER" -d "$POSTGRES_ACC_DB" -tAc "$1"; }
# Đếm đối tượng trong bucket (image MinIO không có grep: lọc ở máy chạy bài kiểm). Tên đối tượng có dạng <thời điểm>_<tên>.
objects() { docker exec minio-acc ls -R /data/accounting-documents 2>/dev/null | grep -c -E '^[0-9]{13}_'; }
TK=$(curl -s -m 15 -X POST "$BASE/api/dept/acc/auth/login" -H 'content-type: application/json' -d "{\"username\":\"acc_manager\",\"password\":\"$DEMO_MANAGER_PASSWORD\"}" | python -I -X utf8 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")
[ -n "$TK" ] || { echo "Không đăng nhập được acc_manager"; exit 2; }
printf 'noi dung kiem thu 503 %s\n' "$STAMP" > "$TMP/f.txt"
K="ra-$STAMP-key"; T="RETRY-$STAMP"
post() { curl -s -m 40 -D "$W/$1.h" -o "$W/$1.json" -w '%{http_code}' -X POST "$BASE/api/dept/acc/documents" -H "Authorization: Bearer $TK" -H "Idempotency-Key: $K" \
  -F "title=$T" -F "description=kiem thu 503" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain"; }
hdr() { grep -i "^$2:" "$TMP/$1.h" | head -1 | cut -d: -f2- | tr -d ' \r'; }

echo "== 1. CSDL ACC dừng: tạo tài liệu =="
O0=$(objects)
docker stop "$DB" >/dev/null; STOPPED="$DB"
sleep 3
C=$(post a)
echo "  mã: $C; thân: $(head -c 160 "$TMP/a.json")"
check "trả 503 (không phải 500)" "$C" 503
check "có Retry-After: 2" "$(hdr a Retry-After)" 2
check "không để tệp mồ côi trong MinIO" "$(objects)" "$O0"
# Có Idempotency-Key thì bước kiểm khóa chạm CSDL trước khi tải tệp: ca trên chưa đụng tới MinIO.
# Ca này không gửi khóa: tệp lên MinIO trước, CSDL lỗi sau; node phải dọn tệp vừa tải.
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
C=$(curl -s -m 40 -D "$W/n.h" -o "$W/n.json" -w '%{http_code}' -X POST "$BASE/api/dept/acc/documents" -H "Authorization: Bearer $TK" \
  -F "title=$T-khongkhoa" -F "description=kiem thu 503" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain")
check "không gửi khóa: cũng trả 503" "$C" 503
check "không gửi khóa: có Retry-After: 2" "$(hdr n Retry-After)" 2
CLEANED=$(for c in dept-acc dept-acc-2; do docker logs --since "$T0" "$c" 2>&1; done | grep -c "dọn sạch file rác")
check "node đã tải tệp lên rồi dọn lại (log dọn tệp: 1 lần)" "$CLEANED" 1
check "MinIO không thêm tệp nào" "$(objects)" "$O0"

echo "== 2. CSDL ACC bật lại: gửi lại cùng Idempotency-Key =="
docker start "$DB" >/dev/null; STOPPED=""
for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] && break; sleep 2; done
sleep 5
C=""; for i in $(seq 1 10); do C=$(post b); [ "$C" = 201 ] && break; sleep 3; done
check "thử lại cùng khóa sau khi CSDL trở lại: 201" "$C" 201
check "CSDL ACC có đúng 1 tài liệu" "$(AQ "select count(*) from document where title='$T'")" 1
D=$(python -I -X utf8 -c "import json; print(json.load(open(r'$W/b.json')).get('docId',''))" 2>/dev/null)
check "gửi lại lần nữa: cùng docId" "$(post c >/dev/null; python -I -X utf8 -c "import json; print(json.load(open(r'$W/c.json')).get('docId',''))")" "$D"

echo
echo "===== KẾT QUẢ RETRY-AFTER: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
