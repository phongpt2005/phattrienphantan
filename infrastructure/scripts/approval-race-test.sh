#!/usr/bin/env bash
# ============================================================
# KIỂM THỬ ĐUA DUYỆT (P0.1 / N5): nhiều trưởng phòng cùng duyệt MỘT yêu cầu xin quyền.
#   bash infrastructure/scripts/approval-race-test.sh
# Đạt khi: đúng MỘT lần trả 201; các lần còn lại trả 409 (đang xử lý) hoặc 400 (đã xử lý);
# node chủ chỉ có MỘT lượt chia sẻ đang hiệu lực cho cặp (tài liệu, phòng nhận).
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
G=http://localhost:8000
N=${RACE_N:-8}
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
jf()  { python -I -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
login() { curl -s -m 15 -X POST "$G/api/dept/$1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$2\",\"password\":\"$3\"}" | jf "d['accessToken']"; }

echo "== 0. Chuẩn bị: yêu cầu xin quyền mới từ ACC tới tài liệu HR =="
MGR=$(login hr hr_manager "$DEMO_MANAGER_PASSWORD")
ACCS=$(login acc acc_staff "$DEMO_STAFF_PASSWORD")
DOC=$(curl -s -m 10 -H "Authorization: Bearer $MGR" "$G/api/dept/hr/documents?limit=1" | jf "d['data'][0]['docId']")
RQ=$(curl -s -m 15 -X POST $G/api/search/shares/requests -H "Authorization: Bearer $ACCS" -H 'content-type: application/json' \
  -d "{\"sourceDocId\":$DOC,\"targetDept\":\"HR\",\"requesterDept\":\"ACC\",\"requesterUsername\":\"acc_staff\",\"requestedDays\":1,\"requestedPermission\":\"VIEW\",\"reason\":\"race test $(date +%s)\"}" \
  | jf "d['request']['request_id']")
[ -n "$RQ" ] && ok "yêu cầu $RQ đã tạo (tài liệu HR $DOC)" || { bad "không tạo được yêu cầu"; exit 1; }

echo "== 1. $N trưởng phòng gửi duyệt cùng lúc =="
TMPD=$(mktemp -d)
for i in $(seq 1 "$N"); do
  ( curl -s -m 20 -o /dev/null -w '%{http_code}\n' -X POST "$G/api/search/shares/requests/$RQ/approve" \
      -H "Authorization: Bearer $MGR" -H 'content-type: application/json' -d '{"permission":"VIEW"}' > "$TMPD/$i.code" ) &
done
wait
CODES=$(cat "$TMPD"/*.code | sort | uniq -c | tr -s ' ' | tr '\n' ' ')
echo "  mã trả về: $CODES"
C201=$(cat "$TMPD"/*.code | grep -c '^201$')
CREJ=$(cat "$TMPD"/*.code | grep -cE '^(409|400)$')
[ "$C201" = 1 ] && ok "đúng một lần duyệt thành công (201)" || bad "số lần thành công = $C201 (mong đợi 1)"
[ $((C201 + CREJ)) = "$N" ] && ok "các lần còn lại bị từ chối có kiểm soát (409/400), không có lỗi 5xx" || bad "có mã ngoài 201/400/409: $CODES"
rm -rf "$TMPD"

echo "== 2. Trạng thái và số lượt chia sẻ =="
ST=$(docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "select status from access_request where request_id=$RQ")
[ "$ST" = APPROVED ] && ok "yêu cầu ở trạng thái APPROVED" || bad "trạng thái là '$ST' (mong đợi APPROVED)"
# Node chỉ giữ MỘT lượt đang hiệu lực cho cặp (tài liệu, phòng nhận) theo chỉ mục duy nhất; duyệt lặp chỉ gia hạn/đổi quyền.
SH=$(docker exec postgres-hr-primary sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"select count(*) from document_share where doc_id=$DOC and shared_with_dept='ACC' and is_revoked=false\"")
[ "$SH" = 1 ] && ok "node HR chỉ có 1 lượt chia sẻ đang hiệu lực cho (tài liệu $DOC, ACC)" || bad "số lượt đang hiệu lực = '$SH' (mong đợi 1)"

echo "== 3. Nhánh xác định: yêu cầu đang PROCESSING thì người duyệt khác nhận 409 =="
RQ2=$(curl -s -m 15 -X POST $G/api/search/shares/requests -H "Authorization: Bearer $ACCS" -H 'content-type: application/json'   -d "{\"sourceDocId\":$DOC,\"targetDept\":\"HR\",\"requesterDept\":\"ACC\",\"requesterUsername\":\"acc_staff\",\"requestedDays\":1,\"requestedPermission\":\"VIEW\",\"reason\":\"409 test $(date +%s)\"}"   | jf "d['request']['request_id']")
docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "update access_request set status='PROCESSING', updated_at=now() where request_id=$RQ2" >/dev/null
C409=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$G/api/search/shares/requests/$RQ2/approve" -H "Authorization: Bearer $MGR" -H 'content-type: application/json' -d '{"permission":"VIEW"}')
[ "$C409" = 409 ] && ok "yêu cầu đang PROCESSING bị từ chối bằng 409" || bad "yêu cầu PROCESSING trả '$C409' (mong đợi 409)"
docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "update access_request set status='PENDING' where request_id=$RQ2" >/dev/null

echo; echo "===== KẾT QUẢ ĐUA DUYỆT: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
