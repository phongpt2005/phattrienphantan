#!/usr/bin/env bash
# ============================================================
# SAO LƯU NGOÀI MÁY (P0.2 / N1, mã hóa P0.5.2): CSDL node (HR, ACC, SALES), CSDL trung tâm, và MinIO từng phòng.
#   bash infrastructure/scripts/backup-offsite.sh
# Đích: %USERPROFILE%\OneDrive\dms_backups\<YYYYMMDD_HHMMSS>\
# Mọi tệp dữ liệu được MÃ HÓA AES-256-CBC (PBKDF2, 200000 vòng) bằng BACKUP_ENCRYPTION_KEY trong .env.
# Thiếu khóa thì DỪNG, không bao giờ ghi bản sao lưu chưa mã hóa ra thư mục đám mây.
# manifest.txt ghi SHA-256 của TỆP ĐÃ MÃ HÓA và số liệu đối soát (không chứa dữ liệu nhạy cảm).
# Script KHÔNG xóa bản sao lưu cũ.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh

KEY="$(printf '%s' "${BACKUP_ENCRYPTION_KEY:-}" | tr -d '\r')"
if [ "${#KEY}" -lt 32 ]; then
  echo "Thiếu hoặc quá ngắn BACKUP_ENCRYPTION_KEY trong .env (cần ≥ 32 ký tự). DỪNG: không sao lưu chưa mã hóa."
  exit 1
fi
export BACKUP_KEY_CLEAN="$KEY"
ENC() { openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass env:BACKUP_KEY_CLEAN; }

PROFILE_UNIX="$(cygpath -u "${USERPROFILE:-}" 2>/dev/null || echo "$HOME")"
BASE="$PROFILE_UNIX/OneDrive/dms_backups"
[ -d "$PROFILE_UNIX/OneDrive" ] || { echo "Không thấy thư mục OneDrive ở $PROFILE_UNIX/OneDrive. Dừng: không sao lưu vào ổ máy chính."; exit 1; }
STAMP=$(date +%Y%m%d_%H%M%S)
DEST="$BASE/$STAMP"
mkdir -p "$DEST" || { echo "Không tạo được $DEST"; exit 1; }
MANIFEST="$DEST/manifest.txt"
: > "$MANIFEST"
echo "# DMS backup $STAMP (encrypted: aes-256-cbc, pbkdf2, iter 200000)" >> "$MANIFEST"

sha() { sha256sum "$1" | awk '{print $1}'; }
note() { echo "$1" >> "$MANIFEST"; echo "$1"; }

# 1. CSDL: plain SQL -> gzip -> mã hóa
dump_db() { # $1 nhãn, $2 container, $3 đường dẫn tệp đích (.sql.gz.enc)
  if docker exec "$2" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip -c | ENC > "$3"; then
    note "db $1 $(basename "$3") $(sha "$3") $(stat -c %s "$3")"
  else
    echo "LỖI pg_dump $1" >&2; rm -f "$3"; return 1
  fi
}
dump_db HR      "$(hr_leader)"     "$DEST/dms_hr.sql.gz.enc"
dump_db ACC     postgres-acc-primary       "$DEST/dms_accounting.sql.gz.enc"
dump_db SALES   dept-sales-db              "$DEST/dms_sales.sql.gz.enc"
dump_db CENTRAL "$(central_leader)"   "$DEST/dms_central.sql.gz.enc"

# 2. MinIO: lấy /data từ container (không cần tar trong container) -> tar.gz -> mã hóa
for pair in "HR:minio-hr" "ACC:minio-acc" "SALES:dept-sales-minio"; do
  label=${pair%%:*}; c=${pair##*:}; lower=$(echo "$label" | tr 'A-Z' 'a-z')
  TMP=$(mktemp -d)
  # docker là chương trình Windows: đích phải là đường dẫn Windows tường minh. Không dựa vào việc Git Bash tự đổi /tmp/...
  # (khi MSYS_NO_PATHCONV=1, ví dụ chạy qua acceptance-scorecard.sh, việc tự đổi tắt và docker cp lỗi: 2026-11-27)
  TMPW=$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")
  out="$DEST/minio_${lower}.tar.gz.enc"
  if docker cp "$c:/data" "$TMPW/data" && tar -czf - -C "$TMP" data | ENC > "$out"; then
    note "minio $label minio_${lower}.tar.gz.enc $(sha "$out") $(stat -c %s "$out")"
  else
    echo "LỖI sao lưu MinIO $label ($c)" >&2; rm -f "$out"
  fi
  rm -rf "$TMP"
done

# 3. Số liệu đối soát tại thời điểm sao lưu (restore-test.sh so với số này)
cnt() { docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"$2\""; }
cen() { docker exec "$(central_leader)" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
note "count node_HR_documents $(cnt "$(hr_leader)" 'select count(*) from document')"
note "count node_ACC_documents $(cnt postgres-acc-primary 'select count(*) from document')"
note "count node_SALES_documents $(cnt dept-sales-db 'select count(*) from document')"
note "count central_search_document $(cen 'select count(*) from search_document')"
note "count central_shares_total $(cen 'select coalesce(sum(jsonb_array_length(shares)),0) from search_document')"
note "count central_access_request $(cen 'select count(*) from access_request')"
note "count central_document_share $(cen 'select count(*) from document_share')"
echo "Sao lưu (đã mã hóa) xong: $DEST"
