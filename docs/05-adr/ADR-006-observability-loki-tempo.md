# ADR-006: Loki + Tempo + OpenTelemetry thay ELK

**Trạng thái:** Proposed (chưa triển khai)

## Bối cảnh

Sơ đồ v1 ghi ELK nhưng repo không có. Hệ thống đã dùng Prometheus và Grafana.

Federated search cần được **quan sát theo trace**: một request gọi tới N node thì node nào chậm, node nào phải dùng fallback.

## Quyết định

| Nhu cầu | Công cụ |
|---|---|
| Đo đạc (instrumentation) | OpenTelemetry SDK trong NestJS. Truyền `traceparent` qua HTTP và qua header của Kafka (đặt trong cột `outbox.trace_id`) |
| Traces | Grafana Tempo |
| Logs | Grafana Loki, thu thập bằng Grafana Alloy hoặc Promtail. Log dạng JSON có `trace_id` |
| Metrics và cảnh báo | kube-prometheus-stack với Alertmanager |
| Giao diện | Một Grafana duy nhất, cho phép nhảy qua lại giữa log và trace |

## Phương án đã cân nhắc

**ELK (Elasticsearch + Logstash + Kibana).** Không chọn vì:

- Tốn 2–4 GB RAM.
- Cần thêm một giao diện riêng (Kibana).
- Không có tracing tích hợp sẵn.

## Hệ quả

- **Một trace thể hiện được toàn bộ luồng.** Đi từ `search → fan-out HR/ACC/SALES → fallback`, và với luồng ghi là từ `upload → outbox → Kafka → projector`. Đây là bằng chứng trực quan cho R2 và cho tính nhất quán cuối cùng.
- **Loki không full-text index nội dung log.** Truy vấn log dựa trên label và lọc, đủ cho nhu cầu vận hành.
