# ADR-010: Chỉ mục trung tâm là thành phần tùy chọn trên đường tìm kiếm

**Trạng thái:** Accepted (đã triển khai, kiểm thử bằng cách tắt thật CSDL trung tâm)

## Bối cảnh

Dữ liệu tài liệu nằm ở các node phòng ban; tìm kiếm liên hợp hỏi thẳng từng node. CSDL trung tâm chỉ nên là **dữ liệu dẫn xuất** (bản sao metadata để dự phòng), cộng với danh bạ phòng ban và quyền chia sẻ.
Nhưng khi đo thật (tắt CSDL trung tâm trên bản chưa sửa):

- Cả hai bản Search Gateway **sập** (pool kết nối không có bộ xử lý `error`, kết nối rảnh bị ngắt làm Node thoát), nginx trả 502. Tìm kiếm chết hoàn toàn dù mọi node còn sống.
- Index Projector thử lại 3 lần rồi **đẩy sự kiện vào DLQ**, tức mất dữ liệu chỉ mục dù sự kiện không hỏng.
- Mỗi truy vấn đều đọc danh bạ và quyền chia sẻ từ trung tâm.

Sau khi bỏ các điểm trên còn lộ thêm một lỗi gián tiếp: kết nối tới tên máy của CSDL đã tắt làm DNS của Docker trả lời rất chậm; các lần phân giải tên bị treo chiếm hết 4 luồng mặc định của Node, nên lệnh gọi tới các node **khỏe mạnh** cũng quá 800 ms và bị coi là sập (tìm kiếm mất 5–7 giây, cả ba node báo không dùng được).

## Quyết định

1. **Bộ xử lý lỗi cho pool** và thời gian chờ kết nối ngắn (1,2 giây) để lỗi nhanh thay vì treo.
2. **Bản chụp "đọc được lần cuối"** (`SnapshotService`) cho danh bạ phòng ban và quyền chia sẻ, lưu bộ nhớ và Redis (dùng chung các bản, sống qua khởi động lại). Ngữ nghĩa khi bình thường không đổi: luôn đọc nguồn gốc trước.
3. **Mạch ngắt** quanh mọi truy cập CSDL trung tâm: lỗi một lần thì nghỉ 4 giây, dùng bản chụp ngay, chỉ một yêu cầu thăm dò lại. Thêm `UV_THREADPOOL_SIZE=16` làm lớp phòng thủ thứ hai.
4. **Projector phân biệt lỗi hạ tầng với sự kiện hỏng**: lỗi hạ tầng thì giữ nguyên vị trí và chờ CSDL trở lại, không bao giờ DLQ; chỉ sự kiện hỏng thật mới vào DLQ.
5. **Bộ quét Registry không kết luận node sập** trong 65 giây sau khi Registry khởi động và trong lúc CSDL lỗi (nhịp tim không ghi được không có nghĩa node đã chết).
6. Phản hồi tìm kiếm và trang giám sát **nói rõ** chế độ suy giảm (`degraded.centralIndex`), không giả vờ bình thường.

## Phương án đã cân nhắc

| Phương án | Vì sao không chọn |
|---|---|
| Chạy CSDL trung tâm có tự chuyển primary (Patroni) | Vẫn cần, nhưng là mục riêng (đắt RAM); không thay được việc bỏ phụ thuộc cứng, vì nó chỉ rút ngắn thời gian sập chứ không loại bỏ. |
| Chuyển quyền chia sẻ về lưu tại node chủ sở hữu | Ban đầu để dành vì sửa nhiều; **sau đó đã làm, xem [ADR-011](ADR-011-share-ledger-at-owner-node.md)**, thay cho bản chụp quyền chia sẻ (quyết định 2 ở trên chỉ còn áp dụng cho danh bạ phòng ban). |
| Chỉ tăng thời gian chờ | Không giải quyết sập tiến trình và mất sự kiện. |

## Hệ quả

- (+) Tắt CSDL trung tâm: tìm kiếm vẫn HTTP 200, đủ 28 kết quả, mọi node `OK`, độ trễ dưới 1,5 giây; node vẫn ghi tài liệu mới; hồi phục thì sự kiện tạo lúc sập về chỉ mục sau vài giây, 0 vào DLQ, 0 sự cố giả.
- (−) Trong lúc trung tâm sập: mất dự phòng khi một node sập; trang lịch sử sự cố và duyệt yêu cầu xin quyền không dùng được. (Cấp/thu hồi chia sẻ KHÔNG còn bị ảnh hưởng từ ADR-011.)
- (−) Lần truy vấn đầu tiên sau khi trung tâm sập trả giá một lần chờ hết thời gian kết nối (~1,2 giây).
- (−) Chưa có bản chụp danh bạ (Gateway khởi động mới, Redis cũng trống, trung tâm đang sập) thì danh sách node không biết; tìm kiếm trả rỗng thay vì đoán.

## Lỗi phát hiện trong lúc kiểm thử mục này (không thuộc phạm vi ban đầu)

**Hash-chain audit bị sai khi ghi đồng thời.** `log_id` lấy từ sequence trước khi trigger giành khóa, và trigger chọn "dòng trước" theo `log_id` lớn nhất. Hai hậu quả: (a) thứ tự nối chuỗi khác thứ tự `log_id` nên bộ kiểm tra báo "đứt chuỗi" oan; (b) ba lần ghi đồng thời có thể sinh hai dòng cùng cha (nhánh rẽ). Đã sửa bằng `chain_seq` cấp ngay trong khóa; kiểm tra chuyển sang "cha phải tồn tại" và báo riêng số nhánh rẽ. Dữ liệu HR hiện có 1 nhánh rẽ cũ (mọi băm vẫn hợp lệ), được ghi chú minh bạch trong kết quả kiểm tra.
