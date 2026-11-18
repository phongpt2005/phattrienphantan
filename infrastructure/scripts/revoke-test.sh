#!/usr/bin/env bash
# ============================================================
# KIỂM THỬ THU HỒI TOKEN (ADR-013): thu hồi có hiệu lực ngay ở gateway, không chờ token hết hạn.
#   bash infrastructure/scripts/revoke-test.sh
# Đạt khi: token nhân viên bị 401 ở gateway ngay sau khi trưởng phòng thu hồi; đăng nhập lại được;
# trưởng phòng không thu hồi được token Ban Giám đốc (403). Ghi nhận riêng: node vẫn nhận token cũ
# trên đường nội bộ (chủ ý, xem ADR-013) cho tới khi token hết hạn.
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
login() { # $1 user, $2 password -> in ra "token|userId"
  curl -s -m 15 -X POST "$G/api/dept/hr/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jf "d.get('accessToken','')+'|'+str(d.get('user',{}).get('userId',''))"
}
code() { curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "$G/api/search/shares/shared-with-me"; }

echo "== 0. Đăng nhập =="
IFS='|' read -r ST STAFF_ID <<< "$(login hr_staff "$DEMO_STAFF_PASSWORD")"
IFS='|' read -r MT _ <<< "$(login hr_manager "$DEMO_MANAGER_PASSWORD")"
IFS='|' read -r AT ADMIN_ID <<< "$(login admin "$DEMO_ADMIN_PASSWORD")"
[ -n "$ST" ] && ok "nhân viên đăng nhập (userId $STAFF_ID)" || bad "nhân viên không đăng nhập được"
[ -n "$MT" ] && ok "trưởng phòng đăng nhập" || bad "trưởng phòng không đăng nhập được"
[ -n "$AT" ] && ok "Ban Giám đốc đăng nhập (userId $ADMIN_ID)" || bad "Ban Giám đốc không đăng nhập được"

echo "== 1. Trước khi thu hồi =="
chk "token nhân viên được chấp nhận ở gateway" "$(code "$ST")" 200

echo "== 2. Trưởng phòng thu hồi token nhân viên =="
R=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$G/api/dept/hr/auth/users/$STAFF_ID/revoke" -H "Authorization: Bearer $MT")
chk "thu hồi thành công (HTTP)" "$R" 201
chk "token nhân viên bị 401 ở gateway ngay lập tức" "$(code "$ST")" 401

echo "== 3. Đăng nhập lại =="
IFS='|' read -r ST2 _ <<< "$(login hr_staff "$DEMO_STAFF_PASSWORD")"
chk "đăng nhập lại được và token mới được chấp nhận" "$(code "${ST2:-x}")" 200

echo "== 4. Giới hạn quyền thu hồi =="
chk "trưởng phòng không thu hồi được token Ban Giám đốc (403)" \
  "$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$G/api/dept/hr/auth/users/$ADMIN_ID/revoke" -H "Authorization: Bearer $MT")" 403
chk "nhân viên không có quyền thu hồi (403)" \
  "$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$G/api/dept/hr/auth/users/$STAFF_ID/revoke" -H "Authorization: Bearer ${ST2:-x}")" 403

echo "== 5. Ghi nhận (không tính là lỗi): đường nội bộ của node =="
NODE_CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${ST:-x}" "$G/api/dept/hr/documents?limit=1")
echo "  token ĐÃ THU HỒI gọi trực tiếp node HR (/api/dept/hr/documents): HTTP $NODE_CODE"
echo "  (theo ADR-013: đường nội bộ không kiểm Redis, nên có thể còn 200 tới khi token hết hạn 8 giờ)"

echo; echo "===== KẾT QUẢ THU HỒI TOKEN: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
