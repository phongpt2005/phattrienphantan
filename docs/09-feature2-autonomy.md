# 09. Feature 2: Phòng ban tự trị khi đứt mạng và tự hội tụ khi phục hồi

Trạng thái: **đã làm và đo** (runbook `infrastructure/scripts/partition-test.sh`: 17/17). Thiết kế và số liệu: [ADR-012](05-adr/ADR-012-autonomous-offline-and-convergence.md).

## 0. Kết quả đo (runbook, cắt thật `dms-network`)

| Chỉ số | Kết quả |
|---|---|
| Backlog WAL chưa gửi lúc đứt mạng | 214 048 byte, 4 sự kiện outbox |
| Trung tâm phát hiện DEGRADED | 30 giây sau khi cắt |
| HR về ACTIVE sau khi nối lại (T0) | 8 giây (lần trước: 90 giây; đã sửa vòng đăng ký) |
| T_convergence = T_detected − T0 (T_detected là lúc trung tâm thấy đủ dữ liệu) | 12 giây |
| Tài liệu tạo khi đứt mạng có ở trung tâm | 3/3 |
| Sổ chia sẻ tạo khi đứt mạng có ở trung tâm | 1/1 |
| Sự kiện cũ (rowVersion thấp hơn) làm đè tiêu đề | không (source_version giữ nguyên) |
| E2E đầy đủ sau khi sửa | 96/96 |
| Watchdog: CSDL HR dừng → task `FAILED` (sau ~19 giây) → CSDL bật lại → watchdog restart → `RUNNING` (sau ~11 giây) | tự khôi phục, không cần thao tác tay |

## 1. Tự trị khi đứt mạng (Autonomous Offline Mode)

**Kịch bản sự cố:** Node phòng ban bị cắt hoàn toàn khỏi mạng chung: mất kết nối tới Gateway, Kafka, CSDL trung tâm và các phòng ban khác.

**Tiêu chí chấp nhận (DoD):**
- Nhân viên của phòng đó vẫn truy cập được node cục bộ: đăng nhập bình thường, xem danh sách tài liệu của phòng mình, tải file nội bộ từ MinIO cục bộ, tạo tài liệu mới và sửa metadata.
- Mọi thao tác ghi được lưu an toàn trong CSDL cục bộ và ghi một dòng vào bảng outbox ở trạng thái `PENDING` (chờ gửi), trong cùng transaction với thay đổi nghiệp vụ.
- Giao diện node hiển thị huy hiệu `CHẾ ĐỘ TỰ TRỊ (OFFLINE) - DỮ LIỆU ĐANG LƯU NỘI BỘ`.

## 2. Tự hội tụ khi phục hồi (Eventual Convergence upon Healing)

**Kịch bản phục hồi:** kết nối giữa node và hệ thống trung tâm được nối lại.

**Tiêu chí chấp nhận (DoD):**
- **Không mất dữ liệu (Zero Data Loss):** mọi tài liệu tạo mới hoặc sửa trong lúc đứt mạng được CDC (Debezium và Kafka) đẩy về CSDL trung tâm.
- **Thứ tự đơn điệu (Monotonic Versioning):** Projector kiểm tra `row_version`. Sự kiện cũ đến muộn không được ghi đè sự kiện mới.
- **Hội tụ sổ chia sẻ:** cấp quyền và thu hồi quyền làm trong lúc đứt mạng phải được phản ánh về bản sao tìm kiếm ở trung tâm.
- **Gateway tự phục hồi:** Registry tự chuyển node từ `DEGRADED` hoặc `DOWN` sang `ACTIVE` và kết nạp lại vào tìm kiếm liên phòng, không cần khởi động lại Gateway.

## 3. Ghi chú cho người làm

- Tên bảng trong DoD là `transactional_outbox`, nhưng hệ thống hiện đặt tên là `outbox`. Giữ tên `outbox` và coi đây là cùng một bảng, để không đổi schema đang chạy.
- "Hội tụ sổ chia sẻ" ghi `search_document.shares`. Sau khi chat phụ chuyển sổ về node, trung tâm chỉ giữ bản sao jsonb để dự phòng, nên cần viết lại tiêu chí này theo bản sao đó.
- Kiểm thử cần cắt mạng thật (`docker network disconnect`) chứ không tắt tiến trình, để đúng kịch bản "đứt mạng".
