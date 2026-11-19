#!/usr/bin/env bash
# ============================================================
# Kiểm thử đầu-cuối qua API Gateway (nginx :8000).
# Chạy:  bash infrastructure/scripts/e2e-smoke.sh
# Yêu cầu: stack đang chạy (docker compose up -d), SEED_DEMO_USERS=true trong .env.
# Bao gồm: xác thực, phân quyền 3 tầng, cô lập phòng ban, federated search, độ trễ đồng bộ,
#          chia sẻ + tải file thật qua Search Gateway, và chịu lỗi khi một node dừng.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
BASE="${BASE:-http://localhost:${NGINX_HTTP_PORT:-8000}}"
# --- Lớp trừu tượng theo môi trường chạy
node_internal_code() {  # gọi /internal/search KHÔNG kèm service token từ bên trong node, in mã HTTP
  docker exec dept-hr curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"q":"a","viewer":{"deptCode":"HR"}}' http://127.0.0.1:3000/internal/search
}
stop_node()  { docker stop dept-$1 >/dev/null; }
start_node() { docker start dept-$1 >/dev/null; }
PASS=0; FAIL=0

# SETTLE & DRAIN: sau mỗi bài tắt/bật hạ tầng, chờ > TTL cache Registry (5 giây) để Circuit Breaker đổi trạng thái và cache
# hết hạn, rồi gửi ping để dọn socket chết trong pool và làm ấm kết nối mới. Bài kế tiếp không còn "dư chấn" của bài trước.
settle() {
  sleep "${SETTLE_SECONDS:-5.5}"
  for _ in 1 2 3; do curl -s -o /dev/null --max-time 3 "$BASE/health" || true; done
  curl -s -o /dev/null --max-time 5 -H "Authorization: Bearer ${HR_MGR:-}" "$BASE/api/search?q=settle&limit=1" || true
}

ok()   { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
jget() { python -I -X utf8 -c "import sys,json
try:
    d=json.load(sys.stdin)
    for k in '$1'.split('.'):
        d=d[int(k)] if k.isdigit() else d[k]
    print('' if d is None else (str(d).lower() if isinstance(d,bool) else d))
except Exception:
    print('')"; }
http()  { curl -s -o /dev/null -w '%{http_code}' "$@"; }
login() { curl -s -X POST "$BASE/api/dept/$1/auth/login" -H 'content-type: application/json' \
            -d "{\"username\":\"$2\",\"password\":\"$3\"}" | jget accessToken; }
search(){ curl -s -H "Authorization: Bearer $1" --get "$BASE/api/search" --data-urlencode "q=$2" "${@:3}"; }

echo "== 0. Gateway & Registry =="
check "Gateway /health" "$(http $BASE/health)" 200
codes=$(curl -s $BASE/api/registry/departments/public | python -I -c "import sys,json; print(','.join(sorted(d['code'] for d in json.load(sys.stdin))))")
echo "     phòng ban trong Registry: $codes"
case ",$codes," in *,HR,*) ok "Registry có HR";; *) bad "Registry thiếu HR";; esac
case ",$codes," in *,ACC,*) ok "Registry có ACC";; *) bad "Registry thiếu ACC";; esac

echo "== 1. Xác thực =="
HR_STAFF=$(login hr "hr_staff" "$DEMO_STAFF_PASSWORD")
HR_MGR=$(login hr "hr_manager" "$DEMO_MANAGER_PASSWORD")
ACC_STAFF=$(login acc "acc_staff" "$DEMO_STAFF_PASSWORD")
ACC_MGR=$(login acc "acc_manager" "$DEMO_MANAGER_PASSWORD")
EXEC=$(login hr "admin" "$DEMO_ADMIN_PASSWORD")
for n in HR_STAFF HR_MGR ACC_STAFF ACC_MGR EXEC; do [ -n "${!n}" ] && ok "đăng nhập $n" || bad "đăng nhập $n"; done
check "mật khẩu sai bị từ chối" "$(http -X POST $BASE/api/dept/hr/auth/login -H 'content-type: application/json' -d '{"username":"hr_staff","password":"mat-khau-sai-123"}')" 401
check "không token -> 401 khi tìm kiếm" "$(http "$BASE/api/search?q=a")" 401
check "token giả -> 401" "$(http -H 'Authorization: Bearer abc.def.ghi' "$BASE/api/search?q=a")" 401

echo "== 2. Phân quyền 3 tầng & cô lập phòng ban =="
check "Nhân viên KHÔNG tạo được chia sẻ" "$(http -X POST $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_STAFF" -H 'content-type: application/json' -d '{"docId":1,"sharedWithDept":"ACC"}')" 403
check "Nhân viên KHÔNG xem được bảng Ban Giám đốc" "$(http -H "Authorization: Bearer $HR_STAFF" $BASE/api/search/executive/dashboard)" 403
check "Trưởng phòng KHÔNG xem được bảng Ban Giám đốc" "$(http -H "Authorization: Bearer $HR_MGR" $BASE/api/search/executive/dashboard)" 403
check "Ban Giám đốc xem được dashboard" "$(http -H "Authorization: Bearer $EXEC" $BASE/api/search/executive/dashboard)" 200
check "Gọi chéo node ACC bằng token HR -> 403" "$(http -H "Authorization: Bearer $HR_STAFF" $BASE/api/dept/acc/documents)" 403
check "Route /internal bị chặn ở gateway" "$(http -X POST $BASE/api/dept/hr/internal/search)" 403
check "Node từ chối /internal khi thiếu service token" "$(node_internal_code)" 403
check "Không tự đăng ký Registry từ bên ngoài" "$(http -X POST $BASE/api/registry/register)" 403

