#!/bin/sh
# ============================================================
# Đăng ký (hoặc cập nhật) connector Debezium Outbox cho một/nhiều phòng ban.
# Idempotent: dùng PUT /connectors/<name>/config (tạo mới hoặc cập nhật).
# Chạy trong container debezium (có curl + sh) — service `connect-init` trong compose,
# hoặc qua scripts/add-department.sh khi thêm phòng ban.
#
# Biến môi trường:
#   CONNECT_URL        mặc định http://debezium:8083
#   REPL_USER, REPL_PASSWORD
#   CONNECTORS         "CODE:db_host:db_name[,CODE:db_host:db_name...]"
#   TEMPLATE           đường dẫn template (mặc định /connector-template.json)
#   RESYNC_AFTER_REGISTER=true  + INTERNAL_SERVICE_TOKEN: sau khi đăng ký, gọi
#                      POST http://dept-<code>:3000/internal/resync để phát lại tài liệu hiện có
#                      (connector chạy no_data nên chỉ thấy sự kiện từ lúc tạo slot)
# ============================================================
set -eu

CONNECT_URL="${CONNECT_URL:-http://debezium:8083}"
TEMPLATE="${TEMPLATE:-/connector-template.json}"

echo ">>> Chờ Kafka Connect tại ${CONNECT_URL} ..."
i=0
until curl -fsS "${CONNECT_URL}/connectors" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "Kafka Connect không sẵn sàng"; exit 1; }
  sleep 3
done

# Escape ký tự đặc biệt của sed (& / \) trong giá trị thay thế
esc() { printf '%s' "$1" | sed -e 's/[\/&|\\]/\\&/g'; }

echo "$CONNECTORS" | tr ',' '\n' | while IFS=: read -r code host db; do
  [ -z "$code" ] && continue
  lc=$(printf '%s' "$code" | tr 'A-Z' 'a-z')
  name="outbox-${lc}"
  # Mật khẩu replication riêng của phòng (ví dụ SALES): REPL_PASSWORD_<MÃ>, nếu không có thì dùng REPL_PASSWORD chung
  uc=$(printf '%s' "$code" | tr 'a-z' 'A-Z')
  eval "pw_override=\${REPL_PASSWORD_${uc}:-}"
  pw="${pw_override:-$REPL_PASSWORD}"
  body=$(sed \
    -e "s|__CODE_LC__|$(esc "$lc")|g" \
    -e "s|__DB_HOST__|$(esc "$host")|g" \
    -e "s|__DB_NAME__|$(esc "$db")|g" \
    -e "s|__REPL_USER__|$(esc "$REPL_USER")|g" \
    -e "s|__REPL_PASSWORD__|$(esc "$pw")|g" \
    "$TEMPLATE")
  code_http=$(printf '%s' "$body" | curl -sS -o /tmp/resp.txt -w '%{http_code}' -X PUT \
    -H 'Content-Type: application/json' --data-binary @- "${CONNECT_URL}/connectors/${name}/config")
  case "$code_http" in
    200|201) echo ">>> Connector ${name}: OK (HTTP ${code_http})" ;;
    *) echo ">>> Connector ${name}: LỖI HTTP ${code_http}"; cat /tmp/resp.txt; echo; exit 1 ;;
  esac

  if [ "${RESYNC_AFTER_REGISTER:-false}" = "true" ]; then
    node_url="http://dept-${lc}:3000"
    echo ">>> Chờ node ${node_url} rồi phát lại tài liệu (resync) ..."
    j=0
    until curl -fsS "${node_url}/health" >/dev/null 2>&1; do
      j=$((j + 1))
      [ "$j" -gt 40 ] && { echo ">>> Node ${code} chưa sẵn sàng, bỏ qua resync (chạy scripts/resync-all.sh sau)"; continue 2; }
      sleep 3
    done
    sleep 3  # để slot của connector sẵn sàng trước khi phát lại
    curl -fsS -X POST -H "x-service-token: ${INTERNAL_SERVICE_TOKEN}" "${node_url}/internal/resync" && echo
  fi
done
echo ">>> Hoàn tất đăng ký connector."
