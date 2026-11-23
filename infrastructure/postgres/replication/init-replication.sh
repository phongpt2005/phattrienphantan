#!/bin/sh
# ============================================================
# Chạy tự động khi PostgreSQL Primary khởi tạo lần đầu.
# Tạo user replication (Streaming Replication + Debezium).
# Publication cho CDC (dms_outbox_pub, chỉ gồm bảng outbox) do node/01-schema.sql tạo.
# ============================================================
set -e

echo ">>> Tạo replication user cho Streaming Replication và Debezium CDC..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER ${POSTGRES_REPLICATION_USER} WITH REPLICATION ENCRYPTED PASSWORD '${POSTGRES_REPLICATION_PASSWORD}';

    -- Debezium cần SELECT bảng outbox (snapshot) -> cấp mặc định cho mọi bảng sẽ tạo sau
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${POSTGRES_REPLICATION_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${POSTGRES_REPLICATION_USER};
EOSQL

# Thêm replication rules vào pg_hba.conf (PostgreSQL 14+ dùng scram-sha-256)
echo "host replication all 0.0.0.0/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"
echo "host all all 0.0.0.0/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"

echo ">>> pg_hba.conf đã được cập nhật."
