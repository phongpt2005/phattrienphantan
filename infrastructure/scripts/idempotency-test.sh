#!/usr/bin/env bash
# ============================================================
# P3 N6: kiểm Idempotency-Key cho POST /documents (qua gateway, node HR).
#   bash infrastructure/scripts/idempotency-test.sh
# Ca kiểm:
#   1. Gửi lại cùng khóa, cùng nội dung: cùng docId, tiêu đề Idempotent-Replayed, CSDL chỉ có 1 tài liệu.
#   2. Cùng khóa, khác nội dung: 422. Khóa sai dạng: 400.
#   3. 8 yêu cầu đồng thời cùng khóa: CSDL đúng 1 tài liệu; yêu cầu thua nhận 201 cùng docId hoặc 409 + Retry-After.
#   4. Khóa gắn với người dùng: người khác dùng cùng khóa tạo tài liệu riêng.
#   5. Không gửi khóa: hành vi cũ (mỗi lần một tài liệu).
#   6. Chỉ mục trung tâm: tài liệu gửi lại không bị nhân đôi qua CDC.
#   7. Khóa giữ 24 giờ; hết hạn thì dùng lại được.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
export MSYS_NO_PATHCONV=1
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
TMP=$(mktemp -d); W="$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")"; trap 'rm -rf "$TMP"' EXIT
STAMP=$(date +%s)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
HRQ() { docker exec "$(hr_leader)" psql -U "$POSTGRES_HR_USER" -d "$POSTGRES_HR_DB" -tAc "$1"; }
CEN() { dx "$(central_leader)" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
login() { curl -s -m 15 -X POST "$BASE/api/dept/hr/auth/login" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" | python -I -X utf8 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))"; }
TM=$(login hr_manager "$DEMO_MANAGER_PASSWORD"); TS=$(login hr_staff "$DEMO_STAFF_PASSWORD")
[ -n "$TM" ] && [ -n "$TS" ] || { echo "Không đăng nhập được"; exit 2; }
printf 'noi dung kiem thu N6 %s\n' "$STAMP" > "$TMP/f.txt"
# post <token> <tiêu đề> <khóa hoặc rỗng> <tệp kết quả>: in mã HTTP; tiêu đề phản hồi lưu ở <tệp>.h
post() {
  local hk=(); [ -n "$3" ] && hk=(-H "Idempotency-Key: $3")
  curl -s -m 20 -D "$W/$4.h" -o "$W/$4.json" -w '%{http_code}' -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $1" "${hk[@]}" \
    -F "title=$2" -F "description=kiem thu N6" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain"; }
docid() { python -I -X utf8 -c "import json; print(json.load(open(r'$W/$1.json')).get('docId',''))" 2>/dev/null; }
hdr()   { grep -i "^$2:" "$TMP/$1.h" | head -1 | cut -d: -f2- | tr -d ' \r'; }
ndocs() { HRQ "select count(*) from document where title = '$1'"; }

echo "== 1. Gửi lại cùng khóa, cùng nội dung =="
T1="IDEM-$STAMP-1"; K1="n6-$STAMP-key-1"
check "lần đầu: 201" "$(post "$TM" "$T1" "$K1" a)" 201
A=$(docid a); echo "  docId lần đầu: $A"
[ -z "$(hdr a Idempotent-Replayed)" ] && ok "lần đầu không đánh dấu gửi lại" || bad "lần đầu bị đánh dấu gửi lại"
check "gửi lại: 201" "$(post "$TM" "$T1" "$K1" b)" 201
check "gửi lại: cùng docId" "$(docid b)" "$A"
check "gửi lại: có Idempotent-Replayed: true" "$(hdr b Idempotent-Replayed)" true
check "gửi lại lần 3: cùng docId" "$( post "$TM" "$T1" "$K1" c >/dev/null; docid c)" "$A"
check "CSDL HR chỉ có 1 tài liệu" "$(ndocs "$T1")" 1
check "khóa ở trạng thái DONE, trỏ đúng tài liệu" "$(HRQ "select status||':'||doc_id from idempotency_key where idem_key='$K1'")" "DONE:$A"

echo "== 2. Cùng khóa, khác nội dung; khóa sai dạng =="
check "cùng khóa, khác tiêu đề: 422" "$(post "$TM" "IDEM-$STAMP-khac" "$K1" d)" 422
check "không tạo tài liệu cho yêu cầu 422" "$(ndocs "IDEM-$STAMP-khac")" 0
check "khóa sai dạng (quá ngắn): 400" "$(post "$TM" "IDEM-$STAMP-sai" "abc" e)" 400

echo "== 3. 8 yêu cầu đồng thời cùng khóa =="
T3="IDEM-$STAMP-3"; K3="n6-$STAMP-key-3"
for i in 1 2 3 4 5 6 7 8; do ( post "$TM" "$T3" "$K3" "p$i" > "$TMP/p$i.code" ) & done; wait
C201=0; C409=0; C429=0; COTHER=0; RA=1; IDS=""
for i in 1 2 3 4 5 6 7 8; do c=$(cat "$TMP/p$i.code")
  case "$c" in 201) C201=$((C201+1)); IDS="$IDS $(docid "p$i")";; 409) C409=$((C409+1)); [ "$(hdr "p$i" Retry-After)" = 2 ] || RA=0;;
    429) C429=$((C429+1));;   # gateway nginx giới hạn tốc độ, yêu cầu không tới node
    *) COTHER=$((COTHER+1));; esac; done
