#!/usr/bin/env bash
# ============================================================
# Kiểm trang giám sát của Ban Giám đốc (GET /api/search/executive/system) đọc đúng hạ tầng dữ liệu:
#   1. Bình thường: hai cụm Patroni ok (máy chính + bản sao đồng bộ), etcd 3/3, 2/2 worker Debezium, connector RUNNING.
#   2. Worker Debezium 1 dừng: vẫn đọc được trạng thái connector qua worker 2 (trước đây báo "không truy vấn được").
#   3. Một nút etcd dừng: etcd báo warn 2/3 (còn quorum).
#   4. Bản sao HR dừng: cụm HR báo warn (chưa có bản sao đồng bộ), máy chính vẫn đúng.
# Mọi container đã dừng luôn được bật lại.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
. infrastructure/scripts/lib-central.sh
export MSYS_NO_PATHCONV=1
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
PASS=0; FAIL=0; STOPPED=""
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if [ -n "$2" ] && [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
cleanup() { [ -n "$STOPPED" ] && docker start $STOPPED >/dev/null 2>&1; }
trap cleanup EXIT
TK=$(curl -s -m 15 -X POST "$BASE/api/dept/hr/auth/login" -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$DEMO_ADMIN_PASSWORD\"}" | python -I -X utf8 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))")
[ -n "$TK" ] || { echo "Không đăng nhập được admin"; exit 2; }
# comp <khóa thành phần> <trường>: đọc một thành phần của trang hệ thống
comp() { curl -s -m 20 -H "Authorization: Bearer $TK" "$BASE/api/search/executive/system" | python -I -X utf8 -c '
import sys,json
d=json.load(sys.stdin); k,f=sys.argv[1],sys.argv[2]
c=[x for x in d.get("components",[]) if x.get("key")==k]
print(c[0].get(f,"") if c else "khong-co")' "$1" "$2"; }
connector_states() { curl -s -m 20 -H "Authorization: Bearer $TK" "$BASE/api/search/executive/system" | python -I -X utf8 -c '
import sys,json
d=json.load(sys.stdin); print(",".join(sorted(x["key"]+"="+x["status"] for x in d.get("components",[]) if x.get("key","").startswith("connector-"))))'; }
wait_comp() { local i v; for i in $(seq 1 20); do v=$(comp "$1" status); [ "$v" = "$2" ] && { echo "$v"; return; }; sleep 3; done; echo "$v"; }
HRNAME="patroni-Phòng HR"; CNAME="patroni-Trung tâm"

echo "== 1. Bình thường =="
check "cụm CSDL trung tâm: ok" "$(wait_comp "$CNAME" ok)" ok
echo "  $(comp "$CNAME" detail)"
check "cụm CSDL HR: ok" "$(wait_comp "$HRNAME" ok)" ok
echo "  $(comp "$HRNAME" detail)"
check "etcd: ok" "$(wait_comp etcd ok)" ok
check "worker Debezium: ok" "$(wait_comp connect-workers ok)" ok
echo "  $(comp connect-workers detail)"
check "ba connector đều ok" "$(connector_states)" "connector-outbox-acc=ok,connector-outbox-hr=ok,connector-outbox-sales=ok"

echo "== 2. Worker Debezium 1 dừng =="
docker stop debezium >/dev/null; STOPPED="debezium"
check "worker Debezium: warn" "$(wait_comp connect-workers warn)" warn
echo "  $(comp connect-workers detail)"
S=""; for i in $(seq 1 30); do S=$(connector_states); [ "$S" = "connector-outbox-acc=ok,connector-outbox-hr=ok,connector-outbox-sales=ok" ] && break; sleep 3; done
check "vẫn đọc được trạng thái ba connector qua worker 2 (sau khi chia lại task)" "$S" "connector-outbox-acc=ok,connector-outbox-hr=ok,connector-outbox-sales=ok"
check "không còn thành phần 'không truy vấn được Kafka Connect'" "$(comp connect status)" khong-co
docker start debezium >/dev/null; STOPPED=""
# Điều cần kiểm là trang giám sát phản ánh đúng khi worker đã hồi phục: chờ worker sẵn sàng trước
# (JVM khởi động có thể hơn 60 giây khi máy tải nặng; lượt bảng điểm 20261127_052231 báo warn đúng ở giây thứ 60)
for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' debezium)" = healthy ] && break; sleep 3; done
check "worker Debezium bật lại: ok (sau khi container healthy)" "$(wait_comp connect-workers ok)" ok

echo "== 3. Một nút etcd dừng =="
docker stop central-etcd-3 >/dev/null; STOPPED="central-etcd-3"
check "etcd: warn" "$(wait_comp etcd warn)" warn
echo "  $(comp etcd detail)"
check "cụm trung tâm vẫn ok" "$(comp "$CNAME" status)" ok
docker start central-etcd-3 >/dev/null; STOPPED=""
check "etcd bật lại: ok" "$(wait_comp etcd ok)" ok

echo "== 4. Bản sao HR dừng =="
L=$(hr_leader); R=$([ "$L" = hr-pg-1 ] && echo hr-pg-2 || echo hr-pg-1)
docker stop "$R" >/dev/null; STOPPED="$R"
check "cụm HR: warn" "$(wait_comp "$HRNAME" warn)" warn
D=$(comp "$HRNAME" detail); echo "  $D"
check "chi tiết nêu đúng máy chính $L" "$(echo "$D" | grep -c "Máy chính $L")" 1
docker start "$R" >/dev/null; STOPPED=""
check "bản sao HR bật lại: ok" "$(wait_comp "$HRNAME" ok)" ok

echo
echo "===== KẾT QUẢ GIÁM SÁT: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
