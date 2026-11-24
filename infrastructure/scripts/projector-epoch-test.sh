#!/usr/bin/env bash
# ============================================================
# KIEM THU P0.6.1: tu phuc hoi tien do projector bang dau van tay ban ghi.
#   bash infrastructure/scripts/projector-epoch-test.sh
# Ca 3: khoi dong binh thuong. Dau van tay khop, khong reset, khong ap dung lai.
# Ca 1: tien do >= log-end (topic bi reset). Phat hien theo khoang offset.
# Ca 2: tien do hop le nhung dau van tay sai (topic tao lai co nhieu ban ghi hon).
# Dat khi: dung ly do phat hien, tien do hoi tu ve log-end-1 co dau van tay,
#          lag ve 0, so tai lieu tung phong o trung tam khong doi.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
export MSYS_NO_PATHCONV=1
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (nhan '$2', mong doi '$3')"; fi; }
CDB() { docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
# P1 B1: công cụ Kafka chạy trong container tạm trên dms-network (không exec vào broker: JVM thứ hai có thể vượt giới hạn 512 MB)
KBS="kafka-1:9092,kafka-2:9092,kafka-3:9092"
kt() { local tool=$1; shift; docker run --rm -i --network dms-network -e KAFKA_HEAP_OPTS="-Xmx96m" --entrypoint "/opt/kafka/bin/$tool" apache/kafka:3.7.0 "$@"; }
LOGEND() { kt kafka-get-offsets.sh --bootstrap-server "$KBS" --topic "$1" --time -1 | awk -F: -v p="$2" '$2==p {print $3}'; }
restart_search() {
  docker restart distributed-dms-search-engine-service-1 distributed-dms-search-engine-service-2 >/dev/null
  for i in $(seq 1 60); do
    n=$(docker ps --filter name=search-engine --format '{{.Status}}' | grep -c healthy)
    [ "$n" -ge 2 ] && break
    sleep 3
  done
}
logs_since() {
  docker logs --since "$1" distributed-dms-search-engine-service-1 2>&1
  docker logs --since "$1" distributed-dms-search-engine-service-2 2>&1
}
# Cho tien do cua mot partition hoi tu: last_offset = log-end - 1 va co dau van tay (toi da ~90 giay)
wait_converged() {
  local t=$1 p=$2 le cur fp
  for i in $(seq 1 45); do
    le=$(LOGEND "$t" "$p")
    cur=$(CDB "select last_offset from cdc_partition_progress where topic='$t' and partition_id=$p")
    fp=$(CDB "select coalesce(last_fingerprint,'') from cdc_partition_progress where topic='$t' and partition_id=$p")
    if [ "$cur" = "$((le-1))" ] && [ -n "$fp" ]; then return 0; fi
    sleep 2
  done
  return 1
}
snapshot_progress() {
  CDB "select string_agg(topic||':'||partition_id||'='||last_offset, ',' order by topic, partition_id) from cdc_partition_progress where topic like 'dms.dept.%.document'"
}
# So partition con lag khac 0. Partition chua co tin (CURRENT "-", LOG-END 0) khong co lag nen khong tinh.
lag_all_zero() {
  kt kafka-consumer-groups.sh --bootstrap-server "$KBS" --describe --group index-projector 2>/dev/null \
    | awk '/dms.dept/ { if ($4=="-" && $5==0) next; if ($6!=0) n++ } END { print n+0 }'
}
docs_count() { CDB "select count(*) from search_document s join department d using(department_id) where d.dept_code='$1'"; }
# Tap partition ky vong khop dau van tay, lay tu CSDL: tien do con hieu luc (last >= 0, co dau van tay)
# thuoc topic con ton tai trong Kafka (loai dong tien do cu cua topic da khong con, vd legal).
expect_set() {
  local topics
  topics=$(kt kafka-topics.sh --bootstrap-server "$KBS" --list 2>/dev/null \
    | grep -E '^dms\.dept\..+\.document$' | sed "s/.*/'&'/" | paste -sd, -)
  CDB "select topic||':'||partition_id from cdc_partition_progress where last_offset >= 0 and last_fingerprint is not null and topic in (${topics:-''})" | LC_ALL=C sort -u
}
# Tap partition da 'Dau van tay khop' ke tu moc thoi gian $1 (gop log ca hai instance)
matched_set() {
  logs_since "$1" | sed 's/\x1b\[[0-9;]*m//g' | grep -a 'khớp' | sed -E 's/.*khớp ([^@]+)@.*/\1/' | LC_ALL=C sort -u
}

echo "== 0. Khoi dong ban dau: tien do co dau van tay cho moi partition =="
restart_search
for t in dms.dept.hr.document dms.dept.acc.document; do
  for p in 0 1 2; do
    wait_converged "$t" "$p" && ok "tien do $t[$p] da hoi tu" || bad "tien do $t[$p] chua hoi tu sau 90 giay"
  done
done

echo "== Ca 3: khoi dong binh thuong (dau van tay khop, khong reset, khong ap dung lai) =="
HR_B=$(docs_count HR); ACC_B=$(docs_count ACC)
SNAP_B=$(snapshot_progress)
EXP=$(expect_set)   # partition ky vong khop, dem tu CSDL (khong ghi so cung)
N=$(echo "$EXP" | grep -c .)
T3=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DB_T3=$(CDB "select now()::timestamp")
restart_search
# Cho den khi moi partition ky vong da khop dau van tay, toi da 90 giay
for i in $(seq 1 30); do
  m=$(matched_set "$T3" | grep -c .)
  [ "$m" -ge "$N" ] && break
  sleep 3
done
LOGS3=$(logs_since "$T3")
[ "$N" -gt 0 ] || bad "khong co partition nao co tien do de kiem tra"
chk "khong co reset khi khoi dong binh thuong" "$(echo "$LOGS3" | grep -c 'Phát hiện\|Phat hien' )" 0
chk "moi partition co tien do deu khop dau van tay (so partition lay tu CSDL: $N)" "$(matched_set "$T3" | paste -sd' ' -)" "$(echo "$EXP" | paste -sd' ' -)"
chk "tien do khong doi sau khoi dong" "$(snapshot_progress)" "$SNAP_B"
chk "khong ap dung lai su kien (sync_event_log moi = 0)" "$(CDB "select count(*) from sync_event_log where received_at >= '$DB_T3'")" 0

echo "== Ca 1: tien do >= log-end (topic bi reset, phat hien theo khoang offset) =="
LE1=$(LOGEND dms.dept.hr.document 0)
CDB "update cdc_partition_progress set last_offset=$LE1 where topic='dms.dept.hr.document' and partition_id=0" >/dev/null
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ)
restart_search
for i in $(seq 1 45); do
  logs_since "$T1" | grep -q "tiến độ $LE1 >= log-end" && break
  logs_since "$T1" | grep -q "tien do $LE1 >= log-end" && break
  sleep 2
