---
name: dms-incident-playbook
description: "BẮT BUỘC khi chẩn đoán, sửa hoặc kiểm thử sự cố trong dự án DMS: Kafka và CDC, projector và tiến độ, CSDL trung tâm sập, registry và node, SLA và hiệu năng, replica HA, Docker và Windows. Gồm kiến thức đã xác minh từ mã và số đo, cách suy luận đã dùng, và bảng xử lý từng trường hợp."
---

# Playbook sự cố DMS

Skill này ghi lại những gì đã **xác minh** trong dự án (có đường dẫn mã hoặc số đo), cách suy luận đã dùng và đã kiểm chứng, và cách xử lý từng trường hợp. Đọc cùng `dms-engineering-principles` (nguyên tắc chung, bảng sự cố) và `plan-before-code` (chốt kế hoạch trước khi sửa). Chỉ mục skill: `dms-lessons-and-skill-index`. Nhật ký: `docs/12-nhat-ky-tien-trinh.md`.

## 1. Tư duy chẩn đoán (làm theo thứ tự)

1. **Đo triệu chứng bằng số thật, không tin thông báo.** Lệnh báo "thành công" có thể sai. Ví dụ: `echo "exit=$?"` ở cuối chuỗi lệnh nền luôn cho mã 0 của `echo`; phải đọc dòng `exit=` bên trong file kết quả.
2. **Xác định lớp gây chậm hoặc lỗi.** Gateway (nginx `rt`, `uct`, `uht`, `urt`), dịch vụ (log Nest, stack trace), CSDL, Kafka, hạ tầng. `urt` tách thời gian upstream khỏi thời gian client.
3. **Đọc log trong khung thời gian có kiểm soát.** `docker logs` trên container có log lớn rất chậm khi máy thiếu RAM. Dùng `--tail N` hoặc xuất ra file rồi lọc, chạy nền; không grep toàn bộ log ở foreground.
4. **Kiểm giả định của test trước khi kết luận sản phẩm lỗi.** Đã gặp: số partition ghi cứng (7) lỗi thời khi e2e ghi vào partition mới; partition trống hiển thị LAG `-` bị đếm là lag; kiểm tra "dừng node HR" chỉ dừng một bản trong khi `dept-hr-2` cùng alias vẫn trả lời.
5. **Phân biệt nguyên nhân gốc và triệu chứng; chứng minh bằng thí nghiệm A/B có kiểm soát.** Ví dụ: để chứng minh nhánh khớp dấu vân tay có commit, đặt offset nhóm HR p2 lùi về 1250 khi log-end là 1254; sau khởi động offset trở lại 1254. Partition đó không có tin sau 1253 nên không có đường commit nào khác.
6. **Đo đúng lớp.** Đo thời gian trong Git Bash (fork `date` và `curl` mỗi lần) bị nhiễu nặng khi máy thiếu RAM: đã thấy chênh khoảng 1,3 s không xuất hiện trong nginx. Dùng `curl -w '%{time_total}'` trong một tiến trình, hoặc đối chiếu `urt`.
7. **Mã trong image là bằng chứng, không phải mã nguồn.** Sau khi build, grep bản đã biên dịch trong image trước khi recreate.
8. **Thay đổi hạ tầng không đảo ngược phải được chốt trước:** recreate container Kafka, xóa topic, `TRUNCATE`, restart Docker Desktop, `wsl --shutdown`, đổi dữ liệu thật. Sao lưu và có đường lùi trước. Đã có lần restart Docker trước khi hỏi; từ đó luôn hỏi trước.
9. **Không tuyên bố xong khi còn FAIL.** Ghi cả lần FAIL, nguyên nhân đã biết và chưa biết. Không hạ ngưỡng để qua kiểm tra.
10. **Tài liệu cũ sai thì sửa theo số đo**, ghi "đính chính" kèm ngày.

## 2. Kiến thức đã xác minh

