# 12. Nhật ký tiến trình dự án DMS

Cập nhật lần cuối: 2026-11-20. Mục đích: ghi theo thứ tự thời gian việc đã làm, vì sao làm, kết quả đo, sự cố và việc còn mở. Người đọc có thể hiểu toàn bộ quá trình mà không cần lật lại cuộc trò chuyện.

Tài liệu liên quan: `07-implementation-status.md` (hiện trạng từng gói, chi tiết kiểm thử), `10-goi-b-va-c.md` (lộ trình P0 → P3), `11-p1-kafka-cutover.md` (runbook P1 và điều kiện C1–C4), `05-adr/` (quyết định kiến trúc).

**Quy ước:**
- Nhãn: **[đã kiểm chứng]** = có lệnh, số đo hoặc log trong phiên làm việc; **[chưa kiểm chứng]** = đã làm nhưng chưa có bằng chứng; **[chưa làm]**.
- Thời gian trong log container là UTC. Giờ trên máy Windows là giờ Việt Nam (UTC+7).
- Ngày commit lấy từ git.
- Bản nháp trước của mục này có một số số liệu chưa đối chiếu được với nhật ký. Lượt cập nhật này đã đối chiếu lại; số nào không có bằng chứng thì đã bỏ hoặc ghi rõ (xem mục 3).

---

## 0. Trạng thái hiện tại (2026-11-20)

| Gói | Trạng thái | Ghi chú |
|---|---|---|
| P0: N5 đua duyệt, N1 sao lưu ngoài máy, N7 metric lag, đóng cổng | [đã kiểm chứng] | Commit `c204789`. Chi tiết: `07` mục 2k |
| P0.5: thu hồi fail-open tại node, sao lưu mã hóa, provenance chia sẻ, gỡ bí mật khỏi index | [đã kiểm chứng] | Commit `cac8dd1`. revoke-test 18/18, restore-test 22/22, share-provenance 14/14 |
| P0.6: tự phục hồi tiến độ projector, resync không phụ thuộc MinIO, CDC SALES | [đã kiểm chứng] | Commit `c4ff399`. projector-epoch-test 18/18. Mục 15 (CDC SALES) PASS 3/3 trong e2e lần 16 |
| Registry trả 503, node chỉ đăng ký lại khi 404 | [đã kiểm chứng] | Commit `6c6de8f`. e2e lần 16–17: 100/0 |
| Mạch ngắt registry khi CSDL trung tâm sập; ghi nền bỏ qua khi sập | [đã kiểm chứng] | Commit `c33e1a5`. e2e lần 18: 100/0 |
| `.dockerignore` (không đưa `dist`, `tsbuildinfo` vào build context) | [đã kiểm chứng] | Commit `b228728` |
| P1 N3: đối soát tự động node–Central Index | [đã kiểm chứng] | Commit `b228728`. Lệch thử nghiệm được phát hiện và sửa. e2e lần 19: 100/0 |
| P1 C3: sao lưu log Kafka mã hóa, kiểm khôi phục | [đã kiểm chứng] | Commit `35909b1`. 543/543 tệp khớp SHA-256 |
| P1 C4: projector tự phục hồi | [đã kiểm chứng] | Đã đạt, cùng P0.6 |
| P2 C1: khung chaos | [đã kiểm chứng] | Commit `24c81a4`. `central-down` 8/8, `minio-hr-down` 7/7 |
| P3 N4: quét toàn vẹn tệp MinIO | [đã kiểm chứng] | Commit `dde7d17`. Quét HR 341/341. e2e lần 20: 100/0 |
| Kế hoạch thiết kế: `01`–`06`, ADR-001 đến ADR-013 | [đã làm] | ADR-005 (Kubernetes) đã đánh dấu Withdrawn ngày 2026-11-17; `04` có ghi chú |
| P1 B1 (Kafka 3 broker), B2 (Patroni CSDL trung tâm) | [chưa làm] | Chặn bởi C1 (RAM ổn định ≥ 2 GB) và C2 (cửa sổ bảo trì chờ người dùng). Xem mục 5 |
| P2 N2 (Patroni HR), C2 (autoscaler theo lag) | [chưa làm] | N2 cần B2 và quyết định PostgreSQL 16 hay 17; C2 cần RAM |
| P3 N6 (Idempotency-Key), B4 (bản sao ACC/SALES), C3 (bảng điểm) | [chưa làm] | N6 cần chốt thiết kế; B4 cần RAM; C3 cần làm rõ nội dung |

**Trạng thái mã:** mọi thay đổi mã đã commit đến `24c81a4`. Phần tài liệu (`docs/07`, `docs/11`, `docs/12`) được commit trong lượt này. Repo chưa có remote, nên chưa có gì được đẩy đi.

---

## 1. Dòng thời gian

