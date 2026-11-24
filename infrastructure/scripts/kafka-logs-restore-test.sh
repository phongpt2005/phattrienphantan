#!/usr/bin/env bash
# ============================================================
# KIỂM KHÔI PHỤC LOG KAFKA (C3): bản sao mới nhất trong OneDrive\dms_backups\kafka_*.
#   bash infrastructure/scripts/kafka-logs-restore-test.sh
# 1. Giải mã vào thư mục tạm (không bao giờ ghi lại vào OneDrive).
# 2. So SHA-256 và kích thước từng tệp với manifest. Phải khớp 100%.
# 3. Đọc thử một segment có dữ liệu bằng kafka-dump-log trong container dùng một lần (không đụng broker đang chạy).
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
export MSYS_NO_PATHCONV=1

KEY="$(printf '%s' "${BACKUP_ENCRYPTION_KEY:-}" | tr -d '\r')"
[ "${#KEY}" -ge 32 ] || { echo "Thiếu BACKUP_ENCRYPTION_KEY trong .env. DỪNG."; exit 1; }
export BACKUP_KEY_CLEAN="$KEY"

PROFILE_UNIX="$(cygpath -u "${USERPROFILE:-}" 2>/dev/null || echo "$HOME")"
LATEST=$(ls -d "$PROFILE_UNIX/OneDrive/dms_backups"/kafka_* 2>/dev/null | sort | tail -n 1)
[ -n "$LATEST" ] || { echo "Không có bản sao Kafka nào trong OneDrive\\dms_backups"; exit 1; }
echo "bản sao kiểm: $LATEST"

# Bước 0: tệp mã hóa trên OneDrive phải đúng với SHA-256 đã ghi trong manifest (phát hiện lỗi sao chép/đồng bộ)
ENC_FILE="$LATEST/kafka_logs.tar.gz.enc"
ENC_SHA_WANT=$(grep '^# encrypted file sha256' "$LATEST/manifest.txt" | awk '{print $5}')
ENC_SHA_GOT=$(sha256sum "$ENC_FILE" | awk '{print $1}')
if [ -z "$ENC_SHA_WANT" ] || [ "$ENC_SHA_GOT" != "$ENC_SHA_WANT" ]; then
  echo "KHÔI PHỤC THẤT BẠI: tệp mã hóa không khớp manifest (sha256 $ENC_SHA_GOT)"; exit 1
fi
echo "tệp mã hóa khớp manifest (sha256 $ENC_SHA_GOT)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMPW="$(cygpath -m "$TMP")"

# Đưa tệp vào qua stdin: openssl bản Windows không đọc được đường dẫn kiểu /c/...
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_KEY_CLEAN < "$ENC_FILE" | tar -xzf - -C "$TMP"; then
  echo "KHÔI PHỤC THẤT BẠI: không giải mã/giải nén được"; exit 1
fi

PASS=0; FAIL=0
while read -r tag sha size rel; do
  [ "$tag" = "file" ] || continue
  f="$TMP/kafka-logs/$rel"
  if [ -f "$f" ] && [ "$(sha256sum "$f" | awk '{print $1}')" = "$sha" ] && [ "$(stat -c %s "$f")" = "$size" ]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1)); echo "KHÁC hoặc THIẾU: $rel"
  fi
done < "$LATEST/manifest.txt"
echo "đối chiếu SHA-256 từng tệp: khớp $PASS, khác/thiếu $FAIL"

# Đọc thử một segment có dữ liệu bằng kafka-dump-log trong container dùng một lần
IMG="$(docker inspect -f '{{.Config.Image}}' kafka-1 2>/dev/null || echo apache/kafka:3.7.0)"
SEG_ABS=$(find "$TMP/kafka-logs" -name '*.log' -size +0 | sort | head -n 1)
SEG_REL="${SEG_ABS#$TMP/}"
DUMP_OUT=$(docker run --rm -v "$TMPW":/data --entrypoint /opt/kafka/bin/kafka-dump-log.sh "$IMG" --files "/data/$SEG_REL" --print-data-log 2>&1)
DUMP_RC=$?
RECORDS=$(printf '%s\n' "$DUMP_OUT" | grep -c 'offset:')
echo "đọc thử segment $SEG_REL: mã thoát $DUMP_RC, số bản ghi thấy được $RECORDS"

if [ "$FAIL" -eq 0 ] && [ "$DUMP_RC" -eq 0 ] && [ "$RECORDS" -gt 0 ]; then
  echo "KẾT QUẢ KHÔI PHỤC: ĐẠT"; exit 0
else
  echo "KẾT QUẢ KHÔI PHỤC: CHƯA ĐẠT"; exit 1
fi
