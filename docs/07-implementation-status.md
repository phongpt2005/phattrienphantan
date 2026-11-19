# 07. Tình trạng triển khai (cập nhật 2026-11-12)

Tài liệu 01–06 mô tả **thiết kế đích**. File này ghi **cái gì đã làm thật, kiểm chứng ra sao, và cái gì chưa làm**,
để không nhầm thiết kế với hiện trạng.

Kiểm chứng tự động: `bash infrastructure/scripts/e2e-smoke.sh` (72 kiểm tra, chạy qua API Gateway, 3 phòng ban HR/ACC/SALES). Lần chạy gần nhất: **72 đạt, 0 lỗi**. Kịch bản demo: [08-demo-script.md](08-demo-script.md).

## 1. Đối chiếu yêu cầu đề bài

| Yêu cầu | Trạng thái | Cách chứng minh |
|---|---|---|
| **R1** Dữ liệu phân đoạn theo phòng ban, node riêng | ✅ Đã có | Mỗi phòng ban có Postgres + MinIO riêng; token HR gọi node ACC bị 403 (test mục 2) |
| **R2** Tìm kiếm hợp nhất, truy vấn đồng thời nhiều node | ✅ Đã có | `SearchService` fan-out song song, circuit breaker + timeout; dừng node ACC thì `partial=true`, ACC `FALLBACK`, HR vẫn `OK`; node trở lại thì `partial=false` (test mục 3, 6) |
| **R3** Thêm phòng ban không sửa node cũ | ✅ Đã có | `bash scripts/add-department.sh SALES "Phòng Kinh doanh"`: node cũ (`dept-hr`, `dept-acc`, `search-engine-service`, `nginx`, DB HR/ACC) **không bị khởi động lại**; SALES vào Registry, được fan-out và hiện trên giao diện |

## 2. Đối chiếu các vấn đề trong review (`01-architecture-review.md`)

| Mã | Vấn đề | Trạng thái | Ghi chú |
|---|---|---|---|
| A1 | R2 chưa đúng nghĩa federated | ✅ Đã sửa | Hybrid: node trực tiếp + Central Index dự phòng |
| A2 | Thêm phòng ban phải sửa code Search | ✅ Đã sửa | Projector subscribe topic theo pattern `dms.dept.<code>.document`; mã phòng ban lấy từ topic, bỏ `startsWith('cdc.hr') ? 1 : 2` |
| A3 | Không có Registry chạy thật | ✅ Đã sửa | Node tự đăng ký + heartbeat; sweeper chuyển `DEGRADED` khi mất heartbeat |
| A4 | Hai service phòng ban trùng nhau | ✅ Đã sửa | Một image `department-service`; `local-service-hr/-accounting` đã xóa |
| A5 | Frontend hardcode `HR`/`ACC` | ✅ Đã sửa | Danh sách phòng ban lấy từ `/api/registry/departments/public`; route `/api/dept/<code>/...` |
| A6 | Sơ đồ thiếu Registry, IdP, Schema Registry, DLQ | 🟡 Một phần | Registry và DLQ đã có. **Chưa có** Keycloak, Apicurio |
| A7 | Tải file liên phòng ban là giả (tạo `.txt`) | ✅ Đã sửa | `GET /api/search/documents/:id/download` stream file thật từ node chủ; quyền VIEW bị chặn (DLP); node ghi audit |
| A8 | CDC thô trên bảng nghiệp vụ | ✅ Đã sửa | Transactional Outbox + Debezium Outbox Event Router; publication chỉ gồm `outbox` |
| B1 | Consumer nuốt lỗi | ✅ Đã sửa | Retry 3 lần rồi DLQ `dms.dlq.projector`; log `sync_event_log` |
| B2 | Event cũ ghi đè dữ liệu mới | ✅ Đã sửa | `source_version` (= `row_version` ở node); phát lại trùng bị `SKIPPED` (đã quan sát thực tế) |
| B3 | Kafka 1 broker, RF=1 | ❌ Chưa | Dev vẫn 1 broker. Không làm trên Compose nếu RAM không cho phép |
| B4 | Postgres không tự failover | ❌ Chưa | Cần công cụ tự failover trên Compose (Patroni), chưa làm |
| B5 | Connector không đăng ký tự động | ✅ Đã sửa | Service `connect-init` đăng ký khi `docker compose up`; `add-department.sh` đăng ký cho phòng mới |
| B6 | Job hết hạn share chạy trên mọi replica | ❌ Chưa | Câu lệnh là idempotent nên không sai dữ liệu, nhưng chưa dùng lock/CronJob |
| B7 | `/health` không kiểm tra phụ thuộc | 🟡 Một phần | Search kiểm tra DB và trạng thái Projector; chưa tách live/ready |
| C1 | Search không xác thực, `isExecutive` do client gửi | ✅ Đã sửa | JWT bắt buộc; người xem lấy từ token (test: tham số giả bị bỏ qua) |
| C2 | JWT secret mặc định trong code | ✅ Đã sửa | `requireEnv('JWT_SECRET')`: thiếu là dừng ngay |
| C3 | Mật khẩu mặc định `Admin@123` cho hash rỗng | ✅ Đã sửa | Tài khoản chưa đặt mật khẩu không đăng nhập được |
| C4 | Ban Giám đốc chỉ là cờ ở frontend | ✅ Đã sửa | Executive = vai trò `ADMIN` trong token; `executive/*` chỉ ADMIN |
| C5 | Secret plaintext | 🟡 Một phần | Bỏ secret cứng trong code, compose, connector; Grafana không còn `admin/admin`. Secret vẫn ở `.env` (không commit). **Chưa có** Sealed Secrets/Vault |
| C6 | Không TLS, `pg_hba` mở rộng | ❌ Chưa | Dev chạy HTTP; `pg_hba` vẫn `0.0.0.0/0` trong mạng Docker nội bộ |
| D1 | Thiếu DDL `document_share`, `access_request` | ✅ Đã sửa | Có trong `infrastructure/postgres/init-scripts/central/01-schema.sql` (khớp schema đang chạy) |
| D2 | nginx dùng `host.docker.internal`, rate limit upload áp cả GET | ✅ Đã sửa | Gọi thẳng service/DNS Docker; upload limit chỉ áp POST/PUT `/documents` |
| D3 | Manifest k8s lệch code | ❌ Chưa | Đã đánh dấu `k8s/DEPRECATED.md`; Helm chart là giai đoạn sau |
| D4 | Không log tập trung, tracing, alert | 🟡 Một phần | **Đã có** số đo Prometheus, dashboard Grafana *DMS - Federated Search & CDC*, 3 luật cảnh báo, và distributed tracing (OpenTelemetry + Jaeger). **Chưa có** log tập trung (Loki), Alertmanager |
| D5 | Không CI, không test tự động | 🟡 Một phần | Có `e2e-smoke.sh` (62 kiểm tra). **Chưa có** unit test, GitHub Actions |
| D6 | Central Index thiếu file/owner/category, FTS không hỗ trợ tiếng Việt | ✅ Đã sửa | Index đủ `file_name`, `mime_type`, `owner_name`, `category_name`, `tags`; cấu hình `vn_unaccent` ("hop dong" khớp "Hợp đồng") |


