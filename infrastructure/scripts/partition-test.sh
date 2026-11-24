#!/usr/bin/env bash
# ============================================================
# RUNBOOK NGHIỆM THU: phòng ban tự trị khi đứt mạng và tự hội tụ khi phục hồi (feature 2).
#   bash infrastructure/scripts/partition-test.sh
#
# Cắt THẬT đường lên của phòng HR (dms-network), giữ mạng riêng dms-site-hr (DB, MinIO, node, edge).
# Nhân viên làm việc qua cổng nội bộ http://localhost:3001 (hr-site-edge).
# Đo: backlog WAL chưa gửi, thời gian node bị đánh dấu DEGRADED, thời gian hội tụ, không mất dữ liệu,
# sự kiện cũ không ghi đè sự kiện mới (source_version).
# Chỉ thay đổi trạng thái mạng của HR; cuối cùng luôn nối lại (kể cả khi lỗi giữa chừng).
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
E=http://localhost:3001
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
CEN() { docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
HRDB() { docker exec postgres-hr-primary psql -U "$POSTGRES_HR_USER" -d "$POSTGRES_HR_DB" -tAc "$1"; }
RECONNECT_DONE=0
reconnect() {
  [ "$RECONNECT_DONE" = 1 ] && return
  docker network connect dms-network dept-hr 2>/dev/null
  docker network connect dms-network postgres-hr-primary 2>/dev/null
  RECONNECT_DONE=1
}
trap 'reconnect' EXIT INT TERM

STAMP=$(date +%s)
S="$(mktemp -d)"
W="$(cygpath -m "$S" 2>/dev/null || echo "$S")"

echo "== 0. Điều kiện ban đầu =="
chk "node HR khỏe qua cổng nội bộ" "$(curl -s -m 8 -o /dev/null -w '%{http_code}' $E/health)" 200
chk "slot Debezium của HR đang hoạt động" "$(HRDB "select active from pg_replication_slots where slot_name='dbz_hr_outbox'")" t
chk "trung tâm thấy HR ACTIVE" "$(CEN "select lifecycle from department where dept_code='HR'")" ACTIVE

echo "== 1. Pha 1: CẮT MẠNG (partition) =="
T_CUT=$(date +%s)
docker network disconnect dms-network dept-hr
docker network disconnect dms-network postgres-hr-primary
sleep 3
TOKEN=$(curl -s -m 15 -X POST $E/auth/login -H 'content-type: application/json' -d "{\"username\":\"hr_manager\",\"password\":\"$DEMO_MANAGER_PASSWORD\"}" | python -I -c "import sys,json;print(json.load(sys.stdin).get('accessToken',''))")
[ -n "$TOKEN" ] && ok "đăng nhập cục bộ khi đứt mạng" || bad "đăng nhập cục bộ khi đứt mạng thất bại"

TITLES=()
for i in 1 2 3; do
  T="Tai lieu dut mang $STAMP-$i"; TITLES+=("$T")
  printf 'Noi dung tao khi dut mang %s-%s\n' "$STAMP" "$i" > "$S/f$i.txt"
  CODE=$(curl -s -m 20 -o "$W/d$i.json" -w '%{http_code}' -X POST $E/documents -H "Authorization: Bearer $TOKEN" -F "title=$T" -F "description=kiem thu dut mang" -F "accessLevel=DEPARTMENT" -F "file=@$W/f$i.txt;type=text/plain")
  [ "$CODE" = 201 ] || [ "$CODE" = 200 ] && ok "tạo tài liệu $i khi đứt mạng (HTTP $CODE)" || bad "tạo tài liệu $i khi đứt mạng (HTTP $CODE)"
done
DOC1=$(python -I -c "import json;print(json.load(open(r'$W/d1.json'))['docId'])" 2>/dev/null)
SH=$(curl -s -m 15 -o "$W/sh.json" -w '%{http_code}' -X POST $E/shares -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"docId\":$DOC1,\"sharedWithDept\":\"ACC\",\"permission\":\"VIEW\",\"expiresInDays\":1}")
[ "$SH" = 201 ] || [ "$SH" = 200 ] && ok "cấp chia sẻ cho ACC khi đứt mạng (HTTP $SH)" || bad "cấp chia sẻ khi đứt mạng (HTTP $SH)"

sleep 5
MODE=$(curl -s -m 10 $E/sync/status | python -I -c "import sys,json;print(json.load(sys.stdin)['mode'])" 2>/dev/null)
chk "trạng thái tự trị tại node" "$MODE" OFFLINE
BACKLOG=$(HRDB "select pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint from pg_replication_slots where slot_name='dbz_hr_outbox'")
ROWS=$(HRDB "select count(*) from outbox where occurred_at >= to_timestamp($T_CUT)")
echo "  backlog WAL chưa gửi lúc đứt mạng: ${BACKLOG:-?} byte; sự kiện outbox ghi trong thời gian đứt mạng: ${ROWS:-?}"
chk "outbox ghi đủ sự kiện của thời gian đứt mạng (>= 4 = 3 tài liệu + 1 chia sẻ)" "$([ "${ROWS:-0}" -ge 4 ] && echo ok || echo thieu)" ok

echo "  chờ trung tâm đánh dấu node DEGRADED (đo thời gian phát hiện)..."
for i in $(seq 1 60); do [ "$(CEN "select lifecycle from department where dept_code='HR'")" = DEGRADED ] && break; sleep 2; done
T_DET=$(date +%s)
chk "trung tâm phát hiện node mất kết nối" "$(CEN "select lifecycle from department where dept_code='HR'")" DEGRADED
echo "  thời gian phát hiện: $((T_DET - T_CUT)) giây (ngưỡng mất nhịp tim 30 giây)"

echo "== 2. Pha 2: KHÔI PHỤC KẾT NỐI (healing) =="
T0=$(date +%s)
reconnect
echo "  nối lại lúc T0 (ghi nhận)"

echo "== 3. Pha 3: XÁC THỰC HỘI TỤ & ĐỘ TRỄ =="
for i in $(seq 1 60); do [ "$(HRDB "select active from pg_replication_slots where slot_name='dbz_hr_outbox'")" = t ] && break; sleep 2; done
chk "slot Debezium hoạt động lại" "$(HRDB "select active from pg_replication_slots where slot_name='dbz_hr_outbox'")" t

for i in $(seq 1 90); do [ "$(CEN "select lifecycle from department where dept_code='HR'")" = ACTIVE ] && break; sleep 2; done
T_ACTIVE=$(date +%s)
chk "Registry tự kích hoạt lại node HR (không cần khởi động lại Gateway)" "$(CEN "select lifecycle from department where dept_code='HR'")" ACTIVE
echo "  Registry ACTIVE sau: $((T_ACTIVE - T0)) giây kể từ T0"

for i in $(seq 1 120); do
  N=$(CEN "select count(*) from search_document s join department d using(department_id) where d.dept_code='HR' and s.title like 'Tai lieu dut mang $STAMP-%'")
  [ "$N" = 3 ] && break; sleep 2
done
T_CONV=$(date +%s)
chk "không mất dữ liệu: đủ 3/3 tài liệu tạo khi đứt mạng ở chỉ mục trung tâm" "$N" 3
echo "  T_detected (trung tâm thấy đủ dữ liệu) - T0 = T_convergence: $((T_CONV - T0)) giây"

SHARE_OK=$(CEN "select count(*) from search_document s join department d using(department_id), jsonb_array_elements(s.shares) x where d.dept_code='HR' and s.title='${TITLES[0]}' and x->>'sharedWith'='ACC' and (x->>'revoked')::boolean=false")
chk "chia sẻ khi đứt mạng đã hội tụ về bản sao trung tâm (sổ chia sẻ)" "$SHARE_OK" 1

echo "== 4. Kiểm tra thứ tự phiên bản (source_version không bị ghi đè bởi sự kiện cũ) =="
CUR_VER=$(CEN "select s.source_version from search_document s join department d using(department_id) where d.dept_code='HR' and s.title='${TITLES[0]}'")
DOCID=$(CEN "select s.source_doc_id from search_document s join department d using(department_id) where d.dept_code='HR' and s.title='${TITLES[0]}'")
STALE_TITLE="STALE-$STAMP"
printf '%s|{"documentId":%s,"departmentCode":"HR","title":"%s","status":"PUBLISHED","rowVersion":%s,"deleted":false,"accessLevel":"DEPARTMENT","tags":[],"shares":[]}\n' "$DOCID" "$DOCID" "$STALE_TITLE" "$(( ${CUR_VER:-1} - 1 ))" \
  | MSYS_NO_PATHCONV=1 docker run --rm -i --network dms-network -e KAFKA_HEAP_OPTS="-Xmx96m" --entrypoint /opt/kafka/bin/kafka-console-producer.sh apache/kafka:3.7.0 \
      --bootstrap-server kafka-1:9092,kafka-2:9092,kafka-3:9092 --topic dms.dept.hr.document --property parse.key=true --property key.separator='|' >/dev/null 2>&1
sleep 8
chk "sự kiện cũ (rowVersion thấp hơn) bị bỏ qua, tiêu đề không bị ghi đè" "$(CEN "select count(*) from search_document where source_doc_id=$DOCID and title like 'STALE-%'")" 0
chk "source_version vẫn là phiên bản mới nhất" "$(CEN "select source_version from search_document s join department d using(department_id) where d.dept_code='HR' and s.source_doc_id=$DOCID")" "$CUR_VER"

echo
echo "===== KẾT QUẢ RUNBOOK: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
