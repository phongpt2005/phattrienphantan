#!/usr/bin/env bash
# ============================================================
# BƯỚC 2 (chỉ chạy trên MÁY 1, người dựng cụm): tạo cụm Docker Swarm.
#   bash scripts/swarm/10-init-cluster.sh
# Làm: swarm init trên địa chỉ Tailscale, dựng lại mạng ingress và tạo mạng overlay dms-net với MTU hợp với Tailscale,
# gắn nhãn máy m1, chạy kho image nội bộ (registry) để 2 máy kia kéo image, in lệnh cho 2 máy kia tham gia.
# ============================================================
set -euo pipefail
say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32mOK\033[0m %s\n' "$*"; }

TSIP=$(tailscale ip -4 | head -1)
# Tailscale dùng MTU 1280; gói VXLAN của overlay thêm 50 byte, nên mạng overlay phải nhỏ hơn: 1230
MTU=1230

say "1. Tạo cụm Swarm trên $TSIP"
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = active ]; then
  ok "máy này đã ở trong một cụm Swarm"
else
  docker swarm init --advertise-addr "$TSIP" --data-path-addr "$TSIP" --listen-addr "$TSIP:2377"
fi

say "2. Mạng ingress và overlay (MTU $MTU)"
if [ "$(docker network inspect ingress --format '{{index .Options "com.docker.network.driver.mtu"}}' 2>/dev/null)" != "$MTU" ]; then
  if [ -n "$(docker service ls -q)" ]; then
    echo "   Đã có service đang chạy: không dựng lại ingress (xóa service trước nếu cần)."
  else
    echo y | docker network rm ingress >/dev/null
    for i in $(seq 1 20); do docker network inspect ingress >/dev/null 2>&1 || break; sleep 1; done
    docker network create --driver overlay --ingress --opt com.docker.network.driver.mtu=$MTU ingress >/dev/null
    ok "đã dựng lại ingress với MTU $MTU"
  fi
else
  ok "ingress đã đúng MTU"
fi
docker network inspect dms-net >/dev/null 2>&1 || \
  docker network create --driver overlay --attachable --opt com.docker.network.driver.mtu=$MTU dms-net >/dev/null
ok "mạng dms-net"

say "3. Gắn nhãn máy m1"
docker node update --label-add machine=m1 "$(docker info --format '{{.Swarm.NodeID}}')" >/dev/null
ok "máy này là m1"

say "4. Kho image nội bộ (registry) cho cả cụm"
# Cổng 5000 công bố qua routing mesh: trên máy nào, 127.0.0.1:5000 cũng tới registry, và Docker cho phép 127.0.0.1
# không cần TLS. Nhờ vậy 2 máy kia kéo được image build ở máy 1 mà không cần cấu hình gì thêm.
if ! docker service inspect registry >/dev/null 2>&1; then
  docker service create --name registry --publish published=5000,target=5000 \
    --constraint node.labels.machine==m1 --mount type=volume,source=registry-data,target=/var/lib/registry \
    registry:2 >/dev/null
fi
ok "registry tại 127.0.0.1:5000"

say "5. Lệnh cho MÁY 2 và MÁY 3 (gửi riêng cho từng người, đừng đăng công khai)"
# Tham gia với vai trò manager: 3 manager thì cụm vẫn điều khiển được khi mất 1 máy (quorum 2/3)
TOKEN=$(docker swarm join-token -q manager)
echo
echo "   bash scripts/swarm/11-join-cluster.sh $TOKEN $TSIP"
echo
echo "Sau khi 2 máy kia tham gia xong, chạy:  bash scripts/swarm/12-label-nodes.sh"
