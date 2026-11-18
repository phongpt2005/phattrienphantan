#!/usr/bin/env bash
# ============================================================
# KIỂM THỬ KHÔI PHỤC (P0.2): một bản sao lưu chưa từng khôi phục thử thì coi như chưa có.
#   bash infrastructure/scripts/restore-test.sh [thư_mục_sao_lưu]
# Mặc định lấy bản mới nhất trong %USERPROFILE%\OneDrive\dms_backups.
# Quy trình: (1) kiểm SHA-256 từng tệp theo manifest; (2) khôi phục CSDL vào DATABASE TẠM (không đụng DB đang chạy);
# (3) đối soát số liệu với manifest (tài liệu từng node, search_document, lượt chia sẻ, yêu cầu);
# (4) xóa DATABASE TẠM. Đo RTO (thời gian từ lúc bắt đầu đến khi đối soát xong).
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

PROFILE_UNIX="$(cygpath -u "${USERPROFILE:-}" 2>/dev/null || echo "$HOME")"
BASE="$PROFILE_UNIX/OneDrive/dms_backups"
SNAP="${1:-$(ls -1d "$BASE"/*/ 2>/dev/null | sort | tail -n 1)}"
SNAP="${SNAP%/}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
[ -n "$SNAP" ] && [ -f "$SNAP/manifest.txt" ] || { echo "Không tìm thấy bản sao lưu (cần manifest.txt) tại: '$SNAP'"; exit 1; }
T0=$(date +%s)
echo "== Bản sao lưu: $SNAP =="

echo "== 1. Kiểm SHA-256 từng tệp =="
while read -r kind label file hash size; do
  case "$kind" in db|minio) ;; *) continue;; esac
  got=$(sha256sum "$SNAP/$file" 2>/dev/null | awk '{print $1}')
  chk "toàn vẹn $file" "${got:-thiếu}" "$hash"
done < "$SNAP/manifest.txt"

restore_db() { # $1 container, $2 tên DB tạm, $3 tệp .sql.gz
  docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -qc 'DROP DATABASE IF EXISTS $2' -c 'CREATE DATABASE $2'" >/dev/null
  gunzip -c "$3" | docker exec -i "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d $2 -v ON_ERROR_STOP=1 -q" >/dev/null 2>&1
}
drop_db() { docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -qc 'DROP DATABASE IF EXISTS $2'" >/dev/null 2>&1; }
q() { docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d $2 -tAc \"$3\""; }
mval() { awk -v k="$1" '$1=="count" && $2==k {print $3}' "$SNAP/manifest.txt"; }

echo "== 2. Khôi phục CSDL node vào DB tạm và đối soát tài liệu =="
for pair in "HR:postgres-hr-primary:dms_hr.sql.gz:node_HR_documents" \
            "ACC:postgres-acc-primary:dms_accounting.sql.gz:node_ACC_documents" \
            "SALES:dept-sales-db:dms_sales.sql.gz:node_SALES_documents"; do
  IFS=: read -r label c file key <<< "$pair"
  tmp="restore_test_$(echo "$label" | tr 'A-Z' 'a-z')"
  restore_db "$c" "$tmp" "$SNAP/$file" && ok "khôi phục $label vào $tmp" || bad "khôi phục $label thất bại"
  chk "tài liệu $label sau khôi phục" "$(q "$c" "$tmp" 'select count(*) from document')" "$(mval "$key")"
  drop_db "$c" "$tmp"
done

echo "== 3. Khôi phục CSDL trung tâm và đối soát chỉ mục, chia sẻ, yêu cầu =="
restore_db postgres-central-primary restore_test_central "$SNAP/dms_central.sql.gz" && ok "khôi phục trung tâm vào restore_test_central" || bad "khôi phục trung tâm thất bại"
chk "search_document" "$(q postgres-central-primary restore_test_central 'select count(*) from search_document')" "$(mval central_search_document)"
chk "tổng lượt shares (jsonb)" "$(q postgres-central-primary restore_test_central 'select coalesce(sum(jsonb_array_length(shares)),0) from search_document')" "$(mval central_shares_total)"
chk "access_request" "$(q postgres-central-primary restore_test_central 'select count(*) from access_request')" "$(mval central_access_request)"
chk "document_share (bảng cũ)" "$(q postgres-central-primary restore_test_central 'select count(*) from document_share')" "$(mval central_document_share)"
drop_db postgres-central-primary restore_test_central

echo "== 4. Kiểm tra khôi phục MinIO (có tệp, không rỗng) =="
for f in "$SNAP"/minio_*.tar.gz; do
  [ -f "$f" ] || continue
  n=$(tar -tzf "$f" | grep -vc '/$')
  [ "$n" -gt 0 ] && ok "$(basename "$f") có $n tệp" || bad "$(basename "$f") rỗng"
done

RTO=$(( $(date +%s) - T0 ))
echo; echo "RTO kiểm thử khôi phục: ${RTO} giây"
echo "===== KẾT QUẢ KHÔI PHỤC: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
