#!/usr/bin/env bash
# ============================================================
# KIỂM THỬ TRUY VẾT CHIA SẺ (P0.5.3): sổ lịch sử tại node + điều kiện đơn điệu theo mã yêu cầu.
#   bash infrastructure/scripts/share-provenance-test.sh
# Kịch bản: hai yêu cầu xin quyền cho cùng một tài liệu (R_cũ tạo trước, R_mới tạo sau).
#   1) Duyệt R_mới trước (quyền VIEW) -> lượt hiệu lực được ghi nhận theo R_mới.
#   2) Duyệt R_cũ sau (xin DOWNLOAD) -> phải báo superseded, quyền hiện hành GIỮ NGUYÊN (VIEW).
# Đạt khi: quyền không đổi; lịch sử có GRANTED/RENEWED cho R_mới và SUPERSEDED cho R_cũ; lịch sử không sửa được.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
G=http://localhost:8000
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
jf()  { python -I -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
login() { curl -s -m 15 -X POST "$G/api/dept/$1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$2\",\"password\":\"$3\"}" | jf "d['accessToken']"; }
hr_sql() { docker exec "$(hr_leader)" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"$1\""; }
central_sql() { docker exec "$(central_leader)" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }

echo "== 0. Chuẩn bị: hai yêu cầu cho cùng tài liệu HR =="
MGR=$(login hr hr_manager "$DEMO_MANAGER_PASSWORD")
ACCS=$(login acc acc_staff "$DEMO_STAFF_PASSWORD")
DOC=$(curl -s -m 10 -H "Authorization: Bearer $MGR" "$G/api/dept/hr/documents?limit=1" | jf "d['data'][0]['docId']")
mkreq() { # $1 quyền xin, $2 lý do
  curl -s -m 15 -X POST $G/api/search/shares/requests -H "Authorization: Bearer $ACCS" -H 'content-type: application/json' \
    -d "{\"sourceDocId\":$DOC,\"targetDept\":\"HR\",\"requesterDept\":\"ACC\",\"requesterUsername\":\"acc_staff\",\"requestedDays\":2,\"requestedPermission\":\"$1\",\"reason\":\"$2 $(date +%s%N)\"}" \
    | jf "d['request']['request_id']"
}
R_OLD=$(mkreq DOWNLOAD "provenance cũ")
R_NEW=$(mkreq VIEW "provenance mới")
[ -n "$R_OLD" ] && [ -n "$R_NEW" ] && [ "$R_NEW" -gt "$R_OLD" ] && ok "tạo R_cũ=$R_OLD (xin DOWNLOAD) trước, R_mới=$R_NEW (xin VIEW) sau" || { bad "không tạo được hai yêu cầu theo đúng thứ tự"; exit 1; }

echo "== 1. Duyệt R_mới trước (VIEW) =="
RESP1=$(curl -s -w '
%{http_code}' -X POST $G/api/search/shares/requests/$R_NEW/approve -H "Authorization: Bearer $MGR" -H 'content-type: application/json' -d '{"permission":"VIEW"}')
C1=$(echo "$RESP1" | tail -n 1)
chk "duyệt R_mới thành công" "$C1" 201
PERM1=$(hr_sql "select permission from document_share where doc_id=$DOC and shared_with_dept='ACC' and is_revoked=false")
chk "quyền hiện hành sau R_mới là VIEW" "$PERM1" VIEW

echo "== 2. Duyệt R_cũ sau (xin DOWNLOAD): phải không ghi đè quyền mới hơn =="
RESP2=$(curl -s -w '
%{http_code}' -X POST $G/api/search/shares/requests/$R_OLD/approve -H "Authorization: Bearer $MGR" -H 'content-type: application/json' -d '{"permission":"DOWNLOAD"}')
C2=$(echo "$RESP2" | tail -n 1)
BODY2=$(echo "$RESP2" | sed '$d')
chk "duyệt R_cũ không lỗi (201, báo superseded)" "$C2" 201
SUP=$(echo "$BODY2" | jf "d.get('superseded')")
chk "phản hồi báo superseded=True" "$SUP" True
PERM2=$(hr_sql "select permission from document_share where doc_id=$DOC and shared_with_dept='ACC' and is_revoked=false")
chk "quyền hiện hành VẪN là VIEW (không bị DOWNLOAD của yêu cầu cũ ghi đè)" "$PERM2" VIEW
ST_OLD=$(central_sql "select status from access_request where request_id=$R_OLD")
chk "trung tâm ghi R_cũ là APPROVED (đã xử lý, quyền không đổi)" "$ST_OLD" APPROVED

echo "== 3. Lịch sử tại node (nguồn sự thật) =="
NEW_ACT=$(hr_sql "select string_agg(action, ',' order by history_id) from document_share_history where access_request_id=$R_NEW")
[[ "$NEW_ACT" == *GRANTED* || "$NEW_ACT" == *RENEWED* ]] && ok "lịch sử có GRANTED/RENEWED cho R_mới ($NEW_ACT)" || bad "lịch sử R_mới thiếu (nhận '$NEW_ACT')"
OLD_ACT=$(hr_sql "select string_agg(action, ',' order by history_id) from document_share_history where access_request_id=$R_OLD")
chk "lịch sử có đúng SUPERSEDED cho R_cũ" "$OLD_ACT" SUPERSEDED
CNT=$(hr_sql "select count(*) from document_share_history where access_request_id=$R_OLD and action='SUPERSEDED' and permission='DOWNLOAD'")
chk "dòng SUPERSEDED ghi lại quyền ĐÃ XIN (DOWNLOAD) nhưng không áp dụng" "$CNT" 1

echo "== 3b. Thu hồi qua API node: phải trả 200, lượt hết hiệu lực, lịch sử có REVOKED (hồi quy P0.5.3) =="
SID=$(hr_sql "select share_id from document_share where doc_id=$DOC and shared_with_dept='ACC' and not is_revoked")
RV=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $G/api/dept/hr/shares/$SID -H "Authorization: Bearer $MGR")
chk "API thu hồi lượt $SID trả 200" "$RV" 200
chk "sau thu hồi: không còn lượt đang hiệu lực cho ACC" "$(hr_sql "select count(*) from document_share where doc_id=$DOC and shared_with_dept='ACC' and not is_revoked")" 0
chk "lịch sử có REVOKED cho lượt $SID" "$(hr_sql "select count(*) from document_share_history where share_id=$SID and action='REVOKED'")" 1

echo "== 4. Lịch sử là chỉ-thêm (trigger chặn sửa/xóa) =="
if hr_sql "update document_share_history set actor='x' where history_id=(select min(history_id) from document_share_history)" >/dev/null 2>&1; then
  bad "UPDATE lịch sử được phép (trigger không hoạt động)"
else
  ok "UPDATE lịch sử bị chặn bởi trigger append-only"
fi

echo; echo "===== KẾT QUẢ TRUY VẾT CHIA SẺ: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
