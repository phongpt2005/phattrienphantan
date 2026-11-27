#!/usr/bin/env bash
# ============================================================
# BƯỚC 4 (máy 1): gắn nhãn m2, m3 cho hai máy vừa tham gia và kiểm tra cụm.
#   bash scripts/swarm/12-label-nodes.sh                 # tự gắn theo thứ tự tham gia
#   bash scripts/swarm/12-label-nodes.sh <tên-máy-2> <tên-máy-3>
# Nhãn machine=m1/m2/m3 quyết định thành phần nào chạy ở máy nào (mỗi máy giữ 1 bản của mỗi thành phần).
# ============================================================
set -euo pipefail
SELF=$(docker info --format '{{.Swarm.NodeID}}')
if [ $# -ge 2 ]; then
  N2=$(docker node inspect "$1" --format '{{.ID}}'); N3=$(docker node inspect "$2" --format '{{.ID}}')
else
  mapfile -t OTHERS < <(docker node ls --format '{{.ID}} {{.Hostname}}' | grep -v "^$SELF" | sort -k2 | awk '{print $1}')
  [ "${#OTHERS[@]}" -ge 2 ] || { echo "Cụm mới có ${#OTHERS[@]} máy khác (cần 2). Chờ hai máy kia chạy 11-join-cluster.sh."; exit 1; }
  N2=${OTHERS[0]}; N3=${OTHERS[1]}
fi
docker node update --label-add machine=m2 "$N2" >/dev/null
docker node update --label-add machine=m3 "$N3" >/dev/null
echo "== Các máy trong cụm"
docker node ls --format '{{.ID}}' | while read -r id; do
  docker node inspect "$id" --format '   {{.Spec.Labels.machine}}  {{.Description.Hostname}}  {{.Status.Addr}}  {{.Status.State}}  {{.ManagerStatus.Reachability}}'
done
echo
echo "Đủ 3 dòng m1, m2, m3 trạng thái ready, reachable: cụm đã sẵn sàng. Bước tiếp: triển khai hệ thống (docs/16 bước 5)."