## 2b. Nghiệp vụ và quan sát bổ sung (2026-11-12)

| Tính năng | Mô tả | Kiểm chứng |
|---|---|---|
| Audit chống sửa đổi | Mỗi dòng `audit_log` băm SHA-256 nối với dòng trước; trigger trong CSDL tự tính, bảng chỉ-ghi (UPDATE/DELETE bị chặn); `GET /api/dept/<code>/audit/verify` phát hiện đứt chuỗi | e2e mục 7; thử UPDATE trực tiếp bị từ chối |
| Thông báo thời gian thực | SSE `GET /api/search/notifications/stream`, lọc theo phòng ban/vai trò từ JWT; chuông trên giao diện; báo khi có chia sẻ, yêu cầu xin quyền, kết quả duyệt | e2e mục 8; kiểm tra tay trên giao diện: chuông nhận yêu cầu của ACC tức thì |
| Số đo federated search | `dms_search_node_duration_seconds{node,status}`, `dms_search_fallback_total`, `dms_search_partial_total`, `dms_cdc_events_processed_total{department,status}`, `dms_sse_clients` | Truy vấn Prometheus có số liệu thật |
| Dashboard + cảnh báo | Grafana *DMS - Federated Search & CDC*; luật `DepartmentNodeDown`, `SearchUsingFallback`, `ProjectorDeadLetter` | Dashboard nạp được, datasource trả dữ liệu; 3 luật hiển thị trong Prometheus |
| Grafana không còn `admin/admin` | Mật khẩu lấy từ `.env` (volume cũ phải đặt lại bằng `grafana cli admin reset-admin-password`) | Đăng nhập bằng mật khẩu mới thành công |

## 2c. Hàng đợi công việc và nhân bản tầng dùng chung (2026-11-12)

| Tính năng | Mô tả | Kiểm chứng |
|---|---|---|
| Tìm theo nội dung tệp | `content-worker` tiêu thụ sự kiện `document` trên Kafka (consumer group `content-indexer`), trích văn bản TXT/PDF/DOCX, ghi về node chủ sở hữu; node tìm full-text cả trong nội dung. [ADR-007](05-adr/ADR-007-content-indexing-pipeline.md) | e2e mục 9: tải lên rồi tìm theo chuỗi chỉ có trong tệp, ra đúng tài liệu sau 0,2–1 giây với cả ba định dạng |
| Nội dung không rời phòng ban | Central Index chỉ nhận cờ `contentIndexedVersion`; nội dung nằm ở DB của node | e2e: dừng node HR thì dự phòng không tìm được theo nội dung; phòng ACC không tìm thấy nội dung của HR |
| Nhân bản worker | `docker compose up -d --no-build --scale content-worker=N` | 2 worker: Kafka chia 9 partition thành 4 và 5; tắt một bản thì bản còn lại nhận cả 9; bật lại thì về 4 và 5 |
| Retry và DLQ | Lỗi hạ tầng: thử 3 lần rồi vào `dms.dlq.content`. Tệp hỏng: ghi nhận `unreadable`, không thử lại | Quan sát trong log khi chạy thật với 2 tệp PDF hỏng có sẵn trong dữ liệu |
| Chống vòng lặp | Sự kiện do chính worker gây ra mang `contentIndexedVersion == versionNo` nên bị bỏ qua | e2e: số việc `indexed` không tăng thêm sau khi xử lý xong |
| Search Gateway 2 bản | `deploy.replicas: 2`, nginx thử bản khác khi một bản lỗi. [ADR-008](05-adr/ADR-008-stateless-search-tier.md) | e2e mục 10: tắt 1 bản, 8/8 truy vấn vẫn thành công |
| Thông báo xuyên bản | SSE đi qua Redis pub/sub | 8/8 thông báo tới nơi, do hai bản khác nhau phát (3 và 5 lần) |
| Giám sát | Prometheus phát hiện mọi bản qua DNS; dashboard thêm số bản đang sống, partition của từng worker, việc lập chỉ mục, DLQ | Truy vấn Prometheus có số liệu thật |

