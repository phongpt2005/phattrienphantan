#!/usr/bin/env bash
# ============================================================
# KIỂM THỬ THU HỒI TOKEN (ADR-013): thu hồi có hiệu lực ngay ở gateway, không chờ token hết hạn.
#   bash infrastructure/scripts/revoke-test.sh
# Kiểm tra trên gateway: tìm kiếm liên phòng, tải tệp liên phòng, danh sách chia sẻ.
# Phân quyền: trưởng phòng thu hồi được nhân viên; trưởng phòng không thu hồi được Ban Giám đốc (403);
# nhân viên không thu hồi được người khác (403).
# Đường nội bộ node (/api/dept/hr/...) cũng kiểm khóa thu hồi (P0.5.1, fail-open khi Redis không đọc được).
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
G=http://localhost:8000
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
jf()  { python -I -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
login() { # $1 user, $2 password -> "token|userId"
  curl -s -m 15 -X POST "$G/api/dept/hr/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jf "d.get('accessToken','')+'|'+str(d.get('user',{}).get('userId',''))"
}
code() { curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "$2"; }
revoke() { curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$G/api/dept/hr/auth/users/$2/revoke" -H "Authorization: Bearer $1"; }

echo "== 0. Chuẩn bị tài khoản =="
# Nhân viên thứ hai cùng phòng (để kiểm thử nhân viên thu hồi người khác). Đã tồn tại thì bỏ qua.
ADMIN_T=$(login admin "$DEMO_ADMIN_PASSWORD" | cut -d'|' -f1)
curl -s -m 15 -o /dev/null -X POST "$G/api/dept/hr/auth/register" -H "Authorization: Bearer $ADMIN_T" -H 'content-type: application/json' \
  -d "{\"username\":\"hr_staff2\",\"password\":\"$DEMO_STAFF_PASSWORD\",\"fullName\":\"Nhân viên HR 2\",\"role\":\"STAFF\"}"
IFS='|' read -r ST STAFF_ID <<< "$(login hr_staff "$DEMO_STAFF_PASSWORD")"
IFS='|' read -r ST_B STAFF_B_ID <<< "$(login hr_staff2 "$DEMO_STAFF_PASSWORD")"
IFS='|' read -r MT _ <<< "$(login hr_manager "$DEMO_MANAGER_PASSWORD")"
IFS='|' read -r AT ADMIN_ID <<< "$(login admin "$DEMO_ADMIN_PASSWORD")"
[ -n "$ST" ] && ok "nhân viên đăng nhập (userId $STAFF_ID)" || bad "nhân viên không đăng nhập được"
[ -n "$ST_B" ] && ok "nhân viên thứ hai đăng nhập (userId $STAFF_B_ID)" || bad "nhân viên thứ hai không đăng nhập được"
[ -n "$MT" ] && ok "trưởng phòng đăng nhập" || bad "trưởng phòng không đăng nhập được"
[ -n "$AT" ] && ok "Ban Giám đốc đăng nhập (userId $ADMIN_ID)" || bad "Ban Giám đốc không đăng nhập được"
DOC_ID=$(curl -s -m 10 -H "Authorization: Bearer $ST" "$G/api/dept/hr/documents?limit=1" | jf "d['data'][0]['docId']")
[ -n "$DOC_ID" ] && ok "có tài liệu HR để thử tải (docId $DOC_ID)" || bad "không tìm thấy tài liệu HR để thử tải"

echo "== 1. Trước khi thu hồi: đường liên phòng hoạt động =="
chk "tìm kiếm liên phòng chấp nhận token" "$(code "$ST" "$G/api/search?q=tai")" 200
chk "danh sách chia sẻ chấp nhận token" "$(code "$ST" "$G/api/search/shares/shared-with-me")" 200
chk "tải tệp HR (cùng phòng) chấp nhận token" "$(code "$ST" "$G/api/search/documents/HR/$DOC_ID/download")" 200

echo "== 2. Trưởng phòng thu hồi token nhân viên =="
chk "thu hồi thành công (HTTP)" "$(revoke "$MT" "$STAFF_ID")" 201
chk "tìm kiếm liên phòng: token đã thu hồi bị 401" "$(code "$ST" "$G/api/search?q=tai")" 401
chk "danh sách chia sẻ: token đã thu hồi bị 401" "$(code "$ST" "$G/api/search/shares/shared-with-me")" 401
chk "tải tệp liên phòng: token đã thu hồi bị 401" "$(code "$ST" "$G/api/search/documents/HR/$DOC_ID/download")" 401

echo "== 3. Đăng nhập lại =="
IFS='|' read -r ST2 _ <<< "$(login hr_staff "$DEMO_STAFF_PASSWORD")"
chk "token mới được chấp nhận sau khi đăng nhập lại" "$(code "${ST2:-x}" "$G/api/search?q=tai")" 200

echo "== 4. Giới hạn quyền thu hồi =="
chk "trưởng phòng không thu hồi được token Ban Giám đốc (403)" "$(revoke "$MT" "$ADMIN_ID")" 403
chk "nhân viên không thu hồi được token của chính mình (403)" "$(revoke "${ST2:-x}" "$STAFF_ID")" 403
chk "nhân viên không thu hồi được token của nhân viên khác (403)" "$(revoke "${ST_B:-x}" "$STAFF_ID")" 403

echo "== 5. Đường nội bộ của node (P0.5.1): token đã thu hồi phải bị 401 =="
chk "node HR /api/dept/hr/documents: token đã thu hồi bị 401" "$(code "${ST:-x}" "$G/api/dept/hr/documents?limit=1")" 401
chk "node HR: token mới (sau đăng nhập lại) vẫn được chấp nhận" "$(code "${ST2:-x}" "$G/api/dept/hr/documents?limit=1")" 200

echo; echo "===== KẾT QUẢ THU HỒI TOKEN: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
