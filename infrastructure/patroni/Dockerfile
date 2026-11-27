# P1 B2: PostgreSQL 16 + Patroni. Cùng nền image với CSDL cũ (postgres:16-alpine) để giữ nguyên collation.
FROM postgres:16-alpine
RUN apk add --no-cache python3 py3-pip py3-psycopg2 py3-psutil py3-yaml py3-urllib3 py3-dateutil py3-prettytable py3-click py3-dnspython \
 && pip3 install --no-cache-dir --break-system-packages "patroni[etcd3]==4.0.6"
COPY infrastructure/patroni/patroni.yml /etc/patroni/patroni.yml
# P2 N2: bộ canh bản chép slot logic trên bản sao (xem slot-guard.py)
COPY --chmod=755 infrastructure/patroni/slot-guard.py /usr/local/bin/slot-guard.py
COPY --chmod=755 infrastructure/patroni/entrypoint.sh /usr/local/bin/dms-patroni-entrypoint.sh
# Cụm 3 máy: khởi tạo CSDL ứng dụng và schema ở lần bootstrap đầu (xem patroni-cluster.yml.tmpl)
COPY --chmod=755 infrastructure/patroni/post-bootstrap.sh /usr/local/bin/dms-post-bootstrap.sh
USER postgres
ENTRYPOINT ["/usr/local/bin/dms-patroni-entrypoint.sh"]