### 2.1 Kafka và CDC
- Broker `apache/kafka` ghi log vào `/tmp/kafka-logs` **trong container** (compose không đặt `KAFKA_LOG_DIRS`). Volume `kafka-data` gắn vào `/var/lib/kafka/data` nhưng trống. **Tạo lại container = mất toàn bộ log topic.** Đã xảy ra: container tạo lúc 2026-11-18 20:14 UTC; topic `dms.dept.sales.document` được tạo lại 2026-11-19 08:36 UTC.
- Tắt Docker/WSL không sạch làm broker phục hồi và cắt đoạn cuối một số segment (log `Corruption found ... truncating`); đã thấy ở topic heartbeat.
- Debezium: connector `outbox-<mã>`, `snapshot.mode=no_data` (không tự snapshot lại), mật khẩu replication riêng theo phòng `REPL_PASSWORD_<MÃ>` (chỉ ghi tên biến).
- kafkajs 2.2.4 (`services/search-engine-service/node_modules/kafkajs`):
  - Không đọc được TopicId (cần Metadata v10 trở lên).
  - `consumer.seek`: runner dừng phần còn lại của batch khi có seek đang chờ (`src/consumer/runner.js:226`); seek được áp dụng trước lần fetch kế tiếp (`consumerGroup.js:454, 660`).
  - `commitOffsets` chỉ có hiệu lực khi consumer đang thuộc nhóm. `commitKafkaOffset` nuốt lỗi commit (`.catch`).
- Reset offset nhóm (`kafka-consumer-groups --reset-offsets ... --execute`) chỉ được khi nhóm ở trạng thái `Empty`. Sau khi dừng thành viên phải chờ session timeout (khoảng 30 s); reset sớm báo "current state is Stable".
- Đọc lag (`--describe`): partition chưa có tin hiển thị CURRENT `-`, LOG-END `0`, LAG `-`: **không có lag**. Partition có tin mà CURRENT `-`: lag chưa xác định, coi là bất thường.
- Projector (`services/search-engine-service/src/modules/projector/projector.service.ts`):
  - B1 kiểm khoảng offset: tiến độ ≥ log-end, hoặc < log-start, hoặc thiếu dấu vân tay → đọc lại từ log-start (log "Phát hiện ...").
  - B2 đọc lại bản ghi tại tiến độ và so dấu vân tay (băm topic, partition, offset, khóa, timestamp, giá trị). Khớp: đặt OK, commit `offset + 1`, tiếp tục. Không khớp: reset (log "dấu vân tay không khớp ... topic đã được tạo lại").
  - Upsert tiến độ dùng `GREATEST` và `CASE` trên `last_fingerprint`. `source_version` chặn bản cũ ghi đè bản mới.
  - Reset **không phải** dựng lại chỉ mục: sự kiện đã mất khỏi topic không quay lại, và tài liệu không còn trong topic mới vẫn nằm trong chỉ mục. Đối soát đầy đủ cần resync (feature 3).

### 2.2 CSDL trung tâm, pool và bản chụp
- `app.module.ts`: `connectionTimeoutMillis` = `CENTRAL_CONNECT_TIMEOUT_MS` (mặc định 1200 ms). Mỗi kết nối trung tâm thất bại tốn tới 1,2 s.
- `snapshot.service.ts`: mạch ngắt nguồn trung tâm với `CENTRAL_COOLDOWN_MS` (mặc định 4000 ms). Trong cooldown trả bản chụp ngay. Hết cooldown: một yêu cầu thăm dò chạy ngầm nếu đã có bản chụp. `sourceDown` = `downUntil > 0`.
- `registry.service.ts` `listForSearch`: cache 5 s; bản chụp được cache ngắn để thử lại nguồn sau.
- `search.service.ts`:
  - `lookupCentralIds` bỏ qua khi `sourceDown`.
  - `fallback` trả `UNAVAILABLE` ngay khi chỉ mục trung tâm đang ngừng.
  - Không cache kết quả khi `partial` hoặc `centralDown`.
  - `recordSearchHistory` chạy nền và ghi trung tâm cho mỗi truy vấn. Đây là nguồn xếp hàng pool khi trung tâm sập (chưa xử lý, xem `docs/12`).
- Mỗi bản search tự chịu một lần thất bại đầu tiên sau khi trung tâm sập (khoảng 1,2–1,3 s). Đây là thiết kế; các lần sau dùng bản chụp.
- Breaker theo node: `SEARCH_BREAKER_FAILURES` = 3, `SEARCH_BREAKER_RESET_MS` = 10000.
- Fallback tìm trong `search_vector` và tiêu đề, **không** tìm trong nội dung tệp.

