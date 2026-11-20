# 12. Nhật ký tiến trình dự án DMS

Cập nhật lần cuối: 2026-11-20. Mục đích: ghi theo thứ tự thời gian việc đã làm, vì sao làm, kết quả đo, sự cố và việc còn mở. Người đọc có thể hiểu toàn bộ quá trình mà không cần lật lại cuộc trò chuyện.

Tài liệu liên quan: `07-implementation-status.md` (hiện trạng từng gói), `10-goi-b-va-c.md` (lộ trình P0 → P3), `11-p1-kafka-cutover.md` (runbook P1 và điều kiện C1–C4), `05-adr/` (quyết định kiến trúc).

Quy ước nhãn: **[đã kiểm chứng]** = có lệnh và số đo; **[đã làm, chưa kiểm chứng]** = đã làm nhưng chưa có bằng chứng; **[chưa làm]**.

---

## 0. Trạng thái hiện tại (2026-11-20)

| Gói | Trạng thái | Ghi chú |
|---|---|---|
| P0 (N5, N1, N7, đóng cổng) | [đã kiểm chứng] | Theo `10-goi-b-va-c.md` mục 5. Gồm P0.5 và P0.6 |
| P0.6 (tự phục hồi tiến độ projector) | [đã kiểm chứng], commit `c4ff399` | Epoch test 18/18; e2e 99/0 |
| Registry 503, node chỉ đăng ký lại khi 404 | [đã kiểm chứng], commit `6c6de8f` | e2e 100/0 (lần 17) |
| P1: B1 (Kafka 3 broker), B2 (Patroni CSDL trung tâm), N3 (đối soát tự động) | [chưa làm] | Chặn bởi C1, C2, C3. Xem mục 5 |
| P2: N2 (Patroni HR), C1 (chaos), C2 (autoscaler) | [chưa làm] | Cần P1 và quyết định PostgreSQL 16 hoặc 17 |
| P3: N4, N6, B4, C3, và các mục chỉ làm khi có số đo | [chưa làm] | — |

**Chưa commit:** `AGENTS.md` (đã sửa từ trước, không thuộc các commit dưới đây); `.claude/` (ba skill mới, skill cũ và file này); `docs/11` (cập nhật điều kiện C4); `docs/12` (tệp này).

---

## 1. Dòng thời gian

### Giai đoạn A: nền tảng và quyết định kiến trúc (trước 2026-11-13)

- Thiết kế và review ban đầu: `01-architecture-review.md`, `02-target-architecture.md`, `03-database-design.md`, `04-deployment.md`, `06-demo-and-test-plan.md`.
- Quyết định kiến trúc (`05-adr/`):
  - ADR-010: chỉ mục trung tâm là tùy chọn; tìm kiếm vẫn chạy qua node khi trung tâm sập.
  - ADR-011: sổ chia sẻ nằm ở node chủ tài liệu.
  - ADR-012: phòng ban tự trị khi đứt mạng.
  - ADR-013: thu hồi token qua Redis.
- Kubernetes đã gỡ khỏi dự án. Chỉ dùng Docker Compose (người dùng chốt).
- Các sai khác có chủ đích so với thiết kế ghi ở `07` mục 3: UUID giữ BIGINT cục bộ, một service `search-engine-service`, JWT HS256 do node cấp, `INTERNAL_SERVICE_TOKEN` dùng chung, stream file qua gateway, token 8 giờ, Debezium `no_data` kết hợp resync.

### Giai đoạn B: chỉ mục trung tâm và chia sẻ (2026-11-13 → 2026-11-17)

- `07` mục 2e (2026-11-13) [đã kiểm chứng]: khi tắt CSDL trung tâm, tìm kiếm từ HTTP 502 thành HTTP 200 với 28 kết quả; sự kiện đồng bộ không vào DLQ khi trung tâm sập; audit chain dùng `chain_seq`.
- Feature 3 (2026-11-17), commit `e5df374` [đã kiểm chứng]: tái thiết chỉ mục trung tâm từ các node (`rebuild-central-index.sh`; `POST /internal/resync`).
- Feature 2, đứt mạng tự trị (`07` mục 2g, `09-feature2-autonomy.md`) [đã kiểm chứng]: hội tụ sau 12 giây.
- Sổ chia sẻ chuyển về node chủ (`07` mục 2f, ADR-011) [đã kiểm chứng]: chuyển 83/83 lượt (HR 78, ACC 5); hiệu lực 6/6; chạy lại không nhân đôi; e2e 94/94 sau hoàn thiện.

