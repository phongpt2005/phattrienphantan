#!/usr/bin/env bash
# ============================================================
# Áp schema v2 lên các database ĐANG CHẠY (idempotent, không xóa dữ liệu).
# DB mới tạo không cần script này: docker-entrypoint-initdb.d đã nạp cùng file SQL.
#
# Dùng:  bash infrastructure/scripts/apply-schema.sh           # hr + acc + các phòng dept-<code>-db + central
#        bash infrastructure/scripts/apply-schema.sh central   # chỉ một đích
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh

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

# Phòng thêm bằng scripts/add-department.sh (ví dụ SALES): CSDL dept-<code>-db, user/db đọc từ biến môi trường của chính container
apply_node_env() { # <container> <label>
  echo ">>> [$2] áp node schema v2"
  docker exec -i "$1" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < "$NODE_SQL" 2> >(grep -v NOTICE >&2)
  docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -qc 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${POSTGRES_REPLICATION_USER};'" >/dev/null
}

apply_central() {
  echo ">>> [central] áp central schema v2"
  psql_in "$(central_leader)" "$POSTGRES_CENTRAL_USER" "$POSTGRES_CENTRAL_DB" "$CENTRAL_SQL"
  # Tính lại search_vector theo cấu hình tiếng Việt không dấu (trigger chạy khi UPDATE)
  docker exec "$(central_leader)" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -qc \
    "UPDATE search_document SET title = title;" >/dev/null
}

target="${1:-all}"
case "$target" in
  hr)      apply_node "$(hr_leader)"  "$POSTGRES_HR_USER"  "$POSTGRES_HR_DB"  HR ;;
  acc)     apply_node postgres-acc-primary "$POSTGRES_ACC_USER" "$POSTGRES_ACC_DB" ACC ;;
  sales)   apply_node_env dept-sales-db SALES ;;
  central) apply_central ;;
  all)
    apply_node "$(hr_leader)"  "$POSTGRES_HR_USER"  "$POSTGRES_HR_DB"  HR
    apply_node postgres-acc-primary "$POSTGRES_ACC_USER" "$POSTGRES_ACC_DB" ACC
    # Các phòng thêm sau (dept-<code>-db đang chạy)
    for c in $(docker ps --format '{{.Names}}' | grep -E '^dept-[a-z0-9]+-db$'); do
      apply_node_env "$c" "$(echo "$c" | sed 's/^dept-//; s/-db$//' | tr a-z A-Z)"
    done
    apply_central ;;
  *) echo "Đích không hợp lệ: $target (hr|acc|sales|central|all)"; exit 1 ;;
esac
echo ">>> Xong."