done
LOGS1=$(logs_since "$T1")
chk "phat hien theo khoang offset cho HR[0]" "$(echo "$LOGS1" | grep -c "log-end $LE1 tại dms.dept.hr.document\[0\]\|log-end $LE1 tai dms.dept.hr.document\[0\]")" 1
wait_converged dms.dept.hr.document 0 && ok "HR[0] hoi tu ve log-end-1 co dau van tay" || bad "HR[0] khong hoi tu"

echo "== Ca 2: tien do hop le nhung dau van tay sai (topic tao lai co nhieu ban ghi hon) =="
LE2=$(LOGEND dms.dept.acc.document 1)
CDB "update cdc_partition_progress set last_offset=$((LE2-2)), last_fingerprint='ffffffffffffffffffffffffffffffff' where topic='dms.dept.acc.document' and partition_id=1" >/dev/null
T2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
restart_search
for i in $(seq 1 45); do
  logs_since "$T2" | grep -q "khong khop\|không khớp" && break
  sleep 2
done
LOGS2=$(logs_since "$T2")
chk "phat hien bang dau van tay cho ACC[1]" "$(echo "$LOGS2" | grep -c 'không khớp tại offset .*dms.dept.acc.document\[1\]')" 1
wait_converged dms.dept.acc.document 1 && ok "ACC[1] hoi tu ve log-end-1 voi dau van tay moi" || bad "ACC[1] khong hoi tu"

echo "== Kiem tra chung =="
chk "so tai lieu HR o trung tam khong doi" "$(docs_count HR)" "$HR_B"
chk "so tai lieu ACC o trung tam khong doi" "$(docs_count ACC)" "$ACC_B"
# lag là số liệu theo offset đã commit: chờ tối đa 30 giây để commit kịp sau khi hội tụ
for i in $(seq 1 15); do [ "$(lag_all_zero)" = 0 ] && break; sleep 2; done
chk "lag cua index-projector ve 0 tren moi partition" "$(lag_all_zero)" 0
chk "khong co MAT DU LIEU trong log" "$(logs_since "$T3" | grep -c 'MẤT DỮ LIỆU\|MAT DU LIEU')" 0

echo; echo "===== KET QUA P0.6.1: $PASS dat, $FAIL loi ====="
[ "$FAIL" -eq 0 ]