### Giai đoạn C: HA và nâng cấp luân phiên (2026-11-18)

- Feature 4 (`07` mục 2i) [đã kiểm chứng]: hai bản `dept-hr` và `dept-hr-2` cùng alias `dept-hr`, cùng CSDL và MinIO. Rolling upgrade test: 0 lỗi 5xx.
- Commit `3a55d19`: "complete package A - core distributed resilience (96/96 e2e)".

### Giai đoạn D: P0 và P0.5 (2026-11-19)

- **Thu hồi token ngay lập tức** (`07` mục 2j, commit `e5df374`; `revoke-test.sh` mở rộng 16/16 ở `78c42cd`, sau đó 18/18 ở P0.5).
- **Gói P0** (`07` mục 2k, commit `c204789`) [đã kiểm chứng]:
  - N5 đua duyệt yêu cầu: giữ chỗ nguyên tử PENDING → PROCESSING. Tám người duyệt đồng thời: một lần 201, bảy lần 409. `approval-race-test.sh` 6/6.
  - N1 sao lưu ra ngoài máy: `backup-offsite.sh`.
  - N7 kafka-exporter và cảnh báo lag.
  - Đóng cổng: chỉ 8000 và 3001 ra ngoài; Grafana, Prometheus, Jaeger bind 127.0.0.1.
- **Gói P0.5** (`07` mục 2l, commit `cac8dd1`) [đã kiểm chứng]:
  - P0.5.1: node tự kiểm thu hồi khi Redis lỗi (fail-open, timeout 150 ms, cảnh báo tối đa mỗi 30 s). `revoke-test.sh` 18/18.
  - P0.5.2: sao lưu mã hóa AES-256-CBC, PBKDF2 200000 vòng, khóa từ biến `BACKUP_ENCRYPTION_KEY`. Bản `20261119_041101` khôi phục thử 22/22, RTO 111 giây.
  - P0.5.3: lịch sử chia sẻ tại node (`document_share_history`, chỉ thêm bằng trigger). `share-provenance-test.sh` 14/14.
  - Gỡ `.env` và `departments/*.env` khỏi index (không xóa file). Bí mật vẫn nằm trong lịch sử git (xem mục 3).
- Lỗi hồi quy trong P0.5: lệnh ghi `REVOKED` truyền `expires_at` dạng chuỗi (lỗi 42804). Đã sửa bằng `CAST(... AS TIMESTAMPTZ)`.
- Sự cố P0.5: tiến độ projector lệch vì Kafka lưu log trong `/tmp`. Đã đặt tiến độ HR và ACC về -1 để đọc lại; hội tụ, lag 0. Đã sao lưu log Kafka vào scratchpad (chưa bền, xem mục 5).

### Giai đoạn E: CDC SALES và chuẩn bị P1 (2026-11-19)

- Commit `c6de3c5` [đã kiểm chứng]: SALES chưa có connector `outbox-sales` vì `connect-init` thiếu SALES. Đã thêm `SALES:dept-sales-db:dms_sales` và mật khẩu replication riêng `REPL_PASSWORD_SALES`. Slot active; WAL còn 288 byte.
- Runbook P1 (`11-p1-kafka-cutover.md`) đã hiệu chỉnh: điều kiện C1–C4, phát hiện, sơ đồ cutover 11 bước, phương án quay lui, lỗ hổng 4.1–4.3.
- Phát hiện quan trọng: Kafka không lưu log vào volume (`11` mục 2.1). P1 phải đặt `KAFKA_LOG_DIRS=/var/lib/kafka/data`.

### Giai đoạn F: P0.6, tự phục hồi tiến độ projector (2026-11-19 → 2026-11-20)

**Quyết định.** Người dùng duyệt phương án dấu vân tay bản ghi, có hiệu chỉnh: low thay vì 0; ghi cả đường DLQ; CASE cho `last_fingerprint`; giá trị băm nằm trong fingerprint. Phương án gồm B1 (kiểm khoảng offset) và B2 (so dấu vân tay tại tiến độ).