### 2.3 Registry và node
- Sweeper của registry chạy mỗi 5 s; `HEARTBEAT_TIMEOUT_MS` = 30 s. Khi `sourceDown` thì không đánh DEGRADED (`quietUntil`).
- `register` và `heartbeat` (commit `6c6de8f`): lỗi kết nối trung tâm → 503 kèm `Retry-After: 5`, đánh dấu mạch ngắt (`toCentralError`, `withRetryAfter`). Lỗi khác (404 khi node chưa đăng ký, 400 khi dữ liệu sai) giữ nguyên.
- Node `registry-client.service.ts`:
  - `post()` có `AbortSignal.timeout(3000)`; lỗi HTTP mang thuộc tính `status`.
  - Heartbeat: **chỉ đăng ký lại khi 404**. Mọi lỗi khác (503, timeout, mất kết nối) giữ heartbeat và ghi cảnh báo.
  - Đăng ký: backoff 1 s, tối đa 5 s.
- HA: `dept-hr` và `dept-hr-2` cùng `DATABASE_URL` và cùng alias `dept-hr` trên hai mạng. Dừng một bản thì bản còn lại vẫn trả lời (đã đo). Muốn mô phỏng "node HR sập" phải dừng cả hai.
- `dept-sales` là project compose riêng:
  - File `docker-compose.department.yml`, service `dept`, image `dms/department-service:2.0`, env từ `.env` và `departments/sales.env`.
  - Recreate: `docker compose -p dept-sales -f docker-compose.department.yml --env-file .env --env-file departments/sales.env up -d --no-build --no-deps --force-recreate dept`.
  - Không in giá trị biến env ra log hay tài liệu.

### 2.4 Đo hiệu năng và e2e
- Nginx access log có `rt` (tổng), `uct` (kết nối upstream), `uht` (header upstream), `urt` (phản hồi upstream). Đây là số đo phía server.
- SLA e2e: Cold ≤ 2500 ms (lần đầu sau khi trung tâm sập, mỗi bản search một lần); Warm ≤ 800 ms. Đo bằng `time_total` của curl trong một tiến trình, có kiểm HTTP 200 (từ lần 17).
- e2e dừng trung tâm bằng `docker stop postgres-central-primary postgres-central-replica`.
- Biến mật khẩu của e2e (`DEMO_*_PASSWORD`) đến từ `.env`; không in giá trị.
- Số kiểm tra e2e hiện tại: 100 (lần 16, 17).

### 2.5 Windows và Docker
- Build: `DOCKER_BUILDKIT=0 docker compose build <svc>` (buildx đôi khi lỗi gRPC). Cảnh báo "Can't add file ...frontend\node_modules..." xuất hiện khi gửi build context: đã biết, chưa sửa `.dockerignore`.
- `docker restart` không đổi image. Đổi image phải **recreate**: `docker compose up -d --no-build --no-deps --force-recreate <svc>`.
- Máy thiếu RAM (commit cao): lệnh nặng có thể vượt 120 s. Chạy nền, đọc file kết quả; không chạy song song với test đo thời gian.
- Đo RAM: PowerShell `Get-CimInstance Win32_OperatingSystem` (`FreePhysicalMemory`, `TotalVisibleMemorySize`, đơn vị KB). `vmmemWSL` là máy ảo chạy Docker.
- PowerShell 5.1: file `.ps1` không BOM có ký tự tiếng Việt bị lỗi parse, nên viết ASCII.
- Python Windows không đọc được `/tmp` của Git Bash: dùng `cygpath -m`.
- Script trong repo dùng `cd "$(dirname "$0")/../.."` để chạy từ gốc dự án.

## 3. Bảng xử lý theo trường hợp

