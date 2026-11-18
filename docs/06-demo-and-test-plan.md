# 06. Kịch bản demo và kế hoạch kiểm thử

> **Trạng thái:** D1, D2 (bản Compose), D4, D5, D7 chạy được **ngay bây giờ**; D3 (failover Postgres) và D6 (NetworkPolicy) cần giai đoạn Kubernetes.
> D2 bản Compose: `bash scripts/add-department.sh SALES "Phòng Kinh doanh"` rồi chạy lại `bash infrastructure/scripts/e2e-smoke.sh`.
> D4: `docker stop dept-acc` rồi tìm kiếm, sau đó `docker start dept-acc` (mục 6 của `e2e-smoke.sh` tự động hóa việc này).
> D5: `docker stop search-engine-service`, tạo tài liệu, `docker start search-engine-service`: Central Index tự bắt kịp nhờ `cdc_partition_progress`.

## 1. Kịch bản demo trước hội đồng (khoảng 15 phút)

Chuẩn bị:

- cluster kind với 3 phòng ban HR, ACC và SALES (SALES chưa cài)
- seed khoảng 2.000 tài liệu cho mỗi phòng ban
- Grafana mở sẵn ba dashboard: *Federated Search*, *CDC Pipeline*, *Department Health*

| # | Kịch bản | Thao tác | Kỳ vọng thấy | Chứng minh |
|---|---|---|---|---|
| D1 | **Tìm kiếm liên hợp** | Đăng nhập Manager HR, tìm "hop dong" (không dấu) | Kết quả từ HR và ACC (tài liệu ACC đã share). Tempo hiện **2 span song song** `/internal/search` | R2, tìm tiếng Việt không dấu, phân quyền |
| D2 | **Thêm phòng ban mới** | `helm install dept-sales …` rồi upload 1 tài liệu ở SALES | Sau khoảng 30–60 s, SALES xuất hiện ở `/registry/departments` và trong kết quả tìm kiếm. `kubectl get pods -A` cho thấy pod HR và ACC **không restart** (AGE giữ nguyên) | **R3** |
| D3 | **Postgres failover** | `kubectl delete pod hr-pg-1` (primary) | CNPG promote `hr-pg-2`. Search và upload HR lỗi tối đa vài giây rồi chạy lại. Debezium vẫn đọc tiếp nhờ slot được đồng bộ | R1 có HA |
| D4 | **Node sập và dữ liệu stale** | `kubectl scale deploy/department-service -n dept-acc --replicas=0` rồi tìm kiếm | Response có `partial:true`, `ACC: FALLBACK`. Kết quả ACC có nhãn "Dữ liệu cập nhật lúc …". Dashboard hiện circuit OPEN | Trade-off CAP, circuit breaker |
| D5 | **Không mất sự kiện** | Scale index-projector về 0, upload 50 tài liệu, scale lên lại | Consumer lag tăng lên 50 rồi về 0. Central Index đủ 50 bản ghi, không trùng | Outbox, idempotent consumer, offset lưu cùng transaction |
| D6 (bonus) | **Cô lập mạng** | Từ pod ACC chạy `curl dept-hr-svc.dept-hr:3000` | Bị NetworkPolicy chặn (timeout) | Cô lập dữ liệu ở tầng hạ tầng |
| D7 (bonus) | **Bảo mật** | Gọi `/api/search?isExecutive=true` bằng token Staff | Kết quả **không** đổi, vì quyền lấy từ JWT | Đã khắc phục lỗ hổng C1 |

## 2. Chỉ số đo (SLO đề xuất)

| Chỉ số | Mục tiêu | Cách đo |
|---|---|---|
| Latency p95 của federated search (3 node khỏe) | ≤ 500 ms | k6, 50 VU, 5 phút; histogram trên Prometheus |
| Latency p95 khi 1 node sập (fallback) | ≤ 1.2 s | Như trên, kèm D4 |
| Độ trễ đồng bộ p95 (node → Central Index) | ≤ 5 s | `index_projector_lag_seconds` |
| RTO khi Postgres primary chết | ≤ 30 s | Thời gian từ lúc xóa pod đến lần ghi thành công đầu tiên |
| RPO | 0 với dữ liệu đã commit | Replication đồng bộ `synchronous: {method: any, number: 1}` của CNPG |
| Thời gian onboarding phòng ban | ≤ 2 phút, không cần sửa code | Bấm giờ D2 |
| Tỉ lệ mất event | 0 | Đối chiếu số dòng outbox với số dòng `document_metadata` sau D5 |

## 3. Kế hoạch kiểm thử

| Tầng | Công cụ | Nội dung |
|---|---|---|
| Unit | Jest | RRF merge, khử trùng lặp, circuit breaker, ánh xạ topic sang phòng ban qua registry, upsert với `source_version` |
| Contract | Pact hoặc OpenAPI validator | Mọi `department-service` trả đúng schema `/internal/search v1` và các event outbox (schema trên Apicurio) |
| Integration | Testcontainers (Postgres 16, Kafka, MinIO) | Đi trọn vòng outbox → Debezium → Kafka → projector. Event trùng lặp và event đến sai thứ tự không làm sai dữ liệu |
| E2E | Playwright | Đăng nhập theo 3 vai trò, tìm kiếm, xin quyền, phê duyệt, tải file qua presigned URL |
| Tải | k6 | Các SLO ở mục 2 |
| Chaos | Chaos Mesh (hoặc `kubectl delete` thủ công) | Kịch bản D3, D4 và network delay 500 ms tới một node |
| Bảo mật | Trivy (image), OWASP ZAP baseline, kiểm tra RBAC | Không có secret trong image. Staff không gọi được API phê duyệt |
