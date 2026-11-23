# ADR-008: Tầng tìm kiếm chạy nhiều bản, không giữ trạng thái

**Trạng thái:** Accepted (đã triển khai trên Docker Compose)

## Bối cảnh

Search Gateway (kèm Registry, Index Projector, Share) là thành phần mọi phòng ban cùng dùng. Chạy một bản thì nó là **điểm chết duy nhất**: nó sập là cả hệ thống mất tìm kiếm, chia sẻ và đăng ký phòng ban.

## Quyết định

1. Chạy **từ 2 bản trở lên** sau gateway nginx (`deploy.replicas: 2`). nginx phân giải tên service ra mọi bản đang sống; một bản lỗi thì thử bản khác (`proxy_next_upstream`, `proxy_connect_timeout 2s`).
2. Mọi trạng thái nằm ngoài tiến trình:
   - dữ liệu ở Central DB, cache kết quả ở Redis;
   - **thông báo thời gian thực đi qua Redis pub/sub** (kênh `dms:notices`): bản nào xử lý thao tác cũng phát lên kênh, mọi bản đều nghe và đẩy cho các kết nối SSE của mình;
   - Index Projector dùng consumer group của Kafka: các bản chia nhau partition, vị trí đọc lưu trong DB cùng transaction với dữ liệu.
3. Các việc định kỳ (quét heartbeat, hết hạn chia sẻ) là idempotent nên nhiều bản cùng chạy vẫn đúng.

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| Một bản + tự khởi động lại | Vẫn gián đoạn vài chục giây mỗi lần sập hoặc cập nhật. |
| Sticky session cho SSE | Không giải quyết được việc thao tác và kết nối SSE rơi vào hai bản khác nhau. |
| Tách 4 service riêng ngay | Đúng hướng lâu dài, nhưng tăng số container; nhân bản một service nhiều module đã loại được điểm chết. |

## Hệ quả

- (+) Tắt một bản: truy vấn vẫn thành công (đã kiểm thử 8/8).
- (+) Cập nhật không gián đoạn: thay từng bản một.
- (−) Circuit breaker và cache Registry (5 giây) là riêng từng bản; mỗi bản tự phát hiện node hỏng.
- (−) Mất Redis: thông báo lùi về phát trong từng bản (người nối vào bản khác sẽ không nhận được) cho tới khi Redis trở lại.
- (−) Redis và Kafka vẫn chạy một bản trên Compose: chúng là điểm chết còn lại, cần Redis Sentinel và Kafka 3 broker ở môi trường thật.
