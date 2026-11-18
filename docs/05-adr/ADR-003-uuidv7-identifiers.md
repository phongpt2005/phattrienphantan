# ADR-003: UUIDv7 làm định danh toàn cục

**Trạng thái:** Deferred (chưa triển khai). Hiện giữ `BIGINT` cục bộ + khóa ghép `(department_id, source_doc_id)`; chuyển UUIDv7 cần migration dữ liệu và đổi API/frontend

## Bối cảnh

Thiết kế v1 dùng `doc_id BIGINT` tự tăng **riêng ở mỗi node**. Vì vậy hai phòng ban đều có thể có tài liệu mang `doc_id = 1`.

Khi gộp kết quả federated, khi chia sẻ, hoặc khi ghi audit, hệ thống phải luôn mang theo cặp `(department, id)`. Chỉ cần quên một lần là nhầm tài liệu.

## Quyết định

`document_id` và `file_id` dùng **UUIDv7** theo RFC 9562.

- PG18 có sẵn hàm `uuidv7()`.
- PG16 và PG17 dùng hàm `uuid_v7()` định nghĩa trong `docs/sql/node-schema.sql`. Hàm này đã được kiểm thử.

Ở Central, khóa chính vẫn là `(department_id, document_id)` để giữ thông tin "ai sở hữu" và để partition hoặc lọc theo phòng ban.

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| UUIDv4 | Ngẫu nhiên hoàn toàn nên B-tree bị phân mảnh, insert chậm dần |
| Snowflake ID | Cần cấp worker-id cho từng node, thêm một thứ phải điều phối |
| Sequence với dải riêng cho từng phòng ban | Phải quy hoạch dải trước, đi ngược R3 |

## Hệ quả

- Node tự sinh ID mà không cần điều phối, phù hợp với R3.
- ID chứa timestamp nên sắp xếp được theo thời gian tạo.
- Tốn 16 byte, so với 8 byte của BIGINT. Mức này chấp nhận được với quy mô của đề tài.
