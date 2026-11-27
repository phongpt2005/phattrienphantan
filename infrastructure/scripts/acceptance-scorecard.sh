#!/usr/bin/env bash
# ============================================================
# P3 C3: BẢNG ĐIỂM NGHIỆM THU. Chạy lần lượt các bộ kiểm của hệ thống, gom điểm và số đo chính vào một bảng.
#   bash infrastructure/scripts/acceptance-scorecard.sh                 # tất cả
#   bash infrastructure/scripts/acceptance-scorecard.sh e2e idem        # chỉ các mục nêu tên
#   SKIP="restore autoscale" bash infrastructure/scripts/acceptance-scorecard.sh
#
# Mỗi mục: kiểm nhanh hệ thống sẵn sàng (các node phòng khỏe, hai cụm Patroni có máy chính, connector Debezium chạy),
# chạy bộ kiểm có giới hạn thời gian, đọc dòng "KẾT QUẢ ...: X đạt, Y lỗi" (chaos: đếm bước PASS/FAIL).
# Kết quả: logs/scorecard-<thời điểm>/ gồm log từng mục, BANG-DIEM.md và scorecard.json.
# Một mục ĐẠT khi có ít nhất một kiểm tra và không có lỗi. Không có dòng kết quả (treo, hết giờ): CHƯA ĐẠT.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
export MSYS_NO_PATHCONV=1
STAMP=$(date +%Y%m%d_%H%M%S)
OUT="logs/scorecard-$STAMP"; mkdir -p "$OUT"
S=infrastructure/scripts

# mã | nhóm | tên | lệnh | giới hạn giây
SUITES='
e2e|Chức năng đầu-cuối|Hồi quy e2e (tạo, duyệt, chia sẻ, tìm kiếm, CDC, nội dung tệp)|bash '"$S"'/e2e-smoke.sh|2400
central|Chịu lỗi tầng dữ liệu|CSDL trung tâm: Patroni, etcd 3 nút, HAProxy 2 bản|bash '"$S"'/central-failover-test.sh|1500
hr|Chịu lỗi tầng dữ liệu|CSDL phòng HR: Patroni, slot Debezium theo máy chính|bash '"$S"'/hr-failover-test.sh|1800
kafka|Chịu lỗi tầng dữ liệu|Kafka 3 broker, RF 3, min ISR 2|bash '"$S"'/kafka-failover-test.sh|1500
debezium|Chịu lỗi tầng dữ liệu|Debezium 2 worker|bash '"$S"'/debezium-failover-test.sh|900
partition|Phân tán và tự trị|Phòng HR đứt mạng: tự trị, hội tụ, không ghi đè bằng sự kiện cũ|bash '"$S"'/partition-test.sh|1200
replica|Phân tán và tự trị|Mỗi phòng 2 bản node, một bản sập vẫn phục vụ|bash '"$S"'/node-replica-test.sh|1200
chaos-central|Phân tán và tự trị|Chaos: trung tâm sập, các phòng vẫn chạy|python -X utf8 infrastructure/chaos/run_scenario.py infrastructure/chaos/scenarios/central-down.json|900
chaos-minio|Phân tán và tự trị|Chaos: kho tệp HR sập|python -X utf8 infrastructure/chaos/run_scenario.py infrastructure/chaos/scenarios/minio-hr-down.json|900
approval|Tính đúng và nhất quán|Đua duyệt yêu cầu xin quyền|bash '"$S"'/approval-race-test.sh|600
provenance|Tính đúng và nhất quán|Truy vết lượt chia sẻ|bash '"$S"'/share-provenance-test.sh|600
epoch|Tính đúng và nhất quán|Projector tự phục hồi tiến độ|bash '"$S"'/projector-epoch-test.sh|900
idem|Tính đúng và nhất quán|Idempotency-Key cho tạo tài liệu|bash '"$S"'/idempotency-test.sh|600
retry|Tính đúng và nhất quán|CSDL lỗi tạm thời: 503 + Retry-After, không để tệp mồ côi|bash '"$S"'/retry-after-test.sh|600
monitor|Quan sát|Trang giám sát đọc đúng Patroni, etcd, worker Debezium khi có sự cố|bash '"$S"'/monitoring-test.sh|900
revoke|Bảo mật|Thu hồi token có hiệu lực ngay|bash '"$S"'/revoke-test.sh|600
autoscale|Co giãn|Tự co giãn content-worker theo lag Kafka|bash '"$S"'/autoscaler-test.sh|900
restore|Sao lưu và khôi phục|Sao lưu mã hóa ra ngoài và khôi phục thử|bash '"$S"'/backup-offsite.sh && bash '"$S"'/restore-test.sh|1800
'

