# P3 (bổ sung thành phần): lớp cân bằng tải trước 2 gateway nginx. Mỗi container chạy HAProxy (chia yêu cầu cho
# nginx và nginx-2, có kiểm sức khỏe) và Keepalived (giữ địa chỉ ảo VIP trên chính container này).
FROM alpine:3.20
RUN apk add --no-cache keepalived haproxy curl iproute2
COPY --chmod=755 infrastructure/keepalived/start-keepalived.sh /usr/local/bin/start-keepalived.sh
COPY infrastructure/keepalived/gateway-lb.cfg /etc/haproxy/gateway-lb.cfg
ENTRYPOINT ["/usr/local/bin/start-keepalived.sh"]