echo "== 3. Federated search =="
R=$(search "$HR_STAFF" "hop dong")
n=$(echo "$R" | jget total); partial=$(echo "$R" | jget partial)
[ "${n:-0}" -gt 0 ] && ok "tìm 'hop dong' (không dấu) khớp tiếng Việt có dấu: $n kết quả" || bad "tìm không dấu không ra kết quả"
check "mọi node trả lời (partial=false)" "$partial" false
echo "     nodes: $(echo "$R" | python -I -c "import sys,json; print([(n['code'],n['status'],n['tookMs']) for n in json.load(sys.stdin)['nodes']])")"
A=$(search "$HR_STAFF" "" --data-urlencode "limit=100" | jget total)
B=$(search "$HR_STAFF" "" --data-urlencode "limit=100" --data-urlencode "isExecutive=true" --data-urlencode "viewerDeptCode=ACC" | jget total)
check "tham số isExecutive/viewerDeptCode do client gửi bị bỏ qua" "$B" "$A"

echo "== 4. Ghi tài liệu -> Outbox -> Kafka -> Central Index =="
TMP=$(mktemp -d); WTMP=$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")  # curl/python bản Windows cần đường dẫn Windows
printf 'Hop dong thu viec e2e %s\n' "$(date +%s)" > "$WTMP/e2e.txt"
SHA_LOCAL=$(python -I -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$WTMP/e2e.txt")
TITLE="Bien ban kiem thu e2e $(date +%s)"
UP=$(curl -s -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $HR_MGR" \
      -F "title=$TITLE" -F "description=tai lieu kiem thu dau cuoi" -F "accessLevel=DEPARTMENT" -F "file=@$WTMP/e2e.txt;type=text/plain")
DOC_ID=$(echo "$UP" | jget docId)
[ -n "$DOC_ID" ] && ok "tạo tài liệu tại node HR (docId=$DOC_ID)" || { bad "tạo tài liệu: $UP"; }
t0=$(date +%s%N); found=""
for i in $(seq 1 40); do
  CID=$(search "$HR_MGR" "$TITLE" | jget data.0.central_doc_id)
  # Tìm federated đọc trực tiếp từ node (luôn mới); central_doc_id chỉ có khi CDC đã đồng bộ
  if [ -n "$CID" ]; then found=$CID; break; fi; sleep 0.5
done
t1=$(date +%s%N)
[ -n "$found" ] && ok "Central Index đồng bộ sau $(( (t1-t0)/1000000 )) ms (central_doc_id=$found)" || bad "Central Index chưa có tài liệu sau 20s"
check "tài liệu thuộc DEPARTMENT: phòng ACC KHÔNG thấy" "$(search "$ACC_STAFF" "$TITLE" | jget total)" 0

echo "== 5. Chia sẻ liên phòng ban + tải file thật =="
check "chưa có chia sẻ: ACC KHÔNG tải được tệp HR (node chủ từ chối)" "$(http -H "Authorization: Bearer $ACC_STAFF" $BASE/api/search/documents/HR/$DOC_ID/download)" 403
RQ=$(curl -s -X POST $BASE/api/search/shares/requests -H "Authorization: Bearer $ACC_STAFF" -H 'content-type: application/json' \
      -d "{\"sourceDocId\":$DOC_ID,\"targetDept\":\"HR\",\"requesterDept\":\"ACC\",\"requesterUsername\":\"acc_staff\",\"requestedDays\":1,\"requestedPermission\":\"DOWNLOAD\",\"reason\":\"e2e kiem thu luong xin quyen\"}")
RQ_ID=$(echo "$RQ" | jget request.request_id)
[ -n "$RQ_ID" ] && ok "ACC gửi yêu cầu xin quyền (request $RQ_ID, lưu ở trung tâm)" || bad "gửi yêu cầu xin quyền thất bại: $RQ"
check "Nhân viên KHÔNG duyệt được yêu cầu" "$(http -X POST $BASE/api/search/shares/requests/$RQ_ID/approve -H "Authorization: Bearer $ACC_STAFF" -H 'content-type: application/json' -d '{}')" 403
AP=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/search/shares/requests/$RQ_ID/approve -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json' -d '{"permission":"DOWNLOAD"}')
check "Trưởng phòng HR duyệt: gateway ghi lượt chia sẻ vào node HR" "$AP" 201
check "sau khi duyệt: ACC thấy tài liệu (SHARED)" "$(search "$ACC_STAFF" "$TITLE" --data-urlencode "limit=93" | jget data.0.access_mode)" SHARED
AP2=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/search/shares/requests/$RQ_ID/approve -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json' -d '{"permission":"DOWNLOAD"}')
[ "$AP2" != 201 ] && ok "duyệt lần 2 không tạo thêm lượt chia sẻ (HTTP $AP2)" || bad "duyệt lần 2 vẫn trả 201"
for sid in $(curl -s $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" | python -I -c "import json,sys; print(' '.join(str(x['share_id']) for x in json.load(sys.stdin) if str(x['source_doc_id'])=='$DOC_ID'))"); do curl -s -X DELETE $BASE/api/dept/hr/shares/$sid -H "Authorization: Bearer $HR_MGR" >/dev/null; done   # dọn trước khi thử chia sẻ trực tiếp
SH=$(curl -s -X POST $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json' \
      -d "{\"docId\":$DOC_ID,\"sharedWithDept\":\"ACC\",\"permission\":\"VIEW\",\"expiresInDays\":1}")
SHARE_ID=$(echo "$SH" | jget share.share_id)
[ -n "$SHARE_ID" ] && ok "Trưởng phòng HR chia sẻ (VIEW) cho ACC (share $SHARE_ID)" || bad "chia sẻ thất bại: $SH"
R=$(search "$ACC_STAFF" "$TITLE")
check "ACC thấy tài liệu được chia sẻ (access_mode=SHARED)" "$(echo "$R" | jget data.0.access_mode)" SHARED
check "quyền VIEW: tải về bị chặn (DLP)" "$(http -H "Authorization: Bearer $ACC_STAFF" $BASE/api/search/documents/HR/$DOC_ID/download)" 403
curl -s -X DELETE $BASE/api/dept/hr/shares/$SHARE_ID -H "Authorization: Bearer $HR_MGR" >/dev/null
SH=$(curl -s -X POST $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json' \
      -d "{\"docId\":$DOC_ID,\"sharedWithDept\":\"ACC\",\"permission\":\"DOWNLOAD\",\"expiresInDays\":1}")
SHARE_ID=$(echo "$SH" | jget share.share_id)
curl -s -H "Authorization: Bearer $ACC_STAFF" -o "$WTMP/down.txt" -D "$WTMP/h.txt" "$BASE/api/search/documents/HR/$DOC_ID/download"
SHA_REMOTE=$(python -I -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$WTMP/down.txt")
check "quyền DOWNLOAD: file tải về khớp SHA-256 bản gốc" "$SHA_REMOTE" "$SHA_LOCAL"
curl -s -X DELETE $BASE/api/dept/hr/shares/$SHARE_ID -H "Authorization: Bearer $HR_MGR" >/dev/null
check "thu hồi share: ACC không còn thấy" "$(search "$ACC_STAFF" "$TITLE" | jget total)" 0

echo "== 6. Chịu lỗi: node ACC dừng -> fallback Central Index =="
stop_node acc
R=$(search "$HR_MGR" "" --data-urlencode "limit=100")
check "partial=true khi node ACC dừng" "$(echo "$R" | jget partial)" true
ST=$(echo "$R" | python -I -c "import sys,json; print({n['code']:n['status'] for n in json.load(sys.stdin)['nodes']}.get('ACC'))")
check "ACC chuyển sang FALLBACK" "$ST" FALLBACK
check "HR vẫn OK" "$(echo "$R" | python -I -c "import sys,json; print({n['code']:n['status'] for n in json.load(sys.stdin)['nodes']}.get('HR'))")" OK
start_node acc
for i in $(seq 1 40); do
  S=$(search "$HR_MGR" "" --data-urlencode "limit=100" | jget partial); [ "$S" = false ] && break; sleep 2
done
check "ACC trở lại: partial=false" "$S" false
settle

echo "== 7. Nhật ký kiểm toán chống sửa đổi (hash chain) =="
V=$(curl -s -H "Authorization: Bearer $HR_MGR" "$BASE/api/dept/hr/audit/verify")
check "Trưởng phòng xác minh chuỗi audit: nguyên vẹn" "$(echo "$V" | jget intact)" true
[ "$(echo "$V" | jget chainedEntries)" -gt 0 ] 2>/dev/null && ok "đã có $(echo "$V" | jget chainedEntries) dòng audit được băm nối" || bad "chưa có dòng audit nào được băm"
check "chuỗi audit không phát sinh nhánh rẽ mới (cùng một cha) sau khi sửa lỗi tranh chấp" "$(echo "$V" | jget forkedLinks | python -I -c "import sys; print(int(sys.stdin.read().strip() or 0) <= 1)")" True
check "Nhân viên KHÔNG được xác minh audit" "$(http -H "Authorization: Bearer $HR_STAFF" $BASE/api/dept/hr/audit/verify)" 403

echo "== 8. Thông báo thời gian thực (SSE) =="
SSE="$WTMP/sse.txt"
curl -s -N -m 20 -H "Authorization: Bearer $ACC_MGR" "$BASE/api/search/notifications/stream" > "$SSE" 2>/dev/null &
SSEPID=$!
sleep 2
SH2=$(curl -s -X POST $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json'       -d "{\"docId\":$DOC_ID,\"sharedWithDept\":\"ACC\",\"permission\":\"VIEW\",\"expiresInDays\":1}")
SID2=$(echo "$SH2" | jget share.share_id)
for i in $(seq 1 10); do grep -q SHARE_GRANTED "$SSE" 2>/dev/null && break; sleep 1; done
grep -q SHARE_GRANTED "$SSE" && ok "Trưởng phòng ACC nhận thông báo SHARE_GRANTED ngay khi HR chia sẻ" || bad "không nhận được thông báo thời gian thực"
kill $SSEPID 2>/dev/null; [ -n "$SID2" ] && curl -s -X DELETE $BASE/api/dept/hr/shares/$SID2 -H "Authorization: Bearer $HR_MGR" >/dev/null

echo "== 9. Lập chỉ mục nội dung tệp qua hàng đợi Kafka (content-worker) =="
TOKEN_TXT="noidungtxt$(date +%s)"; TOKEN_DOCX="noidungdocx$(date +%s)"
TOKEN_PDF="dmsfixturepdf2026"   # chuỗi nằm trong fixtures/sample.pdf (PDF chuẩn do pdflatex sinh)
printf 'Bien ban cuoc hop quy.\nMa tham chieu noi bo: %s\n' "$TOKEN_TXT" > "$WTMP/c.txt"
python -I -X utf8 infrastructure/scripts/make-sample-files.py "$WTMP" "$TOKEN_DOCX"
cp infrastructure/scripts/fixtures/sample.pdf "$TMP/s.pdf"
upload() { curl -s -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $HR_MGR" -F "title=$1" -F "description=tai lieu kiem thu lap chi muc" -F "accessLevel=DEPARTMENT" -F "file=@$2;type=$3" | jget docId; }
D_TXT=$(upload "Tep van ban e2e" "$WTMP/c.txt" "text/plain")
D_PDF=$(upload "Tep PDF e2e" "$WTMP/s.pdf" "application/pdf")
D_DOCX=$(upload "Tep Word e2e" "$WTMP/s.docx" "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
wait_content() { # <token> <nhãn> <docId>: chờ đến khi tìm theo NỘI DUNG ra đúng tài liệu vừa tải lên
  local t0=$(date +%s%N) hit=""
  for i in $(seq 1 60); do
    hit=$(search "$HR_MGR" "$1" --data-urlencode "limit=50" | python -I -c "import sys,json
try: print(any(str(r['source_doc_id'])=='$3' and r.get('content_match') for r in json.load(sys.stdin)['data']))
except Exception: print(False)")
    [ "$hit" = True ] && { ok "$2: tìm theo nội dung tệp ra tài liệu #$3 sau $(( ($(date +%s%N)-t0)/1000000 )) ms"; return; }
    sleep 0.5
  done
  bad "$2: không tìm được tài liệu #$3 theo nội dung tệp sau 30s"
}
wait_content "$TOKEN_TXT" "TXT" "$D_TXT"; wait_content "$TOKEN_PDF" "PDF" "$D_PDF"; wait_content "$TOKEN_DOCX" "DOCX" "$D_DOCX"
check "nội dung tệp vẫn theo phân quyền: phòng ACC KHÔNG tìm thấy" "$(search "$ACC_STAFF" "$TOKEN_TXT" | jget total)" 0
sleep 12   # chờ Prometheus quét xong số đo của 3 tệp vừa lập chỉ mục (chu kỳ quét 5 giây)
N1=$(curl -s --get http://127.0.0.1:9090/api/v1/query --data-urlencode 'query=sum(dms_content_jobs_total{status="indexed"})' | jget data.result.0.value.1)
sleep 12
N2=$(curl -s --get http://127.0.0.1:9090/api/v1/query --data-urlencode 'query=sum(dms_content_jobs_total{status="indexed"})' | jget data.result.0.value.1)
check "worker không tự xử lý lặp lại sự kiện do chính nó gây ra" "$N2" "$N1"
# Node HR có hai bản (dept-hr, dept-hr-2) cùng alias: chỉ dừng một bản thì bản còn lại vẫn trả lời, nên phải dừng CẢ HAI
check "dừng cả hai bản node HR: dự phòng Central Index KHÔNG chứa nội dung tệp (nội dung không rời node)" "$(docker stop dept-hr dept-hr-2 >/dev/null; sleep 1; search "$EXEC" "$TOKEN_TXT" | jget total; docker start dept-hr dept-hr-2 >/dev/null)" 0
settle
for i in $(seq 1 40); do [ "$(search "$HR_MGR" "" --data-urlencode "limit=1" | jget partial)" = false ] && break; sleep 2; done

echo "== 10. Nhân bản & chịu lỗi của tầng dùng chung =="
REPL=$(docker compose ps -q search-engine-service | wc -l | tr -d ' ')
[ "$REPL" -ge 2 ] && ok "Search Gateway đang chạy $REPL bản" || bad "Search Gateway chỉ có $REPL bản"
VICTIM=$(docker compose ps -q search-engine-service | head -1)
docker stop "$VICTIM" >/dev/null
FAILS=0; for i in $(seq 1 8); do [ "$(http -H "Authorization: Bearer $HR_MGR" "$BASE/api/search?q=hop%20dong&limit=$i")" = 200 ] || FAILS=$((FAILS+1)); done
check "tắt 1 bản Search Gateway: 8/8 truy vấn vẫn thành công" "$FAILS" 0
docker start "$VICTIM" >/dev/null
docker compose up -d --no-build --scale content-worker=2 >/dev/null 2>&1
PARTS=""
for i in $(seq 1 30); do
  PARTS=$(curl -s --get http://127.0.0.1:9090/api/v1/query --data-urlencode 'query=dms_content_assigned_partitions' | python -I -c "import sys,json; print(','.join(sorted(r['value'][1] for r in json.load(sys.stdin)['data']['result'])))")
  case "$PARTS" in *,*) echo "$PARTS" | grep -q '^0' || break;; esac; sleep 3
done
case "$PARTS" in *,*) echo "$PARTS" | grep -q '^0' && bad "consumer group chưa chia partition cho cả 2 worker ($PARTS)" || ok "2 content-worker: Kafka chia partition cho từng bản ($PARTS)";; *) bad "không thấy 2 worker ($PARTS)";; esac
settle

echo "== 11. Distributed tracing (OpenTelemetry -> Jaeger) =="
# Span được xuất theo lô 5 giây ở từng service: chờ qua một chu kỳ xuất (tương đương forceFlush) trước khi tra Jaeger
settle
R=$(search "$HR_MGR" "truy vet $(date +%s)")
TID=$(echo "$R" | jget traceId)
[ -n "$TID" ] && ok "phản hồi tìm kiếm mang traceId ($TID)" || bad "phản hồi không có traceId"
TR=""
for i in $(seq 1 15); do
  TR=$(curl -s "http://127.0.0.1:16686/api/traces/$TID" | python -I -X utf8 -c "import sys,json
try:
    t=json.load(sys.stdin)['data'][0]
    svc=sorted({p['serviceName'] for p in t['processes'].values()})
    fed=sorted(s['operationName'] for s in t['spans'] if s['operationName'].startswith('federated.query'))
    print(len(t['spans']), ','.join(svc), '|'.join(fed))
except Exception:
    print('')")
  # Các service gửi span theo lô (5 giây): chờ đến khi trace có đủ Search Gateway và node
  # chờ đủ span của ÍT NHẤT HAI node (mỗi service xuất lô riêng nên span về lệch nhau vài giây)
  case "$TR" in *dept-acc*dept-hr*search-gateway*|*dept-hr*dept-sales*search-gateway*|*dept-acc*dept-sales*search-gateway*) break;; esac; sleep 2
done
echo "     trace: $TR"
case "$TR" in *search-gateway*) ok "trace có span của Search Gateway";; *) bad "trace thiếu Search Gateway";; esac
case "$TR" in *dept-hr*dept-sales*|*dept-acc*dept-hr*|*dept-acc*dept-sales*) ok "MỘT trace xuyên qua nhiều node phòng ban (truyền traceparent)";; *) bad "trace không xuyên tới các node";; esac
case "$TR" in *"federated.query ACC"*"federated.query HR"*) ok "mỗi node là một span riêng (federated.query <mã>)";; *) bad "thiếu span federated.query";; esac

echo "== 12. Giám sát hệ thống: biết node sập và phục hồi =="
SYS="$BASE/api/search/executive/system"
check "Nhân viên KHÔNG xem được trang giám sát" "$(http -H "Authorization: Bearer $HR_STAFF" $SYS)" 403
check "Trưởng phòng KHÔNG xem được trang giám sát" "$(http -H "Authorization: Bearer $HR_MGR" $SYS)" 403
sysq() { curl -s -H "Authorization: Bearer $EXEC" $SYS | python -I -X utf8 -c "import sys,json
d=json.load(sys.stdin)
$1"; }
check "Ban Giám đốc: mọi node đang sống, không có sự cố đang diễn ra" "$(sysq "print(d['summary']['departmentsUp']==d['summary']['departmentsTotal'] and d['summary']['ongoingIncidents']==0)")" True
check "số liệu lấy từ nguồn thật (Prometheus + Kafka Connect đọc được)" "$(sysq "print(d['sources']['prometheus'] and d['sources']['kafkaConnect'])")" True
check "mỗi phòng ban có đủ 48 ô lịch sử 24 giờ" "$(sysq "print(all(len(x['buckets'])==48 for x in d['departments']))")" True
NSSE="$WTMP/node_sse.txt"; STSSE="$WTMP/staff_sse.txt"
curl -s -N -m 60 -H "Authorization: Bearer $EXEC" "$BASE/api/search/notifications/stream" > "$NSSE" 2>/dev/null &
P1=$!
curl -s -N -m 60 -H "Authorization: Bearer $HR_STAFF" "$BASE/api/search/notifications/stream" > "$STSSE" 2>/dev/null &
P2=$!
sleep 2
stop_node acc; sleep 3
check "tắt node ACC: trang giám sát báo ACC không phục vụ" "$(sysq "print([x['lifecycle'] for x in d['departments'] if x['code']=='ACC'][0] != 'ACTIVE')")" True
check "có sự cố ĐANG DIỄN RA của ACC kèm nguyên nhân" "$(sysq "print(any(i['deptCode']=='ACC' and i['ongoing'] and i['reason'] for i in d['incidents']))")" True
check "trạng thái tổng chuyển sang suy giảm" "$(sysq "print(d['overall'])")" degraded
start_node acc
for i in $(seq 1 40); do [ "$(sysq "print([x['lifecycle'] for x in d['departments'] if x['code']=='ACC'][0])")" = ACTIVE ] && break; sleep 2; done
check "bật lại: sự cố của ACC được đóng, có giờ phục hồi và thời lượng" "$(sysq "i=[i for i in d['incidents'] if i['deptCode']=='ACC'][0]; print((not i['ongoing']) and i['resolvedAt'] is not None and i['durationSeconds']>0)")" True
sleep 2
grep -q NODE_DOWN "$NSSE" && grep -q NODE_RECOVERED "$NSSE" && ok "Ban Giám đốc nhận cảnh báo tức thời NODE_DOWN và NODE_RECOVERED" || bad "Ban Giám đốc không nhận đủ cảnh báo node"
check "Nhân viên KHÔNG nhận cảnh báo hạ tầng" "$(grep -c 'NODE_' "$STSSE")" 0
kill $P1 $P2 2>/dev/null
for i in $(seq 1 40); do [ "$(search "$HR_MGR" "" --data-urlencode "limit=1" | jget partial)" = false ] && break; sleep 2; done
settle

echo "== 13. Trung tâm sập, tìm kiếm liên phòng vẫn chạy (không có điểm chết ở chỉ mục trung tâm) =="
for i in $(seq 1 30); do [ "$(search "$HR_MGR" "" --data-urlencode "limit=1" | jget partial)" = false ] && break; sleep 2; done
# PRE-FLIGHT WARM-UP (không tính vào SLA): mở sẵn pool DB, làm ấm JIT của V8 và phân giải DNS nội bộ Docker (127.0.0.11)
# cho đường Gateway -> node, để số đo sau đó phản ánh hệ thống đang chạy chứ không phải khởi động nguội.
COLD_SLA_MS="${COLD_SLA_MS:-2500}"; WARM_SLA_MS="${WARM_SLA_MS:-800}"
curl -s -o /dev/null "$BASE/health" || true
curl -s -o /dev/null -H "Authorization: Bearer $HR_MGR" "$BASE/api/dept/hr/documents?limit=1" || true
curl -s -o /dev/null -H "Authorization: Bearer $ACC_STAFF" "$BASE/api/search/documents/HR/$DOC_ID/download" || true
for w in 1 2 3; do search "$HR_MGR" "warmup $w" >/dev/null; done
search "$HR_MGR" "hop dong" --data-urlencode "limit=98" >/dev/null   # nạp bản chụp danh bạ và quyền chia sẻ (limit khác để không dùng cache kết quả)
BASE_N=$(search "$HR_MGR" "hop dong" --data-urlencode "limit=97" | jget total)
docker stop postgres-central-primary postgres-central-replica >/dev/null
sleep 6   # > 5 giây: danh bạ trong bộ nhớ (cache ngắn của Registry) đã hết hạn nên phải thử nguồn gốc và nhận lỗi
CODE=$(curl -s -o "$WTMP/c13.json" -w '%{http_code}' -H "Authorization: Bearer $HR_MGR" --get "$BASE/api/search" --data-urlencode "q=hop dong" --data-urlencode "limit=96")
check "tắt CSDL trung tâm: tìm kiếm vẫn trả HTTP 200 (trước đây: 502, cả 2 bản Gateway sập)" "$CODE" 200
check "mọi node vẫn trả lời trực tiếp (OK)" "$(python -I -c "import json;d=json.load(open(r'$WTMP/c13.json'));print(all(n['status']=='OK' for n in d['nodes']))")" True
check "kết quả đầy đủ như lúc bình thường" "$(python -I -c "import json;print(json.load(open(r'$WTMP/c13.json'))['total'])")" "$BASE_N"
check "phản hồi báo rõ chế độ suy giảm của chỉ mục trung tâm" "$(python -I -c "import json;print(bool((json.load(open(r'$WTMP/c13.json')).get('degraded') or {}).get('centralIndex')))")" True
# Hai ngưỡng SLA tách bạch: COLD = lần đầu sau khi trung tâm sập (trả giá chờ hết thời gian kết nối, mạch ngắt mở từ đây);
# WARM = các lần sau (mạch ngắt đã mở, dùng bản chụp ngay).
# Mỗi bản Gateway tự phát hiện trung tâm sập ở lần truy vấn ĐẦU TIÊN của nó (mạch ngắt riêng từng bản, tối đa 1,2 giây chờ kết nối),
# nên "cold" phải đo cho TỪNG bản: gửi 3 truy vấn cho mỗi bản (một bản có thể trả giá tới hai lần chờ: đọc danh bạ và làm giàu kết quả) rồi lấy lần chậm nhất.
REPLICAS=$(docker compose ps -q search-engine-service | wc -l | tr -d ' ')
# Đo bằng time_total của curl TRONG MỘT tiến trình (không fork date/curl riêng cho mỗi lần đo: trên máy thiếu RAM việc fork chậm, làm lệch số đo).
# Trả về "mã_HTTP mili_giây"; lưu thân phản hồi để in tookMs từng node khi vượt ngưỡng.
search_ms() { curl -s -o "$2" -w '%{http_code} %{time_total}' -H "Authorization: Bearer $1" --get "$BASE/api/search" --data-urlencode "q=hop dong $RANDOM" | awk '{printf "%s %d", $1, $2*1000}'; }
COLD_MS=0; NONOK=0
for i in $(seq 1 $(( REPLICAS * 3 ))); do
  read -r C D <<< "$(search_ms "$HR_MGR" "$WTMP/cold_$i.json")"
  [ "$C" = 200 ] || NONOK=$((NONOK+1))
  [ "$D" -gt "$COLD_MS" ] && COLD_MS=$D
done
[ "$COLD_MS" -le "$COLD_SLA_MS" ] && ok "Cold SLA: lần đầu của từng bản Gateway sau khi trung tâm sập, chậm nhất ${COLD_MS} ms (≤ ${COLD_SLA_MS} ms)" || bad "Cold SLA vượt: ${COLD_MS} ms (> ${COLD_SLA_MS} ms)"
WARM_WORST=0; WARM_BODY=""
for i in 1 2 3 4 5; do
  read -r C W <<< "$(search_ms "$HR_MGR" "$WTMP/warm_$i.json")"
  [ "$C" = 200 ] || NONOK=$((NONOK+1))
  if [ "$W" -gt "$WARM_WORST" ]; then WARM_WORST=$W; WARM_BODY="$WTMP/warm_$i.json"; fi
done
[ "$WARM_WORST" -le "$WARM_SLA_MS" ] && ok "Warm SLA: 5 lần sau, chậm nhất ${WARM_WORST} ms (≤ ${WARM_SLA_MS} ms)" || bad "Warm SLA vượt: chậm nhất ${WARM_WORST} ms (> ${WARM_SLA_MS} ms)"
[ "$WARM_WORST" -gt "$WARM_SLA_MS" ] && python -I -X utf8 -c "import json,sys;d=json.load(open(sys.argv[1]));print('    tookMs theo node:',[(n.get('code'),n.get('status'),n.get('tookMs')) for n in d.get('nodes',[])])" "$WARM_BODY" 2>/dev/null
[ "$NONOK" -eq 0 ] && ok "Mọi truy vấn trong vòng đo SLA trả HTTP 200" || bad "Có $NONOK truy vấn trong vòng đo SLA không trả HTTP 200"
check "cả hai bản Search Gateway vẫn sống" "$(docker compose ps -q search-engine-service | wc -l | tr -d ' ')" 2
# Sổ chia sẻ nằm ở node chủ: trung tâm sập KHÔNG chặn cấp quyền, cũng KHÔNG chặn thu hồi
SHC=$(curl -s -X POST $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json' -d "{\"docId\":$DOC_ID,\"sharedWithDept\":\"ACC\",\"permission\":\"DOWNLOAD\",\"expiresInDays\":1}")
SHC_ID=$(echo "$SHC" | jget share.share_id)
[ -n "$SHC_ID" ] && ok "trung tâm sập: HR vẫn CẤP được quyền chia sẻ (share $SHC_ID, sổ nằm ở node HR)" || bad "không cấp được chia sẻ khi trung tâm sập: $SHC"
check "trung tâm sập: ACC thấy ngay tài liệu vừa chia sẻ" "$(search "$ACC_STAFF" "$TITLE" --data-urlencode "limit=95" | jget data.0.access_mode)" SHARED
curl -s -H "Authorization: Bearer $ACC_STAFF" -o "$WTMP/c13dl.txt" "$BASE/api/search/documents/HR/$DOC_ID/download"
check "trung tâm sập: ACC vẫn tải được tệp thật (node HR tự kiểm tra quyền DOWNLOAD)" "$(python -I -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$WTMP/c13dl.txt")" "$SHA_LOCAL"
curl -s -X DELETE $BASE/api/dept/hr/shares/$SHC_ID -H "Authorization: Bearer $HR_MGR" >/dev/null
check "trung tâm sập: THU HỒI có hiệu lực ngay, ACC không còn thấy" "$(search "$ACC_STAFF" "$TITLE" --data-urlencode "limit=94" | jget total)" 0
check "trung tâm sập: sau thu hồi ACC tải file bị 403" "$(http -H "Authorization: Bearer $ACC_STAFF" $BASE/api/search/documents/HR/$DOC_ID/download)" 403
EVT="trungtamsap$(date +%s)"
printf 'Ghi luc trung tam sap %s\n' "$EVT" > "$WTMP/c13.txt"
NEWD=$(curl -s -X POST "$BASE/api/dept/hr/documents" -H "Authorization: Bearer $HR_MGR" -F "title=Tai lieu $EVT" -F "description=kiem thu outbox" -F "accessLevel=DEPARTMENT" -F "file=@$WTMP/c13.txt;type=text/plain" | jget docId)
[ -n "$NEWD" ] && ok "node vẫn ghi tài liệu mới khi trung tâm sập (#$NEWD)" || bad "node không ghi được tài liệu khi trung tâm sập"
docker start postgres-central-primary postgres-central-replica >/dev/null
for i in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' postgres-central-primary)" = healthy ] && break; sleep 2; done
GOT=0; for i in $(seq 1 40); do
  c=$(docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "select count(*) from search_document s join department d using(department_id) where d.dept_code='HR' and s.source_doc_id=$NEWD" 2>/dev/null)
  [ "$c" = 1 ] && { GOT=1; break; }; sleep 2; done
check "trung tâm hồi phục: sự kiện tạo lúc sập về đủ chỉ mục (không bị mất vào DLQ)" "$GOT" 1
sleep 45
check "không có sự cố giả (node bị đánh dấu sập oan) do trung tâm sập" "$(docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "select count(*) from department_status_event where occurred_at > now() - interval '3 minutes' and to_state='DEGRADED'")" 0
settle

echo "== 14. Chống đua khi cấp quyền, lỗi kho tệp (MinIO) và trả kết quả một phần =="
# 14.1 CHỐNG ĐUA: 8 yêu cầu cấp quyền ĐỒNG THỜI cùng (tài liệu, phòng nhận) -> CSDL chỉ giữ MỘT lượt đang hiệu lực
for i in 1 2 3 4 5 6 7 8; do
  curl -s -o "$WTMP/race$i.code" -w '%{http_code}' -X POST $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json'     -d "{\"docId\":$DOC_ID,\"sharedWithDept\":\"ACC\",\"permission\":\"DOWNLOAD\",\"expiresInDays\":1}" > "$WTMP/race$i.http" &
done
wait
check "8 yêu cầu cấp quyền đồng thời: không có lỗi 5xx" "$(cat $WTMP/race*.http | grep -c '^5')" 0
check "8 yêu cầu đồng thời: CSDL chỉ có 1 lượt chia sẻ đang hiệu lực" "$(docker exec postgres-hr-primary psql -U "$POSTGRES_HR_USER" -d "$POSTGRES_HR_DB" -tAc "select count(*) from document_share where doc_id=$DOC_ID and shared_with_dept='ACC' and not is_revoked" | tr -d '[:space:]')" 1
check "chèn thẳng dòng thứ hai bị CSDL từ chối (chỉ mục duy nhất)" "$(docker exec postgres-hr-primary psql -U "$POSTGRES_HR_USER" -d "$POSTGRES_HR_DB" -tAc "insert into document_share(doc_id,shared_with_dept,permission) values ($DOC_ID,'ACC','VIEW')" 2>&1 | grep -c 'idx_unique_active_share')" 1
# Phân biệt cấp mới / gia hạn trong phản hồi
check "cấp lại cho phòng đã có quyền: action=EXTENDED (đổi quyền + gia hạn, không nhân dòng)" "$(curl -s -X POST $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json' -d "{\"docId\":$DOC_ID,\"sharedWithDept\":\"ACC\",\"permission\":\"VIEW\",\"expiresInDays\":2}" | jget action)" EXTENDED
for sid in $(curl -s $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" | python -I -c "import json,sys; print(' '.join(str(x['share_id']) for x in json.load(sys.stdin) if str(x['source_doc_id'])=='$DOC_ID'))"); do curl -s -X DELETE $BASE/api/dept/hr/shares/$sid -H "Authorization: Bearer $HR_MGR" >/dev/null; done
check "cấp sau khi đã thu hồi: action=CREATED" "$(curl -s -X POST $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" -H 'content-type: application/json' -d "{\"docId\":$DOC_ID,\"sharedWithDept\":\"ACC\",\"permission\":\"DOWNLOAD\",\"expiresInDays\":1}" | jget action)" CREATED
# 14.2 LỖI KHO TỆP: MinIO của HR sập nhưng DB HR còn sống -> 503 STORAGE_NODE_UNAVAILABLE (không phải 500)
docker stop minio-hr >/dev/null
sleep 2
CODE=$(curl -s -o "$WTMP/st.json" -w '%{http_code}' -H "Authorization: Bearer $ACC_STAFF" "$BASE/api/search/documents/HR/$DOC_ID/download")
check "MinIO của HR sập: tải file trả 503 (không phải 500)" "$CODE" 503
check "503 mang errorCode STORAGE_NODE_UNAVAILABLE" "$(python -I -c "import json;print(json.load(open(r'$WTMP/st.json',encoding='utf-8')).get('errorCode'))")" STORAGE_NODE_UNAVAILABLE
check "MinIO HR sập: tìm kiếm HR (DB) vẫn đạt" "$(search "$HR_MGR" "$TITLE" --data-urlencode "limit=92" | jget total)" 1
docker start minio-hr >/dev/null
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' minio-hr)" = healthy ] && break; sleep 2; done
curl -s -o "$WTMP/again.txt" -H "Authorization: Bearer $ACC_STAFF" "$BASE/api/search/documents/HR/$DOC_ID/download"
check "MinIO hồi phục: tải lại được, đúng SHA-256" "$(python -I -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$WTMP/again.txt")" "$SHA_LOCAL"
# 14.3 KẾT QUẢ MỘT PHẦN: node SALES sập -> "được chia sẻ với tôi" vẫn trả phần còn lại, nói rõ node nào thiếu
OK_PART=$(curl -s -H "Authorization: Bearer $ACC_STAFF" $BASE/api/search/shares/shared-with-me | python -I -c "import json,sys;d=json.load(sys.stdin);print(d['isPartial'],d['unavailableNodes'])")
check "mọi node sống: isPartial=False, không thiếu node" "$OK_PART" "False []"
docker stop dept-sales >/dev/null
sleep 3
PART=$(curl -s -H "Authorization: Bearer $ACC_STAFF" $BASE/api/search/shares/shared-with-me | python -I -c "import json,sys;d=json.load(sys.stdin);print(d['isPartial'],'SALES' in d['unavailableNodes'],len(d['shares'])>0)")
check "SALES sập: isPartial=True, unavailableNodes có SALES, vẫn trả tài liệu của HR" "$PART" "True True True"
docker start dept-sales >/dev/null
for i in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' dept-sales)" = healthy ] && break; sleep 2; done
for i in $(seq 1 30); do [ "$(curl -s -H "Authorization: Bearer $ACC_STAFF" $BASE/api/search/shares/shared-with-me | jget isPartial)" = false ] && break; sleep 2; done
check "SALES hồi phục: isPartial trở lại False" "$(curl -s -H "Authorization: Bearer $ACC_STAFF" $BASE/api/search/shares/shared-with-me | jget isPartial)" false
# dọn
for sid in $(curl -s $BASE/api/dept/hr/shares -H "Authorization: Bearer $HR_MGR" | python -I -c "import json,sys; print(' '.join(str(x['share_id']) for x in json.load(sys.stdin) if str(x['source_doc_id'])=='$DOC_ID'))"); do curl -s -X DELETE $BASE/api/dept/hr/shares/$sid -H "Authorization: Bearer $HR_MGR" >/dev/null; done
settle

echo "== 15. CDC cho SALES: tài liệu tạo ở node SALES phải vào CHỈ MỤC TRUNG TÂM (P0.6.4) =="
SALES_STAFF=$(login sales "sales_staff" "$DEMO_STAFF_PASSWORD")
SALES_TS=$(date +%s%N)
SALES_TITLE="sales cdc e2e $SALES_TS"
printf 'noi dung sales %s\n' "$SALES_TS" > "$TMP/sales.txt"
SCODE=$(curl -s -o "$WTMP/sales_doc.json" -w '%{http_code}' -X POST "$BASE/api/dept/sales/documents" -H "Authorization: Bearer $SALES_STAFF" -F "title=$SALES_TITLE" -F "description=kiem thu CDC sales" -F "accessLevel=DEPARTMENT" -F "file=@$WTMP/sales.txt;type=text/plain")
check "tạo tài liệu tại node SALES (HTTP $SCODE)" "$SCODE" 201
SN=0
for i in $(seq 1 30); do
  SN=$(docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "select count(*) from search_document s join department d using(department_id) where d.dept_code='SALES' and s.title='$SALES_TITLE'" 2>/dev/null | tr -d '[:space:]')
  [ "$SN" = 1 ] && break
  sleep 1
done
check "CDC SALES: tài liệu có trong CHỈ MỤC TRUNG TÂM trong 30 giây (không chỉ tìm trực tiếp trên node)" "$SN" 1
check "tìm liên phòng qua API Gateway thấy tài liệu SALES" "$(search "$SALES_STAFF" "$SALES_TITLE" | jget total)" 1

rm -rf "$TMP"
echo; echo "===== KẾT QUẢ: $PASS đạt, $FAIL lỗi ====="
[ "$FAIL" -eq 0 ]
