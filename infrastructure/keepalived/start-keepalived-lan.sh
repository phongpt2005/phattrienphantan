#!/bin/sh
# Cụm 3 máy: Keepalived giữ một ĐỊA CHỈ ẢO trên mạng LAN (dùng khi ba máy ngồi chung một Wi-Fi/LAN lúc demo).
# Chạy trên mạng của máy (host network). Client chỉ cần nhớ http://<LAN_VIP>:8000; máy đang giữ địa chỉ chết thì
# máy khác nhận địa chỉ sau vài giây. Cổng 8000 trên máy nào cũng tới được gateway (routing mesh của Swarm).
#   LAN_VIP     địa chỉ ảo, vd 192.168.1.250 (chọn địa chỉ trống trong mạng, ngoài dải DHCP nếu được)
#   LAN_PEERS   địa chỉ LAN của cả 3 máy, cách nhau dấu phẩy
#   PRIORITY    ưu tiên của máy này (máy ưu tiên cao giữ địa chỉ khi khỏe)
#   VRRP_PASS   mật khẩu VRRP (8 ký tự đầu)
# Không đặt LAN_VIP (đang làm việc ở xa nhau qua Tailscale): chỉ chờ, không làm gì.
set -eu
if [ -z "${LAN_VIP:-}" ]; then
  echo "start-keepalived-lan: chưa đặt LAN_VIP, không giữ địa chỉ ảo LAN"
  exec sleep infinity
fi
rm -rf /run/keepalived /run/keepalived.pid /run/vrrp.pid /run/checkers.pid /run/bfd.pid
# Giao diện và địa chỉ của máy này: giao diện có địa chỉ nằm trong LAN_PEERS
MYIP=""; IF=""
for p in $(echo "$LAN_PEERS" | tr ',' ' '); do
  i=$(ip -o -4 addr show | awk -v ip="$p" '{split($4,a,"/"); if (a[1]==ip) print $2}' | head -1)
  if [ -n "$i" ]; then MYIP=$p; IF=$i; fi
done
[ -n "$MYIP" ] || { echo "start-keepalived-lan: máy này không có địa chỉ nào trong LAN_PEERS ($LAN_PEERS)"; exec sleep infinity; }
PREFIX=$(ip -o -4 addr show dev "$IF" | awk '{split($4,a,"/"); print a[2]; exit}')
PASS8=$(printf '%s' "$VRRP_PASS" | cut -c1-8)
PEERS=$(echo "$LAN_PEERS" | tr ',' '\n' | grep -v "^$MYIP\$" | sed 's/^/    /')
mkdir -p /etc/keepalived
cat > /etc/keepalived/keepalived.conf <<EOF
global_defs {
  enable_script_security
  script_user root
}
vrrp_script chk_gateway {
  script "/usr/bin/curl -s -m 2 -o /dev/null -f http://127.0.0.1:8000/health"
  interval 2
  fall 2
  rise 1
}
vrrp_instance LAN_GATEWAY {
  state BACKUP
  interface $IF
  virtual_router_id 52
  priority $PRIORITY
  advert_int 1
  unicast_src_ip $MYIP
  unicast_peer {
$PEERS
  }
  authentication {
    auth_type PASS
    auth_pass $PASS8
  }
  virtual_ipaddress {
    $LAN_VIP/$PREFIX dev $IF
  }
  track_script {
    chk_gateway
  }
}
EOF
echo "start-keepalived-lan: $IF $MYIP, địa chỉ ảo $LAN_VIP, ưu tiên $PRIORITY"
exec keepalived -n -l -D -f /etc/keepalived/keepalived.conf
