# 01. Review kiến trúc (góc nhìn Tech Lead)

**Phạm vi review:** sơ đồ kiến trúc v1, file `BảngDB.docx` và mã nguồn trong repo (các service NestJS, `docker-compose.yml`, `k8s/`, `infrastructure/`).
**Ngày:** 2026-11-11

> **Cập nhật 2026-11-11:** phần lớn các vấn đề dưới đây đã được xử lý, xem bảng đối chiếu trong [07-implementation-status.md](07-implementation-status.md). Nội dung bên dưới giữ nguyên là kết quả review ban đầu.

## 1. Đề bài

| Mã | Yêu cầu |
|---|---|
| **R1** | Dữ liệu tài liệu được phân đoạn và lưu trữ theo từng phòng ban, mỗi phòng ban một node riêng. |
| **R2** | Có dịch vụ tìm kiếm hợp nhất (federated search) truy vấn đồng thời nhiều node phòng ban. |
| **R3** | Thêm được một phòng ban mới vào hệ thống tìm kiếm mà không phải sửa các node đã có. |

## 2. Tóm tắt kết luận

| Yêu cầu | Thiết kế v1 | Đánh giá | Lý do chính |
|---|---|---|---|
| R1 | Mỗi phòng ban có Local Service, Database chính, Replica và File Storage riêng | ✅ **Đạt** | Đúng mô hình *data partitioning theo miền nghiệp vụ*. Các node cô lập với nhau qua `DepartmentGuard`. |
| R2 | CDC đẩy dữ liệu vào **một DB trung tâm**, Search Engine tìm trong DB đó | ⚠️ **Đạt một phần** | Đây là *centralized index* (CQRS read model), không phải *federated query*. Lúc tìm kiếm, hệ thống không truy vấn node nào. |
| R3 | Bảng `departments.service_route` có trong thiết kế, nhưng code không dùng | ❌ **Chưa đạt** | Thêm một phòng ban phải sửa khoảng 10 nơi, trong đó có code của Search Engine và frontend (xem mục 4). |

**Nhận định chung.** Nền móng tốt: phân vùng dữ liệu, CDC, outbox, IAM chuẩn OIDC. Nhưng thiết kế v1 đang giải bài toán *"đồng bộ về trung tâm"* chứ chưa giải bài toán *"truy vấn liên hợp"* và *"mở rộng động"*, vốn là hai điểm cốt lõi của đề tài. Bản nâng cấp ([02-target-architecture.md](02-target-architecture.md)) giữ lại toàn bộ phần tốt và bổ sung ba thứ:

- **Federated scatter-gather**
- **Department Registry** cùng cơ chế node tự đăng ký
- **Central Index** đóng vai trò lớp dự phòng khi node gặp sự cố

## 3. Điểm mạnh nên giữ

1. **Phân vùng dữ liệu theo phòng ban.** Mỗi phòng ban có DB, MinIO và replica riêng, đúng tinh thần *shared-nothing*.
2. **Dùng CDC qua Debezium thay vì dual-write.** Cách này tránh được lỗi ghi DB thành công nhưng gửi event thất bại.
3. **`AUDIT_OUTBOX` trong docx.** Đúng *Transactional Outbox pattern*.
4. **`cdc_partition_progress` trong docx.** Offset được lưu cùng transaction với dữ liệu, nên mỗi event được áp dụng đúng một lần về mặt hiệu lực (*effectively-once*). Đây là điểm cộng lớn, nhiều đồ án bỏ qua.
5. **IAM theo chuẩn OIDC** với khóa `UQ(identity_issuer, identity_subject)`. Thiết kế này sẵn sàng tích hợp Keycloak hoặc Azure AD.
6. **`audit_events` có `event_id` do nguồn sinh ra và giữ nguyên khi gửi lại.** Nhờ vậy việc ghi audit có tính idempotent.
7. **Đã có Redis cache, Prometheus, Grafana và streaming replication cho Postgres.**

## 4. Danh sách vấn đề

Mức độ: 🔴 Nghiêm trọng, ảnh hưởng tới yêu cầu đề bài hoặc bảo mật · 🟠 Cao · 🟡 Trung bình.

### 4.1 Mô hình và kiến trúc

