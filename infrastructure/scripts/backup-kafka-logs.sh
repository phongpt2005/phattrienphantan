#!/usr/bin/env bash
# ============================================================
# SAO LƯU LOG KAFKA RA NGOÀI CONTAINER (P1 / C3).
#   bash infrastructure/scripts/backup-kafka-logs.sh
# Từ P1 B1: log nằm trên volume của từng broker (KAFKA_LOG_DIRS=/var/lib/kafka/data). Với RF = 3, mỗi broker giữ bản sao
# của mọi partition, nên chụp một broker là đủ (mặc định kafka-1; đổi bằng KAFKA_BACKUP_BROKER, KAFKA_BACKUP_LOGDIR).
# Broker đơn cũ (log trong /tmp/kafka-logs) đã gỡ ngày 2026-11-24; bản sao lưu gần nhất của nó: kafka_20261124_005140 (đã khôi phục thử; không gồm 396 sự kiện phát sinh sau đó).
# Đích: %USERPROFILE%\OneDrive\dms_backups\kafka_<YYYYMMDD_HHMMSS>\
# Mã hóa AES-256-CBC (PBKDF2, 200000 vòng) bằng BACKUP_ENCRYPTION_KEY trong .env. Thiếu khóa thì DỪNG.
# manifest.txt ghi SHA-256 và kích thước của TỪNG TỆP GỐC (trước khi mã hóa), để restore-test đối chiếu từng tệp.
# Bản này chụp khi broker đang chạy ("bản nóng"): dùng để khôi phục và kiểm tra, không thay cho snapshot sạch.
# Script KHÔNG xóa bản sao cũ.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
export MSYS_NO_PATHCONV=1

KEY="$(printf '%s' "${BACKUP_ENCRYPTION_KEY:-}" | tr -d '\r')"
if [ "${#KEY}" -lt 32 ]; then
  echo "Thiếu hoặc quá ngắn BACKUP_ENCRYPTION_KEY trong .env (cần ≥ 32 ký tự). DỪNG: không sao lưu chưa mã hóa."
  exit 1
fi
export BACKUP_KEY_CLEAN="$KEY"
ENC() { openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass env:BACKUP_KEY_CLEAN; }

PROFILE_UNIX="$(cygpath -u "${USERPROFILE:-}" 2>/dev/null || echo "$HOME")"
[ -d "$PROFILE_UNIX/OneDrive" ] || { echo "Không thấy OneDrive ở $PROFILE_UNIX/OneDrive. DỪNG: không sao lưu vào ổ máy chính."; exit 1; }
STAMP=$(date +%Y%m%d_%H%M%S)
DEST="$PROFILE_UNIX/OneDrive/dms_backups/kafka_$STAMP"
mkdir -p "$DEST" || { echo "Không tạo được $DEST"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMPW="$(cygpath -m "$TMP")"   # docker là tiến trình Windows: cần đường dẫn Windows

BROKER="${KAFKA_BACKUP_BROKER:-kafka-1}"
LOGDIR="${KAFKA_BACKUP_LOGDIR:-/var/lib/kafka/data}"
KIMG="$(docker inspect -f '{{.Config.Image}}' "$BROKER" 2>/dev/null || echo apache/kafka:3.7.0)"
# Công cụ Kafka chạy trong container tạm trên dms-network, không exec vào broker (JVM thứ hai có thể vượt giới hạn bộ nhớ)
kt() { local tool=$1; shift; docker run --rm --network dms-network -e KAFKA_HEAP_OPTS="-Xmx96m" --entrypoint "/opt/kafka/bin/$tool" "$KIMG" "$@"; }
KBS="${KAFKA_BACKUP_BOOTSTRAP:-kafka-1:9092,kafka-2:9092,kafka-3:9092}"

# Đích chưa tồn tại: docker cp tạo thư mục kafka-logs chứa nội dung LOGDIR (giữ tên kafka-logs cho restore-test)
if ! docker cp "$BROKER:$LOGDIR" "$TMPW/kafka-logs"; then
  echo "LỖI docker cp $BROKER:$LOGDIR"; exit 1
fi

MANIFEST="$DEST/manifest.txt"
{
  echo "# DMS Kafka log backup $STAMP (UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "# encrypted: aes-256-cbc, pbkdf2, iter 200000; hot copy taken while the broker was running"
  echo "# source: $BROKER:$LOGDIR"
  echo "# file <sha256> <size> <relpath>"
  (cd "$TMP/kafka-logs" && find . -type f | sort | while read -r f; do
     echo "file $(sha256sum "$f" | awk '{print $1}') $(stat -c %s "$f") ${f#./}"
   done)
  echo "# topic log-end offsets at backup time"
  kt kafka-topics.sh --bootstrap-server "$KBS" --list 2>/dev/null | grep -E '^dms\.' | while read -r t; do
    kt kafka-get-offsets.sh --bootstrap-server "$KBS" --topic "$t" --time -1 2>/dev/null | sed 's/^/offset /'
  done
} > "$MANIFEST"

if ! tar -czf - -C "$TMP" kafka-logs | ENC > "$DEST/kafka_logs.tar.gz.enc"; then
  echo "LỖI tar/mã hóa"; rm -f "$DEST/kafka_logs.tar.gz.enc"; exit 1
fi
echo "# encrypted file sha256 $(sha256sum "$DEST/kafka_logs.tar.gz.enc" | awk '{print $1}') size $(stat -c %s "$DEST/kafka_logs.tar.gz.enc")" >> "$MANIFEST"
echo "sao lưu xong: $DEST"
echo "tệp gốc: $(grep -c '^file ' "$MANIFEST") ; kích thước mã hóa: $(stat -c %s "$DEST/kafka_logs.tar.gz.enc") byte"
