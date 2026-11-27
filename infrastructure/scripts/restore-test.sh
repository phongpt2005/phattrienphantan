#!/usr/bin/env bash
# ============================================================
# KIỂM THỬ KHÔI PHỤC (P0.2, cập nhật P0.5.2 cho bản mã hóa): bản sao lưu chưa khôi phục thử thì coi như chưa có.
#   bash infrastructure/scripts/restore-test.sh [thư_mục_sao_lưu]
# Mặc định lấy bản mới nhất trong %USERPROFILE%\OneDrive\dms_backups.
# Quy trình: (1) kiểm SHA-256 từng tệp theo manifest; (2) giải mã (nếu là .enc) và khôi phục CSDL vào DB TẠM,
# không đụng DB đang chạy; (3) đối soát số liệu với manifest; (4) kiểm MinIO còn tệp; (5) xóa DB tạm.
# Bản cũ chưa mã hóa (trước P0.5.2) vẫn được kiểm; cảnh báo rõ là chưa mã hóa.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh

KEY="$(printf '%s' "${BACKUP_ENCRYPTION_KEY:-}" | tr -d '\r')"
export BACKUP_KEY_CLEAN="$KEY"
DEC() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_KEY_CLEAN; }

PROFILE_UNIX="$(cygpath -u "${USERPROFILE:-}" 2>/dev/null || echo "$HOME")"
BASE="$PROFILE_UNIX/OneDrive/dms_backups"
# Chỉ lấy thư mục sao lưu CSDL (tên YYYYMMDD_HHMMSS); trước đây lấy nhầm kafka_* vì sắp theo chữ cái
SNAP="${1:-$(ls -1d "$BASE"/[0-9]*/ 2>/dev/null | sort | tail -n 1)}"
SNAP="${SNAP%/}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
chk() { # giá trị rỗng là lỗi (truy vấn hỏng): không được tính "rỗng = rỗng" là đạt
  if [ -z "$2" ] || [ -z "$3" ]; then bad "$1 (giá trị rỗng: nhận '$2', mong đợi '$3')"; elif [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
[ -n "$SNAP" ] && [ -f "$SNAP/manifest.txt" ] || { echo "Không tìm thấy bản sao lưu (cần manifest.txt) tại: '$SNAP'"; exit 1; }
T0=$(date +%s)
echo "== Bản sao lưu: $SNAP =="
ENCRYPTED=0; grep -q "encrypted" "$SNAP/manifest.txt" && ENCRYPTED=1
[ "$ENCRYPTED" = 1 ] && ok "bản sao lưu được ghi là đã mã hóa" || echo "  CẢNH BÁO: bản này CHƯA MÃ HÓA (tạo trước P0.5.2). Cần xóa hoặc mã hóa lại khi đã xác nhận."
[ -n "$KEY" ] || [ "$ENCRYPTED" = 0 ] || { bad "thiếu BACKUP_ENCRYPTION_KEY trong .env để giải mã"; exit 1; }

echo "== 1. Kiểm SHA-256 từng tệp (trên tệp như đang lưu trên đĩa) =="
while read -r kind label file hash size; do
  case "$kind" in db|minio) ;; *) continue;; esac
  got=$(sha256sum "$SNAP/$file" 2>/dev/null | awk '{print $1}')
  chk "toàn vẹn $file" "${got:-thiếu}" "$hash"
done < "$SNAP/manifest.txt"

file_of() { awk -v l="$1" '$1=="db"  && $2==l {print $3}' "$SNAP/manifest.txt"; }
mfile_of() { awk -v l="$1" '$1=="minio" && $2==l {print $3}' "$SNAP/manifest.txt"; }
mval() { awk -v k="$1" '$1=="count" && $2==k {print $3}' "$SNAP/manifest.txt"; }

# Đọc tệp dữ liệu: giải mã nếu là .enc, rồi gunzip (CSDL) hoặc giữ nguyên (tar.gz)
stream() { # $1 đường dẫn tệp
  case "$1" in *.enc) DEC < "$1" ;; *) cat "$1" ;; esac
}
restore_db() { # $1 container, $2 tên DB tạm, $3 tệp
  docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -qc 'DROP DATABASE IF EXISTS $2' -c 'CREATE DATABASE $2'" >/dev/null
  stream "$3" | gunzip | docker exec -i "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d $2 -v ON_ERROR_STOP=1 -q" >/dev/null 2>&1
}
drop_db() { docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -qc 'DROP DATABASE IF EXISTS $2'" >/dev/null 2>&1; }
q() { docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d $2 -tAc \"$3\""; }

echo "== 2. Khôi phục CSDL node vào DB tạm và đối soát tài liệu =="
for pair in "HR:$(hr_leader):node_HR_documents" \
            "ACC:postgres-acc-primary:node_ACC_documents" \
            "SALES:dept-sales-db:node_SALES_documents"; do
  IFS=: read -r label c key <<< "$pair"
  file=$(file_of "$label")
  tmp="restore_test_$(echo "$label" | tr 'A-Z' 'a-z')"
  if [ -z "$file" ]; then bad "manifest không có tệp CSDL $label"; continue; fi
  restore_db "$c" "$tmp" "$SNAP/$file" && ok "khôi phục $label ($file) vào $tmp" || bad "khôi phục $label thất bại"
  chk "tài liệu $label sau khôi phục" "$(q "$c" "$tmp" 'select count(*) from document')" "$(mval "$key")"
  drop_db "$c" "$tmp"
done

echo "== 3. Khôi phục CSDL trung tâm và đối soát chỉ mục, chia sẻ, yêu cầu =="
cfile=$(file_of CENTRAL)
restore_db "$(central_leader)" restore_test_central "$SNAP/$cfile" && ok "khôi phục trung tâm ($cfile) vào restore_test_central" || bad "khôi phục trung tâm thất bại"
chk "search_document" "$(q "$(central_leader)" restore_test_central 'select count(*) from search_document')" "$(mval central_search_document)"
chk "tổng lượt shares (jsonb)" "$(q "$(central_leader)" restore_test_central 'select coalesce(sum(jsonb_array_length(shares)),0) from search_document')" "$(mval central_shares_total)"
chk "access_request" "$(q "$(central_leader)" restore_test_central 'select count(*) from access_request')" "$(mval central_access_request)"
chk "document_share (bảng cũ)" "$(q "$(central_leader)" restore_test_central 'select count(*) from document_share')" "$(mval central_document_share)"
drop_db "$(central_leader)" restore_test_central

echo "== 4. Kiểm MinIO: giải mã và liệt kê, có tệp và không rỗng =="
for label in HR ACC SALES; do
  f=$(mfile_of "$label")
  [ -n "$f" ] || { bad "manifest không có MinIO $label"; continue; }
  n=$(stream "$SNAP/$f" | tar -tzf - | grep -vc '/$')
  [ "$n" -gt 0 ] && ok "MinIO $label ($f) giải mã được, có $n tệp" || bad "MinIO $label rỗng hoặc không giải mã được"
done

RTO=$(( $(date +%s) - T0 ))
echo; echo "RTO kiểm thử khôi phục: ${RTO} giây"
echo "===== KẾT QUẢ KHÔI PHỤC: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