| Distributed tracing | OpenTelemetry trong Search Gateway và mọi node, xem trên Jaeger (`http://localhost:16686`); phản hồi tìm kiếm trả `traceId`. [ADR-009](05-adr/ADR-009-distributed-tracing.md) | e2e mục 11: một trace 53 span xuyên qua `search-gateway`, `dept-hr`, `dept-acc`, `dept-sales`; ba span `federated.query` chạy song song. Dừng node ACC: span của ACC báo `FALLBACK`, đánh dấu lỗi, lý do `lifecycle=DRAINING` |

**Giới hạn còn lại của hai phần này:** truy vấn Prisma tại node và chuỗi Outbox → Kafka → worker chưa nối vào trace; Jaeger lưu trong bộ nhớ; chưa OCR ảnh quét, chưa đọc Excel/PowerPoint (đánh dấu `unsupported`); Redis và Kafka vẫn chạy một bản nên là hai điểm chết còn lại; Helm chart chưa có `content-worker`.

## 2d. Giám sát hệ thống cho Ban Giám đốc (2026-11-12)

Trang **Giám sát hệ thống** (chỉ vai trò Ban Giám đốc) trả lời: node nào đang sống, node nào sập, sập từ lúc nào, phục hồi lúc nào, sập bao lâu.
Mọi số liệu là dữ liệu thật; nguồn nào không đọc được thì hiện "không rõ" chứ không đoán.

| Thành phần | Mô tả | Kiểm chứng |
|---|---|---|
| Lịch sử trạng thái node | Registry ghi một dòng vào `department_status_event` mỗi lần node đổi vòng đời (đăng ký, mất nhịp tim, tắt có trật tự, phục hồi). Chạy nhiều bản Registry vẫn chỉ ghi một lần (`UPDATE ... RETURNING` nguyên tử) | Dừng có trật tự: ghi nhận ngay. Sập đột ngột (`docker kill`): phát hiện sau 29–32 giây (ngưỡng mất nhịp tim 30 giây) |
| Thời điểm bắt đầu sự cố | Sập đột ngột tính từ **nhịp tim cuối cùng**, không phải lúc phát hiện | Kill lúc 23:29:33 → sự cố ghi bắt đầu 23:29:32, phục hồi 23:30:19, thời lượng 47 giây |
| Khoảng chờ khi Registry khởi động | Trong 40 giây đầu Registry không kết luận node sập (lúc Registry tắt, node không gửi được nhịp tim) | Khởi động lại cả 2 bản Search: số sự kiện trạng thái không đổi (22 → 22) |
| API tổng hợp | `GET /api/search/executive/system`: trạng thái tổng, từng node (nhịp tim, 48 ô lịch sử 24 giờ, tỉ lệ sẵn sàng, p95, số lần dùng dự phòng), nhật ký sự cố, thành phần nền tảng, cảnh báo Prometheus đang bật | e2e mục 12 (11 kiểm tra) |
| Thành phần nền tảng | Số bản Search/worker đang sống (Prometheus), trạng thái connector Debezium (Kafka Connect REST), Projector, CSDL trung tâm, Redis, đường ống đồng bộ và DLQ | Bắt được lỗi thật: ba connector kẹt `UNASSIGNED` sau khi Kafka khởi động lại (đã sửa bằng `ADVERTISED_HOST_NAME`) |
| Cảnh báo tức thời | Thông báo `NODE_DOWN`, `NODE_RECOVERED`, `NODE_JOINED` đẩy qua SSE cho riêng Ban Giám đốc; trang tự làm mới ngay khi nhận | Ban Giám đốc nhận đủ; Nhân viên nhận 0 |
| Giao diện | Dải trạng thái tổng, bảng node với thanh lịch sử 24 giờ, bảng thành phần, cảnh báo, nhật ký sự cố, dòng sự kiện. Tham khảo cách trình bày của Uptime Kuma, Gatus, openstatus | Xem trực tiếp: tắt ACC, sau vài giây trang chuyển "suy giảm một phần", dòng ACC hiện "ĐÃ DỪNG từ 23:33:45", chuông và thanh bên cùng báo |

### Làm lại các màn hình nghiệp vụ (2026-11-13)

Bộ thành phần dùng chung `frontend/src/components/ui.tsx` (nhãn trạng thái, bảng mật độ cao, thanh tỉ lệ, nút) theo quy chuẩn `AGENTS.md`: hàng bảng 36–44px, màu doanh nghiệp, góc bo nhỏ, nhãn DLP (`BẢO MẬT PHÒNG BAN`, `CHỈ XEM - DLP`, `ĐƯỢC TẢI VỀ`...), chữ mono cho mã và ngày.

| Màn hình | Thay đổi |
|---|---|
| Tra cứu | Hiện node nào trả lời trực tiếp và mất bao lâu, node nào phải dùng dự phòng; nhãn "khớp trong nội dung tệp" kèm đoạn trích tô sáng (dựng bằng React node, không chèn HTML thô); liên kết mở vết truy vấn trên Jaeger |
| Báo cáo điều hành | Bỏ hoàn toàn số liệu giả (chữ "ALL NODES HEALTHY", "Zero Data Loss", "STREAMING" cố định). Chỉ còn số liệu nghiệp vụ thật: tài liệu theo phòng, trạng thái, định dạng, chia sẻ đang hiệu lực, yêu cầu chờ duyệt, dòng sự kiện đồng bộ. Tình trạng hạ tầng chuyển sang màn Giám sát hệ thống |
| Trung tâm phê duyệt | Bốn danh sách dạng bảng; người duyệt tự chọn mức quyền cấp (chỉ xem hoặc tải về) khác mức được xin; từ chối kèm lý do gửi cho người xin |
| Kho hồ sơ | Bỏ kiểu "Google Drive" (viên thuốc bo tròn, hiệu ứng phóng to); bỏ thanh dung lượng giả (số tài liệu x 0,42 MB, thanh 22% cố định) |

