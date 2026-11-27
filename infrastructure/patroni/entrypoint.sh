#!/bin/sh
# Node Patroni: bộ canh slot logic chạy nền (lỗi của nó không ảnh hưởng Patroni), Patroni là tiến trình chính.
# init: true trong compose (tini) thu dọn tiến trình con.
# Có mẫu /etc/patroni/patroni.yml.tmpl (cụm 3 máy trên Swarm): thay ${BIẾN} bằng biến môi trường rồi chạy bản đã thay.
CFG=/etc/patroni/patroni.yml
if [ -f /etc/patroni/patroni.yml.tmpl ]; then
  python3 - <<'PY' > /tmp/patroni.yml
import os, string
print(string.Template(open('/etc/patroni/patroni.yml.tmpl').read()).safe_substitute(os.environ))
PY
  CFG=/tmp/patroni.yml
fi
python3 /usr/local/bin/slot-guard.py &
exec patroni "$CFG"
