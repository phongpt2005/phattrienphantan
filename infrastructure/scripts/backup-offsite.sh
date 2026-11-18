#!/usr/bin/env bash
# ============================================================
# SAO LƯU NGOÀI MÁY (P0.2 / N1): CSDL node (HR, ACC, SALES), CSDL trung tâm, và MinIO của từng phòng.
#   bash infrastructure/scripts/backup-offsite.sh
# Đích: %USERPROFILE%\OneDrive\dms_backups\<YYYYMMDD_HHMMSS>\  (thư mục đồng bộ đám mây, nằm NGOÀI ổ máy chính)
# Mỗi lần chạy ghi manifest.txt gồm SHA-256 từng tệp và số liệu đối soát, để restore-test.sh kiểm chứng.
# Script KHÔNG xóa bản sao lưu cũ.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

PROFILE_UNIX="$(cygpath -u "${USERPROFILE:-}" 2>/dev/null || echo "$HOME")"
BASE="$PROFILE_UNIX/OneDrive/dms_backups"
[ -d "$PROFILE_UNIX/OneDrive" ] || { echo "Không thấy thư mục OneDrive ở $PROFILE_UNIX/OneDrive. Dừng: không sao lưu vào ổ máy chính."; exit 1; }
STAMP=$(date +%Y%m%d_%H%M%S)
DEST="$BASE/$STAMP"
mkdir -p "$DEST" || { echo "Không tạo được $DEST"; exit 1; }
MANIFEST="$DEST/manifest.txt"
: > "$MANIFEST"
echo "# DMS backup $STAMP (host: $(hostname))" >> "$MANIFEST"

sha() { sha256sum "$1" | awk '{print $1}'; }
note() { echo "$1" >> "$MANIFEST"; echo "$1"; }

# 1. CSDL: plain SQL nén gzip, một tệp mỗi CSDL
dump_db() { # $1 nhãn, $2 container, $3 đường dẫn tệp đích
  if docker exec "$2" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip -c > "$3"; then
    note "db $1 $(basename "$3") $(sha "$3") $(stat -c %s "$3")"
  else
    echo "LỖI pg_dump $1" >&2; rm -f "$3"; return 1
  fi
}
dump_db HR    postgres-hr-primary      "$DEST/dms_hr.sql.gz"
dump_db ACC   postgres-acc-primary     "$DEST/dms_accounting.sql.gz"
dump_db SALES dept-sales-db            "$DEST/dms_sales.sql.gz"
dump_db CENTRAL postgres-central-primary "$DEST/dms_central.sql.gz"

# 2. MinIO: lấy thư mục /data từ container (không cần tar trong container), nén trên máy
for pair in "HR:minio-hr" "ACC:minio-acc" "SALES:dept-sales-minio"; do
  label=${pair%%:*}; c=${pair##*:}
  TMP=$(mktemp -d)
  if docker cp "$c:/data" "$TMP/data" 2>/dev/null; then
    tar -czf "$DEST/minio_${label,,}.tar.gz" -C "$TMP" data
    note "minio $label minio_${label,,}.tar.gz $(sha "$DEST/minio_${label,,}.tar.gz") $(stat -c %s "$DEST/minio_${label,,}.tar.gz")"
  else
    echo "LỖI docker cp $c" >&2
  fi
  rm -rf "$TMP"
done

# 3. Số liệu đối soát tại thời điểm sao lưu (restore-test.sh so với số này)
cnt() { docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"$2\""; }
cen() { docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
note "count node_HR_documents $(cnt postgres-hr-primary 'select count(*) from document')"
note "count node_ACC_documents $(cnt postgres-acc-primary 'select count(*) from document')"
note "count node_SALES_documents $(cnt dept-sales-db 'select count(*) from document')"
note "count central_search_document $(cen 'select count(*) from search_document')"
note "count central_shares_total $(cen 'select coalesce(sum(jsonb_array_length(shares)),0) from search_document')"
note "count central_access_request $(cen 'select count(*) from access_request')"
note "count central_document_share $(cen 'select count(*) from document_share')"
echo "Sao lưu xong: $DEST"
