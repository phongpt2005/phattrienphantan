# ADR-009: Distributed tracing bằng OpenTelemetry, xem trên Jaeger

**Trạng thái:** Accepted (đã triển khai trên Docker Compose). Thay thế phần tracing của [ADR-006](ADR-006-observability-loki-tempo.md) (Tempo) trong môi trường dev.

## Bối cảnh

Một truy vấn liên hợp đi qua nhiều tiến trình: Search Gateway gọi song song N node, node nào chậm hoặc chết thì lấy từ Central Index. Số đo Prometheus cho biết **bao nhiêu** truy vấn chậm, nhưng không cho biết **một truy vấn cụ thể** chậm ở đâu.

## Quyết định

1. Dùng **OpenTelemetry** (chuẩn mở, không khóa nhà cung cấp). Mã ứng dụng chỉ phụ thuộc `@opentelemetry/api`; nơi nhận trace đổi được bằng cấu hình.
2. SDK được nạp trước ứng dụng (`node -r packages/common/dist/tracing.js ...`) và tự gắn vào HTTP, Express/Nest, `fetch`, `pg`, Redis. Ngữ cảnh truyền giữa service bằng header W3C `traceparent`.
3. Search Gateway tạo thêm một span cho **từng node** (`federated.query <mã>`) với thuộc tính `dms.node.status` (OK/FALLBACK), `dms.node.took_ms`, `dms.fallback.reason`. Node dùng dự phòng được đánh dấu lỗi nên hiện màu đỏ trên Jaeger.
4. Phản hồi tìm kiếm trả về `traceId` để tra ngay: `http://localhost:16686/trace/<traceId>`.
5. Bật bằng biến `OTEL_EXPORTER_OTLP_ENDPOINT`. Không đặt thì tracing tắt hoàn toàn. Tên service của node suy ra từ `DEPT_CODE` (`dept-hr`, `dept-acc`...) nên phòng ban mới tự có trace.
6. Dev dùng **Jaeger all-in-one** (một container, lưu trong bộ nhớ). Bỏ qua healthcheck, scrape metrics và luồng SSE để trace không bị nhiễu.

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| Tempo + Grafana (như ADR-006) | Cần thêm cấu hình lưu trữ và datasource; Jaeger all-in-one nhẹ hơn cho máy 16 GB. Mã không đổi nếu sau này chuyển sang Tempo vì cùng giao thức OTLP. |
| Tự ghi `trace_id` vào log | Không có cây span, không thấy được các node chạy song song. |
| `auto-instrumentations-node` (gói tất cả) | Kéo theo hàng chục thư viện không dùng; chỉ chọn 6 instrumentation cần thiết. |

## Hệ quả

- (+) Nhìn thấy trực tiếp mô hình scatter-gather: các span `federated.query` xếp chồng theo thời gian.
- (+) Truy nguyên nhân chậm tới từng node, từng câu SQL ở Central Index.
- (−) Truy vấn của Prisma tại node **chưa** có span (Prisma dùng engine riêng, cần `@prisma/instrumentation`).
- (−) Chuỗi bất đồng bộ Outbox → Kafka → Projector/content-worker **chưa** nối vào trace: cột `outbox.trace_id` và header `traceparent` đã có sẵn trong connector nhưng node chưa ghi giá trị.
- (−) Jaeger lưu trong bộ nhớ: khởi động lại là mất trace. Lấy mẫu 100%, chỉ phù hợp dev/demo.
