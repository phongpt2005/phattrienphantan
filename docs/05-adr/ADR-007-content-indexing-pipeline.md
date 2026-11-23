# ADR-007: Lập chỉ mục nội dung tệp bằng worker bất đồng bộ trên Kafka (không thêm RabbitMQ)

**Trạng thái:** Accepted (đã triển khai trên Docker Compose)

## Bối cảnh

Người dùng cần tìm được tài liệu theo **nội dung bên trong tệp** (PDF, Word, văn bản), không chỉ theo tiêu đề và mô tả.
Trích văn bản là việc nặng và chậm (đọc tệp, phân tích PDF), không thể làm trong request tải lên.

Câu hỏi thường gặp: "sao không dùng RabbitMQ làm hàng đợi?"

## Quyết định

1. Việc trích nội dung chạy ở một tiến trình riêng, `content-worker`, **tiêu thụ chính các sự kiện `document` đã có trên Kafka** (do Transactional Outbox phát). Không thêm broker mới.
2. Worker dùng **consumer group `content-indexer`**. Chạy N bản thì Kafka chia partition cho từng bản; một bản chết thì partition được giao lại cho bản còn sống.
3. Bảo đảm xử lý: **at-least-once + idempotent**. Offset chỉ commit sau khi xử lý xong; ghi lại cùng một phiên bản là vô hại (node chỉ nhận khi `versionNo` trùng phiên bản hiện tại).
4. Lỗi: thử lại 3 lần có backoff, sau đó chuyển sang **DLQ `dms.dlq.content`** để không nghẽn partition.
5. **Nội dung tệp không rời phòng ban.** Worker tải tệp qua API nội bộ của node (có ghi audit), trích trong bộ nhớ, rồi ghi kết quả về chính node đó (`PUT /internal/documents/:id/content`). Central Index chỉ nhận cờ `contentIndexedVersion`.
6. Chống vòng lặp: sự kiện phát ra sau khi ghi nội dung mang `contentIndexedVersion == versionNo`, worker bỏ qua.

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| Thêm RabbitMQ làm hàng đợi công việc | Hai broker làm cùng một việc: thêm một thành phần phải vận hành, giám sát, sao lưu. Kafka đã có sẵn sự kiện, giữ lại được để **phát lại** (lập chỉ mục lại toàn bộ khi đổi thuật toán trích), và cho nhiều nhóm tiêu thụ độc lập trên cùng một luồng (Projector và content-worker không ảnh hưởng nhau). RabbitMQ hợp hơn khi cần định tuyến phức tạp hoặc ưu tiên từng thông điệp, hệ thống này không cần. |
| Trích nội dung ngay trong request tải lên | Người dùng phải chờ; tệp lỗi làm hỏng cả thao tác tải lên. |
| Đưa nội dung lên Central Index | Vi phạm nguyên tắc phân đoạn dữ liệu (R1): nội dung của mọi phòng ban sẽ nằm chung một chỗ. |
| Worker riêng cho từng phòng ban | Cô lập tốt hơn nhưng tốn tài nguyên gấp N lần; để dành cho môi trường có yêu cầu tuân thủ cao. |

## Hệ quả

- (+) Tải lên vẫn nhanh; nội dung tìm được sau khoảng 1–2 giây.
- (+) Tăng thông lượng bằng một lệnh: `docker compose up -d --no-build --scale content-worker=3`.
- (+) Phòng ban mới tự được phục vụ: worker dò topic theo pattern.
- (−) **Khi node của phòng ban sập, phần dự phòng (Central Index) chỉ tìm được theo metadata**, không theo nội dung tệp. Đây là đánh đổi có chủ ý để giữ nội dung trong phạm vi phòng ban.
- (−) Nội dung tệp đi qua bộ nhớ của worker dùng chung (không lưu lại). Môi trường yêu cầu cao hơn có thể chạy worker riêng cho từng phòng ban.
- (−) Chưa hỗ trợ ảnh quét (OCR), Excel, PowerPoint: các tệp này được đánh dấu `unsupported`.
- (−) Thứ tự sự kiện chỉ được bảo đảm trong một partition; hai sự kiện của cùng một tài liệu luôn cùng partition vì khóa là `aggregate_id`.
