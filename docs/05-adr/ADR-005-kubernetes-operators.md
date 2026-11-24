# ADR-005: Triển khai trên Kubernetes bằng Operator và Helm chart dùng chung

**Trạng thái: Withdrawn (2026-11-17).** Kubernetes đã gỡ khỏi dự án vì tài nguyên của môi trường phát triển không đủ cho cụm nhiều nút; hạ tầng chuẩn hóa trên Docker Compose. Giữ lại làm hồ sơ thiết kế.

**Trạng thái:** Proposed (chưa triển khai)

## Bối cảnh

Postgres hiện được dựng thủ công bằng `pg_basebackup` trong `command` của compose. Cách này không tự failover, và replication slot của CDC mất khi primary chết.

Kafka chỉ có 1 broker với RF=1. Connector không được đăng ký tự động.

Các file `k8s/*.yaml` lệch với code: sai tên biến môi trường, sai user DB, không có Debezium.

## Quyết định

- **CloudNativePG** cho mọi cụm Postgres.
  - 3 instance cho mỗi cụm.
  - Bật `replicationSlots.highAvailability` và `synchronizeReplicas` để slot của Debezium còn nguyên sau failover.
  - Dùng service `-ro` để đọc từ replica.
  - Backup bằng barman lên MinIO.
- **Strimzi** cho Kafka.
  - KRaft với 3 node.
  - `KafkaTopic`, `KafkaConnect` và `KafkaConnector` được khai báo bằng CRD.
- **Một Helm chart `department`.** Mỗi phòng ban là một release trong namespace riêng, kèm `NetworkPolicy`, `ResourceQuota`, `HPA` và `PDB`.
- **Docker Compose vẫn giữ cho dev**, tách thành `compose.core.yml` và `compose.department.yml` dạng template.

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| Patroni hoặc Bitnami postgresql-ha | Chạy được, nhưng CNPG là operator gốc của Kubernetes, quản lý slot tốt hơn và khai báo đơn giản hơn |
| Bitnami Kafka chart | Không quản lý connector bằng CRD |
| Kustomize | Phù hợp với overlay theo môi trường, nhưng Helm biểu đạt "một template, N phòng ban" rõ hơn |

## Hệ quả

- **Demo được failover thật**: xóa pod primary, CNPG promote replica trong khoảng 10–30 s.
- **Cần RAM khoảng 12–16 GB.** Có phương án giảm xuống 2 instance cho mỗi phòng ban.
- **Cần học thêm CRD của hai operator.**