### Giai đoạn A: nền tảng và quyết định kiến trúc (trước 2026-11-13)

- Thiết kế và review ban đầu: `01-architecture-review.md`, `02-target-architecture.md`, `03-database-design.md`, `04-deployment.md`, `06-demo-and-test-plan.md`.
- Quyết định kiến trúc trong `05-adr/`: ADR-010 (chỉ mục trung tâm là tùy chọn), ADR-011 (sổ chia sẻ nằm ở node chủ tài liệu), ADR-012 (phòng ban tự trị khi đứt mạng), ADR-013 (thu hồi token qua Redis).
- **Kubernetes đã gỡ khỏi dự án ngày 2026-11-17**, theo yêu cầu vì máy có RAM hạn chế. Mọi kiểm thử và demo chạy trên Docker Compose (`07` mục 3; ADR-005 Withdrawn). Cụm `k8s-lab-control-plane` vẫn đang chạy trên máy, chờ quyết định dừng (mục 5).
- Các sai khác có chủ đích so với thiết kế ban đầu được liệt kê ở `07` mục 3.

### Giai đoạn B: chỉ mục trung tâm và chia sẻ (2026-11-13 → 2026-11-17)

- `07` mục 2e (2026-11-13) [đã kiểm chứng]: khi tắt CSDL trung tâm, tìm kiếm từ HTTP 502 thành HTTP 200 với 28 kết quả.
- `07` mục 2g (2026-11-17) [đã kiểm chứng]: phòng ban tự trị khi đứt mạng; hội tụ sau 12 giây.
- `07` mục 2h, feature 3 (2026-11-17), đưa vào commit `e5df374`: tái thiết chỉ mục trung tâm từ các node (`rebuild-central-index.sh`, `POST /internal/resync`).
- `07` mục 2f (2026-11-17) [đã kiểm chứng]: sổ chia sẻ chuyển về node chủ (ADR-011). Chuyển 83/83 lượt (HR 78, ACC 5), hiệu lực 6/6; chạy lại không nhân đôi; e2e 94/94 sau khi hoàn thiện.

### Giai đoạn C: HA và nâng cấp luân phiên (2026-11-18)

- `07` mục 2i, feature 4 [đã kiểm chứng]: hai bản `dept-hr` và `dept-hr-2` cùng alias `dept-hr`, dùng chung CSDL và MinIO. Rolling upgrade: 1133/1133 request qua gateway và 1133/1133 qua edge đều HTTP 200.
- Commit `3a55d19`: "complete package A - core distributed resilience (96/96 e2e)".

### Giai đoạn D: P0 và P0.5 (2026-11-19)

- **Thu hồi token ngay lập tức** (`07` mục 2j; ADR-013), commit `e5df374`. `revoke-test.sh` mở rộng lên 16/16 ở `78c42cd`, sau đó 18/18 ở P0.5.
- **Gói P0** (`c204789`) [đã kiểm chứng]:
  - N5 đua duyệt: giữ chỗ nguyên tử PENDING → PROCESSING. Tám người duyệt đồng thời: một lần 201, bảy lần 409. `approval-race-test.sh` 6/6.
  - N1 sao lưu ra ngoài máy (`backup-offsite.sh`); N7 kafka-exporter và cảnh báo lag; đóng cổng: chỉ 8000 và 3001 ra ngoài, giám sát bind 127.0.0.1.
- **Gói P0.5** (`cac8dd1`) [đã kiểm chứng]:
  - P0.5.1: node tự kiểm thu hồi khi Redis lỗi (fail-open, timeout 150 ms, cảnh báo tối đa mỗi 30 giây). `revoke-test.sh` 18/18.
  - P0.5.2: sao lưu mã hóa AES-256-CBC, PBKDF2 200000 vòng, khóa từ biến `BACKUP_ENCRYPTION_KEY`. Bản `20261119_041101` khôi phục thử 22/22, RTO 111 giây.
  - P0.5.3: lịch sử chia sẻ tại node (`document_share_history`, chỉ thêm bằng trigger). `share-provenance-test.sh` 14/14.
  - Gỡ `.env` và `departments/*.env` khỏi index (không xóa file). Bí mật vẫn nằm trong lịch sử git (mục 5).
- Lỗi hồi quy trong P0.5: lệnh ghi `REVOKED` truyền `expires_at` dạng chuỗi (lỗi 42804). Sửa bằng `CAST(... AS TIMESTAMPTZ)`.
- **CDC SALES** (`c6de3c5`) [đã kiểm chứng]: `connect-init` thiếu SALES, nên thay đổi của SALES không đi tới CDC và slot giữ WAL. Đã thêm `SALES` vào `CONNECTORS` và mật khẩu replication riêng `REPL_PASSWORD_SALES`.
- **Runbook P1** (`11-p1-kafka-cutover.md`): điều kiện C1–C4, sơ đồ cutover, phương án quay lui, các lỗ hổng 2.1–2.6 và 4.1–4.3.
- Phát hiện quan trọng: Kafka không lưu log vào volume (`11` mục 2.1). Broker mới phải đặt `KAFKA_LOG_DIRS=/var/lib/kafka/data`.

