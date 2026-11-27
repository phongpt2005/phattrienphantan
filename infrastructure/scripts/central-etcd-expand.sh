#!/usr/bin/env bash
# ============================================================
# Mở rộng etcd của cụm CSDL trung tâm từ 1 nút lên 3 nút, không xóa dữ liệu Patroni.
#   bash infrastructure/scripts/central-etcd-expand.sh
#
# Thứ tự (cụm không lúc nào mất quorum):
#   1. Sửa địa chỉ peer của nút cũ (trước đây là localhost) thành central-etcd:2380, tạo lại nút với cấu hình mới.
#   2. Với từng nút mới: thêm dạng learner (không bỏ phiếu), khởi động với state existing,
#      chờ theo kịp rồi mới nâng thành thành viên bỏ phiếu.
# Chạy lại an toàn: nút nào đã là thành viên thì bỏ qua.
# Patroni giữ máy chính trong lúc etcd khởi động lại nhờ failsafe_mode (đã kiểm ở central-failover-test ca 4).
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
E() { docker exec central-etcd etcdctl "$@"; }
wait_healthy() { # $1 container, $2 giây
  local t0; t0=$(date +%s)
  while [ $(( $(date +%s)-t0 )) -lt "$2" ]; do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ] && return 0; sleep 2
  done; return 1; }

echo "== Hiện trạng =="
E member list -w table

ID1=$(E member list | awk -F', ' '$3=="central-etcd"{print $1}')
PEER1=$(E member list | awk -F', ' '$3=="central-etcd"{print $4}')
if [ "$PEER1" != "http://central-etcd:2380" ]; then
  echo "== 1. Đổi địa chỉ peer của central-etcd: $PEER1 -> http://central-etcd:2380 =="
  E member update "$ID1" --peer-urls=http://central-etcd:2380
fi
if [ "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' central-etcd | grep '^ETCD_LISTEN_PEER_URLS=')" != "ETCD_LISTEN_PEER_URLS=http://0.0.0.0:2380" ]; then
  echo "== 1b. Tạo lại central-etcd với cấu hình mới (dữ liệu giữ trên volume) =="
  docker compose up -d --no-build --no-deps --force-recreate central-etcd
  wait_healthy central-etcd 90 || { echo "central-etcd không khỏe sau khi tạo lại"; exit 1; }
fi

for N in central-etcd-2 central-etcd-3; do
  if E member list | awk -F', ' '{print $3}' | grep -qx "$N"; then
    echo "== $N đã là thành viên, bỏ qua =="; continue
  fi
  echo "== 2. Thêm $N dạng learner =="
  OUT=$(E member add "$N" --learner --peer-urls="http://$N:2380")
  echo "$OUT" | grep -v -i token
  IC=$(echo "$OUT" | sed -n 's/^ETCD_INITIAL_CLUSTER="\(.*\)"$/\1/p')
  [ -n "$IC" ] || { echo "Không đọc được ETCD_INITIAL_CLUSTER"; exit 1; }
  CENTRAL_ETCD_INITIAL_CLUSTER="$IC" CENTRAL_ETCD_CLUSTER_STATE=existing \
    docker compose up -d --no-build --no-deps "$N"
  NID=$(E member list | awk -F', ' -v n="$N" '$3==n{print $1}')
  # Learner chỉ nâng quyền được khi đã theo kịp nhật ký của leader
  ok=0
  for i in $(seq 1 45); do
    if E member promote "$NID" >/dev/null 2>&1; then ok=1; break; fi; sleep 2
  done
  [ "$ok" = 1 ] || { echo "Không nâng được $N thành thành viên bỏ phiếu"; exit 1; }
  echo "  $N đã thành thành viên bỏ phiếu"
  wait_healthy "$N" 90 || { echo "$N không khỏe"; exit 1; }
done

echo "== Kết quả =="
E member list -w table
E endpoint status --cluster -w table
E endpoint health --cluster