Lỗi dữ liệu phát hiện khi xem trên giao diện thật và đã sửa:
- **Tên thư mục bị hỏng chữ** (`Quy???t ?????nh`): trong DB là dấu `?` thật do nạp dữ liệu mẫu sai bảng mã. Đã cập nhật lại tên đúng cho HR và ACC, tăng phiên bản tài liệu và phát lại qua Outbox để chỉ mục trung tâm cập nhật theo (0 dòng còn lỗi).
- **Giờ hiển thị lệch 7 giờ** ở năm cột `timestamp` không kèm múi giờ (giờ đồng bộ, giờ sự kiện, lịch sử tìm kiếm, giờ đăng ký phòng ban): đã chuyển sang `timestamptz` (migration idempotent trong `central/01-schema.sql`). Hạn chia sẻ và yêu cầu xin quyền vốn đã dùng `timestamptz` nên không bị ảnh hưởng.
- Đoạn "trích nội dung tệp" đôi khi hiện mô tả: nay lấy từ nội dung tệp khi từ khóa khớp trong nội dung.
- Ban Giám đốc xem tài liệu phòng khác bị gắn nhãn "PHÒNG TÔI SỞ HỮU": nay là "QUYỀN BAN GIÁM ĐỐC".
- Cụm kind `dms` tự chạy lại sau khi bật máy và chiếm cổng 8000 của cổng vào: đã dừng và đặt không tự khởi động.

Thay đổi giao diện kèm theo: thanh bên, tiêu đề và bảng lệnh Ctrl+K viết lại (điều hướng theo vai trò, tài khoản mẫu sinh từ Registry và chỉ hiện khi `VITE_DEMO_LOGIN=true`). Trang "Sơ đồ phân tán 3D" cũ dùng số liệu viết cứng nên đã bỏ khỏi ứng dụng; hai file `TopologyTab.tsx` và `InteractiveTopology3D.tsx` còn nằm trong `frontend/src/components/` nhưng không được dùng (nên xóa tay).

**Giới hạn:** độ trễ phát hiện sập đột ngột khoảng 30 giây; tỉ lệ sẵn sàng chỉ tính từ lúc bắt đầu theo dõi (2026-11-12); chưa có trang trạng thái công khai, chưa gửi cảnh báo ra email/chat (cần Alertmanager); giao diện chưa dùng bộ component Astryx như `frontend/.claude/CLAUDE.md` yêu cầu (công cụ dòng lệnh của nó bị chặn trong phiên làm việc).

## 2e. Loại bỏ điểm chết: chỉ mục trung tâm (2026-11-13) — mục 1 của kế hoạch hoàn thiện

Đo thật trên bản cũ rồi sửa. Chi tiết và lý do: [ADR-010](05-adr/ADR-010-central-index-is-optional.md).

| | Trước khi sửa (đã đo) | Sau khi sửa (đã đo) |
|---|---|---|
| Tắt CSDL trung tâm, tìm kiếm | **HTTP 502**, cả 2 bản Gateway sập | HTTP 200, đủ 28 kết quả, mọi node `OK`, báo rõ chế độ suy giảm |
| Quyền chia sẻ khi trung tâm sập | Không đọc được | (bản đầu dùng bản chụp; **nay node chủ tự kiểm quyền, xem 2f**) |
| Sự kiện đồng bộ trong lúc trung tâm sập | Đẩy vào DLQ sau 3 lần thử (mất chỉ mục) | Giữ nguyên chờ trung tâm, hồi phục xong về đủ sau vài giây, 0 vào DLQ |
| Node sập oan sau khi Registry khởi động lại | Bị đánh dấu `DEGRADED` | Ân hạn 65 giây, 0 sự cố giả |
| Chuỗi audit khi ghi đồng thời | Báo đứt oan; HR có 1 nhánh rẽ thật | Thứ tự theo `chain_seq` cấp trong khóa; 200 lần ghi đồng thời vẫn nguyên; sửa lén vẫn bị phát hiện |

## 2l. Gói P0.5: khép kín P0 trước khi làm P1 (2026-11-19)

| Mục | Nội dung | Kết quả đã kiểm chứng |
|---|---|---|
| P0.5.1 Thu hồi tại node (fail-open) | JWT của node kiểm khóa `tv:<phòng>:<userId>` trên Redis; client đọc riêng, không xếp hàng, timeout 150 ms; Redis lỗi thì cho qua và cảnh báo tối đa mỗi 30 giây | `revoke-test.sh` 18/18, gồm đường nội bộ `/api/dept/hr/...` trả 401. Thử dừng Redis: node vẫn trả 200 trong 40–70 ms |
| P0.5.2 Mã hóa sao lưu | `backup-offsite.sh` mã hóa AES-256-CBC, PBKDF2, 200000 vòng bằng `BACKUP_ENCRYPTION_KEY`; thiếu khóa thì dừng; `restore-test.sh` giải mã trước khi khôi phục | Bản `20261119_041101`: 22/22, RTO 111 giây. Bản cũ `20261119_031054` vẫn là bản chưa mã hóa, chờ quyết định xóa |
| P0.5.3 Lịch sử chia sẻ | Bảng `document_share_history` tại node (nguồn sự thật), chỉ-thêm bằng trigger; ghi trong cùng transaction với thay đổi; sổ idempotent theo lịch sử; điều kiện đơn điệu theo mã yêu cầu nên yêu cầu cũ không ghi đè quyền mới; trả `SUPERSEDED` và gateway không báo "đã cấp quyền" khi quyền không đổi | `share-provenance-test.sh` 14/14; `approval-race-test.sh` 6/6 (1 lần 201, còn lại 409/400) |