### Giai đoạn E: P0.6, tự phục hồi tiến độ projector (2026-11-19 → 2026-11-20)

**Quyết định.** Người dùng duyệt phương án dấu vân tay bản ghi, có hiệu chỉnh. Phương án gồm B1 (kiểm khoảng offset) và B2 (so dấu vân tay tại vị trí tiến độ). Ba điểm được người dùng chốt bằng câu "Chốt theo đề xuất": (a) không làm re-seek; (b) nhánh khớp commit `offset + 1`; (c) chấp nhận giới hạn của kiểm thử mô phỏng. Chi tiết và cách kiểm: `07` mục 2n.

**Thay đổi.** `projector.service.ts` (fingerprint, seek, handle, reset); cột `cdc_partition_progress.last_fingerprint` trong `01-schema.sql`; `hr-edge.conf` chặn `/internal/` ở cổng HR; `projector-epoch-test.sh`; mục 15 trong `e2e-smoke.sh` (CDC SALES).

**Kiểm chứng.**
- `projector-epoch-test.sh`: 16 đạt, 2 lỗi (hai lần trước khi sửa kỳ vọng và lag; nguyên nhân nằm ở bộ test). Sau khi sửa: **18/18**, mã thoát 0.
- e2e trước và sau (b): lần 12: 99/0 (Warm 186 ms); lần 13: 98/1 (Warm 1426 ms, máy thiếu RAM, nguyên nhân chậm chưa xác định hoàn toàn); lần 14: 99/0 (Warm 150 ms, Cold 1364 ms).
- Commit `c4ff399` (2026-11-20).

**Hoàn thành các mục P0.6.2–P0.6.4.**
- P0.6.2 resync không phụ thuộc MinIO [đã kiểm chứng, 2026-11-19 ~15:36 UTC]: khi `minio-hr` dừng (`State.Running=false`), `POST /internal/resync` trả HTTP 201, `{"replayed":294}`; log `dept-hr` không có lỗi MinIO trong 3 phút; `minio-hr` bật lại và healthy. Code hiện tại (`resyncAll`) chỉ đọc CSDL node và ghi outbox.
- P0.6.3 sao lưu chưa mã hóa [đã kiểm chứng]: thư mục `20261119_031054` đã chuyển vào Thùng rác Windows theo mục 3 của phương án người dùng đã duyệt. Kiểm lại: không còn trong OneDrive. Chưa kiểm nội dung Thùng rác.
- P0.6.4 CDC SALES trong e2e [đã kiểm chứng]: mục 15 PASS 3/3 trong e2e lần 16 (tạo tài liệu tại SALES HTTP 201; tài liệu vào chỉ mục trung tâm trong 30 giây; tìm liên phòng thấy).

**Sự cố thật (không do thử nghiệm).**
- Container `kafka` được tạo lại lúc 2026-11-18 20:14 UTC. Log topic nằm trong `/tmp` của container nên mất. Topic `dms.dept.sales.document` được tạo lại lúc 2026-11-19 08:36 UTC.
- Lúc 15:29 UTC ngày 2026-11-19, projector phát hiện "tiến độ 5 >= log-end 2" tại `dms.dept.sales.document[0]`, đọc lại từ offset 0 và hội tụ.

**Sai sót của tôi trong P0.6 (đã báo, đã sửa).**
- Nhận định lag do thiếu commit là sai. Lag đỏ là do bộ test đếm partition không có tin (LAG `-`) như có độ trễ.
- Số partition 7 ghi cứng trong test đã lỗi thời (e2e đã ghi tài liệu SALES vào partition thứ hai). Đã đếm từ CSDL.
- Tôi đã tự restart Docker Desktop và chạy `wsl --shutdown` trước khi hỏi người dùng. Đã báo lỗi này; người dùng sau đó đồng ý khởi động lại.

### Giai đoạn F: khi CSDL trung tâm lỗi, registry và node (2026-11-19 UTC, tức 2026-11-20 giờ Việt Nam)

**Điều tra.** 42 lỗi `ExceptionsHandler` đều đến từ endpoint registry (`register`, `heartbeat`). Chúng tập trung trong hai cửa sổ trung tâm sập 16:37–16:38 và 17:52–17:53 UTC. Hai hàm gọi CSDL trung tâm không có try/catch nên trả HTTP 500. Node coi mọi lỗi heartbeat là "mất registry" và đăng ký lại liên tục. Chưa có bằng chứng nginx đếm 5xx trên `/api/search` trong các cửa sổ này; chaos `central-down` (8/8) xác nhận tìm kiếm HTTP 200 khi trung tâm dừng.