| # | Mức | Vấn đề | Bằng chứng | Hướng xử lý |
|---|---|---|---|---|
| A1 | 🔴 | **R2 chưa đúng nghĩa federated.** Search chỉ đọc `dms_central`. | `services/search-engine-service/src/modules/search/search.service.ts` chỉ dùng một pool tới Central DB. | Hybrid Federated Search: scatter-gather tới từng node, dùng Central Index làm dự phòng. |
| A2 | 🔴 | **Thêm phòng ban phải sửa code Search Engine.** | `cdc-consumer.controller.ts:9,18` hardcode `@EventPattern('cdc.hr…')` và `('cdc.acc…')`. `cdc-consumer.service.ts:47` có `topic.startsWith('cdc.hr') ? 1 : 2`, nên phòng ban thứ 3 sẽ bị gán nhầm thành Kế toán. | Subscribe Kafka theo pattern và ánh xạ topic sang phòng ban qua Registry. |
| A3 | 🔴 | **Không có Department Registry chạy thật.** Bảng `department` có `node_endpoint` và `kafka_topic` nhưng không ai đọc. Giá trị seed `cdc.hr.documents` cũng không khớp với topic thật `cdc.hr.public.document`. | `infrastructure/postgres/init-scripts/central/01-schema.sql` | Registry Service, node tự đăng ký kèm heartbeat. |
| A4 | 🟠 | **Hai service phòng ban là bản sao của nhau.** `local-service-hr` và `local-service-accounting` chỉ khác nhau ở `DEPT_CODE`, port và bucket. | `services/local-service-*` | Gộp thành **một image `department-service`** và cấu hình bằng biến môi trường. |
| A5 | 🟠 | **Frontend hardcode `'HR' \| 'ACC'`** ở khoảng 15 component. Hàm `api.ts` chọn route bằng toán tử ba ngôi. | `frontend/src/types/index.ts`, `AuthContext.tsx`, `ExecutiveTab.tsx` | Lấy danh sách phòng ban từ `GET /registry/departments`. |
| A6 | 🟠 | **Sơ đồ thiếu thành phần:** IAM/IdP, Registry, Schema Registry, DLQ, đường tải file liên phòng ban. | Sơ đồ v1 | Bổ sung trong sơ đồ v2. |
| A7 | 🟠 | **Tải file liên phòng ban đang là giả lập.** Trình duyệt tự tạo file `.txt` từ metadata. | `frontend/src/components/SharedDocDetailDrawer.tsx` | Node chủ sở hữu cấp presigned URL MinIO (TTL 60 giây) và ghi audit. |
| A8 | 🟡 | **Đang dùng CDC thô trên bảng nghiệp vụ.** Đổi tên một cột là phá vỡ consumer. | `infrastructure/debezium/connectors/*.json` (`FOR ALL TABLES`) | Outbox Event Router với hợp đồng sự kiện có version. |

### 4.2 Độ tin cậy và tính sẵn sàng (single point of failure)

| # | Mức | Vấn đề | Hướng xử lý |
|---|---|---|---|
| B1 | 🔴 | **Consumer nuốt lỗi.** `processDocumentEvent` bắt exception rồi kết thúc bình thường, Kafka vẫn commit offset, nên event bị mất vĩnh viễn. | Retry có backoff, quá N lần thì đẩy vào DLQ topic. Lưu offset cùng transaction (`cdc_partition_progress`). |
| B2 | 🟠 | **Không chống event cũ ghi đè dữ liệu mới.** Upsert không kiểm tra `ts_ms`, LSN hay version. | Cột `source_version` với điều kiện `UPDATE … WHERE source_version < $new`. |
| B3 | 🟠 | **Kafka chỉ có 1 broker, RF=1. Debezium cũng chỉ có 1 instance.** | 3 broker KRaft, `RF=3`, `min.insync.replicas=2` (Strimzi). |
| B4 | 🟠 | **Postgres có replica nhưng không tự failover.** Replication slot của CDC chỉ nằm trên primary. | CloudNativePG: tự động failover, đồng bộ logical slot (PG17 `sync_replication_slots`). |
| B5 | 🟠 | **Không có connector nào được đăng ký tự động.** Chạy `docker compose up` xong thì không có CDC. | Init job (compose) hoặc CRD `KafkaConnector` (Strimzi). |
| B6 | 🟡 | **Job thu hồi share hết hạn chạy bằng `setInterval` trên mọi replica.** | Chỉ cho một replica chạy: K8s `CronJob` hoặc advisory lock của Postgres. |
| B7 | 🟡 | **`/health` của Search không kiểm tra DB, Kafka hay Redis.** | Tách `/health/live` và `/health/ready` (Terminus). |

### 4.3 Bảo mật

| # | Mức | Vấn đề | Bằng chứng |
|---|---|---|---|
| C1 | 🔴 | **Search Engine không xác thực.** `isExecutive` và `viewerDeptCode` do client tự gửi, ai cũng có thể gửi `?isExecutive=true`. | `services/search-engine-service/src/dto/search-query.dto.ts:44,48` |
| C2 | 🔴 | **JWT secret có giá trị mặc định nằm ngay trong code**, và compose không đặt `JWT_SECRET`. | `services/local-service-*/src/modules/auth/auth.module.ts:14`, `jwt.strategy.ts:12` |
| C3 | 🔴 | **Chấp nhận mật khẩu `Admin@123` cho mọi user có hash rỗng.** | `services/local-service-*/src/modules/auth/auth.service.ts:31` |
| C4 | 🟠 | **Vai trò Ban Giám đốc chỉ là cờ ở frontend**, JWT không mang role đó. | `frontend/src/context/AuthContext.tsx` |
| C5 | 🟠 | **Secret plaintext** trong `.env`, connector JSON, k8s `stringData`, Grafana `admin/admin`. | `k8s/01-configmaps-secrets.yaml`, `infrastructure/debezium/connectors/*.json` |
| C6 | 🟡 | **Không có TLS.** `pg_hba` mở `0.0.0.0/0`. Kafka chạy PLAINTEXT. | `infrastructure/nginx/*`, `infrastructure/postgres/*` |