echo "  201: $C201, 409: $C409, 429 (gateway giới hạn tốc độ): $C429, mã khác: $COTHER; docId trả về:$IDS"
check "CSDL đúng 1 tài liệu" "$(ndocs "$T3")" 1
check "mọi phản hồi 201 cùng một docId" "$(echo $IDS | tr ' ' '\n' | sort -u | grep -c .)" 1
check "không có mã lỗi ngoài 201/409/429" "$COTHER" 0
check "mọi phản hồi 409 có Retry-After: 2" "$RA" 1
D3=$(echo $IDS | awk '{print $1}')
for i in 1 2 3 4 5; do c=$(post "$TM" "$T3" "$K3" r); [ "$c" = 201 ] && break; sleep 2; done
check "thử lại sau 409: 201 cùng docId" "$(docid r)" "$D3"

echo "== 4. Khóa gắn với người dùng =="
check "hr_staff dùng cùng khóa K1 với tiêu đề của mình: 201" "$(post "$TS" "IDEM-$STAMP-staff" "$K1" s)" 201
S=$(docid s); [ -n "$S" ] && [ "$S" != "$A" ] && ok "tài liệu riêng của hr_staff ($S khác $A)" || bad "khóa của hai người bị lẫn (nhận '$S')"

echo "== 5. Không gửi khóa: mỗi lần một tài liệu (hành vi cũ) =="
T5="IDEM-$STAMP-5"
post "$TM" "$T5" "" n1 >/dev/null; post "$TM" "$T5" "" n2 >/dev/null
check "2 lần gửi không khóa: 2 tài liệu" "$(ndocs "$T5")" 2

echo "== 6. Chỉ mục trung tâm không nhân đôi =="
for i in $(seq 1 40); do N=$(CEN "select count(*) from search_document s join department d using(department_id) where d.dept_code='HR' and s.title='$T1'"); [ "$N" = 1 ] && break; sleep 2; done
sleep 4; N=$(CEN "select count(*) from search_document s join department d using(department_id) where d.dept_code='HR' and s.title='$T1'")
check "chỉ mục trung tâm có đúng 1 bản của tài liệu gửi 3 lần" "$N" 1

echo "== 7. Thời hạn khóa =="
check "khóa giữ 24 giờ" "$(HRQ "select extract(epoch from expires_at - created_at)::int from idempotency_key where idem_key='$K1' and doc_id=$A")" 86400
HRQ "update idempotency_key set expires_at = now() - interval '1 second' where idem_key='$K1' and doc_id=$A" >/dev/null
check "khóa hết hạn: dùng lại tạo tài liệu mới (201)" "$(post "$TM" "$T1" "$K1" x)" 201
X=$(docid x); [ -n "$X" ] && [ "$X" != "$A" ] && ok "tài liệu mới $X sau khi khóa hết hạn" || bad "khóa hết hạn vẫn trả tài liệu cũ (nhận '$X')"

echo
echo "===== KẾT QUẢ IDEMPOTENCY: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
