#!/usr/bin/env bash
# ============================================================
# THÊM PHÒNG BAN MỚI MÀ KHÔNG SỬA NODE NÀO ĐÃ CÓ (yêu cầu R3).
#
#   bash scripts/add-department.sh SALES "Phòng Kinh doanh"
#
# Việc script làm (toàn bộ là THÊM, không sửa HR/ACC/Search/nginx):
#   1. Sinh thông tin đăng nhập ngẫu nhiên cho DB + MinIO -> departments/<code>.env
#   2. Dựng Postgres + MinIO + department-service riêng (project compose dept-<code>)
#   3. Đăng ký connector Debezium outbox-<code> và phát lại dữ liệu hiện có
#   4. Ghi target Prometheus (file_sd)
# Node tự đăng ký Registry; nginx tự có route /api/dept/<code>/; Projector tự nhận topic mới.
# Gỡ phòng ban: bash scripts/remove-department.sh <CODE>
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

CODE="$(printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]')"
NAME="${2:-Phòng $CODE}"
if ! printf '%s' "$CODE" | grep -Eq '^[A-Z][A-Z0-9_]{1,19}$'; then
  echo "Dùng: bash scripts/add-department.sh <MÃ> \"<Tên phòng ban>\"  (MÃ: A-Z, 0-9, _ ; bắt đầu bằng chữ; tối đa 20 ký tự)"
  exit 1
fi
LC="$(printf '%s' "$CODE" | tr '[:upper:]' '[:lower:]')"
mkdir -p departments
ENVF="departments/$LC.env"

case "$LC" in hr|acc) echo "HR/ACC thuộc compose chính, không thêm bằng script này."; exit 1;; esac
if docker ps -a --format '{{.Names}}' | grep -qx "dept-$LC"; then
  echo ">>> dept-$LC đã tồn tại: chạy lại các bước còn thiếu (mọi bước đều idempotent)"
fi

rand() { python -I -c "import secrets; print(secrets.token_urlsafe($1))"; }

if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<EOF
# Sinh bởi scripts/add-department.sh — KHÔNG commit (departments/ nằm trong .gitignore)
DEPT_CODE=$CODE
DEPT_LC=$LC
DEPT_NAME="$NAME"
DEPT_DB_USER=${LC}_admin
DEPT_DB_NAME=dms_$LC
DEPT_DB_PASSWORD=$(rand 18)
DEPT_REPL_PASSWORD=$(rand 18)
DEPT_MINIO_USER=${LC}_minio_admin
DEPT_MINIO_PASSWORD=$(rand 18)
EOF
  echo ">>> Đã sinh $ENVF"
fi
set -a; . ./.env; . "./$ENVF"; set +a

echo ">>> [1/4] Dựng node $CODE (Postgres + MinIO + department-service)"
COMPOSE_BAKE=false docker compose -p "dept-$LC" -f docker-compose.department.yml --env-file .env --env-file "$ENVF" up -d --no-build

echo ">>> [2/4] Chờ DB và node sẵn sàng"
until [ "$(docker inspect -f '{{.State.Health.Status}}' "dept-$LC-db" 2>/dev/null)" = "healthy" ]; do sleep 2; done
until [ "$(docker inspect -f '{{.State.Health.Status}}' "dept-$LC" 2>/dev/null)" = "healthy" ]; do sleep 2; done

echo ">>> [2b] Kiểm tra sổ chia sẻ (document_share + chỉ mục chống đua) trên DB mới"
share_ok() {
  docker exec "dept-$LC-db" psql -U "$DEPT_DB_USER" -d "$DEPT_DB_NAME" -tAc \
    "SELECT count(*) FROM pg_indexes WHERE tablename='document_share' AND indexname IN ('idx_unique_active_share','uq_node_share_request','uq_node_share_legacy')
       AND (SELECT count(*) FROM information_schema.table_constraints WHERE table_name='document_share' AND constraint_type='FOREIGN KEY') >= 1" 2>/dev/null | tr -d '[:space:]'
}
if [ "$(share_ok)" != "3" ]; then
  # DB tạo từ trước khi schema có sổ chia sẻ: áp lại file schema (idempotent, không xóa dữ liệu)
  echo "    thiếu bảng/chỉ mục, áp lại node schema"
  docker exec -i "dept-$LC-db" psql -U "$DEPT_DB_USER" -d "$DEPT_DB_NAME" -v ON_ERROR_STOP=1 -q < infrastructure/postgres/init-scripts/node/01-schema.sql
fi
[ "$(share_ok)" = "3" ] || { echo "LỖI: node $CODE vẫn thiếu document_share/chỉ mục/khóa ngoại"; exit 1; }
echo "    OK: document_share có khóa ngoại + chỉ mục duy nhất (đang hiệu lực / theo yêu cầu / dữ liệu cũ)"

echo ">>> [3/4] Đăng ký connector Debezium + phát lại dữ liệu"
# Dùng chính service connect-init của core (cùng template) nhưng chỉ cho phòng ban này
docker compose run --rm --no-deps -e "CONNECTORS=$CODE:dept-$LC-db:$DEPT_DB_NAME" -e "REPL_PASSWORD=$DEPT_REPL_PASSWORD" connect-init

echo ">>> [4/4] Prometheus target"
printf '[{"targets": ["dept-%s:3000"], "labels": {"service": "department-service", "department": "%s"}}]\n' "$LC" "$CODE" \
  > "infrastructure/monitoring/prometheus/targets/$LC.json"

echo
echo "Đã thêm phòng ban $CODE ($NAME)."
echo "  Đăng nhập thử : tài khoản demo ${LC}_manager / ${LC}_staff (mật khẩu theo DEMO_* trong .env), admin"
echo "  API node      : /api/dept/$LC/...   |  Registry: /api/registry/departments/public"