**Hồi quy phát hiện và đã sửa trong P0.5:** lệnh ghi lịch sử `REVOKED` truyền `expires_at` dưới dạng chuỗi (lỗi 42804), làm thu hồi thất bại. Đã sửa bằng `CAST(... AS TIMESTAMPTZ)` và thêm kiểm thử thu hồi qua API node vào `share-provenance-test.sh`.

**Điểm lệch có chủ đích so với kế hoạch:** bảng lịch sử chỉ tạo ở node (nguồn sự thật), không tạo ở trung tâm vì trung tâm chỉ là bản chiếu.

**Sự cố phát hiện khi chạy e2e và đã xử lý:**
- Tiến độ projector trong CSDL trung tâm lệch với topic Kafka hiện tại. Nguyên nhân gốc là Kafka không lưu log vào volume: log thật nằm ở `/tmp/kafka-logs` trong container, nên mỗi lần tạo lại container Kafka thì mất topic. Lần tạo lại lúc P0.4 là nguyên nhân. Đã đặt tiến độ HR/ACC về -1 để projector đọc lại; tiến độ đã hội tụ về log-end − 1 và lag về 0. Đã sao lưu log Kafka ra ngoài container trước khi thay đổi.
- Hàm `GREATEST` trong upsert tiến độ không bao giờ hạ giá trị, nên lỗi lệch sẽ lặp lại khi topic bị tạo lại. Cần sửa mã (xem mục P1 trước).
- Content-worker dừng xử lý sau lỗi "Dựng consumer lỗi" lúc broker bầu lại leader; đã khởi động lại và backlog được xử lý hết.
- Bộ nhớ Windows chỉ còn khoảng 0,8 GB trên 15,6 GB, làm heartbeat của broker Kafka bị timeout khi máy bận.

**Kết quả cuối:** `e2e-smoke.sh` 96/96, 0 lỗi (Warm SLA 169 ms, Cold 1445 ms).

## 2m. Sửa CDC cho SALES và trạng thái P1 (2026-11-19)

| Mục | Nội dung | Kết quả đã kiểm chứng |
|---|---|---|
| CDC cho SALES | `connect-init` thiếu SALES, nên không có connector `outbox-sales`. Slot `dbz_sales_outbox` không hoạt động và giữ 10 MB WAL, 5 sự kiện chưa gửi. Đã thêm `SALES:dept-sales-db:dms_sales`, và mật khẩu replication riêng theo phòng (`REPL_PASSWORD_<MÃ>`) | Connector RUNNING; slot active; WAL còn 288 byte; topic `dms.dept.sales.document` có; số tài liệu SALES ở trung tâm khớp node (1 = 1) |
| Resync phụ thuộc MinIO | Khi `minio-hr` dừng, resync của HR trả HTTP 500 (`getaddrinfo ... minio-hr`). Đã kiểm chứng: khi MinIO khỏe, resync trả 289 | Ghi nhận như một lỗ hổng thiết kế; cần sửa để resync không đọc MinIO |
| Kafka không lưu log vào volume | Log thật nằm ở `/tmp/kafka-logs` trong container; volume `dms-kafka-data` trống. Mỗi lần tạo lại container Kafka làm mất topic. Đã sao lưu log hiện tại (1,9 GB) ra scratchpad | Ảnh hưởng trực tiếp đến cutover P1 (xem `docs/11`) |
| Hồi quy | `e2e-smoke.sh` sau thay đổi | 96/96, 0 lỗi |

**P1:** đã chuẩn bị runbook đã hiệu chỉnh tại [docs/11-p1-kafka-cutover.md](11-p1-kafka-cutover.md). **Chưa thi công**: RAM trống của Windows chỉ khoảng 0,8 GB trên 15,6 GB, chưa đủ cho 3 broker. Cần bạn giải phóng RAM và chọn cửa sổ bảo trì (~10 phút).

## 2k. Gói P0 (ổn định trước khi làm Gói B, 2026-11-19)

Thứ tự theo quyết định Q4: N5 → N1 → N7 → đóng cổng. Mỗi mục có bằng chứng chạy thật.

