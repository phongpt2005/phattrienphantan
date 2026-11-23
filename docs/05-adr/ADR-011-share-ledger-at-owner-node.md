# ADR-011: Sổ chia sẻ nằm tại node của phòng chủ tài liệu

**Trạng thái:** Accepted (đã triển khai; e2e 83/83, gồm kiểm thử cấp, tải và THU HỒI quyền khi CSDL trung tâm đang tắt)
**Thay thế một phần:** ADR-010 (quyết định 2: bản chụp quyền chia sẻ; nay không còn cần)

## Bối cảnh

Trước đây mọi lượt chia sẻ nằm ở bảng `document_share` của **CSDL trung tâm**. ADR-010 làm tìm kiếm sống khi trung tâm sập, nhưng để lại một khe hở về an toàn:

- Quyền chia sẻ phải lấy từ **bản chụp cũ** khi trung tâm sập. Một lượt chia sẻ vừa bị **thu hồi** vẫn có thể còn hiện cho phòng nhận (đến khi trung tâm trở lại).
- **Cấp** và **thu hồi** chia sẻ đều cần trung tâm, nên đúng lúc sự cố, trưởng phòng không dừng được việc chia sẻ.
- Trung tâm không phải chủ tài liệu nhưng lại giữ quyết định "ai được xem tài liệu của phòng khác". Điều này ngược với nguyên tắc dữ liệu của phòng nằm ở phòng.

## Quyết định

1. **Sổ chia sẻ là bảng `document_share` trong DB của node chủ tài liệu** (phòng nào sở hữu tài liệu thì phòng đó giữ và quyết định). Cấp/thu hồi là một giao dịch tại node, cùng giao dịch với ghi Outbox.
2. **Node tự ép quyền ở cả hai nơi**:
   - tìm kiếm (`/internal/search`): hit mang `access_via` (`OWNER|SHARED|PUBLIC`) và `share_permission`;
   - tải tệp: node kiểm tra lại `DOWNLOAD` (`403` phân biệt "chỉ cấp quyền xem" và "không có quyền"), ghi audit cả lần bị từ chối.
   Định danh người xem (phòng, Ban Giám đốc) luôn lấy từ JWT ở Gateway, truyền cho node bằng service token.
3. **Trung tâm chỉ giữ BẢN SAO ĐỌC** trong `search_document.shares` (JSONB), cập nhật qua Outbox → Debezium → Projector như mọi thay đổi tài liệu (trigger tăng `row_version` nên không bị chặn bởi "phiên bản không mới hơn"). Bản sao chỉ dùng cho **dự phòng khi node sập** và thống kê của Ban Giám đốc. Không dùng để cấp quyền.
4. **Luồng xin quyền vẫn ở trung tâm** (đây là quy trình giữa hai phòng, không phải dữ liệu của một phòng). Khi trưởng phòng chủ **duyệt**, Gateway gọi `POST /internal/shares` của node chủ, **idempotent theo `accessRequestId`**; chỉ sau khi node ghi xong mới đánh dấu yêu cầu `APPROVED`. Node chủ không sống thì trả 503, yêu cầu vẫn `PENDING`, không có trạng thái nửa vời.
5. **Node báo Gateway** (`POST /search/internal/notify`, service token, nginx chặn từ ngoài) để đẩy thông báo thời gian thực `SHARE_GRANTED/SHARE_REVOKED` và xóa cache kết quả tìm kiếm. Đây chỉ là tiện ích: không nhận được thì quyền vẫn đúng, chỉ chậm hiện thông báo tối đa theo TTL cache (30 giây).
6. **Chuyển dữ liệu cũ** bằng `infrastructure/scripts/migrate-shares-to-nodes.js`: idempotent theo `legacy_share_id`, giữ cả lượt đã thu hồi và thời điểm tạo. Bảng cũ ở trung tâm **được giữ nguyên** (đánh dấu legacy, không còn đọc/ghi) để đối soát; xóa là quyết định riêng.

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| Giữ ở trung tâm, thêm bản chụp (ADR-010) | Khi trung tâm sập vẫn không thu hồi được và có thể cho xem nhầm. Chỉ giảm nhẹ, không loại bỏ. |
| Nhân bản sổ ở cả trung tâm và node (ghi 2 nơi) | Ghi kép: hai nơi có thể lệch nhau, và vẫn phải chọn nơi nào là sự thật. |
| Đặt sổ ở node **nhận** | Thu hồi phải nhờ phòng khác thực thi: chủ tài liệu mất quyền kiểm soát. |