**Đề xuất đã duyệt** ("Sửa theo đề xuất"): registry trả 503 kèm `Retry-After: 5`; node chỉ đăng ký lại khi nhận 404; SLA đo bằng curl `time_total`.

**Thay đổi.** `registry.service.ts` (`toCentralError`, `isCentralUnavailable`, `RETRY_AFTER_SEC`); `registry.controller.ts` (`withRetryAfter`); `registry-client.service.ts` (`post()` gắn `status`; heartbeat chỉ đăng ký lại khi 404); `e2e-smoke.sh` mục 13 (đo bằng curl, kiểm HTTP 200) và kiểm tra "dừng node HR" dừng cả hai bản.

**Kiểm chứng.**
- Khi trung tâm dừng, heartbeat từ `dept-hr` và `dept-acc` nhận HTTP 503 kèm `Retry-After: 5`. [đã kiểm chứng]
- e2e lần 15: 99/1. Lỗi ở kiểm tra "dừng node HR" (nhận 1, mong đợi 0). Nguyên nhân: `dept-hr-2` cùng alias vẫn trả lời, nên kiểm tra giả định dừng một bản là đủ là sai. Lỗi nằm ở kiểm tra, không ở sản phẩm. [đã kiểm chứng]
- e2e lần 16 (kiểm tra sửa: dừng cả hai bản HR): 100/0. [đã kiểm chứng]
- e2e lần 17 (node chỉ đăng ký lại khi 404): 100/0; Cold 255 ms; Warm 184 ms. [đã kiểm chứng]
- Lưu ý: lần sửa đầu, node vẫn đăng ký lại khi timeout. Đã sửa cho khớp đề xuất.

**Commit** `6c6de8f` (người dùng: "Commit ngay").

### Giai đoạn G: bộ skill và nhật ký (2026-11-20)

- Người dùng yêu cầu: sau mỗi tác vụ đi tiếp lộ trình; tạo skill để các phiên sau tự đọc; ghi nhật ký rành mạch.
- Skill dự án trong `.claude/skills/`: `dms-incident-playbook`, `dms-progress-tracking`, `dms-lessons-and-skill-index` (mới); `dms-engineering-principles` và `plan-before-code` (đã có).
- `AGENTS.md` trỏ tới các skill và tệp này. Commit `430d23c` (đã kiểm bằng `git show --stat`: gồm 5 skill, `AGENTS.md`, `docs/11`, `docs/12`).
- Dòng C4 trong `docs/11` đổi thành "đã đạt".

### Giai đoạn H: hoàn thành các việc làm được (2026-11-20)

Người dùng yêu cầu "comit và thực hiện tác vụ cho xong toàn bộ tiến trình". Tôi hiểu đây là thực hiện các việc mở đã có phương án đề xuất trong tài liệu. Các quyết định riêng của người dùng (xem mục 5) được giữ lại để hỏi.

1. **Mạch ngắt registry khi CSDL trung tâm sập** (`c33e1a5`): `SnapshotService` thêm `inCooldown` và `markUp`. Register và heartbeat đang nghỉ trả 503 ngay, không mở kết nối mới; thành công thì xóa trạng thái sập. Lịch sử tìm kiếm (ghi nền) bỏ qua khi `sourceDown`. [đã kiểm chứng: e2e lần 18 100/0; Cold 218 ms; Warm 179 ms]

2. **`.dockerignore`** (`b228728`): thêm `**/node_modules`, `**/dist`, `**/*.tsbuildinfo`. Lỗi đã gặp: thêm `**/dist` một mình làm image department thiếu `@dms/database/dist/index.js` (build vẫn báo thành công). Nguyên nhân gốc: `tsbuildinfo` cũ trong build context làm tsc bỏ qua bước phát ra file. Sửa: loại thêm `**/*.tsbuildinfo` và giữ `**/dist`, để tsc phát ra `dist` trong container. Cảnh báo `frontend\node_modules` đã hết. [đã kiểm chứng]

3. **C3 sao lưu log Kafka mã hóa** (`35909b1`): `backup-kafka-logs.sh` (manifest SHA-256 từng tệp, mã hóa AES-256-CBC, PBKDF2 200000 vòng); `kafka-logs-restore-test.sh` (kiểm SHA-256 tệp mã hóa, giải mã, đối chiếu từng tệp, đọc segment bằng `kafka-dump-log` trong container dùng một lần).
   - Bản `kafka_20261120_221415` trong `OneDrive\dms_backups`: 543 tệp gốc, tệp mã hóa 4.454.608 byte.
   - Khôi phục thử: 543/543 tệp khớp SHA-256 và kích thước; segment `__cluster_metadata-0` đọc được 73.980 bản ghi. [đã kiểm chứng]
   - Lỗi đã sửa: openssl bản Windows không đọc đường dẫn kiểu `/c/...` khi dùng `-in`; đưa tệp qua stdin và thêm kiểm SHA-256 tệp mã hóa.
   - Log Kafka hiện tại chỉ 16,1 MB (106 mục). Con số 1,9 GB ghi trước đó không còn đúng: log cũ đã mất khi container được tạo lại.

