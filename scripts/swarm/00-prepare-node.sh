#!/usr/bin/env bash
# ============================================================
# BƯỚC 1 (chạy trên CẢ 3 MÁY, trong máy ảo Ubuntu 22.04/24.04):
#   cài Docker Engine, Tailscale, mở cổng cho Docker Swarm, kiểm tra tài nguyên.
#   curl -fsSL https://raw.githubusercontent.com/phongpt2005/phattrienphantan/nghiem-thu/scripts/swarm/00-prepare-node.sh | bash
#   hoặc sau khi clone repo:  bash scripts/swarm/00-prepare-node.sh
# Chạy lại nhiều lần không sao (bước nào xong rồi thì bỏ qua).
# ============================================================
set -euo pipefail
say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32mOK\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33mCHÚ Ý\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] && SUDO="" || SUDO="sudo"

say "1. Kiểm tra tài nguyên máy"
MEM_GB=$(awk '/MemTotal/ {printf "%.1f", $2/1024/1024}' /proc/meminfo)
DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
CPUS=$(nproc)
echo "   RAM: ${MEM_GB} GB | CPU: ${CPUS} luồng | ổ trống: ${DISK_GB} GB"
awk -v m="$MEM_GB" 'BEGIN{exit !(m < 5.5)}' && warn "RAM dưới 6 GB: nên cấp cho máy ảo 6-8 GB" || ok "RAM đủ"
[ "$DISK_GB" -lt 25 ] && warn "Ổ trống dưới 25 GB: image và dữ liệu cần khoảng 20-25 GB" || ok "Ổ đĩa đủ"

say "2. Cài Docker Engine"
if command -v docker >/dev/null 2>&1; then
  ok "đã có $(docker --version)"
else
  curl -fsSL https://get.docker.com | $SUDO sh
  ok "đã cài $(docker --version)"
fi
$SUDO usermod -aG docker "${SUDO_USER:-$USER}" || true
$SUDO systemctl enable --now docker

say "3. Cài Tailscale (mạng riêng nối 3 máy khi ở xa nhau)"
if command -v tailscale >/dev/null 2>&1; then
  ok "đã có tailscale"
else
  curl -fsSL https://tailscale.com/install.sh | $SUDO sh
fi
if ! tailscale ip -4 >/dev/null 2>&1; then
  echo "   Mở đường link hiện ra dưới đây và đăng nhập CÙNG MỘT tài khoản Tailscale cho cả 3 máy (nhóm dùng chung 1 tài khoản)."
  $SUDO tailscale up --hostname "dms-$(hostname)"
fi
TSIP=$(tailscale ip -4 | head -1)
ok "địa chỉ Tailscale của máy này: $TSIP"

say "4. Cấu hình mạng cho Docker Swarm"
# Swarm dùng 2377/tcp (quản lý), 7946/tcp+udp (trao đổi giữa node), 4789/udp (mạng overlay)
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q active; then
  for p in 2377/tcp 7946/tcp 7946/udp 4789/udp 8000/tcp 3001/tcp; do $SUDO ufw allow "$p" >/dev/null; done
  $SUDO ufw allow proto vrrp from any >/dev/null 2>&1 || $SUDO ufw allow 112 >/dev/null 2>&1 || true
  ok "đã mở cổng trên ufw"
else
  ok "ufw không bật, không cần mở cổng"
fi
# Vùng nhớ ánh xạ cho Kafka; cho phép Keepalived giữ địa chỉ ảo LAN chưa gắn vào máy
echo 'vm.max_map_count=262144' | $SUDO tee /etc/sysctl.d/99-dms.conf >/dev/null
echo 'net.ipv4.ip_nonlocal_bind=1' | $SUDO tee -a /etc/sysctl.d/99-dms.conf >/dev/null
$SUDO sysctl --system >/dev/null
ok "sysctl đã đặt"

say "5. Thông tin gửi cho người dựng cụm (máy 1)"
LANIP=$(ip -o -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
echo "   Tên máy:          $(hostname)"
echo "   Địa chỉ Tailscale: $TSIP"
echo "   Địa chỉ LAN:       ${LANIP:-không rõ}"
echo "   RAM / CPU / ổ:     ${MEM_GB} GB / ${CPUS} luồng / ${DISK_GB} GB"
echo
echo "Xong bước 1. Đăng xuất rồi đăng nhập lại (để dùng docker không cần sudo), sau đó làm bước tiếp theo trong docs/16."
