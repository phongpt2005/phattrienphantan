# ============================================================
# P1 B2: hàm chung để script làm việc với CSDL trung tâm, dù đang là cụm Patroni hay máy chủ đơn cũ.
#   . infrastructure/scripts/lib-central.sh      (gọi sau khi đã cd về gốc dự án)
#
# Cách nhận biết: địa chỉ máy chủ trong DATABASE_URL của search-engine-service đang chạy.
#   @central-db:              -> cụm Patroni (central-pg-1, central-pg-2, HAProxy central-db)
#   @postgres-central-primary -> máy chủ đơn cũ
# Nhờ vậy script đúng cả trước khi chuyển, sau khi chuyển và khi quay lui. Không in DATABASE_URL (có mật khẩu).
# ============================================================
central_mode() {
  local id
  id=$(docker ps -aq --filter name=search-engine-service 2>/dev/null | head -1)
  if [ -n "$id" ] && docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null | grep -q '^DATABASE_URL=.*@central-db:'; then
    echo patroni
  else
    echo legacy
  fi
}

# Các container CSDL trung tâm của chế độ hiện tại (dùng để dừng/bật cả cụm khi mô phỏng "trung tâm sập")
central_nodes() {
  if [ "$(central_mode)" = patroni ]; then echo "central-pg-1 central-pg-2"; else echo "postgres-central-primary postgres-central-replica"; fi
}

# Container đang là máy chính. Patroni: hỏi GET /primary (chỉ máy chính trả 200). Rỗng nếu chưa có máy chính.
# Container máy chính trong một cụm Patroni. Hỏi lại tới LEADER_WAIT giây (mặc định 15): khi máy tải nặng, vòng lặp Patroni
# có thể chạy quá giờ và GET /primary tạm không trả 200 dù máy chính vẫn đó (restore-test 2026-11-27 trả rỗng vì vậy).
# Bài kiểm chuyển máy chính cần biết "ngay lúc này" thì đặt LEADER_WAIT=0.
patroni_leader() {
  local c t0; t0=$(date +%s)
  while :; do
    for c in "$@"; do
      if MSYS_NO_PATHCONV=1 docker exec "$c" wget -q -T 3 -O /dev/null http://127.0.0.1:8008/primary 2>/dev/null; then echo "$c"; return 0; fi
    done
    [ $(( $(date +%s) - t0 )) -ge "${LEADER_WAIT:-15}" ] && return 1
    sleep 2
  done
}

central_leader() {
  if [ "$(central_mode)" = patroni ]; then patroni_leader central-pg-1 central-pg-2; return; fi
  echo postgres-central-primary
}

# Chờ tới khi có máy chính nhận truy vấn (mặc định 90 giây)
central_wait() {
  local t0 l
  t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt "${1:-90}" ]; do
    l=$(central_leader) && [ -n "$l" ] && docker exec "$l" psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc 'select 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# ------------------------------------------------------------
# P2 N2: CSDL phòng HR, cụm Patroni (hr-pg-1, hr-pg-2, HAProxy hr-db) hay máy chủ đơn cũ (postgres-hr-primary).
# Nhận biết qua DATABASE_URL của container dept-hr: @hr-db-site: (hoặc @hr-db: trước khi tách tên theo mạng) -> cụm Patroni.
# ------------------------------------------------------------
hr_mode() {
  if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' dept-hr 2>/dev/null | grep -q -E '^DATABASE_URL=.*@hr-db(-site)?:'; then
    echo patroni
  else
    echo legacy
  fi
}
hr_nodes() {
  if [ "$(hr_mode)" = patroni ]; then echo "hr-pg-1 hr-pg-2"; else echo "postgres-hr-primary postgres-hr-replica"; fi
}
hr_leader() {
  if [ "$(hr_mode)" = patroni ]; then patroni_leader hr-pg-1 hr-pg-2; return; fi
  echo postgres-hr-primary
}
