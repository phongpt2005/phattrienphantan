#!/usr/bin/env bash
# ============================================================
# Tạo lại lần lượt các node của một cụm Patroni (áp cấu hình mới) mà không sập ghi ngoài kế hoạch.
#   bash infrastructure/scripts/patroni-roll.sh central-pg-1 central-pg-2
#   bash infrastructure/scripts/patroni-roll.sh hr-pg-1 hr-pg-2
#
# Thứ tự: tạo lại bản sao -> chờ nó streaming và đồng bộ -> chuyển máy chính có kế hoạch sang nó
#         -> tạo lại máy chính cũ -> chờ đồng bộ.
# Bỏ qua (chỉ báo) node có cấu hình đã khớp nếu ROLL_ONLY_CHANGED=1 và compose không đổi gì.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
[ $# -eq 2 ] || { echo "Dùng: $0 <node-1> <node-2>"; exit 2; }
A=$1; B=$2
role() { docker exec "$1" wget -q -T 3 -O - http://127.0.0.1:8008/patroni 2>/dev/null \
         | python -I -X utf8 -c 'import sys,json; print(json.load(sys.stdin).get("role",""))' 2>/dev/null || true; }
leader() { local c; for c in $A $B; do [ "$(role "$c")" = primary ] && { echo "$c"; return; }; done; }
sync_of() { # máy chính $1: tên bản sao đang streaming và sync
  docker exec "$1" wget -q -T 3 -O - http://127.0.0.1:8008/patroni 2>/dev/null | python -I -X utf8 -c '
import sys,json; d=json.load(sys.stdin)
print(",".join(r["application_name"] for r in d.get("replication",[]) if r.get("state")=="streaming" and r.get("sync_state") in ("sync","quorum")))' 2>/dev/null || true; }
wait_sync() { # $1 máy chính, $2 bản sao, $3 giây
  local t0; t0=$(date +%s)
  while [ $(( $(date +%s)-t0 )) -lt "$3" ]; do
    sync_of "$1" | tr ',' '\n' | grep -qx "$2" && return 0; sleep 2
  done; return 1; }

L=$(leader); [ -n "$L" ] || { echo "Không thấy máy chính trong $A $B"; exit 1; }
R=$([ "$L" = "$A" ] && echo "$B" || echo "$A")
SCOPE=$(docker exec "$L" wget -q -T 3 -O - http://127.0.0.1:8008/patroni | python -I -X utf8 -c 'import sys,json; print(json.load(sys.stdin)["patroni"]["scope"])')
echo "== Cụm $SCOPE: máy chính $L, bản sao $R =="

echo "== 1. Tạo lại bản sao $R =="
docker compose up -d --no-build --no-deps --force-recreate "$R"
wait_sync "$L" "$R" 180 || { echo "$R chưa streaming/đồng bộ sau 180 giây"; exit 1; }
echo "  $R đã streaming và đồng bộ"

# Cụm có slot logic cố định (Debezium): chỉ chuyển khi bản chép slot trên $R dùng được (bộ canh slot báo ok),
# nếu không Debezium sẽ kẹt trên máy chính mới (lỗi đã gặp ở hr-failover-test lượt 1)
NSLOTS=$(docker exec "$L" wget -q -T 3 -O - http://127.0.0.1:8008/config | python -I -X utf8 -c 'import sys,json; print(sum(1 for v in (json.load(sys.stdin).get("slots") or {}).values() if (v or {}).get("type")=="logical"))')
if [ "$NSLOTS" -gt 0 ]; then
  t0=$(date +%s); G=""
  while [ $(( $(date +%s)-t0 )) -lt 180 ]; do
    G=$(docker exec "$R" sh -c 'cat /tmp/slot-guard.json 2>/dev/null' | python -I -X utf8 -c 'import sys,json; s=json.load(sys.stdin).get("slots",{}); print("ok" if s and all(v=="ok" for v in s.values()) else json.dumps(s))' 2>/dev/null || true)
    [ "$G" = ok ] && break; sleep 3
  done
  [ "$G" = ok ] || { echo "Bản chép slot logic trên $R chưa dùng được ($G): không chuyển máy chính"; exit 1; }
  echo "  bản chép $NSLOTS slot logic trên $R dùng được"
fi

echo "== 2. Chuyển máy chính có kế hoạch $L -> $R =="
docker exec "$L" patronictl -c /etc/patroni/patroni.yml switchover "$SCOPE" --leader "$L" --candidate "$R" --force
t0=$(date +%s); until [ "$(role "$R")" = primary ]; do
  [ $(( $(date +%s)-t0 )) -gt 60 ] && { echo "$R chưa thành máy chính sau 60 giây"; exit 1; }; sleep 1; done
echo "  $R là máy chính sau $(( $(date +%s)-t0 )) giây (tính từ lúc lệnh trả về)"

echo "== 3. Tạo lại máy chính cũ $L =="
docker compose up -d --no-build --no-deps --force-recreate "$L"
wait_sync "$R" "$L" 180 || { echo "$L chưa streaming/đồng bộ sau 180 giây"; exit 1; }
echo "== Xong: máy chính $R, bản sao đồng bộ $L =="
