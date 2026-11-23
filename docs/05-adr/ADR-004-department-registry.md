# ADR-004: Department Registry và cơ chế tự đăng ký

**Trạng thái:** Accepted · **Liên quan:** R3

## Bối cảnh

Hiện tại, muốn thêm một phòng ban phải sửa:

- consumer của Search (`@EventPattern` hardcode và `topic.startsWith('cdc.hr') ? 1 : 2`)
- nginx
- connector JSON
- compose và k8s
- frontend (`'HR' | 'ACC'`)

Bảng `department` đã có nhưng không ai đọc.

## Quyết định

> **Triển khai thực tế:** Registry là một module trong `search-engine-service` (cùng Central DB). Search đọc Registry trực tiếp từ DB (cache 5 giây) thay vì qua event `DepartmentRegistered`; Projector dò topic mới mỗi 5 giây. Mô hình và hành vi (tự đăng ký, heartbeat, vòng đời) đúng như bên dưới.


1. Dùng **Registry Service** làm nguồn sự thật duy nhất. Dữ liệu gồm ba bảng: `departments`, `department_endpoints`, `department_health`.
2. **Node tự đăng ký** khi khởi động bằng `POST /registry/register`, gửi kèm `code`, endpoint, `schema_version` và capabilities. Lời gọi được xác thực bằng service token của Keycloak (client credentials).
3. **Heartbeat** gửi mỗi 10 s. Bỏ lỡ 3 lần thì node chuyển sang `DEGRADED`. Khi tắt node có trật tự, node tự chuyển sang `DRAINING`.
4. Registry phát event `DepartmentRegistered` hoặc `DepartmentStateChanged` lên topic `dms.platform.registry`. Search Gateway nghe event này để xóa cache.
5. Index Projector subscribe Kafka theo **pattern** `^dms\.dept\..+\.document$`. Ánh xạ từ topic sang phòng ban được tra trong `department_endpoints.kafka_topic`.
6. Gateway và Ingress: mỗi Helm release tự mang theo route `/api/dept/{code}`. Frontend gọi `GET /registry/departments`.

## Phương án đã cân nhắc

- **Kubernetes Service discovery thuần** (đặt label lên Service): loại vì không có metadata nghiệp vụ như `schema_version` hay `lifecycle`, và không chạy được trên Compose.
- **Consul/etcd**: loại vì thêm một hệ phân tán phải vận hành. Postgres cộng Redis cache đã đủ cho quy mô này.

## Hệ quả

- **R3 đạt.** Thêm phòng ban bằng `helm install` với một file values. Không node cũ nào bị sửa hay restart.
- **Registry trở thành thành phần quan trọng**, nên phải chạy ít nhất 2 replica. Search Gateway cache danh sách phòng ban trong Redis và trong bộ nhớ, nên Registry sập ngắn hạn không làm hỏng việc tìm kiếm.