| Trường hợp | Dấu hiệu | Xử lý | Kiểm chứng |
|---|---|---|---|
| Container Kafka bị tạo lại | Topic mới, offset nhỏ hơn tiến độ | Projector B1 tự reset và đọc lại; kiểm đối soát node với chỉ mục (`id`, `row_version`, `status`); nếu thiếu tài liệu thì resync | Log "Phát hiện tiến độ X >= log-end Y"; đối soát khớp |
| Tiến độ ≥ log-end | WARN "Phát hiện tiến độ" | Đã tự xử lý; không sửa tay | Tiến độ về log-end − 1; lag 0 |
| Dấu vân tay không khớp | WARN "dấu vân tay không khớp" | Đã tự reset | Epoch test ca 2 |
| CSDL trung tâm sập | Log `CentralPool`; search trả `degraded` | Tìm kiếm qua node và bản chụp; registry trả 503 + `Retry-After`; node giữ heartbeat | Heartbeat trả 503 với `Retry-After: 5`; `ExceptionsHandler` = 0 |
| Yêu cầu chậm vì pool trung tâm xếp hàng | Heartbeat chờ quá 3 s, node báo "aborted due to timeout" | **Chưa xử lý**. Cần thiết kế: không ghi nền khi trung tâm lỗi; giới hạn thời gian chờ pool | Chưa có |
| Node HR, ACC hoặc SALES sập | `UNAVAILABLE` hoặc fallback chỉ mục; DEGRADED sau 30 s | Fallback có cờ `stale`. Với HR phải dừng cả hai bản để mô phỏng | Mục 13 của e2e |
| Lag khác 0 giả | `LAG -` trên partition trống | Bỏ partition có CURRENT `-` và LOG-END 0 | Describe sau khi sửa |
| Test đếm bằng số cứng | Kỳ vọng 7, thực tế 8 | Đếm từ CSDL: tiến độ có fingerprint thuộc topic còn trong Kafka | Epoch test 18/18 |
| SLA đỏ khi máy thiếu RAM | Client báo chậm; nginx `rt` thấp | Không hạ ngưỡng. Đo bằng `time_total`, đối chiếu nginx, ghi số đo | Lần 17: Cold 255 ms, Warm 184 ms |
| Build xong nhưng image thiếu mã | Grep trong image không thấy dấu hiệu | **Không recreate**; kiểm lại build | Grep JS đã biên dịch |
| Đổi image nhưng container cũ | Image ID khác | Recreate, không restart | `docker inspect -f '{{.Image}}'` |
| Consumer group không reset được | "current state is Stable" | Chờ `Empty` (session timeout) | `--describe --state` |
| Số trong tài liệu cũ mâu thuẫn với đo | Ví dụ RAM 2,0 GB trong tài liệu cũ | Dùng số đo; đính chính | Ghi ngày đo |
| Bí mật bị lộ | Giá trị trong log, diff, tài liệu | Không in lại; đề xuất đổi khóa; báo người dùng | Quét diff bằng pattern (chỉ đếm dòng nghi ngờ) |
| Thao tác hạ tầng không đảo ngược | Recreate Kafka, xóa topic, `wsl --shutdown` | Sao lưu trước; chốt với người dùng; rồi mới làm | Ghi nhật ký |
| Sau khi chuyển máy chính HR, CDC kẹt | Connector RUNNING nhưng `pg_replication_slots.active = f`; log Debezium "requested WAL segment ... has already been removed" | Bản chép slot không dùng được (ADR-015). Phục hồi: bỏ slot trên máy chính (Patroni tạo lại), bỏ bản chép trên bản sao, resync phòng. Phòng ngừa: `slot-guard.py`, `heartbeat.action.query` | `hr-failover-test.sh` ca 2 và 3b; `/tmp/slot-guard.json` báo `ok` |
| Slot đứng yên khi phòng không có hoạt động | `confirmed_flush_lsn` không đổi, WAL chưa xác nhận tăng | Kiểm `heartbeat.action.query` có trong cấu hình connector và bảng `debezium_heartbeat` nằm trong publication | Phần chưa xác nhận dưới vài kB |
| Site đứt mạng: node không ghi được CSDL trong site | Đăng nhập 500 "Timed out fetching a new connection from the connection pool" | Lưu lượng nội bộ site phải dùng tên `*-site` (alias chỉ có trên mạng site) | `partition-test.sh` |
| Site đứt mạng: yêu cầu treo hàng chục giây dù CSDL trả lời nhanh | Thời điểm sinh tên tệp và câu INSERT cách nhau lâu | Hỏi tên ở mạng chung treo, chiếm hết luồng phân giải của Node.js: `dns_opt timeout:1 attempts:1`, `UV_THREADPOOL_SIZE: 16` | `partition-test.sh` ca failsafe |
| Hội tụ chậm sau khi hết đứt mạng | Debezium chỉ báo "Producer failure" khoảng 1 phút sau khi nối lại | Socket cũ treo tới lần truyền lại TCP kế tiếp; watchdog khởi động lại task khi node báo `slotActive=false` 30 giây | Thời gian hội tụ trong `partition-test.sh` |
| Gateway trả 429 khi bắn đồng thời | Trang HTML của nginx "429 Too Many Requests" | Giới hạn tốc độ của gateway, đúng thiết kế; bài kiểm tách riêng 429 | `idempotency-test.sh` ca 3 |
| Sentinel chuyển bản chính Redis rất chậm (hàng trăm giây) | Sentinel trả lời chậm, `get-master-addr-by-name` treo | Sentinel phân giải tên đồng bộ; tên của bản chính đã chết làm cả Sentinel chậm. Nhóm Redis dùng IP cố định (ADR-016) | `redis-sentinel-test.sh` ca 2: dưới 20 giây |
| Một bản Search Gateway không nhận thông báo sau khi Redis chuyển bản chính | e2e "Ban Giám đốc không nhận đủ cảnh báo node"; `PUBSUB NUMSUB dms:notices` nhỏ hơn số bản search; log client Redis "Connection is closed" rồi im | Client ioredis rơi vào `end` (do `failoverDetector`). Không bật `failoverDetector`; mọi client có `keepRedisAlive()`. Tạm thời: tạo lại bản search đó | `redis-sentinel-test.sh` kiểm số bản nghe kênh sau mỗi lần chuyển |
| Bài kiểm đứng yên tới hết giờ của bảng điểm, không in thêm dòng nào | Dữ liệu cần chờ đã có (ví dụ tài liệu đã lên chỉ mục) nhưng vòng chờ không in kết quả; máy thiếu bộ nhớ | Một lệnh `docker exec` treo vô hạn. Gốc: trong Git Bash `docker` là script bọc (sh + 2 fork rồi mới gọi `docker.exe`), chậm gấp 4 và dễ treo khi máy thiếu bộ nhớ. Script gọi thẳng `docker.exe` (hàm `docker` trong `lib-central.sh`, `export -f` trong bảng điểm); truy vấn ngắn dùng `dx` (có `timeout`). Sau khi bảng điểm cắt một mục giữa chừng: dừng bộ ghi nền (`touch /tmp/n2_stop` trong `hr-db`), kiểm container nào còn dừng và bật lại (bẫy dọn dẹp không chạy) | Bảng điểm thu gọn sau khi sửa |
| Bộ cân bằng khởi động lại liên tục | Log "daemon is already running"; `RestartCount` tăng mãi | Tệp pid cũ sau khi script tự thoát; `start-keepalived.sh` xóa pid cũ và chờ keepalived dừng hẳn. Tạm thời: `docker compose up -d --force-recreate keepalived-N` | `keepalived-test.sh` ca 5 |
| Keepalived không giữ địa chỉ ảo sau khi tạo lại nginx | Container dùng `network_mode: service:` mất mạng, không tự bật lại | Bộ cân bằng là container riêng (HAProxy + Keepalived), tự thoát khi HAProxy chết | `keepalived-test.sh` |

## 4. Trước khi báo "đã xong"
- Có số đo, lệnh chạy và file kết quả (đường dẫn đầy đủ hoặc trong docs).
- Đã kiểm trên container đang chạy hoặc trong image, không chỉ mã nguồn.
- Đã chạy e2e sau thay đổi; đã ghi cả lần FAIL.
- Đã ghi `docs/12-nhat-ky-tien-trinh.md`, và `docs/07` nếu trạng thái đổi.
- Phân loại từng kết quả: đã kiểm chứng, đã làm nhưng chưa kiểm chứng, hoặc chưa làm.