| Mục | Nội dung | Kết quả |
|---|---|---|
| P0.1 Đua duyệt yêu cầu | Giữ chỗ nguyên tử `PENDING → PROCESSING` (chỉ một người đi tiếp), gọi node, rồi `APPROVED`; lỗi thì trả về `PENDING`; giữ chỗ quá 2 phút được nhận lại | `approval-race-test.sh` với 8 người duyệt đồng thời: 1 lần 201, 7 lần 409; node chỉ có 1 lượt đang hiệu lực. Nhánh xác định (yêu cầu đang PROCESSING bị 409): đạt. **6/6** |
| P0.2 Sao lưu ngoài máy | `backup-offsite.sh`: pg_dump của HR, ACC, SALES, trung tâm (nén gzip) và thư mục `/data` của MinIO, ghi vào `OneDrive\dms_backups\<thời điểm>`, kèm manifest SHA-256 và số liệu đối soát | Bản `20261119_031054`: 4 CSDL + 3 MinIO, đủ tệp và hash |
| P0.2 Kiểm khôi phục | `restore-test.sh`: kiểm hash, khôi phục vào DB tạm rồi xóa, đối soát với manifest | **21/21**, RTO 37 giây |
| P0.3 Đo độ trễ hàng đợi | Thêm `kafka-exporter` v1.7.0 (chỉ trong mạng nội bộ) và scrape job `kafka-exporter:9308` | Có metric `kafka_consumergroup_lag` (36 dòng khớp) |
| P0.4 Đóng cổng | Bỏ publish CSDL (6), MinIO (2), Redis, Kafka, Debezium và node ACC; Grafana, Prometheus, Jaeger chỉ bind `127.0.0.1` | `docker ps`: chỉ `nginx :8000` và `hr-site-edge :3001` mở ra ngoài |

**Hồi quy sau P0:** `e2e-smoke.sh` 96/96, 0 lỗi (Warm SLA 140 ms, Cold 1370 ms).

**Ghi chú và các điểm đã phát hiện khi làm P0:**
- Số liệu đối soát trong manifest được đọc **sau** khi dump. Nếu có ghi dữ liệu xen giữa, hai số có thể lệch. Restore-test sẽ bắt được lệch đó; nên chạy sao lưu khi hệ thống ít ghi.
- Một yêu cầu duyệt cho tài liệu đã được chia sẻ cho cùng phòng sẽ **cập nhật** lượt đang hiệu lực (đổi quyền, gia hạn) chứ không tạo lượt mới. Trung tâm vẫn ghi APPROVED đúng, nhưng node giữ `access_request_id` của yêu cầu cũ: mất liên kết truy vết giữa lượt chia sẻ và yêu cầu mới nhất. Đề xuất: bảng lịch sử `document_share_event` (chưa làm).
- `test-enterprise-resilience.js` đã từng có mật khẩu CSDL HR viết cứng trong mã nguồn, và file này đã nằm trong commit. Đã thay bằng biến `HR_NODE_DB_URL`. **Nên xoay mật khẩu đó** trước khi đẩy repo lên đâu.
- Đã đóng cổng node ACC: trước đây node có thể bị gọi thẳng, bỏ qua gateway.

## 2j. Thu hồi token ngay lập tức (2026-11-19)

Thiết kế: [ADR-013](05-adr/ADR-013-token-revocation.md). Kiểm thử: `infrastructure/scripts/revoke-test.sh`.

| Nội dung | Kết quả |
|---|---|
| Phiên bản token | Cột `local_user.token_version` (Expand, mặc định 0) đã thêm vào CSDL HR, ACC, SALES; JWT mang `tv` |
| Thu hồi | `POST /api/dept/<mã>/auth/users/:userId/revoke`: Trưởng phòng và Ban Giám đốc; Trưởng phòng không thu hồi được token Ban Giám đốc (403) |
| Thực thi ở gateway | Token bị thu hồi nhận 401 ngay ở tìm kiếm, danh sách chia sẻ và tải tệp liên phòng (16/16 kiểm tra) |
| Đăng nhập lại | Token mới được chấp nhận (200) |
| Đường nội bộ node | Token đã thu hồi vẫn nhận 200 trên `/api/dept/hr/...` tới khi hết hạn 8 giờ (đánh đổi đã chọn) |
| Redis lỗi | Thu hồi trả 503 và không báo thành công; gateway cho qua và ghi cảnh báo (fail-open) |
| Hồi quy e2e-smoke | 96/96, 0 lỗi (Warm SLA 143 ms, Cold 1288 ms) |

## 2i. Cụm node HA và nâng cấp luân phiên (feature 4, 2026-11-18)

| Nội dung | Kết quả |
|---|---|
| Hai bản sao node HR | `dept-hr` và `dept-hr-2` cùng image, cùng CSDL và MinIO; cả hai mang alias `dept-hr` trên `dms-network` và `dms-site-hr` |
| Phân tải | Gateway (`/api/dept/hr`) dùng biến `proxy_pass` + resolver; edge `hr-site-edge` dùng upstream `resolve` + `proxy_next_upstream` |
| Rolling upgrade (`rolling-upgrade-test.sh`) | Tạo lại `dept-hr` rồi `dept-hr-2` trong lúc tải liên tục: 1133/1133 request qua gateway và 1133/1133 qua edge đều 200; mỗi bản khỏe lại sau 11–12 giây |
| Dừng một bản | 40/40 request qua gateway vẫn 200 |
| Hồi quy e2e-smoke | 96/96, 0 lỗi (Warm SLA 171 ms, Cold 1316 ms) |

**Giới hạn:** "nâng cấp" trong bài test là tạo lại container với cùng image, chưa đổi phiên bản mã. Hai bản chạy trên cùng máy và cùng CSDL nên không chứng minh chịu lỗi phần cứng.

**Gateway `:8000`:** đã thêm `proxy_connect_timeout 1s`, `proxy_next_upstream error timeout http_502 http_503 http_504` và `proxy_next_upstream_tries 2` cho route `/api/dept/<mã>` và route tương thích cũ. Kiểm tra sau khi reload: 30/30 request 200. Chưa có bài kiểm thử nào chứng minh cơ chế retry đã kích hoạt, vì không tái hiện được khoảng thời gian DNS còn IP của bản đã tắt.

