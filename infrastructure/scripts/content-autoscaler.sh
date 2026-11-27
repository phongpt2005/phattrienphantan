#!/usr/bin/env bash
# ============================================================
# P2 C2: tự co giãn content-worker theo độ trễ tiêu thụ Kafka (lag của nhóm content-indexer).
#   bash infrastructure/scripts/content-autoscaler.sh            # chạy vòng lặp
#   bash infrastructure/scripts/content-autoscaler.sh --once     # một lần quyết định (dùng trong bài kiểm, cron)
#
# Chạy ở máy chủ (không mount docker.sock vào container nào): đọc lag từ Prometheus (cổng chỉ bind 127.0.0.1),
# đổi số bản bằng docker compose --scale. Quy tắc:
#   - lag >= UP_LAG trong UP_POLLS lần đọc liên tiếp  -> thêm 1 bản (tối đa MAX = số partition của topic)
#   - lag == 0 trong DOWN_POLLS lần đọc liên tiếp     -> bớt 1 bản (tối thiểu MIN)
#   - số bản đang chạy < MIN (bản bị sập)              -> đưa về MIN ngay
#   - sau mỗi lần đổi: chờ COOLDOWN giây (để nhóm consumer chia lại partition rồi mới đo tiếp)
#   - Prometheus không trả lời hoặc thiếu số liệu       -> giữ nguyên (không co giãn theo số liệu mù)
# Mỗi quyết định ghi một dòng vào $LOG (mặc định logs/content-autoscaler.log).
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
PROM="${PROM:-http://127.0.0.1:9090}"
GROUP="${GROUP:-content-indexer}"
MIN="${MIN:-1}"; MAX="${MAX:-3}"
UP_LAG="${UP_LAG:-10}"; UP_POLLS="${UP_POLLS:-2}"; DOWN_POLLS="${DOWN_POLLS:-6}"
INTERVAL="${INTERVAL:-10}"; COOLDOWN="${COOLDOWN:-60}"
STATE="${STATE:-logs/.content-autoscaler.state}"
LOG="${LOG:-logs/content-autoscaler.log}"
mkdir -p "$(dirname "$LOG")" "$(dirname "$STATE")"

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" | tee -a "$LOG"; }
lag() { curl -s -m 5 "$PROM/api/v1/query" --data-urlencode "query=sum(kafka_consumergroup_lag{consumergroup=\"$GROUP\"})" \
        | python -I -X utf8 -c 'import sys,json
d=json.load(sys.stdin)["data"]["result"]
print(int(float(d[0]["value"][1])) if d else "")' 2>/dev/null; }
partitions() { curl -s -m 5 "$PROM/api/v1/query" --data-urlencode 'query=min(kafka_topic_partitions{topic=~"dms\\.dept\\..*\\.document"})' \
        | python -I -X utf8 -c 'import sys,json
d=json.load(sys.stdin)["data"]["result"]
print(int(float(d[0]["value"][1])) if d else "")' 2>/dev/null; }
# Số bản đang có (chạy hoặc bị treo; bản đã thoát không tính). Bản treo vẫn giữ partition tới khi hết phiên Kafka.
# Lưu ý: docker compose --scale từ chối khi có bản ở trạng thái paused ("cannot start a paused container"): ghi action=error.
running() { docker compose ps -q content-worker 2>/dev/null | grep -c .; }
# Đổi số bản. Lỗi (ví dụ docker từ chối khởi động lại một bản đang bị treo) phải được báo, không được ghi như đã đổi.
SCALE_ERR=""
scale_to() {
  local out; out=$(docker compose up -d --no-build --no-deps --scale content-worker="$1" content-worker 2>&1)
  local rc=$?
  SCALE_ERR=$(echo "$out" | grep -i -E "error|cannot" | grep -v "level=warning" | head -1 | tr -s ' ' | cut -c1-160)
  [ $rc -eq 0 ] && [ -z "$SCALE_ERR" ]; }

# Trạng thái giữa các lần chạy --once: số lần đọc liên tiếp vượt ngưỡng / bằng 0, lúc đổi gần nhất
UPS=0; ZEROS=0; LAST=0
[ -f "$STATE" ] && . "$STATE"
save() { printf 'UPS=%s\nZEROS=%s\nLAST=%s\n' "$UPS" "$ZEROS" "$LAST" > "$STATE"; }

decide() {
  local L N P now cap
  now=$(date +%s); N=$(running); L=$(lag); P=$(partitions)
  cap=$MAX; [ -n "$P" ] && [ "$P" -lt "$cap" ] && cap=$P       # thêm bản quá số partition thì bản dư ngồi không
  if [ "$N" -lt "$MIN" ]; then
    if scale_to "$MIN"; then log "action=restore replicas=$N->$MIN lag=${L:-?} reason=duoi-toi-thieu"
    else log "action=error want=$MIN replicas=$N lag=${L:-?} err=\"$SCALE_ERR\""; fi
    LAST=$now; UPS=0; ZEROS=0; save; return
  fi
  if [ -z "$L" ]; then log "action=hold replicas=$N lag=? reason=khong-doc-duoc-prometheus"; save; return; fi
  if [ "$L" -ge "$UP_LAG" ]; then UPS=$((UPS+1)); ZEROS=0; elif [ "$L" -eq 0 ]; then ZEROS=$((ZEROS+1)); UPS=0; else UPS=0; ZEROS=0; fi
  if [ $((now - LAST)) -lt "$COOLDOWN" ]; then log "action=hold replicas=$N lag=$L reason=cooldown"; save; return; fi
  if [ "$UPS" -ge "$UP_POLLS" ] && [ "$N" -lt "$cap" ]; then
    if scale_to $((N+1)); then log "action=scale-up replicas=$N->$((N+1)) lag=$L cap=$cap"
    else log "action=error want=$((N+1)) replicas=$N lag=$L err=\"$SCALE_ERR\""; fi
    LAST=$now; UPS=0; save; return
  fi
  if [ "$ZEROS" -ge "$DOWN_POLLS" ] && [ "$N" -gt "$MIN" ]; then
    if scale_to $((N-1)); then log "action=scale-down replicas=$N->$((N-1)) lag=$L"
    else log "action=error want=$((N-1)) replicas=$N lag=$L err=\"$SCALE_ERR\""; fi
    LAST=$now; ZEROS=0; save; return
  fi
  log "action=hold replicas=$N lag=$L ups=$UPS zeros=$ZEROS"; save
}

if [ "${1:-}" = "--once" ]; then decide; exit 0; fi
log "start min=$MIN max=$MAX up_lag=$UP_LAG up_polls=$UP_POLLS down_polls=$DOWN_POLLS interval=$INTERVAL cooldown=$COOLDOWN"
STOP=0; trap 'STOP=1' INT TERM
while [ "$STOP" = 0 ]; do decide; [ -f "${STOP_FILE:-/nonexistent}" ] && break; sleep "$INTERVAL"; done
log "stop"
