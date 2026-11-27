#!/usr/bin/env python3
"""
P2 N2: canh bản chép slot logic trên bản sao Patroni (chạy nền trong mỗi node Patroni).

Vấn đề (đã gặp 2026-11-26, hr-failover-test lượt 1): Patroni 4.0.6 chép slot logic cố định (dbz_hr_outbox) từ máy
chính sang bản sao, rồi đẩy vị trí bằng pg_replication_slot_advance. Nếu bản sao được dựng (pg_basebackup) lúc
restart_lsn của slot trên máy chính CŨ HƠN điểm bắt đầu WAL của bản sao (ví dụ Debezium đang tạm dừng hoặc đứt mạng),
bản chép trỏ vào đoạn WAL mà bản sao không bao giờ có: không đẩy được ("requested WAL segment ... has already been
removed"), nhưng Patroni vẫn báo "safe to be used after a failover". Chuyển máy chính lúc đó thì Debezium kẹt,
sự kiện CDC dừng lại.

Cách xử lý của bộ canh, mỗi INTERVAL giây, chỉ khi node đang là bản sao:
  - Với mỗi slot logic cố định (đọc từ GET /config của Patroni), so đoạn WAL cần cho restart_lsn của bản chép
    với đoạn WAL cũ nhất còn trên bản sao.
  - Bản chép dùng được: ghi trạng thái ok.
  - Không dùng được, và slot trên máy chính đã đi tới đoạn WAL mà bản sao có: bỏ bản chép để Patroni chép lại
    (Patroni tự chép slot cố định còn thiếu).
  - Không dùng được, và slot trên máy chính vẫn cũ hơn: chưa sửa được (chép lại cũng hỏng); ghi trạng thái
    UNSAFE để giám sát cảnh báo; tự hết khi bên đọc slot (Debezium) đọc tiếp.
Trạng thái ghi ở /tmp/slot-guard.json (bài kiểm và giám sát đọc). Lỗi của bộ canh không ảnh hưởng Patroni.
"""
import json
import logging
import os
import time
import urllib.request

import psycopg2

INTERVAL = int(os.environ.get("SLOT_GUARD_INTERVAL", "15"))
STATUS_FILE = os.environ.get("SLOT_GUARD_STATUS", "/tmp/slot-guard.json")
SUPERUSER = os.environ.get("PATRONI_SUPERUSER_USERNAME", "postgres")
SUPERPASS = os.environ.get("PATRONI_SUPERUSER_PASSWORD", "")
REST = "http://127.0.0.1:8008"

logging.basicConfig(level=logging.INFO, format="%(asctime)s slot-guard %(levelname)s: %(message)s")
log = logging.getLogger("slot-guard")


def rest(path):
    with urllib.request.urlopen(REST + path, timeout=3) as r:
        return json.loads(r.read().decode())


def write_status(state):
    state["at"] = int(time.time())
    tmp = STATUS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATUS_FILE)


def segno_of_walfile(name):
    # Tên tệp WAL: 8 ký tự timeline + 8 ký tự log + 8 ký tự đoạn; mặc định 256 đoạn 16 MB mỗi log
    return int(name[8:16], 16) * 256 + int(name[16:24], 16)


def check_once():
    me = rest("/patroni")
    if me.get("role") != "replica":
        write_status({"role": me.get("role"), "slots": {}})
        return
    cfg = rest("/config")
    wanted = {n: v for n, v in (cfg.get("slots") or {}).items() if (v or {}).get("type") == "logical"}
    if not wanted:
        write_status({"role": "replica", "slots": {}})
        return
    local = psycopg2.connect(host="/var/run/postgresql", user=SUPERUSER, dbname="postgres")
    local.autocommit = True
    out = {}
    try:
        cur = local.cursor()
        cur.execute("select setting::bigint from pg_settings where name='wal_segment_size'")
        seg_size = cur.fetchone()[0]
        cur.execute("select min(name) from pg_ls_waldir() where name ~ '^[0-9A-F]{24}$'")
        oldest = cur.fetchone()[0]
        if not oldest:
            return
        oldest_seg = segno_of_walfile(oldest)
        cur.execute(
            "select slot_name, pg_wal_lsn_diff(restart_lsn, '0/0')::bigint from pg_replication_slots "
            "where slot_type='logical' and restart_lsn is not null"
        )
        have = dict(cur.fetchall())
        for name in wanted:
            if name not in have:
                out[name] = "missing"  # Patroni sẽ chép
                continue
            need_seg = have[name] // seg_size
            if need_seg >= oldest_seg:
                out[name] = "ok"
                continue
            leader = next((m for m in rest("/cluster").get("members", []) if m.get("role") == "leader"), None)
            if not leader:
                out[name] = "unusable-no-leader"
                continue
            db = wanted[name].get("database", "postgres")
            pc = psycopg2.connect(host=leader["host"], port=leader.get("port", 5432), user=SUPERUSER,
                                  password=SUPERPASS, dbname=db, connect_timeout=3)
            try:
                pcur = pc.cursor()
                pcur.execute(
                    "select pg_wal_lsn_diff(restart_lsn, '0/0')::bigint from pg_replication_slots where slot_name=%s",
                    (name,),
                )
                row = pcur.fetchone()
            finally:
                pc.close()
            if row and row[0] is not None and row[0] // seg_size >= oldest_seg:
                log.warning("bản chép slot %s cần đoạn WAL %X nhưng đoạn cũ nhất còn là %X; máy chính đã đi tới đoạn %X: "
                            "bỏ bản chép để Patroni chép lại", name, need_seg, oldest_seg, row[0] // seg_size)
                cur.execute("select pg_drop_replication_slot(%s)", (name,))
                out[name] = "recopy"
            else:
                log.error("bản chép slot %s không dùng được và slot trên máy chính vẫn cũ hơn WAL của bản sao: "
                          "chuyển máy chính lúc này sẽ làm CDC kẹt (chờ bên đọc slot đọc tiếp)", name)
                out[name] = "UNSAFE"
    finally:
        local.close()
    write_status({"role": "replica", "slots": out})


def main():
    log.info("bắt đầu, chu kỳ %s giây", INTERVAL)
    time.sleep(INTERVAL)
    while True:
        try:
            check_once()
        except Exception as e:  # node đang khởi động, CSDL chưa sẵn sàng, mất mạng...
            log.info("bỏ qua lượt này: %s", e)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