**Quy tắc đổi schema CSDL khi rolling update (Expand/Contract):**
1. Expand: chỉ thêm bảng hoặc cột có `NULL` hoặc `DEFAULT`. Không đổi tên, không xóa cột, không thêm `NOT NULL` ngay. Bản cũ và bản mới đều đọc/ghi được.
2. Rolling: thay từng bản sao từ bản cũ sang bản mới.
3. Contract: khi mọi bản đã chạy bản mới ổn định, mới chạy migration dọn cột cũ.

## 2h. Tái thiết chỉ mục trung tâm từ các node (feature 3, 2026-11-17)

Script: `infrastructure/scripts/rebuild-central-index.sh`. Nguyên lý: node là nguồn sự thật duy nhất; `search_document` chỉ là bản chiếu.

| Nội dung | Kết quả |
|---|---|
| Sao lưu 3 bảng trước khi phá hủy | `search_document` 255, `access_request` 40, `document_share` 83 (đều khớp) |
| Tháo khóa ngoại tạm, TRUNCATE `search_document` | Đã làm; không mất dòng nào của `access_request` và `document_share` |
| Resync song song các node ACTIVE (HR, ACC, SALES) | HR 249, ACC 4, SALES 1: đúng số tài liệu của node |
| Thời gian dựng lại chỉ mục (T_rebuild) | 5 giây |
| Phòng RETIRED (LEGAL, 1 tài liệu) | Được khôi phục từ bản sao lưu vì không còn node để resync |
| Ánh xạ lại `central_doc_id` theo `(department_id, source_doc_id)` | Xong; `access_request` và `document_share` không có dòng mồ côi |
| Khóa ngoại | Đã khôi phục (2 ràng buộc) |
| Đối soát | Lần chạy đầu: 19/20. Kiểm tra lệch là so với bản sao lưu: tổng `shares` 305 so với 304, do lượt chia sẻ 342 (HR → ACC, VIEW, đang hiệu lực) có ở node nhưng chưa có trong bản sao lưu. Đã đổi tiêu chí sang so với node chủ (ADR-011). Kiểm tra lại bằng truy vấn chỉ đọc: HR 299 = 299, ACC 5 = 5, SALES 0 = 0. **Chưa chạy lại toàn bộ script** vì script có TRUNCATE; kết quả 20/20 chưa được kiểm chứng bằng một lần chạy mới. |

Ghi chú: bảng `search_document_backup`, `access_request_backup`, `document_share_backup` được giữ lại để đối chiếu, chưa xóa.

## 2g. Phòng ban tự trị khi đứt mạng và tự hội tụ (2026-11-17)

Thiết kế: [ADR-012](05-adr/ADR-012-autonomous-offline-and-convergence.md). Tiêu chí và ghi chú: [09](09-feature2-autonomy.md). Runbook: `infrastructure/scripts/partition-test.sh`.

| Nội dung | Kết quả |
|---|---|
| Cô lập đường lên | `dms-site-hr` riêng cho HR; `dept-hr` và `postgres-hr-primary` vẫn nối `dms-network` để cắt thật |
| Nhân viên làm việc khi đứt mạng | Đăng nhập, tạo 3 tài liệu, cấp chia sẻ qua cổng `localhost:3001`; trạng thái `OFFLINE` |
| Backlog khi đứt mạng | 214 048 byte WAL, 4 sự kiện outbox |
| Trung tâm phát hiện | DEGRADED sau 30 giây |
| Nối lại | HR ACTIVE sau 8 giây (trước đó 90 giây do vòng đăng ký chồng nhau; đã sửa) |
| Hội tụ | 3/3 tài liệu, 1/1 chia sẻ, T_convergence 12 giây |
| Thứ tự phiên bản | Sự kiện cũ không ghi đè (source_version giữ nguyên) |
| Regression e2e-smoke | **96/96, 0 lỗi** (`e2e-smoke.sh`, sau khi sửa registry-client; Warm SLA 119 ms, Cold 1307 ms) |
| Watchdog Kafka Connect | Dừng CSDL HR: task Debezium `FAILED` sau khoảng 19 giây; bật lại CSDL, watchdog restart task và trở về `RUNNING` sau khoảng 11 giây, không cần thao tác tay |

## 2f. Sổ chia sẻ chuyển về node chủ tài liệu (2026-11-17)

Lý do, phương án và bảng miền lỗi: [ADR-011](05-adr/ADR-011-share-ledger-at-owner-node.md).

| | Trước | Sau (đã đo bằng e2e 83/83) |
|---|---|---|
| Nơi lưu lượt chia sẻ | CSDL trung tâm | Bảng `document_share` trong DB node chủ; trung tâm chỉ giữ bản sao đọc `search_document.shares` |
| Cấp chia sẻ khi trung tâm sập | HTTP 500 | Được (HR cấp, ACC thấy ngay) |
| **Thu hồi** khi trung tâm sập | Không thu hồi được; phòng nhận có thể còn thấy theo bản chụp cũ | Có hiệu lực ngay (ACC không còn thấy, tải file bị 403) |
| Ai ép quyền tải | Gateway | **Node chủ** (VIEW → 403, DOWNLOAD → tải đúng SHA-256; kể cả khi Gateway sai) |
| Luồng xin quyền | Ghi thẳng sổ trung tâm | Yêu cầu ở trung tâm; duyệt → node ghi, idempotent, node sập thì yêu cầu vẫn chờ |
| Dữ liệu cũ | 83 lượt (6 còn hiệu lực) ở trung tâm | Chuyển 83/83 (HR 78, ACC 5), hiệu lực 6/6; chạy lại không nhân đôi. Bảng cũ giữ nguyên để đối soát |
| API | `/api/search/shares*`, `/api/search/documents/<id trung tâm>/download` | `/api/dept/<mã>/shares`, `/api/search/documents/<phòng>/<docId>/download`; bỏ nút "quét hết hạn" (hết hạn tự mất hiệu lực theo giờ node) |