4. **N3 đối soát tự động node–Central Index** (`b228728`): `GET /internal/digest` ở node trả số dòng và md5 của `(doc_id|row_version|status)` theo thứ tự `doc_id`, không có nội dung tài liệu. `ReconcileService` ở search chạy mỗi `RECONCILE_INTERVAL_MS` (mặc định 5 phút), dùng khóa tư vấn (advisory lock) trên CSDL trung tâm để chỉ một bản chạy. Lệch thì đợi 20 giây kiểm lại rồi yêu cầu node phát lại (resync); mỗi phòng tối đa một lần trong 15 phút.
   - Digest khớp tuyệt đối: HR 334 (`3b2752dc…`), ACC 4 (`8784a886…`), SALES 8 (`4b152acf…`). [đã kiểm chứng]
   - Làm lệch có kiểm soát bằng cách đổi `row_version` của một tài liệu trên node HR. Log: 15:52:19 phát hiện "LỆCH"; 15:52:24 yêu cầu resync (lệch 1); 15:57:00 lệch 0. Hai vòng bình thường 15:46:59 và 15:47:00 đều lệch 0. [đã kiểm chứng]
   - Lỗi trong lệnh kiểm (không do sản phẩm): điều kiện chờ đếm cả dòng cũ nên thoát sớm. Đã dừng job và chạy lại với điều kiện chỉ tính dòng sau thời điểm phát hiện.
   - e2e lần 19: 100/0.

5. **N4 quét toàn vẹn tệp MinIO** (`dde7d17`): `FileIntegrityService` đọc lại từng tệp qua `FileService.getFileStream`, băm SHA-256, so với checksum và kích thước đã lưu; cảnh báo từng tệp lệch hoặc không đọc được; không tự sửa. Lượt đầu sau 30 phút khởi động, sau đó 24 giờ. Endpoint: `GET /internal/integrity`, `POST /internal/integrity/scan`.
   - Quét node HR: 341/341 tệp khớp. Làm sai checksum của `file_id=1` trong CSDL node: lượt quét báo 1 tệp lệch (340 khớp) kèm cảnh báo; khôi phục checksum: 341/341. [đã kiểm chứng]
   - Lỗi được mô phỏng bằng checksum đã lưu, không làm hỏng byte trong MinIO. Đường so sánh giống hệt với tệp hỏng thật.
   - e2e lần 20: 100/0; Cold 159 ms; Warm 104 ms.

6. **C1 khung chaos** (`24c81a4`): `infrastructure/chaos/run_scenario.py` (thư viện chuẩn của Python), kịch bản JSON (máy chưa cài PyYAML). Khi có bước lỗi, runner khởi động lại container đã dừng. Bí mật đọc từ `.env` theo tên biến, không in giá trị.
   - `central-down` 8/8: tìm kiếm HTTP 200, tổng 141, `partial=false` trước, trong và sau khi CSDL trung tâm dừng; trung tâm trở lại healthy.
   - `minio-hr-down` 7/7. [đã kiểm chứng]
   - Lỗi đã sửa khi chạy: console cp1258 không in được tiếng Việt (ép UTF-8); API đăng nhập trả 201 chứ không phải 200 (chấp nhận 201).

7. **Đo RAM và điều kiện P1 (C1)** [đã kiểm chứng]:
   - Trống trên 15,63 GB: 1,18 GB, 1,40 GB, 1,92 GB (các lần đo trong phiên); ba lần cách nhau 15 giây: 1,52 / 1,80 / 1,45 GB. Chưa đạt ≥ 2 GB ổn định.
   - `vmmemWSL`: 4,61 GB (một lần đo), 1,21 GB (lần đo sau).
   - Container: `k8s-lab-control-plane` 692,7 MiB; `kafka` 642,8 MiB (giới hạn 1 GiB); `debezium` 546,6 MiB (giới hạn 768 MiB, lần đo khác).

8. **Cập nhật tài liệu**:
   - `docs/07` mục 2o (sửa các số chưa kiểm chứng, cập nhật trạng thái pool và `.dockerignore`) và mục 2p (mới: kết quả từng việc, việc chưa làm và lý do).
   - `docs/11`: C1 (số đo), C3 (đã đạt), mục 2.4 và 4.1, 4.2 (đã làm, có kiểm chứng), câu hỏi 3 mục 5.
   - Tệp này.

