#!/usr/bin/env bash
# ============================================================
# KIỂM THỬ NÂNG CẤP LUÂN PHIÊN (feature 4): nâng cấp từng bản sao node HR khi người dùng vẫn gửi request liên tục.
#   bash infrastructure/scripts/rolling-upgrade-test.sh
# Hai luồng tải song song: qua gateway (:8000, route /api/dept/hr) và qua cổng nội bộ edge (:3001).
# Nâng cấp = tạo lại container (force-recreate) từng bản: dept-hr, rồi dept-hr-2. Đếm mọi mã 5xx.
# Đạt: 0 mã 502/503/504 và tổng request > 0 ở cả hai luồng.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
GW=http://localhost:8000/api/dept/hr/health
EDGE=http://localhost:3001/health
TMPD="$(mktemp -d)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }

load() { # $1 url, $2 file đích, $3 số giây
  local end=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    curl -s -m 5 -o /dev/null -w '%{http_code}\n' "$1" >> "$2" || echo 000 >> "$2"
  done
}
wait_healthy() {
  for i in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ] && return 0
    sleep 3
  done
  return 1
}

echo "== 0. Điều kiện =="
wait_healthy dept-hr && ok "dept-hr khỏe trước khi bắt đầu" || bad "dept-hr chưa khỏe"
wait_healthy dept-hr-2 && ok "dept-hr-2 khỏe trước khi bắt đầu" || bad "dept-hr-2 chưa khỏe"

echo "== 1. Tải liên tục (gateway + edge) trong lúc nâng cấp =="
load "$GW" "$TMPD/gw.txt" 150 &
LG=$!
load "$EDGE" "$TMPD/edge.txt" 150 &
LE=$!
sleep 8

echo "== 2. Nâng cấp luân phiên =="
for svc in dept-hr dept-hr-2; do
  T=$(date +%s)
  docker compose up -d --no-build --no-deps --force-recreate "$svc" >/dev/null 2>&1
  wait_healthy "$svc" && ok "$svc nâng cấp xong, khỏe lại sau $(( $(date +%s) - T )) giây" || bad "$svc không khỏe lại"
  sleep 6
done

wait $LG $LE

echo "== 3. Đối soát mã phản hồi =="
for f in gw edge; do
  total=$(wc -l < "$TMPD/$f.txt" | tr -d ' ')
  n5=$(grep -cE '^(5[0-9][0-9]|000)$' "$TMPD/$f.txt")
  summary=$(sort "$TMPD/$f.txt" | uniq -c | tr -s ' ' | tr '\n' ' ')
  echo "  $f: tổng $total request | $summary"
  [ "$total" -gt 0 ] && ok "$f có tải thật ($total request)" || bad "$f không có request nào"
  [ "$n5" = 0 ] && ok "$f: 0 lỗi 5xx/timeout" || bad "$f: $n5 lỗi 5xx/timeout"
done

rm -rf "$TMPD"
echo; echo "===== KẾT QUẢ ROLLING UPGRADE: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
