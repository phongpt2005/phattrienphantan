#!/usr/bin/env bash
# ============================================================
# Gỡ phòng ban đã thêm bằng add-department.sh.
#   bash scripts/remove-department.sh SALES            # dừng node, GIỮ dữ liệu (volume)
#   bash scripts/remove-department.sh SALES --purge    # xóa luôn dữ liệu (KHÔNG hoàn tác được)
# Không dùng cho HR/ACC (thuộc compose chính).
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

CODE="$(printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]')"
[ -n "$CODE" ] || { echo "Dùng: bash scripts/remove-department.sh <MÃ> [--purge]"; exit 1; }
LC="$(printf '%s' "$CODE" | tr '[:upper:]' '[:lower:]')"
case "$LC" in hr|acc) echo "HR/ACC thuộc compose chính, không gỡ bằng script này."; exit 1;; esac
ENVF="departments/$LC.env"
[ -f "$ENVF" ] || { echo "Không thấy $ENVF: phòng ban này không do add-department.sh tạo."; exit 1; }

set -a; . ./.env; . "./$ENVF"; set +a
echo ">>> Đưa $CODE sang DRAINING và gỡ connector"
curl -s -o /dev/null -X DELETE "http://localhost:${DEBEZIUM_PORT:-8083}/connectors/outbox-$LC" || true

PURGE=""
[ "${2:-}" = "--purge" ] && PURGE="-v"
docker compose -p "dept-$LC" -f docker-compose.department.yml --env-file .env --env-file "$ENVF" down $PURGE
rm -f "infrastructure/monitoring/prometheus/targets/$LC.json"
# Gỡ CÓ CHỦ ĐÍCH không phải sự cố: ghi RETIRED để trang giám sát không đếm là node sập (sự cố đang diễn ra)
docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -qc   "UPDATE department SET lifecycle='RETIRED' WHERE dept_code='$CODE'; INSERT INTO department_status_event (dept_code, from_state, to_state, reason) VALUES ('$CODE','DRAINING','RETIRED','Gỡ có chủ đích bằng remove-department.sh')" >/dev/null
if [ -n "$PURGE" ]; then
  docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -qc \
    "SELECT 1" >/dev/null
  rm -f "$ENVF"
  echo ">>> Đã xóa dữ liệu. Phòng ban $CODE ở trạng thái RETIRED trong Registry."
else
  echo ">>> Đã dừng node, dữ liệu còn trong volume dms-pgdata-dept-$LC / dms-minio-dept-$LC."
fi