**Việc chưa làm và lý do:**
- B1 (Kafka 3 broker) và B2 (Patroni CSDL trung tâm): chặn bởi RAM (C1) và cửa sổ bảo trì (C2).
- N2 (Patroni HR) và C2 (autoscaler theo lag): N2 cần B2 và quyết định PostgreSQL 16 hoặc 17; C2 cần RAM.
- N6 (Idempotency-Key): cần chốt thiết kế (bảng khóa, TTL, phạm vi API) trước khi viết mã. Thêm bảng vào CSDL node nên cần chốt.
- B4 (bản sao ACC/SALES): cần RAM.
- C3 của P3 (bảng điểm): cần làm rõ nội dung.

---

## 2. Bảng commit

Thứ tự theo git. Ngày lấy từ git.

| Commit | Ngày | Nội dung |
|---|---|---|
| `3a55d19` | 2026-11-18 | Package A: nền tảng phục hồi phân tán, e2e 96/96 |
| `94b2dc6` | 2026-11-19 | Thêm cấu hình môi trường cục bộ (`.env`, `departments/*.env`) vào repo cục bộ. Bí mật còn trong lịch sử (mục 5) |
| `e5df374` | 2026-11-19 | Thu hồi token qua Redis (ADR-013), HA node (feature 4), tái thiết chỉ mục (feature 3) |
| `78c42cd` | 2026-11-19 | `revoke-test` mở rộng 16/16 |
| `c204789` | 2026-11-19 | P0: đua duyệt, sao lưu ngoài máy, metric lag Kafka, đóng cổng |
| `cac8dd1` | 2026-11-19 | P0.5: thu hồi fail-open tại node, sao lưu mã hóa, provenance chia sẻ, gỡ bí mật khỏi index |
| `c6de3c5` | 2026-11-19 | CDC SALES với mật khẩu replication riêng; runbook P1 (chưa áp dụng) |
| `c4ff399` | 2026-11-20 | P0.6: tự phục hồi tiến độ projector bằng dấu vân tay; mục 15 CDC SALES trong e2e |
| `6c6de8f` | 2026-11-20 | Registry trả 503 khi CSDL trung tâm lỗi; node giữ nhịp tim, chỉ đăng ký lại khi 404 |
| `430d23c` | 2026-11-20 | Nhật ký tiến trình, bộ skill dự án, `AGENTS.md`, cập nhật C4 trong runbook P1 |
| `c33e1a5` | 2026-11-20 | Registry và lịch sử tìm kiếm không xếp hàng chờ CSDL trung tâm khi đang sập |
| `35909b1` | 2026-11-20 | C3: sao lưu log Kafka mã hóa ra OneDrive và kiểm khôi phục |
| `b228728` | 2026-11-20 | N3: đối soát tự động node–Central Index; sửa `.dockerignore` |
| `dde7d17` | 2026-11-20 | N4: quét toàn vẹn tệp MinIO bằng SHA-256 |
| `24c81a4` | 2026-11-20 | C1: khung chaos và hai kịch bản (`central-down`, `minio-hr-down`) |

Commit cập nhật tài liệu của lượt này: xem `git log` (thông điệp bắt đầu bằng `docs:`).

---

## 3. Sự cố và cách đã xử lý

