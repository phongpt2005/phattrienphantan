#!/usr/bin/env bash
# ============================================================
# Áp schema v2 lên các database ĐANG CHẠY (idempotent, không xóa dữ liệu).
# DB mới tạo không cần script này: docker-entrypoint-initdb.d đã nạp cùng file SQL.
#
# Dùng:  bash infrastructure/scripts/apply-schema.sh           # hr + acc + central
#        bash infrastructure/scripts/apply-schema.sh central   # chỉ một đích
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

NODE_SQL=infrastructure/postgres/init-scripts/node/01-schema.sql
CENTRAL_SQL=infrastructure/postgres/init-scripts/central/01-schema.sql

psql_in() { # <container> <user> <db> <sqlfile>
  docker exec -i "$1" psql -U "$2" -d "$3" -v ON_ERROR_STOP=1 -q < "$4" 2> >(grep -v NOTICE >&2)
}

apply_node() { # <container> <user> <db> <label>
  echo ">>> [$4] áp node schema v2"
  psql_in "$1" "$2" "$3" "$NODE_SQL"
  # Debezium dùng user replication: cần SELECT bảng outbox
  docker exec "$1" psql -U "$2" -d "$3" -qc \
    "GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${POSTGRES_REPLICATION_USER};" >/dev/null
}

apply_central() {
  echo ">>> [central] áp central schema v2"
  psql_in postgres-central-primary "$POSTGRES_CENTRAL_USER" "$POSTGRES_CENTRAL_DB" "$CENTRAL_SQL"
  # Tính lại search_vector theo cấu hình tiếng Việt không dấu (trigger chạy khi UPDATE)
  docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -qc \
    "UPDATE search_document SET title = title;" >/dev/null
}

target="${1:-all}"
case "$target" in
  hr)      apply_node postgres-hr-primary  "$POSTGRES_HR_USER"  "$POSTGRES_HR_DB"  HR ;;
  acc)     apply_node postgres-acc-primary "$POSTGRES_ACC_USER" "$POSTGRES_ACC_DB" ACC ;;
  central) apply_central ;;
  all)
    apply_node postgres-hr-primary  "$POSTGRES_HR_USER"  "$POSTGRES_HR_DB"  HR
    apply_node postgres-acc-primary "$POSTGRES_ACC_USER" "$POSTGRES_ACC_DB" ACC
    apply_central ;;
  *) echo "Đích không hợp lệ: $target (hr|acc|central|all)"; exit 1 ;;
esac
echo ">>> Xong."