## Hệ quả

Miền lỗi sau khi chuyển (đã đo bằng cách tắt thật từng thành phần):

| Sự cố | Cấp quyền | **Thu hồi** | Tìm thấy/tải tài liệu được chia sẻ |
|---|---|---|---|
| Trung tâm sập | **Được** (trước: 500) | **Được và có hiệu lực ngay** (trước: không thu hồi được, có thể còn hiện theo bản chụp) | Được, node chủ tự kiểm quyền |
| Node chủ sập | Không (tài liệu cũng không với tới được) | Không thể (nhưng cũng không tải được tệp) | Chỉ metadata từ bản sao ở trung tâm, gắn `stale`; không tải được tệp |
| Node nhận sập | Được | Được | Không liên quan |
| Trung tâm **và** node chủ cùng sập | Không | Không | Không; phòng chủ không còn truy cập tài liệu của chính mình trong lúc đó (hạn chế vật lý, ngoài phạm vi sổ chia sẻ) |

- (+) Quyền chia sẻ được ép **tại nơi giữ tệp**: dù Gateway hay chỉ mục sai, node chủ vẫn từ chối tải khi không có quyền (kiểm thử: chưa chia sẻ → 403; chỉ VIEW → 403; DOWNLOAD → tải đúng SHA-256).
- (+) Thu hồi không còn phụ thuộc trung tâm: khe hở "đã thu hồi mà vẫn xem được trong lúc trung tâm sập" biến mất.
- (−) **Duyệt yêu cầu xin quyền vẫn cần trung tâm** (yêu cầu nằm ở đó). Trung tâm sập thì xin/duyệt chờ; cấp trực tiếp bởi trưởng phòng thì không bị ảnh hưởng.
- (−) Bản sao ở trung tâm chỉ nhất quán cuối cùng (vài giây): thống kê chia sẻ của Ban Giám đốc và hiển thị khi dự phòng có thể chậm hơn sổ thật. Quyết định cho xem/tải **không** dựa vào bản sao này.
- (−) Danh sách "được chia sẻ cho tôi" hỏi tất cả node (hết 2,5 giây thì bỏ qua node đó): node chậm thì danh sách thiếu phần của node đó cho đến lần sau.
- (−) Nhân viên không thấy nút chia sẻ và `POST/DELETE /api/dept/<mã>/shares` cần Trưởng phòng trở lên, qua `DepartmentGuard` nên chỉ phòng của chính mình.

## Bổ sung (hoàn thiện sau review)

- **Chống đua cấp quyền:** chỉ mục duy nhất từng phần `idx_unique_active_share (doc_id, shared_with_dept) WHERE NOT is_revoked`. `grant()` dùng `INSERT ... ON CONFLICT ... DO UPDATE` (upsert): cấp lại cho cùng phòng thì đổi quyền VIEW↔DOWNLOAD và gia hạn thay vì chèn dòng thứ hai. Chuyển dữ liệu cũ thì không ghi đè lượt hiện có. Vi phạm duy nhất còn lại ở khóa idempotency (cùng `accessRequestId`) được bắt (23505/P2002) và trả lượt đã có. Kiểm thử: 8 yêu cầu đồng thời → 0 lỗi 5xx, đúng 1 dòng hiệu lực; chèn thẳng dòng thứ hai bị CSDL từ chối.
- **Lỗi kho tệp:** MinIO của node sập trong khi DB còn sống → node trả `503 STORAGE_NODE_UNAVAILABLE`, Gateway chuyển tiếp nguyên văn (trước: 500). Luồng đứt giữa chừng thì ngắt kết nối để client không nhận tệp cụt.
- **Kết quả một phần:** `GET /api/search/shares/shared-with-me` trả `{ shares, isPartial, unavailableNodes }`; giao diện hiện banner nêu rõ phòng nào không kết nối được.
- **Thăm dò ngầm của mạch ngắt:** trước đây mỗi chu kỳ nghỉ (4 giây) một yêu cầu người dùng trả giá chờ kết nối ~1,2 giây (đo được 1358–1744 ms). Nay bản chụp được phục vụ ngay còn việc thăm dò chạy ngầm: độ trễ "warm" khi trung tâm sập đo được 282–671 ms (SLA ≤ 800 ms; lần đầu ≤ 2500 ms).