want() { # mục $1 có được chọn không
  local k
  for k in ${SKIP:-}; do [ "$k" = "$1" ] && return 1; done
  [ $# -eq 1 ] && [ -z "$SELECTED" ] && return 0
  for k in $SELECTED; do [ "$k" = "$1" ] && return 0; done; return 1; }
SELECTED="$*"

ready() { # in lý do nếu hệ thống chưa sẵn sàng, rỗng nếu sẵn sàng
  local c bad=""
  for c in $(docker ps -a --format '{{.Names}}' | grep -E '^dept-[a-z0-9]+(-[0-9]+)?$'); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy ] || bad="$bad $c"
  done
  [ -n "$(central_leader 2>/dev/null)" ] || bad="$bad cum-trung-tam-chua-co-may-chinh"
  [ "$(hr_mode)" != patroni ] || [ -n "$(hr_leader 2>/dev/null)" ] || bad="$bad cum-HR-chua-co-may-chinh"
  local h st; for h in debezium debezium-2; do st=$(docker exec "$h" curl -s -m 5 http://localhost:8083/connectors?expand=status 2>/dev/null) && break; done
  local cb; cb=$(echo "$st" | python -I -X utf8 -c 'import sys,json
d=json.load(sys.stdin); b=[n for n,v in d.items() if v["status"]["connector"]["state"]!="RUNNING" or any(t["state"]!="RUNNING" for t in v["status"]["tasks"])]
print(" ".join("connector-"+n for n in b))' 2>/dev/null || echo khong-doc-duoc-kafka-connect)
  [ -n "$cb" ] && bad="$bad $cb"
  echo "$bad" | sed 's/^ *//'; }
wait_ready() { local i r; for i in $(seq 1 60); do r=$(ready); [ -z "$r" ] && return 0; sleep 5; done; echo "$r"; return 1; }

score() { # $1 tệp log -> "đạt lỗi" hoặc rỗng
  local l; l=$(grep -a -o -E '[0-9]+ (đạt|dat), [0-9]+ (lỗi|loi)' "$1" | tail -1)
  if [ -n "$l" ]; then echo "$l" | awk '{print $1, $3}'; return; fi
  # chaos runner: mỗi bước một dòng "  <số> <loại> PASS|FAIL ..."
  local p f; p=$(grep -a -c -E '^ +[0-9]+ +[a-z_]+ +PASS' "$1"); f=$(grep -a -c -E '^ +[0-9]+ +[a-z_]+ +FAIL' "$1")
  [ $((p+f)) -gt 0 ] && echo "$p $f"; }

ROWS=""; TOTAL_P=0; TOTAL_F=0; N_OK=0; N_ALL=0
echo "Bảng điểm nghiệm thu $STAMP -> $OUT"
while IFS='|' read -r -u 3 key group name cmd limit; do
  [ -z "$key" ] && continue
  want "$key" || continue
  N_ALL=$((N_ALL+1))
  printf '\n== [%s] %s ==\n' "$key" "$name"
  R=$(wait_ready)
  if [ -n "$R" ]; then
    echo "  hệ thống chưa sẵn sàng: $R"
    ROWS="$ROWS$key|$group|$name|-|-|CHƯA ĐẠT (hệ thống chưa sẵn sàng: $R)|0\n"; continue
  fi
  T0=$(date +%s)
  # < /dev/null: danh sách mục được đọc từ stdin của vòng lặp; bài kiểm nào đọc stdin (docker run, ssh...) sẽ "ăn" mất
  # các mục còn lại (lượt 20261127_001413 dừng sau 4 mục vì vậy). sed: bỏ mã màu để đọc được dòng PASS/FAIL.
  timeout "$limit" bash -c "$cmd" < /dev/null 2>&1 | sed -u 's/\x1b\[[0-9;]*m//g' > "$OUT/$key.log"; RC=${PIPESTATUS[0]}
  DUR=$(( $(date +%s) - T0 ))
  SC=$(score "$OUT/$key.log"); P=${SC% *}; F=${SC#* }
  if [ -z "$SC" ]; then P=0; F=0; V="CHƯA ĐẠT (không có dòng kết quả; mã thoát $RC)"
  elif [ "$F" = 0 ] && [ "$P" -gt 0 ]; then V="ĐẠT"; N_OK=$((N_OK+1))
  else V="CHƯA ĐẠT"; fi
  [ "$RC" = 124 ] && V="$V, hết giờ ${limit} giây"
  TOTAL_P=$((TOTAL_P+P)); TOTAL_F=$((TOTAL_F+F))
  echo "  $P đạt, $F lỗi, $DUR giây: $V"
  grep -a -E '^ *FAIL' "$OUT/$key.log" | head -5 | sed 's/^/    /'
  ROWS="$ROWS$key|$group|$name|$P|$F|$V|$DUR\n"
done 3<<< "$SUITES"

# Số đo chính lấy thẳng từ log (không ghi số tay)
metric() { grep -a -h -o -E "$2" "$OUT/$1.log" 2>/dev/null | head -${3:-1} | tr '\n' ';' | sed 's/;$//'; }
{
  echo "# Bảng điểm nghiệm thu"
  echo
  echo "Lượt chạy: $STAMP. Sinh tự động bởi \`infrastructure/scripts/acceptance-scorecard.sh\`; log từng mục nằm cùng thư mục."
  echo
  echo "**Tổng: $N_OK/$N_ALL mục đạt; $TOTAL_P kiểm tra đạt, $TOTAL_F lỗi.**"
  echo
  echo "| Mục | Nhóm | Nội dung | Đạt | Lỗi | Kết luận | Thời gian (giây) |"
  echo "|---|---|---|---|---|---|---|"
  printf '%b' "$ROWS" | while IFS='|' read -r k g n p f v d; do [ -n "$k" ] && echo "| \`$k\` | $g | $n | $p | $f | $v | $d |"; done
  echo
  echo "## Số đo chính (trích từ log)"
  echo
  echo "- CSDL trung tâm, RTO: $(metric central 'RTO [0-9]+ giây' 3)"
  echo "- CSDL HR, RTO: $(metric hr 'RTO [0-9]+ giây' 2); CDC sau chuyển: $(metric hr 'thiếu ở chỉ mục trung tâm: [0-9]+' 1)"
  echo "- Đứt mạng HR: $(metric partition 'T_convergence: [0-9]+ giây' 1)"
  echo "- Tự co giãn: $(metric autoscale 'thêm bản sau [0-9]+ giây|lag về 0 sau [0-9]+ giây|bớt về 1 bản sau [0-9]+ giây' 3)"
  echo "- e2e, độ trễ tìm kiếm: $(metric e2e '(Cold|Warm)[^,;]*ms' 2)"
  echo
  echo "## Mục chưa đạt"
  echo
  for f in "$OUT"/*.log; do [ -f "$f" ] || continue; k=$(basename "$f" .log); n=$(grep -a -c -E '^ *FAIL' "$f" 2>/dev/null); [ "${n:-0}" -gt 0 ] && { echo "- \`$k\`:"; grep -a -E '^ *FAIL' "$f" | sed 's/^ */  - /'; }; done
  [ "$TOTAL_F" = 0 ] && echo "Không có."
} > "$OUT/BANG-DIEM.md"
printf '%b' "$ROWS" | python -I -X utf8 -c '
import sys,json
rows=[dict(zip(["key","group","name","pass","fail","verdict","seconds"],l.rstrip("\n").split("|"))) for l in sys.stdin if l.strip()]
json.dump({"stamp":sys.argv[1],"suites":rows},open(sys.argv[2],"w",encoding="utf-8"),ensure_ascii=False,indent=1)' "$STAMP" "$OUT/scorecard.json"

[ "$N_ALL" -gt 0 ] || { echo "Không có mục nào được chạy (kiểm lại tên mục). Không tính là đạt."; exit 2; }
echo
echo "===== BẢNG ĐIỂM: $N_OK/$N_ALL mục đạt; $TOTAL_P kiểm tra đạt, $TOTAL_F lỗi ====="
echo "Chi tiết: $OUT/BANG-DIEM.md"
[ "$TOTAL_F" = 0 ] && [ "$N_OK" = "$N_ALL" ]