**Thay đổi.**
- `services/search-engine-service/src/modules/projector/projector.service.ts`: fingerprint, `seekToProgress`, `handle`, `resetPartition`.
- `infrastructure/postgres/init-scripts/central/01-schema.sql`: cột `cdc_partition_progress.last_fingerprint`.
- `infrastructure/site/hr-edge.conf`: chặn `/internal/` ở cổng HR (404).
- `infrastructure/scripts/projector-epoch-test.sh`: ba ca kiểm thử.
- `infrastructure/scripts/e2e-smoke.sh` mục 15: kiểm tra CDC SALES.

**Kiểm chứng.**
- Ca 1 (tiến độ ≥ log-end, mô phỏng): HR[0] được đọc lại và hội tụ. [đã kiểm chứng]
- Ca 2 (dấu vân tay sai, mô phỏng): ACC[1] được đọc lại và hội tụ. [đã kiểm chứng; chỉ là mô phỏng]
- Ca 3 (khởi động bình thường): tất cả partition có tiến độ khớp dấu vân tay; không reset; không áp dụng lại sự kiện. [đã kiểm chứng]
- Lần chạy epoch test:
  - Trước khi sửa kỳ vọng: 16 đạt, 2 lỗi (hai lần).
  - Sau khi sửa kỳ vọng và lag: 18 đạt, 0 lỗi.
  - Sau khi sửa (b): 18 đạt, 0 lỗi, mã thoát 0.
- P0.6.2 resync khi `minio-hr` dừng: HTTP 201, `replayed` 294. [đã làm, kiểm trước đó, chưa chạy lại trong P0.6]. Lưu ý: lúc đầu resync trả HTTP 500 khi `minio-hr` dừng; nguyên nhân gốc chưa được ghi lại đầy đủ, cần xác nhận khi kiểm lại.
- P0.6.3 sao lưu chưa mã hóa (`20261119_031054`): đã chuyển khỏi OneDrive, theo bản spec người dùng duyệt. [đã kiểm chứng: không còn trong OneDrive. Chưa kiểm nội dung Thùng rác]
- P0.6.4 CDC SALES trong e2e (mục 15): 3/3 đạt. [đã kiểm chứng]

**Ba điểm chốt.** Người dùng chốt bằng câu "Chốt theo đề xuất":
- (a) Không làm re-seek. kafkajs 2.2.4 áp dụng seek trước batch kế tiếp (`runner.js:226`, `consumerGroup.js:454, 660`). [đã kiểm chứng bằng đọc mã]
- (b) Đã làm: nhánh khớp dấu vân tay commit `offset + 1`. Kiểm A/B: đặt offset nhóm HR p2 lùi về 1250 khi log-end 1254; sau khởi động offset trở về 1254, lag 0. [đã kiểm chứng]
- (c) Chấp nhận có giới hạn: ca 2 mô phỏng bằng cách ghi đè dấu vân tay. Hàm so khớp vẫn chạy trên bản ghi thật tại offset thật. Chưa kiểm tạo lại topic thật, vì làm trên cụm đang chạy sẽ xóa log. [ghi nhận giới hạn]

**Sự cố thật ngày 2026-11-19 (không do test).**
- Container `kafka` được tạo lại lúc 2026-11-18 20:14 UTC, nên log trong `/tmp` mất. Topic `dms.dept.sales.document` được tạo lại lúc 2026-11-19 08:36 UTC.
- Lúc 15:29 UTC, projector (code P0.6.1) thấy "tiến độ 5 ≥ log-end 2" tại `dms.dept.sales.document[0]`, đọc lại từ offset 0 và hội tụ. [đã kiểm chứng: log search]
- Đối chiếu node SALES với chỉ mục trung tâm: khớp (2 tài liệu, `id`, `row_version`, `status`). [đã kiểm chứng]

**Sai sót của tôi trong P0.6 (đã sửa).**
- Nhận định lag do thiếu commit là sai. Lag đỏ là do test đếm partition trống có LAG `-`.
- Số 7 partition ghi cứng trong test bị lỗi thời sau khi e2e ghi tài liệu SALES vào partition thứ hai.
- Đã tự restart Docker Desktop và chạy `wsl --shutdown` trước khi hỏi người dùng. Đã báo lỗi này; người dùng sau đó đồng ý khởi động lại.

**e2e trong P0.6:**
- Trước (b): 99 đạt, 0 lỗi (Warm 186 ms).
- Sau (b), lần 1: 98 đạt, 1 lỗi. Warm SLA 1426 ms (ngưỡng 800 ms). Máy thiếu RAM; nguyên nhân chưa xác định tại thời điểm đó.
- Sau (b), lần 2: 99 đạt, 0 lỗi (Warm 150 ms, Cold 1364 ms).
- Commit `c4ff399` (2026-11-20).

