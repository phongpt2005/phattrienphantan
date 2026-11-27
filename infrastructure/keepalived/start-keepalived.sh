#!/bin/sh
# Một bộ cân bằng tải trước gateway: HAProxy (cổng 80, chia cho nginx và nginx-2) + Keepalived giữ VIP.
#   VIP        địa chỉ ảo, ví dụ 172.28.255.10
#   PEER       tên bộ cân bằng còn lại (ví dụ keepalived-2)
#   PRIORITY   ưu tiên VRRP (bản ưu tiên cao giữ VIP khi cả hai khỏe)
#   VRRP_PASS  mật khẩu VRRP (lấy 8 ký tự đầu)
# VRRP gửi unicast tới PEER (không dựa vào multicast trên bridge). VIP chuyển khi bộ này không còn chuyển được yêu
# cầu tới gateway nào (kiểm /health qua chính HAProxy của nó) hoặc container này dừng.
# PEER đổi địa chỉ (bị tạo lại) thì thoát để được khởi động lại với cấu hình mới (restart: unless-stopped).
set -eu
IF=$(ip -o -4 addr show | awk '$4 ~ /^172\.28\./ && $4 !~ /\/32$/ {print $2; exit}')
MYIP=$(ip -o -4 addr show dev "$IF" | awk '$4 !~ /\/32$/ {sub(/\/.*/, "", $4); print $4; exit}')
PEERIP=""
for i in $(seq 1 30); do
  PEERIP=$(getent hosts "$PEER" | awk '{print $1; exit}' || true)
  [ -n "$PEERIP" ] && break
  sleep 2
done
[ -n "$IF" ] && [ -n "$MYIP" ] || { echo "start-keepalived: không thấy giao diện mạng 172.28.x"; exit 1; }
[ -n "$PEERIP" ] || { echo "start-keepalived: chưa phân giải được $PEER, thử lại sau"; exit 1; }
PASS8=$(printf '%s' "$VRRP_PASS" | cut -c1-8)

# Tệp pid cũ: container được restart policy bật lại trên cùng hệ thống tệp. Nếu lần trước bị giết (docker kill, hoặc
# script này thoát trước khi keepalived kịp dọn), keepalived thấy pid cũ trùng một tiến trình mới, báo "daemon is already
# running" rồi thoát, container khởi động lại mãi (gặp 2026-11-27). Lúc này chưa có keepalived/HAProxy nào chạy.
rm -rf /run/keepalived /run/keepalived.pid /run/vrrp.pid /run/checkers.pid /run/bfd.pid /run/haproxy.pid

haproxy -f /etc/haproxy/gateway-lb.cfg -D -p /run/haproxy.pid

mkdir -p /etc/keepalived   # gói keepalived của Alpine không tạo sẵn thư mục này
cat > /etc/keepalived/keepalived.conf <<EOF
global_defs {
  enable_script_security
  script_user root
}
vrrp_script chk_gateway {
  script "/usr/bin/curl -s -m 2 -o /dev/null -f http://127.0.0.1:80/health"
  interval 2
  fall 2
  rise 1
}
vrrp_instance GATEWAY {
  state BACKUP
  interface $IF
  virtual_router_id 51
  priority $PRIORITY
  advert_int 1
  unicast_src_ip $MYIP
  unicast_peer {
    $PEERIP
  }
  authentication {
    auth_type PASS
    auth_pass $PASS8
  }
  virtual_ipaddress {
    $VIP/16 dev $IF
  }
  track_script {
    chk_gateway
  }
}
EOF
echo "start-keepalived: giao diện $IF, địa chỉ $MYIP, bên kia $PEER=$PEERIP, VIP $VIP, ưu tiên $PRIORITY"

keepalived -n -l -D -f /etc/keepalived/keepalived.conf &
KPID=$!
# Dừng keepalived và CHỜ nó thoát (nhả VIP, xóa tệp pid) rồi mới thoát container
stop_and_exit() { echo "start-keepalived: $1"; kill "$KPID" 2>/dev/null; wait "$KPID" 2>/dev/null || true; exit 1; }
while kill -0 "$KPID" 2>/dev/null; do
  sleep 3
  kill -0 "$(cat /run/haproxy.pid)" 2>/dev/null || stop_and_exit "HAProxy dừng, thoát"
  NOW=$(getent hosts "$PEER" | awk '{print $1; exit}' || true)
  if [ -n "$NOW" ] && [ "$NOW" != "$PEERIP" ]; then stop_and_exit "$PEER đổi địa chỉ $PEERIP -> $NOW, thoát để cấu hình lại"; fi
done
echo "start-keepalived: keepalived dừng"
exit 1
