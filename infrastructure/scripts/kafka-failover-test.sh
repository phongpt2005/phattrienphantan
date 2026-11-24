#!/usr/bin/env bash
# ============================================================
# P1 B1: kiểm chịu lỗi cụm Kafka 3 broker (bản gọn, KRaft, RF = 3, min.insync.replicas = 2)
#   bash infrastructure/scripts/kafka-failover-test.sh
#
# Ca kiểm (docs/11 mục 2.5):
#   1. Quorum KRaft đủ 3 voter và có leader; mọi topic RF = 3; không có partition thiếu bản sao.
#   2. Dừng 1 broker: topic min.insync=3 bị từ chối acks=all (NOT_ENOUGH_REPLICAS);
#      topic min.insync=2 vẫn ghi được; CDC đầu-cuối vẫn chạy (tài liệu mới vào Central Index).
#      Bật lại: hết partition thiếu bản sao.
#   3. Dừng 2 broker: mất quorum, ghi acks=all không có ack thành công (ghi lại mã lỗi thực tế).
#      Bật lại: quorum có leader, hết partition thiếu bản sao, CDC chạy lại.
#
# Công cụ quản trị Kafka chạy trong container tạm trên mạng dms-network, không exec vào broker:
# một JVM thứ hai bên trong broker có thể đẩy broker vượt giới hạn bộ nhớ 512 MB.
# Broker đã dừng luôn được bật lại khi script kết thúc, kể cả khi lỗi.
# Bài kiểm để lại hai tài liệu "Kiem thu failover Kafka ..." ở phòng HR (giống e2e).
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
NET="${KAFKA_NET:-dms-network}"
IMG="apache/kafka:3.7.0"
BS="kafka-1:9092,kafka-2:9092,kafka-3:9092"
T_MIN3="ha-minisr-test"
T_MIN2="ha-minisr2-test"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
jget() { python -I -X utf8 -c "import sys,json
try:
    d=json.load(sys.stdin)
    for k in '$1'.split('.'):
        d=d[int(k)] if k.isdigit() else d[k]
    print('' if d is None else d)
except Exception:
    print('')"; }

# Công cụ Kafka trong container tạm (heap nhỏ)
kt() { local tool=$1; shift
  MSYS_NO_PATHCONV=1 docker run --rm -i --network "$NET" -e KAFKA_HEAP_OPTS="-Xmx96m" \
    --entrypoint "/opt/kafka/bin/$tool" "$IMG" "$@"; }

STOPPED=""
stop_b()  { docker stop "$@" >/dev/null; STOPPED="$STOPPED $*"; }
start_b() { docker start "$@" >/dev/null; for b in "$@"; do STOPPED=$(echo " $STOPPED " | sed "s/ $b / /g"); done; }
restore() { local s; s=$(echo $STOPPED); if [ -n "$s" ]; then docker start $s >/dev/null; echo "  khôi phục: đã bật lại $s"; STOPPED=""; fi; }
trap restore EXIT

wait_healthy() {
  for _ in $(seq 1 40); do
    local all=1
    for b in "$@"; do [ "$(docker inspect -f '{{.State.Health.Status}}' "$b" 2>/dev/null)" = healthy ] || all=0; done
    [ "$all" = 1 ] && return 0; sleep 3
  done; return 1; }

quorum() { kt kafka-metadata-quorum.sh --bootstrap-server "$BS" describe --status 2>/dev/null; }
voters() { quorum | sed -n 's/^CurrentVoters:[[:space:]]*\[\(.*\)\]/\1/p' | tr ',' '\n' | grep -c '[0-9]'; }
leader() { quorum | sed -n 's/^LeaderId:[[:space:]]*\([-0-9]*\).*/\1/p'; }
urp()    { kt kafka-topics.sh --bootstrap-server "$BS" --describe --under-replicated-partitions 2>/dev/null | grep -c 'Partition:'; }
wait_urp0() { for _ in $(seq 1 30); do [ "$(urp)" = 0 ] && return 0; sleep 4; done; return 1; }
end_offset() { kt kafka-get-offsets.sh --bootstrap-server "$BS" --topic "$1" --time -1 2>/dev/null | awk -F: '{s+=$3} END {print s+0}'; }
# Gửi 1 tin với acks=all, in toàn bộ đầu ra và dòng cuối "rc=<mã thoát>" (lỗi nằm trong đầu ra).
# Giới hạn cứng PRODUCE_LIMIT giây: producer Java có thể kẹt vô hạn khi phân giải tên broker đã dừng
# (đã gặp: treo 34 phút khi mất quorum), nên container được đặt tên và bị dừng khi hết giờ (rc=137).
PRODUCE_LIMIT=60
produce() {
  local name="kfo-prod-$$-$RANDOM" out rc killer
  ( sleep "$PRODUCE_LIMIT"; docker kill "$name" >/dev/null 2>&1 ) & killer=$!
  out=$(echo "msg-$(date +%s%N)" | MSYS_NO_PATHCONV=1 docker run --rm -i --name "$name" --network "$NET" \
    -e KAFKA_HEAP_OPTS="-Xmx96m" --entrypoint /opt/kafka/bin/kafka-console-producer.sh "$IMG" \
    --bootstrap-server "$BS" --topic "$1" \
    --producer-property acks=all --producer-property request.timeout.ms=5000 \
    --producer-property delivery.timeout.ms=20000 --producer-property max.block.ms=15000 2>&1); rc=$?
  kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
  printf '%s\nrc=%s\n' "$out" "$rc"; }
connectors_running() { docker exec debezium curl -s 'http://localhost:8083/connectors?expand=status' 2>/dev/null \
  | python -I -X utf8 -c "import sys,json
try:
    d=json.load(sys.stdin); print(sum(1 for v in d.values() if v['status']['connector']['state']=='RUNNING' and all(t['state']=='RUNNING' for t in v['status']['tasks'])))
except Exception:
    print(0)"; }

search(){ curl -s -H "Authorization: Bearer $1" --get "$BASE/api/search" --data-urlencode "q=$2"; }
HR_MGR=$(curl -s -X POST "$BASE/api/dept/hr/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"hr_manager\",\"password\":\"$DEMO_MANAGER_PASSWORD\"}" | jget accessToken)

cdc_check() {  # tạo tài liệu tại node HR, chờ tài liệu vào Central Index (đi qua outbox -> Debezium -> Kafka -> projector)
  local label=$1 T W TITLE UP DOC t0 t1 found=""
  T=$(mktemp -d); W=$(cygpath -m "$T" 2>/dev/null || echo "$T")
  printf 'kiem thu failover kafka %s\n' "$(date +%s)" > "$W/f.txt"
  TITLE="Kiem thu failover Kafka $(date +%s%N)"
  UP=$(curl -s -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $HR_MGR" \
    -F "title=$TITLE" -F "description=kiem thu chiu loi Kafka" -F "accessLevel=DEPARTMENT" -F "file=@$W/f.txt;type=text/plain")
  DOC=$(echo "$UP" | jget docId)
  if [ -z "$DOC" ]; then bad "$label: tạo tài liệu lỗi"; rm -rf "$T"; return; fi
  t0=$(date +%s)
  for _ in $(seq 1 90); do found=$(search "$HR_MGR" "$TITLE" | jget data.0.central_doc_id); [ -n "$found" ] && break; sleep 1; done
  t1=$(date +%s)
  if [ -n "$found" ]; then ok "$label: tài liệu mới (docId=$DOC) vào Central Index sau $((t1-t0)) s"
  else bad "$label: Central Index chưa có tài liệu docId=$DOC sau 90 s"; fi
  rm -rf "$T"; }

[ -n "$HR_MGR" ] || { echo "Không đăng nhập được hr_manager"; exit 2; }

echo "== 1. Hiện trạng cụm =="
check "quorum KRaft có 3 voter" "$(voters)" 3
L=$(leader); [ -n "$L" ] && [ "$L" != "-1" ] && ok "quorum có leader (node $L)" || bad "quorum chưa có leader ('$L')"
DESC=$(kt kafka-topics.sh --bootstrap-server "$BS" --describe 2>/dev/null)
NTOP=$(echo "$DESC" | grep -c '^Topic:')
RFBAD=$(echo "$DESC" | grep '^Topic:' | grep -v 'ReplicationFactor: 3' | awk '{print $2}' | tr '\n' ' ')
[ "$NTOP" -gt 0 ] && ok "cụm có $NTOP topic" || bad "không đọc được danh sách topic"
check "mọi topic có RF = 3 (lệch: ${RFBAD:-không})" "$(echo "$RFBAD" | wc -w | tr -d ' ')" 0
check "không có partition thiếu bản sao" "$(urp)" 0
check "3 connector Debezium RUNNING" "$(connectors_running)" 3

kt kafka-topics.sh --bootstrap-server "$BS" --create --if-not-exists --topic "$T_MIN3" --partitions 1 --replication-factor 3 --config min.insync.replicas=3 >/dev/null 2>&1
kt kafka-topics.sh --bootstrap-server "$BS" --create --if-not-exists --topic "$T_MIN2" --partitions 1 --replication-factor 3 --config min.insync.replicas=2 >/dev/null 2>&1

echo "== 2. Dừng 1 broker (kafka-3) =="
stop_b kafka-3; sleep 8
OUT=$(produce "$T_MIN3")
if echo "$OUT" | grep -q -E 'NotEnoughReplicas|NOT_ENOUGH_REPLICAS'; then ok "min.insync=3: acks=all bị từ chối NOT_ENOUGH_REPLICAS"
else bad "min.insync=3: không thấy NOT_ENOUGH_REPLICAS ($(echo "$OUT" | grep -o -E '[A-Za-z]+(Exception|Error)' | sort -u | head -2 | tr '\n' ' '))"; fi
B0=$(end_offset "$T_MIN2"); OUT2=$(produce "$T_MIN2"); B1=$(end_offset "$T_MIN2")
check "min.insync=2: ghi acks=all được khi mất 1 broker" "$((B1-B0))" 1
cdc_check "mất 1 broker"
start_b kafka-3
wait_healthy kafka-3 && ok "kafka-3 healthy lại" || bad "kafka-3 chưa healthy"
wait_urp0 && ok "bật lại kafka-3: hết partition thiếu bản sao" || bad "vẫn còn $(urp) partition thiếu bản sao"

echo "== 3. Dừng 2 broker (kafka-2, kafka-3): mất quorum =="
stop_b kafka-2 kafka-3; sleep 8
OUT3=$(produce "$T_MIN2")
RC3=$(echo "$OUT3" | sed -n 's/^rc=//p' | tail -1)
ERRS=$(echo "$OUT3" | grep -o -E '[A-Za-z]+(Exception|Error)' | sort -u | head -3 | tr '\n' ' ')
if [ "$RC3" = 137 ]; then ok "mất quorum: không có ack trong ${PRODUCE_LIMIT} s, producer bị dừng khi hết giờ${ERRS:+ (lỗi thấy: $ERRS)}"
elif [ -n "$ERRS" ]; then ok "mất quorum: không có ack thành công, producer báo lỗi: $ERRS(mã thoát $RC3)"
else bad "mất quorum: producer thoát sạch (mã $RC3), có thể đã được ack"; fi
start_b kafka-2 kafka-3
wait_healthy kafka-2 kafka-3 && ok "kafka-2, kafka-3 healthy lại" || bad "kafka-2/kafka-3 chưa healthy"
for _ in $(seq 1 20); do [ "$(voters)" = 3 ] && L=$(leader) && [ -n "$L" ] && [ "$L" != "-1" ] && break; sleep 3; done
check "hồi phục: quorum 3 voter" "$(voters)" 3
L=$(leader); [ -n "$L" ] && [ "$L" != "-1" ] && ok "hồi phục: quorum có leader (node $L)" || bad "hồi phục: chưa có leader"
wait_urp0 && ok "hồi phục: hết partition thiếu bản sao" || bad "hồi phục: còn $(urp) partition thiếu bản sao"
for _ in $(seq 1 20); do [ "$(connectors_running)" = 3 ] && break; sleep 3; done
check "hồi phục: 3 connector Debezium RUNNING" "$(connectors_running)" 3
cdc_check "sau hồi phục"

kt kafka-topics.sh --bootstrap-server "$BS" --delete --topic "$T_MIN3" >/dev/null 2>&1
kt kafka-topics.sh --bootstrap-server "$BS" --delete --topic "$T_MIN2" >/dev/null 2>&1

echo
echo "===== KẾT QUẢ KAFKA FAILOVER: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