### Giai đoạn G: khi CSDL trung tâm lỗi, registry và node (2026-11-20)

**Điều tra (từ log thật).**
- 42 dòng `ERROR ExceptionsHandler` ở hai instance search. Stack trace: `RegistryService.register` (34), `RegistryService.heartbeat` (8). Hai hàm này gọi CSDL trung tâm không có `try/catch`, nên trả HTTP 500.
- Node coi mọi lỗi heartbeat là "mất registry" và đăng ký lại liên tục. Log `dept-hr` (lũy kế): 51 lỗi heartbeat, 114 lần đăng ký thất bại, 62 lần đăng ký lại thành công.
- Tìm kiếm không bị ảnh hưởng: nginx không ghi 5xx trên `/api/search`.

**Đề xuất đã duyệt** ("Sửa theo đề xuất"): registry trả 503 kèm `Retry-After`; node chỉ đăng ký lại khi nhận 404; đo SLA bằng curl.

**Thay đổi.**
- `services/search-engine-service/src/modules/registry/registry.service.ts`: `toCentralError`, `isCentralUnavailable`, `RETRY_AFTER_SEC`, và `register`/`heartbeat` bọc `registerInner`/`heartbeatInner`.
- `services/search-engine-service/src/modules/registry/registry.controller.ts`: `withRetryAfter` với `@Res({ passthrough: true })`.
- `services/department-service/src/modules/registry/registry-client.service.ts`: `post()` gắn `status`; heartbeat chỉ đăng ký lại khi 404.
- `infrastructure/scripts/e2e-smoke.sh`: mục 13 đo bằng `time_total`, kiểm HTTP 200, in `tookMs`; kiểm tra "dừng node HR" dừng cả hai bản.

**Kiểm chứng.**
- Dừng trung tâm, gọi heartbeat từ `dept-hr` và `dept-acc`: HTTP 503, `Retry-After: 5`. [đã kiểm chứng]
- Log search sau sửa: 0 `ExceptionsHandler`. [đã kiểm chứng]
- e2e lần 15 (sau sửa registry, node và SLA): 99 đạt, 1 lỗi. Lỗi ở kiểm tra "dừng node HR": nhận 1, mong đợi 0. Nguyên nhân: `dept-hr-2` cùng alias vẫn trả lời. Đã đo: dừng `dept-hr`, token có trong tệp vẫn trả `total 1` từ node HR. Đây là lỗi giả định của test, không phải sản phẩm.
- e2e lần 16 (sau sửa kiểm tra HR, dừng cả hai bản): 100 đạt, 0 lỗi. [đã kiểm chứng]
- e2e lần 17 (sau sửa node chỉ đăng ký lại khi 404): 100 đạt, 0 lỗi; Cold 255 ms; Warm 184 ms. Log node: mỗi bản chỉ có 2 dòng "nhịp tim chưa gửi được (HTTP 503)" trong cửa sổ sập; 0 đăng ký lại; 0 đăng ký thất bại. [đã kiểm chứng]
- Lưu ý: ở lần sửa đầu, node vẫn đăng ký lại khi timeout 3 s. Đã sửa thêm cho khớp đề xuất (chỉ đăng ký lại khi 404).

**Commit** `6c6de8f` (người dùng: "Commit ngay"). Chưa push.

**Còn mở:** pool kết nối trung tâm xếp hàng khi trung tâm sập. Heartbeat và đăng ký có lúc chờ quá 3 s (timeout của node). Nguyên nhân khả dĩ nhất: các ghi nền (lịch sử tìm kiếm mỗi truy vấn, truy vấn giám sát) cùng chờ kết nối trung tâm. Chưa xác minh; chưa sửa.

### Giai đoạn H: lộ trình và nhật ký (2026-11-20)

- Người dùng yêu cầu: sau mỗi tác vụ đi tiếp lộ trình; tạo skill để các phiên sau tự đọc; ghi nhật ký rành mạch.
- Kiểm điều kiện P1 (`11` mục 2): xem mục 5 của tệp này.
- Cập nhật `docs/11` dòng C4 thành "đã đạt" (có bằng chứng P0.6 và sự cố thật ngày 19/11).
- Tạo ba skill trong `.claude/skills/`: `dms-incident-playbook`, `dms-progress-tracking`, `dms-lessons-and-skill-index`.
- Tạo tệp này. Cập nhật `AGENTS.md` để các phiên sau đọc các skill đó và tệp này.