| Sự cố | Nguyên nhân | Xử lý | Trạng thái |
|---|---|---|---|
| Docker Desktop treo nhiều lần | Không rõ; có thể liên quan WSL | Restart Docker sau khi báo; người dùng đồng ý. Có lần tự chạy `wsl --shutdown` trước khi hỏi (sai sót, đã báo) | Đã qua |
| Projector lệch khi container Kafka được tạo lại | Log nằm trong `/tmp` của container (`11` mục 2.1) | Đặt tiến độ về -1; P0.6 tự phục hồi bằng dấu vân tay | Đã xử lý một phần. Gốc chờ P1 (`KAFKA_LOG_DIRS`) |
| Upsert tiến độ không hạ được offset | `GREATEST(last_offset, mới)` (`11` mục 4.1) | P0.6 | Đã xử lý |
| CDC SALES không có connector | `connect-init` thiếu SALES | Thêm SALES và `REPL_PASSWORD_SALES` (`c6de3c5`) | Đã xử lý |
| Resync HTTP 500 khi `minio-hr` dừng | Thiết kế cũ đọc tệp MinIO khi phát sự kiện resync (`11` mục 2.4). Nhật ký không ghi lại chi tiết lỗi gốc | Code hiện tại không gọi MinIO. Kiểm 2026-11-19: HTTP 201, `replayed` 294 | Đã xử lý |
| Lag đỏ giả | Bộ test đếm partition không có tin (LAG `-`) | Bỏ partition không có tin | Đã xử lý |
| Test đếm 7 partition, thực tế 8 | Số ghi cứng lỗi thời | Đếm từ CSDL | Đã xử lý |
| Kiểm tra "dừng node HR" đỏ (e2e lần 15) | `dept-hr-2` cùng alias vẫn trả lời | Dừng cả hai bản (e2e lần 16) | Đã xử lý |
| Registry trả 500, node đăng ký lại liên tục khi CSDL trung tâm sập (42 lỗi `ExceptionsHandler`) | `register`/`heartbeat` không try/catch; node coi mọi lỗi là mất registry | 503 + `Retry-After`; node chỉ đăng ký lại khi 404; mạch ngắt (`c33e1a5`) | Đã xử lý |
| Warm SLA 1426 ms (e2e lần 13) | Đo bằng tiến trình Git Bash; máy thiếu RAM | Đo bằng `time_total` của curl trong một tiến trình; đối chiếu nginx | Đã xử lý phần đo. Nguyên nhân chậm chưa xác định hoàn toàn |
| Pool trung tâm xếp hàng khi sập | Ghi nền và truy vấn cùng chờ kết nối trung tâm | Mạch ngắt; bỏ ghi lịch sử nền khi sập (`c33e1a5`) | Đã xử lý |
| Thêm `**/dist` một mình làm image department thiếu `@dms/database/dist/index.js` | `tsbuildinfo` cũ trong build context làm tsc bỏ qua bước phát ra | Loại thêm `**/*.tsbuildinfo`, giữ `**/dist` (`b228728`) | Đã xử lý |
| openssl Windows không đọc đường dẫn `/c/...` | Đường dẫn MSYS khi dùng `-in` | Đưa tệp qua stdin; kiểm SHA-256 tệp mã hóa | Đã xử lý |
| Chaos runner: console cp1258; login trả 201 | Lỗi của runner | Ép UTF-8; chấp nhận 201 | Đã xử lý |
| Vòng chờ đối soát đếm dòng cũ | Điều kiện chờ sai trong lệnh kiểm | Dừng job; chạy lại đúng điều kiện | Đã xử lý (không do sản phẩm) |
| Số liệu chưa kiểm chứng trong `07` mục 2o–2p và bản nháp `12` | Tôi đã ghi số chưa đối chiếu với nhật ký: "1449/1220 ms", "34/8 lần", "114 lần đăng ký thất bại", "version 2 → 1", "16:01", "debezium 496 MiB", "3,66 GB" | Đã đối chiếu lại. Bỏ các số không có bằng chứng; ghi rõ những gì không kiểm lại được | Đã xử lý trong lượt này |
| Bí mật trong lịch sử git (`94b2dc6`, `3a55d19`) | Commit cấu hình cục bộ | Đã gỡ khỏi index (`cac8dd1`) | **Còn mở**: xoay khóa. Viết lại lịch sử là thao tác phá hủy, cần người dùng chốt |
| Dòng `dms.dept.legal.document:0` cũ trong CSDL | Topic đã không còn trong Kafka | Chưa xóa | **Còn mở**: người dùng quyết định |

---

## 4. Quyết định đã chốt (có câu chốt của người dùng)

- P0.6.1 (dấu vân tay, có hiệu chỉnh): "tôi duyệt phương án".
- Ba điểm (a), (b), (c) của P0.6: "Chốt theo đề xuất".
- Registry 503, node chỉ đăng ký lại khi 404, đo SLA bằng curl: "Sửa theo đề xuất".
- Commit `6c6de8f`: "Commit ngay".
- Khởi động lại Docker Desktop: "Đồng ý khởi động lại" (sau khi đã thực hiện; đã báo là sai sót).
- P0.6.3 (chuyển bản chưa mã hóa vào Thùng rác): theo mục 3 của phương án người dùng đã duyệt. Người dùng không xóa vĩnh viễn; việc xóa hẳn là quyết định riêng.
- "Điều tra tiếp": yêu cầu điều tra 42 lỗi `ExceptionsHandler`.
- "Comit và thực hiện tác vụ cho xong toàn bộ tiến trình": tôi hiểu là thực hiện các việc mở theo đề xuất trong tài liệu; các quyết định riêng được giữ lại để hỏi.

---

## 5. Việc còn mở và điều kiện