### 4.4 Hạ tầng và vận hành

| # | Mức | Vấn đề | Bằng chứng |
|---|---|---|---|
| D1 | 🔴 | **Thiếu DDL của `document_share` và `access_request`.** Code có query hai bảng này, nên stack dựng mới sẽ lỗi `relation does not exist`. | `infrastructure/postgres/init-scripts/central/01-schema.sql` (không có), trong khi `share.service.ts` và `search.service.ts` có dùng |
| D2 | 🟠 | **Nginx proxy tới `host.docker.internal`** thay vì tên service. Không có `upstream` nên không có cân bằng tải. Upload rate limit (2r/s) áp lên cả request GET. | `infrastructure/nginx/conf.d/api-gateway.conf:24-79` |
| D3 | 🟠 | **K8s manifest lệch với code.** Biến `DEPARTMENT_CODE` trong manifest nhưng code đọc `DEPT_CODE`. Tương tự `MINIO_BUCKET_NAME` và `MINIO_BUCKET`. User và tên DB cũng khác compose. Không có Debezium, `wal_level=logical`, HPA, NetworkPolicy, resources hay PVC cho Kafka. | `k8s/01-configmaps-secrets.yaml`, `k8s/07-*.yaml` |
| D4 | 🟡 | **Không có ELK hay log tập trung, không có tracing, không có alert rule.** | `infrastructure/monitoring/` |
| D5 | 🟡 | **Không có CI, không có test tự động.** | `.github/`, không có file `*.spec.ts` |
| D6 | 🟡 | **Central Index chỉ consume bảng `document`.** Các cột `file_name`, `mime_type`, `category`, `tags`, `owner` luôn NULL. FTS dùng config `'simple'` nên không hỗ trợ tiếng Việt không dấu. Điều kiện `ILIKE '%q%'` khiến GIN index không được dùng. | `cdc-consumer.service.ts`, `search.service.ts` |

## 5. Review chi tiết `BảngDB.docx`

| Nhóm | Điểm tốt | Vấn đề | Đề xuất |
|---|---|---|---|
| Kiểu dữ liệu | Có microsecond (`DATETIME(6)`) | Đang dùng kiểu **MySQL** trong khi hệ thống chạy Postgres | `TIMESTAMPTZ`, `UUID`, `JSONB` |
| Định danh | `doc_id BIGINT` gọn | ID cục bộ **trùng nhau giữa các phòng ban** khi gộp kết quả federated | **UUIDv7** cho `document_id`: duy nhất toàn cục, vẫn sắp xếp được theo thời gian, B-tree hoạt động tốt |
| `DOCUMENT` | Có soft delete (`deleted_at`) | Thiếu `classification`, `row_version`, `search_vector`, `owner_department` | Thêm cột (xem [03](03-database-design.md)) |
| `FILE_OBJECT` | Có `checksum_sha256`, `UQ storage_key` | `file_id UNIQUE` trong `DOCUMENT` tạo quan hệ 1-1, **làm mất lịch sử phiên bản** | Thêm bảng `DOCUMENT_VERSION` (1-n) |
| `AUDIT_OUTBOX` | Đúng outbox pattern | Chỉ dùng cho audit. Sự kiện tài liệu vẫn đi qua CDC thô | Gộp thành `OUTBOX` chung, dùng Debezium Outbox Event Router |
| IAM | Đúng chuẩn OIDC, có `scope_type` | `departments` trộn hai việc: danh mục phòng ban và định tuyến | Tách thành `departments` + `department_endpoints` + `department_health` |
| Central | `PK (department_id, document_id)`, có `cdc_partition_progress` | Thiếu `description`, `tags`, `classification`, `is_deleted`, `source_version`, `search_vector`. **Thiếu bảng chia sẻ và bảng yêu cầu truy cập** | Bổ sung `document_share`, `access_request` |
| Audit | `event_id` idempotent, có `request_id` | Bảng sẽ phình to rất nhanh và không chống được việc sửa dữ liệu | Partition theo tháng, chỉ cho phép append, thêm hash chain (`prev_hash`, `hash`) |

## 6. Ma trận truy vết (sau khi nâng cấp)

| Yêu cầu | Thành phần | Bảng hoặc hợp đồng | Kịch bản demo |
|---|---|---|---|
| R1 | Helm release `department` cho mỗi phòng ban (Postgres cluster + MinIO bucket + service) | Schema node (`document`, `document_version`, `file_object`, `outbox`) | Demo 3: failover Postgres của một node |
| R2 | Federated Search Gateway: scatter-gather, timeout, circuit breaker | `GET /internal/search` (OpenAPI), `FederatedSearchResponse` | Demo 1: trace fan-out trên Tempo. Demo 4: kết quả partial và stale |
| R3 | Registry + self-registration + Kafka pattern subscribe + routing động | `departments`, `department_endpoints`, `department_health`, event `DepartmentRegistered` | Demo 2: `helm install dept-sales` |