---

## 2. Bảng commit

| Commit | Ngày (UTC) | Nội dung |
|---|---|---|
| `3a55d19` | 2026-11-18 | Package A: nền tảng phục hồi phân tán, e2e 96/96 |
| `e5df374` | 2026-11-19 | Thu hồi token qua Redis (ADR-013), HA node (feature 4), tái thiết chỉ mục (feature 3) |
| `94b2dc6` | 2026-11-19 | Thêm `.env` và `departments/*.env` vào repo cục bộ (về sau gỡ khỏi index; bí mật vẫn còn trong lịch sử) |
| `78c42cd` | 2026-11-19 | `revoke-test` mở rộng 16/16 |
| `c204789` | 2026-11-19 | P0: đua duyệt, sao lưu ngoài máy, metric lag Kafka, đóng cổng |
| `cac8dd1` | 2026-11-19 | P0.5: fail-open thu hồi tại node, sao lưu mã hóa, provenance chia sẻ, gỡ bí mật khỏi index |
| `c6de3c5` | 2026-11-19 | CDC SALES, mật khẩu replication riêng, runbook P1 |
| `c4ff399` | 2026-11-20 | P0.6: tự phục hồi tiến độ projector bằng dấu vân tay; sales CDC trong e2e |
| `6c6de8f` | 2026-11-20 | Registry trả 503 khi CSDL trung tâm lỗi; node chỉ đăng ký lại khi 404 |

---

## 3. Sự cố và cách đã xử lý (tóm tắt)

| Sự cố | Nguyên nhân | Xử lý | Trạng thái |
|---|---|---|---|
| Docker Desktop treo nhiều lần | Không rõ; có thể liên quan WSL | Restart Docker sau khi báo; người dùng đồng ý | Đã qua; restart không được hỏi trước là sai sót |
| Projector lệch offset | Log Kafka trong `/tmp`; container bị tạo lại | Đặt tiến độ về -1; sao lưu log; P0.6 tự phục hồi | Đã xử lý; gốc còn ở P1 (`KAFKA_LOG_DIRS`) |
| Upsert tiến độ không hạ offset | `GREATEST` | P0.6: dấu vân tay, reset khi tiến độ ≥ log-end | Đã xử lý |
| CDC SALES không có connector | `connect-init` thiếu SALES | Thêm SALES và mật khẩu replication riêng | Đã xử lý (`c6de3c5`) |
| Resync HTTP 500 khi `minio-hr` dừng | Chưa xác định đầy đủ | Kiểm lại: HTTP 201, replayed 294 | Cần xác nhận lại nguyên nhân gốc |
| Kafka `REQUEST_TIMED_OUT` khi RAM thấp | Máy thiếu RAM | Ghi nhận rủi ro cho P1 | Còn mở |
| Lag đỏ giả | Test đếm partition trống (LAG `-`) | Bỏ partition có CURRENT `-` và LOG-END 0 | Đã xử lý |
| Test đếm 7, thực tế 8 | Số ghi cứng lỗi thời | Đếm từ CSDL | Đã xử lý |
| Kiểm tra "dừng node HR" đỏ | Replica `dept-hr-2` cùng alias | Dừng cả hai bản | Đã xử lý (`e2e` lần 16) |
| 42 lỗi `ExceptionsHandler` khi trung tâm sập | `register`/`heartbeat` không có try/catch | 503 + `Retry-After`; node chỉ đăng ký lại khi 404 | Đã xử lý (`6c6de8f`) |
| Warm SLA 1426 ms (e2e lần 13) | Đo client trong Git Bash; máy thiếu RAM | Đo bằng `time_total`; đối chiếu nginx | Đã xử lý về đo lường; nguyên nhân chưa xác định hoàn toàn |
| Pool trung tâm xếp hàng khi sập | Ghi nền và truy vấn cùng chờ kết nối | — | **Còn mở** |
| Bí mật trong lịch sử git | Commit `94b2dc6`, `3a55d19` | Đã gỡ khỏi index (`cac8dd1`) | **Còn mở**: cần xoay khóa; viết lại lịch sử là thao tác phá hủy, cần chốt |
| Build context gửi `frontend\node_modules` | `.dockerignore` thiếu | — | **Còn mở** (cảnh báo) |

