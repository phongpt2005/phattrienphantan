#!/usr/bin/env bash
# ============================================================
# BƯỚC 3 (chạy trên MÁY 2 và MÁY 3): tham gia cụm do máy 1 tạo.
#   bash scripts/swarm/11-join-cluster.sh <TOKEN> <địa chỉ Tailscale của máy 1>
# Lệnh đầy đủ do 10-init-cluster.sh in ra ở máy 1.
# ============================================================
set -euo pipefail
TOKEN="${1:?thiếu token (lấy từ máy 1)}"
MANAGER="${2:?thiếu địa chỉ Tailscale của máy 1}"
TSIP=$(tailscale ip -4 | head -1)
echo "== Kiểm tra đường tới máy 1 ($MANAGER) qua Tailscale"
ping -c 2 -W 2 "$MANAGER" >/dev/null && echo "   OK thấy máy 1" || { echo "   KHÔNG thấy máy 1: kiểm tra 'tailscale status' ở cả hai máy"; exit 1; }
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = active ]; then
  echo "   Máy này đã ở trong một cụm Swarm"; exit 0
fi
docker swarm join --advertise-addr "$TSIP" --data-path-addr "$TSIP" --listen-addr "$TSIP:2377" --token "$TOKEN" "$MANAGER:2377"
echo "== Xong. Báo người dựng cụm chạy 12-label-nodes.sh ở máy 1."