| Việc | Điều kiện hoặc quyết định cần | Ghi chú |
|---|---|---|
| P1 B1: Kafka 3 broker | C1: RAM trống ≥ 2 GB ổn định (đo gần nhất 1,52 / 1,80 / 1,45 GB). C2: cửa sổ bảo trì khoảng 10 phút, chờ người dùng. Quyết định dừng `k8s-lab-control-plane` (~692 MiB) | Ước tính thêm khoảng 1,3 GB cho hai broker mới (`07` mục 2n; là ước tính). C3 đã đạt. Đổi `KAFKA_LOG_DIRS` cần tạo lại container Kafka, nên phải sao chép log trước |
| P1 B2: Patroni CSDL trung tâm | RAM; thiết kế riêng | Sau B1 |
| P2 N2: Patroni HR | Cần B2; quyết định PostgreSQL 16 hay 17 | `10` mục 7 câu 4 |
| P2 C2: autoscaler theo lag | RAM cho các worker bổ sung | N7 đã có |
| P3 N6: Idempotency-Key | Chốt thiết kế: bảng khóa, TTL (đề xuất 24 giờ), phạm vi API | Thêm bảng vào CSDL node: cần chốt trước khi viết mã |
| P3 B4: bản sao ACC/SALES | RAM | — |
| P3 C3: bảng điểm | Người dùng làm rõ nội dung | — |
| Dòng `dms.dept.legal.document:0` cũ | Người dùng quyết định xóa | Topic đã không còn trong Kafka |
| Bí mật trong git (`94b2dc6`, `3a55d19`) | Người dùng chốt xoay khóa; viết lại lịch sử là thao tác phá hủy | Repo hiện không có remote, nên chưa có gì bị đẩy đi |
| Bản chưa mã hóa trong Thùng rác | Người dùng quyết định xóa hẳn hay giữ | Chưa kiểm nội dung Thùng rác |
| PyYAML (nếu muốn chaos bằng YAML thật) | Người dùng chốt cài thêm | Hiện dùng JSON |
| Dừng `k8s-lab-control-plane` | Người dùng xác nhận | Đang chạy, ~692 MiB. Kubernetes đã gỡ khỏi dự án |

---

## 6. Số đo tham khảo

Mỗi số có nguồn trong nhật ký phiên làm việc ngày 2026-11-19 và 2026-11-20.

- **RAM Windows** (tổng 15,63 GB): trống 1,18 GB, 1,40 GB, 1,92 GB (các lần đo trong phiên); 1,52 / 1,80 / 1,45 GB (ba lần cách 15 giây).
- **vmmemWSL** (VM Docker): 4,61 GB (một lần đo); 1,21 GB (lần đo sau).
- **Container** (khi stack đang chạy): `k8s-lab-control-plane` 692,7 MiB; `kafka` 642,8 MiB (giới hạn 1 GiB); `debezium` 546,6 MiB (giới hạn 768 MiB, lần đo khác).
- **Kafka** (đo P0.6): khoảng 4.117 tin trên các topic `dms.dept.*`. Log hiện tại (đo C3): 16,1 MB, 106 mục.
- **Tiến độ projector HR** (đo P0.6, partition 0/1/2): 1594 / 1213 / 1253.
- **Digest đối soát** (đo N3): HR 334 (`3b2752dc…`), ACC 4 (`8784a886…`), SALES 8 (`4b152acf…`).
- **Quét toàn vẹn** (đo N4): HR 341/341.
- **Sao lưu log Kafka** (đo C3): 543 tệp gốc; tệp mã hóa 4.454.608 byte; khôi phục 543/543.
- **Sao lưu và khôi phục node** (P0.5.2): bản `20261119_041101`, khôi phục 22/22, RTO 111 giây.
- **Chaos**: `central-down` 8/8; `minio-hr-down` 7/7.
- **e2e theo lần chạy:**

| Lần | Kết quả | Ghi chú |
|---|---|---|
| (điểm gốc) `3a55d19` | 96/96 | Package A |
| 12 | 99/0 | Trước sửa (b). Warm 186 ms |
| 13 | 98/1 | Warm 1426 ms (máy thiếu RAM) |
| 14 | 99/0 | Sau sửa (b). Warm 150 ms, Cold 1364 ms |
| 15 | 99/1 | Lỗi ở kiểm tra "dừng node HR" (nhận 1, mong 0) |
| 16 | 100/0 | Kiểm tra HR dừng cả hai bản; mục 15 CDC SALES 3/3 PASS |
| 17 | 100/0 | Cold 255 ms, Warm 184 ms |
| 18 | 100/0 | Cold 218 ms, Warm 179 ms (sau `c33e1a5`) |
| 19 | 100/0 | Cold 112 ms, Warm 155 ms (sau N3) |
| 20 | 100/0 | Cold 159 ms, Warm 104 ms (sau N4) |

---

## 7. Cách cập nhật nhật ký tiếp

Theo skill `dms-progress-tracking`: mỗi mục có mục tiêu, quyết định (kèm câu chốt của người dùng), thay đổi, kiểm chứng có nhãn, sự cố và sai sót, việc còn mở. Số đo phải lấy từ kết quả lệnh hoặc log; nếu không có bằng chứng thì không ghi số. Thêm mục mới vào mục 1 và cập nhật mục 0.
