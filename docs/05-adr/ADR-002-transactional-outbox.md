# ADR-002: Transactional Outbox + Debezium Outbox Event Router

**Trạng thái:** Accepted

## Bối cảnh

Hiện tại Debezium đọc **mọi bảng** (`FOR ALL TABLES`) và đẩy raw row change lên Kafka. Cách này có ba vấn đề:

- Consumer phụ thuộc vào cấu trúc bảng nội bộ của node. Chỉ cần đổi tên một cột là consumer vỡ.
- Không có chỗ cho các sự kiện nghiệp vụ không gắn với một bảng, ví dụ `DOCUMENT_DOWNLOAD_DENIED`.
- Thứ tự sự kiện và việc phân partition không do mình kiểm soát.

## Quyết định

- Mỗi node ghi vào bảng `outbox` **trong cùng transaction** với thay đổi nghiệp vụ.
- Publication chỉ gồm bảng `outbox`.
- Debezium dùng `EventRouter` để định tuyến theo `aggregate_type`, đẩy vào topic `dms.dept.{code}.{aggregate_type}`.
- Message key là `aggregate_id`.
- `event_type`, `schema_version` và `traceparent` được đặt vào header.
- Schema của payload đăng ký trên Apicurio Registry với chế độ tương thích BACKWARD.

## Phương án đã cân nhắc

- **Dual-write** (ghi DB rồi publish Kafka): loại vì không nguyên tử.
- **Polling outbox bằng job**: loại vì tạo độ trễ và tải lên DB.
- **CDC bảng thô**: chính là hiện trạng, đã nêu ở trên.

## Hệ quả

- **Hợp đồng sự kiện ổn định**, có version. Node mới chỉ cần phát đúng schema.
- **Audit đi chung pipeline**, không cần kênh riêng.
- **Bảng `outbox` cần được dọn định kỳ.** Dòng cũ hơn 7 ngày có thể xóa vì dữ liệu đã nằm trong Kafka.