---

## 4. Quyết định đã chốt (có câu chốt của người dùng)

- P0.6.1: "tôi duyệt phương án" (có hiệu chỉnh).
- Ba điểm (a), (b), (c): "Chốt theo đề xuất".
- Registry 503, node chỉ đăng ký lại khi 404, đo SLA bằng curl: "Sửa theo đề xuất".
- Commit `6c6de8f`: "Commit ngay".
- Khởi động lại Docker Desktop: "Đồng ý khởi động lại" (sau khi đã thực hiện; đã báo là sai sót).
- Các yêu cầu đã thực hiện: "Điều tra tiếp", "Hãy thử lại", "Commit ngay".

## 5. Việc còn mở và điều kiện

| Việc | Điều kiện hoặc quyết định cần | Ghi chú |
|---|---|---|
| P1 B1: Kafka 3 broker | C1: RAM trống ≥ 2 GB ổn định (lần đo gần nhất 1,92 GB; các lần trước 1,18–1,40 GB). C2: cửa sổ bảo trì khoảng 10 phút. C3: sao lưu log Kafka bền ngoài `/tmp` và scratchpad, và đã kiểm đọc được. Quyết định dừng `k8s-lab-control-plane` (~0,7 GB) | Hướng A ước tính thêm khoảng 1,3 GB cho hai broker. Điều kiện "≥ 2 GB trống" trong runbook có thể chưa đủ; cần tính lại |
| P1 B2: Patroni CSDL trung tâm | RAM (thêm container); thiết kế riêng | Sau B1 |
| P1 N3: đối soát tự động | Thiết kế; kiểm trên hạ tầng hiện có | Chưa bắt đầu |
| Pool trung tâm khi sập | Thiết kế: không ghi nền khi trung tâm lỗi; giới hạn thời gian chờ pool; kiểm bằng e2e | Xem mục 3 |
| Dòng `dms.dept.legal.document:0` cũ | Người dùng quyết định xóa | Topic đã không còn trong Kafka; dòng còn trong CSDL |
| Xoay khóa; viết lại lịch sử git | Người dùng chốt | Chưa đẩy lên remote |
| `.dockerignore` | Thêm `frontend/node_modules` | Cảnh báo build |
| PostgreSQL 16 hay 17 (P2) | Người dùng quyết định | `10` mục 7 câu 4 |
| `KAFKA_LOG_DIRS` và đổi volume Kafka | Thuộc P1; cần sao lưu bền và cửa sổ bảo trì | Mọi lần recreate Kafka xóa log hiện tại |
| Dừng `k8s-lab-control-plane` | Người dùng xác nhận | Đang chạy, ~692 MiB |

## 6. Số đo tham khảo (thời điểm đo ghi kèm)

- RAM Windows: tổng 15,63 GB. Trống: 1,18 GB, 1,40 GB, 1,92 GB (2026-11-20, lần gần nhất). Máy ảo `vmmemWSL` (chạy Docker): 4,57–4,61 GB trước khi đo, 1,21 GB sau đó.
- Container (đo khi stack đang chạy): `k8s-lab-control-plane` ~692 MiB; `kafka` ~643 MiB (giới hạn 1 GiB); `debezium` ~496 MiB.
- Kafka (đo P0.6): tổng ~4.117 tin ở bốn topic `dms.dept.*`.
- Tiến độ projector (đo P0.6): HR 1594/1213/1253; ACC 11/11/23; SALES p0 3, p2 1; `legal` p0 1 (dòng cũ).
- Chỉ mục trung tâm và node (SALES, đối soát sau P0.6): 2 tài liệu, khớp.
- e2e theo thời gian: 96/96 (`3a55d19`) → 99/0 (trước P0.6 b) → 98/1 (sau b, lần 1) → 99/0 (sau b, lần 2) → 99/1 (sau sửa registry, HR check sai) → 100/0 (sau sửa kiểm tra HR) → 100/0 (sau sửa node, lần 17).

## 7. Cách cập nhật nhật ký tiếp

Theo skill `dms-progress-tracking`: mỗi mục có mục tiêu, quyết định (kèm câu chốt), thay đổi, kiểm chứng có nhãn, sự cố và sai sót, việc còn mở. Thêm mục mới vào mục 1 (dòng thời gian) và cập nhật mục 0 (trạng thái hiện tại).