Hoàn thiện sau review (e2e 94/94): chỉ mục duy nhất + upsert chống đua, MinIO lỗi → 503 chuyển tiếp, `shared-with-me` trả `isPartial/unavailableNodes`, thăm dò ngầm cho mạch ngắt, e2e có warm-up và hai ngưỡng Cold ≤ 2500 ms / Warm ≤ 800 ms. Chi tiết: phần "Bổ sung" của ADR-011.

**Giới hạn:** duyệt yêu cầu xin quyền vẫn cần trung tâm; bản sao chia sẻ ở trung tâm chỉ nhất quán cuối cùng; Kubernetes đã gỡ khỏi dự án nên chỉ có Docker Compose.

 (01–06) và bản triển khai

| Nội dung | Thiết kế ghi | Thực tế đã làm | Lý do |
|---|---|---|---|
| Định danh tài liệu | UUIDv7 (ADR-003) | **Giữ `BIGINT` cục bộ** + khóa ghép `(department_id, source_doc_id)` ở Central | Đổi sang UUID chạm Prisma schema, mọi API và frontend; để làm bước riêng có migration dữ liệu |
| Search / Registry / Projector / Share | 4 service tách rời | **Một service `search-engine-service`** gồm 4 module | Ít container hơn cho dev; module tách biệt, có thể tách deploy sau |
| Xác thực người dùng | Keycloak (OIDC) | JWT HS256 do chính node cấp, `JWT_SECRET` dùng chung | Chưa tích hợp IdP; vai trò đã nằm trong token nên đổi sang Keycloak không đổi mô hình phân quyền |
| Xác thực giữa service | mTLS / client credentials | `INTERNAL_SERVICE_TOKEN` dùng chung (so sánh hằng thời gian) | Đơn giản cho dev; ghi rõ là bước tạm |
| Thông báo Registry | Event `DepartmentRegistered` qua Kafka | Search đọc Registry trực tiếp từ DB (cache 5 giây); Projector dò topic mới mỗi 5 giây | Registry và Search cùng một service, không cần kênh sự kiện |
| Tải file liên phòng ban | Presigned URL MinIO TTL 60s | **Stream qua Search Gateway** | URL presigned chứa địa chỉ MinIO nội bộ, trình duyệt không truy cập được |
| Thời gian token | 24 giờ | 8 giờ | Thu hẹp cửa sổ lạm dụng token |
| Compose | `deploy/compose/...` | `docker-compose.yml` + `docker-compose.department.yml` + `scripts/` | Giữ cấu trúc gần với repo hiện có |
| Snapshot Debezium | `initial` | `no_data` + **resync** từ node sau khi đăng ký connector | Bản Event Router dùng không xử lý chắc chắn sự kiện snapshot; resync thay thế và dùng lại được |

## 4. Những lỗi phát hiện thêm trong quá trình làm (không có trong review ban đầu)

| Lỗi | Hậu quả | Đã xử lý |
|---|---|---|
| Nút tải file dùng `window.open` không mang token | Mọi lần tải file đều 401 | Tải qua `axios` có token (`downloadFile`) |
| Dashboard Ban Giám đốc đọc sai tên trường (`fileTypes` vs `fileTypeDistribution`) | Biểu đồ định dạng file luôn rỗng | Sửa ánh xạ |
| Dashboard hiển thị "Lag <10ms" và "ALL NODES HEALTHY" cố định | Số liệu giả | Hiển thị số sự kiện và lỗi/DLQ thật; trạng thái lấy từ Registry |
| Dockerfile gọi script/workspace không tồn tại, copy thư mục không có | Không build được image | Sửa cả ba Dockerfile (nay còn hai) |
| `init-replication.sh` có `RAISE NOTICE` ngoài khối `DO` | Có thể làm hỏng khởi tạo Postgres mới | Xóa dòng đó |
| Hai connector Debezium cũ đang chạy trên máy này (khác với kết luận ban đầu "chưa đăng ký") | Slot không dùng giữ WAL | Gỡ connector, slot và publication cũ |

## 5. Chưa làm

1. **Kubernetes: đã gỡ khỏi dự án (2026-11-17)** theo yêu cầu, vì máy có RAM hạn chế. Mọi kiểm thử và demo chỉ chạy trên Docker Compose.
2. Failover Postgres tự động (CloudNativePG), Kafka 3 broker, Redis Sentinel: phụ thuộc mục 1.
3. NetworkPolicy: kind mặc định không thực thi, cần CNI khác (Calico/Cilium).
4. Loki (log tập trung), Alertmanager; nối chuỗi Outbox → Kafka vào trace.
5. Keycloak / mTLS, TLS ở gateway, Sealed Secrets.
6. UUIDv7, Schema Registry (Apicurio), partition `audit_events`.
7. CI (GitHub Actions), unit/contract test, kiểm thử tải (k6).
8. ~~Các script cũ `test-enterprise-resilience.js`, `test-phase6-monitoring.js`, `test-single-upload.js` còn dùng đường dẫn `/api/hr` và thông tin cũ.~~ **(Đã sửa 2026-11-17)**: Đã cập nhật sang `/api/dept/hr`, sửa lỗi thiếu token/sai tên thuộc tính `accessToken`, và kiểm thử chạy thật đạt 100% (Circuit Breaker ngắt sang Central DB trả về 71 văn bản khi Redis bị pause).
