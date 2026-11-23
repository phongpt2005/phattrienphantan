#!/usr/bin/env bash
# ============================================================
# CÀI ĐẶT DMS MỘT LỆNH
#
#   bash scripts/setup.sh              # cài đặt đầy đủ
#   bash scripts/setup.sh --verify     # cài xong, chạy bộ kiểm thử e2e (mất vài phút)
#   bash scripts/setup.sh --only-env   # chỉ tạo và điền .env, rồi dừng
#
# Các bước:
#   1. Kiểm tra Docker, Docker Compose, Node.js, npm, curl
#   2. Tạo .env từ .env.example và sinh ngẫu nhiên các bí mật (giá trị CHANGE_ME)
#   3. Build giao diện (frontend/dist) và 3 image: department-service,
#      search-engine-service, content-worker
#   4. docker compose up -d --no-build
#   5. Chờ gateway sẵn sàng (http://localhost:<NGINX_HTTP_PORT>/health)
#
# Chạy lại an toàn: .env đã có giá trị thật thì được giữ nguyên.
# Script không in ra giá trị bí mật.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VERIFY=0
ONLY_ENV=0
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY=1 ;;
    --only-env) ONLY_ENV=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Tham số không hợp lệ: $arg (xem: bash scripts/setup.sh --help)"; exit 2 ;;
  esac
done

say()  { printf '\n>>> %s\n' "$*"; }
fail() { printf '\nLỖI: %s\n' "$*" >&2; exit 1; }

# Các biến bí mật được sinh ngẫu nhiên khi còn CHANGE_ME.
# Mật khẩu demo (DEMO_*) không nằm trong danh sách này: nút đăng nhập nhanh của giao diện dùng đúng các giá trị đó.
SECRET_KEYS="POSTGRES_HR_PASSWORD POSTGRES_ACC_PASSWORD POSTGRES_CENTRAL_PASSWORD POSTGRES_REPLICATION_PASSWORD MINIO_HR_ROOT_PASSWORD MINIO_ACC_ROOT_PASSWORD REDIS_PASSWORD JWT_SECRET INTERNAL_SERVICE_TOKEN GRAFANA_ADMIN_PASSWORD BACKUP_ENCRYPTION_KEY DEPT_REPL_PASSWORD_SALES"

random_secret() {
  if command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    fail "Cần Node.js hoặc openssl để sinh bí mật ngẫu nhiên"
  fi
}

check_tools() {
  command -v docker >/dev/null 2>&1 || fail "Chưa cài Docker Desktop: https://www.docker.com/products/docker-desktop"
  docker info >/dev/null 2>&1 || fail "Docker chưa chạy. Mở Docker Desktop, đợi nó sẵn sàng rồi chạy lại script"
  docker compose version >/dev/null 2>&1 || fail "Cần Docker Compose v2 (đi kèm Docker Desktop)"
  command -v node >/dev/null 2>&1 || fail "Chưa cài Node.js 20: https://nodejs.org"
  command -v npm >/dev/null 2>&1 || fail "Chưa có npm (đi kèm Node.js)"
  command -v curl >/dev/null 2>&1 || fail "Thiếu curl"
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  [ "$major" -ge 18 ] || fail "Node.js quá cũ (đang là bản $major). Cần Node.js 20"
  echo "  Docker, Compose, Node.js $(node -v), npm $(npm -v), curl: OK"
}

prepare_env() {
  [ -f .env.example ] || fail "Thiếu file .env.example"
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "  Đã tạo .env từ .env.example"
  fi
  local key val
  for key in $SECRET_KEYS; do
    if grep -q "^${key}=CHANGE_ME\$" .env; then
      val="$(random_secret)"
      sed "s|^${key}=CHANGE_ME\$|${key}=${val}|" .env > .env.tmp && mv .env.tmp .env
    fi
  done
  if grep -q '=CHANGE_ME$' .env; then
    fail "Còn biến CHANGE_ME trong .env. Điền giá trị thật cho các biến đó rồi chạy lại"
  fi
  chmod 600 .env 2>/dev/null || true
  echo "  .env đã có đủ giá trị (bí mật không được in ra)"
}

build_frontend() {
  say "Build giao diện (frontend/dist)"
  (cd frontend && npm ci && npm run build)
  [ -f frontend/dist/index.html ] || fail "Build giao diện không tạo ra frontend/dist/index.html"
  echo "  Giao diện đã build"
}

build_images() {
  say "Build 3 image của dự án (lần đầu mất nhiều phút; lần sau nhanh nhờ cache)"
  docker build -f services/department-service/Dockerfile    -t dms/department-service:2.0    .
  docker build -f services/search-engine-service/Dockerfile -t dms/search-engine-service:2.0 .
  docker build -f services/content-worker/Dockerfile        -t dms/content-worker:2.0        .
}

start_stack() {
  say "Khởi động stack (docker compose up -d --no-build)"
  docker compose up -d --no-build
}

gateway_port() {
  local p
  p="$(grep -E '^NGINX_HTTP_PORT=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r')"
  echo "${p:-8000}"
}

wait_gateway() {
  local url tries
  url="http://localhost:$(gateway_port)/health"
  say "Chờ gateway sẵn sàng: $url"
  for tries in $(seq 1 180); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      echo "  Gateway đã sẵn sàng"
      return 0
    fi
    sleep 5
  done
  fail "Gateway chưa sẵn sàng sau 900 giây (15 phút). Xem log: docker compose logs --tail=100 nginx search-engine-service"
}

finish() {
  cat <<EOF

================================================================
 CÀI ĐẶT XONG
 Giao diện:      http://localhost:$(gateway_port)
 Tài khoản demo: admin, hr_manager, hr_staff, acc_manager, acc_staff
                 (mật khẩu demo: xem README.md)
 Thêm phòng ban: bash scripts/add-department.sh SALES "Phòng Kinh doanh"
 Kiểm thử e2e:   bash infrastructure/scripts/e2e-smoke.sh
================================================================
EOF
}

main() {
  if [ "$ONLY_ENV" = 1 ]; then
    say "Tạo và điền .env"
    prepare_env
    exit 0
  fi
  say "Kiểm tra công cụ"
  check_tools
  say "Chuẩn bị .env"
  prepare_env
  build_frontend
  build_images
  start_stack
  wait_gateway
  finish
  if [ "$VERIFY" = 1 ]; then
    say "Chạy kiểm thử e2e"
    bash infrastructure/scripts/e2e-smoke.sh
  fi
}

main
