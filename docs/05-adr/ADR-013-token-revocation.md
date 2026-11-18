# ADR-013: Thu hồi token ngay lập tức ở gateway

**Trạng thái:** Accepted (đã triển khai và kiểm thử bằng `infrastructure/scripts/revoke-test.sh`: 16/16)
**Liên quan:** ADR-004 (Registry), ADR-011 (sổ chia sẻ tại node chủ)

## Bối cảnh

JWT có hạn 8 giờ. Khi nhân sự bị điều chuyển hoặc bị đình chỉ, token cũ vẫn dùng được tới khi hết hạn. Đặc biệt, luồng tải file liên phòng và tìm kiếm đi qua gateway (search-engine), nên đây là nơi cần chặn ngay.

Lưu ý: `status` của tài khoản chỉ được kiểm tra lúc đăng nhập, nên việc khóa tài khoản không có tác dụng với token đang có.

## Quyết định

1. **Phiên bản token.** Bảng `local_user` có cột `token_version` (Expand: `INT NOT NULL DEFAULT 0`). Khi đăng nhập, JWT mang `tv = token_version`. Token cũ không có `tv` được coi là `tv = 0`.
2. **Thu hồi.** `POST /api/dept/<mã>/auth/users/:userId/revoke` (Trưởng phòng và Ban Giám đốc). Thứ tự: tăng `token_version` trong CSDL node, rồi ghi khóa Redis `tv:<phòng>:<userId>` = phiên bản tối thiểu còn hợp lệ. Ghi Redis bằng Lua để giá trị chỉ tăng. Nếu Redis lỗi, trả 503 và không báo thành công; thử lại sẽ tăng phiên bản và ghi lại khóa.
3. **Kiểm tra ở gateway.** `JwtAuthGuard` (dùng chung trong `packages/common`) đọc khóa Redis sau khi verify chữ ký. Nếu `tv` của token nhỏ hơn giá trị trong khóa thì trả 401.
4. **Phạm vi Redis của node.** Node chỉ GHI khóa khi thu hồi. Đường đọc nghiệp vụ nội bộ của node không kiểm Redis, để giữ tính tự trị và không tăng tải.

**Lệch so với bản đề xuất ban đầu:** khóa Redis là `tv:<mã phòng>:<userId>` chứ không phải `user:<userId>:token_version`. Lý do: `userId` là ID cục bộ của từng node, nên khóa không có mã phòng sẽ làm hai nhân viên khác phòng nhưng cùng `userId` ghi đè khóa của nhau.

## Phương án đã cân nhắc

- **Khóa theo `userId` đơn thuần:** bị loại. `userId` là ID cục bộ của từng node, hai phòng có thể cùng có `userId = 5`. Khóa phải là `(mã phòng, userId)`.
- **Danh sách đen token (JTI):** bị loại. Phải lưu mọi token đã cấp và tra cứu theo từng request; tốn hơn so với một số nguyên theo người dùng.
- **Node kiểm Redis trên mọi request:** bị loại ở lượt này theo yêu cầu giữ tính tự trị. Đây là đánh đổi đã biết (xem Hệ quả).
- **Đổi thời hạn token ngắn hơn:** không giải quyết việc thu hồi ngay; chỉ thu hẹp cửa sổ.

## Hệ quả

- **Đường nội bộ của node còn hở.** Nhân viên bị thu hồi vẫn gọi được `/api/dept/<mã>/...` trực tiếp tới node của phòng mình bằng token cũ, tới khi token hết hạn (tối đa 8 giờ). Kiểm thử ghi nhận HTTP 200 trên đường này. Cần quyết định có kiểm Redis ở node hay không; chi phí là một lần đọc Redis cho mỗi request.
- **Redis lỗi thì gateway cho qua** (fail-open) và ghi cảnh báo, để tìm kiếm không sập. Trong thời gian Redis lỗi, token bị thu hồi vẫn dùng được ở gateway.
- **Token đăng nhập trong lúc đang thu hồi** nhận `tv` mới và không bị ảnh hưởng.
- Cột `token_version` đã được thêm vào CSDL các node đang chạy và vào `init-scripts` cho bản triển khai mới.
- Node HR, ACC, SALES nhận thêm biến `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (chỉ dùng cho thu hồi).

## Kết quả kiểm thử

| Kiểm tra | Kết quả |
|---|---|
| Token nhân viên được chấp nhận trước khi thu hồi | 200 |
| Trưởng phòng thu hồi thành công | 201 |
| Cùng token đó sau khi thu hồi ở gateway | 401 ngay lập tức |
| Đăng nhập lại và token mới | 200 |
| Trưởng phòng thu hồi token Ban Giám đốc | 403 |
| Nhân viên thu hồi | 403 |
| Token đã thu hồi gọi trực tiếp node HR | 200 (đánh đổi đã nêu) |
