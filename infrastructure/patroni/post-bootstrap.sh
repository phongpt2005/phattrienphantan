#!/bin/sh
# Patroni gọi một lần, ngay sau khi khởi tạo cụm mới (chỉ trên node khởi tạo). $1 = chuỗi kết nối superuser tới CSDL postgres.
# Tạo CSDL ứng dụng (APP_DB), áp schema (/schema/schema.sql: trung tâm hoặc phòng ban), cấp quyền đọc cho tài khoản
# replication mà Debezium dùng. Schema phòng ban tự tạo publication dms_outbox_pub và bảng debezium_heartbeat.
set -eu
CONN="$1"
: "${APP_DB:?thiếu APP_DB}"
echo "post-bootstrap: tạo CSDL ${APP_DB}"
psql "$CONN" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${APP_DB}\""
if [ -s /schema/schema.sql ]; then
  echo "post-bootstrap: áp schema"
  psql "$CONN dbname=${APP_DB}" -v ON_ERROR_STOP=1 -q -f /schema/schema.sql
fi
R="${PATRONI_REPLICATION_USERNAME:-}"
if [ -n "$R" ]; then
  psql "$CONN dbname=${APP_DB}" -v ON_ERROR_STOP=1 -q <<SQL
GRANT CONNECT ON DATABASE "${APP_DB}" TO "${R}";
GRANT USAGE ON SCHEMA public TO "${R}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${R}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${R}";
SQL
fi
echo "post-bootstrap: xong"
