#!/bin/sh
# Node Patroni: bộ canh slot logic chạy nền (lỗi của nó không ảnh hưởng Patroni), Patroni là tiến trình chính.
# init: true trong compose (tini) thu dọn tiến trình con.
python3 /usr/local/bin/slot-guard.py &
exec patroni /etc/patroni/patroni.yml
