# Architecture Decision Records

Mỗi ADR theo định dạng: **Bối cảnh → Quyết định → Phương án đã cân nhắc → Hệ quả**.

| ADR | Tiêu đề | Trạng thái |
|---|---|---|
| [ADR-001](ADR-001-hybrid-federated-search.md) | Hybrid Federated Search (scatter-gather + central fallback) | Accepted |
| [ADR-002](ADR-002-transactional-outbox.md) | Transactional Outbox + Debezium Outbox Router thay CDC bảng thô | Accepted |
| [ADR-003](ADR-003-uuidv7-identifiers.md) | UUIDv7 làm định danh toàn cục | Deferred |
| [ADR-004](ADR-004-department-registry.md) | Department Registry + self-registration | Accepted |
| [ADR-005](ADR-005-kubernetes-operators.md) | CloudNativePG + Strimzi trên Kubernetes, Helm chart dùng chung | Withdrawn (2026-11-17: gỡ K8s, chỉ dùng Compose) |
| [ADR-006](ADR-006-observability-loki-tempo.md) | Loki + Tempo + OpenTelemetry thay ELK | Proposed |
| [ADR-007](ADR-007-content-indexing-pipeline.md) | Lập chỉ mục nội dung tệp bằng worker bất đồng bộ trên Kafka (không thêm RabbitMQ) | Accepted |
| [ADR-008](ADR-008-stateless-search-tier.md) | Tầng tìm kiếm chạy nhiều bản, không giữ trạng thái | Accepted |
| [ADR-009](ADR-009-distributed-tracing.md) | Distributed tracing bằng OpenTelemetry, xem trên Jaeger | Accepted |
| [ADR-010](ADR-010-central-index-is-optional.md) | Chỉ mục trung tâm là thành phần tùy chọn trên đường tìm kiếm | Accepted |
| [ADR-011](ADR-011-share-ledger-at-owner-node.md) | Sổ chia sẻ nằm tại node của phòng chủ tài liệu | Accepted |
| [ADR-012](ADR-012-autonomous-offline-and-convergence.md) | Phòng ban tự trị khi đứt mạng và tự hội tụ khi phục hồi | Accepted |
| [ADR-013](ADR-013-token-revocation.md) | Thu hồi token ngay lập tức ở gateway (token_version + khóa Redis) | Accepted |
| [ADR-014](ADR-014-central-patroni-synchronous.md) | CSDL trung tâm dùng Patroni, ghi đồng bộ không chặn | Accepted |
| [ADR-015](ADR-015-dept-patroni-logical-slot.md) | CSDL phòng ban trên Patroni, slot Debezium đi theo máy chính (bộ canh slot, nhịp tim) | Accepted |
| [ADR-016](ADR-016-redis-sentinel-and-gateway-vip.md) | Redis có bản sao và Sentinel; gateway có địa chỉ ảo (Keepalived) | Accepted |
