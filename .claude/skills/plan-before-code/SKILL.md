---
name: plan-before-code
description: "BẮT BUỘC khi người dùng phản hồi, góp ý, đề xuất, sửa yêu cầu hoặc gửi bản kế hoạch trong dự án DMS. Quy trình: hiểu đúng, kiểm chứng bằng mã và số đo, suy luận phương án tốt nhất, cùng người dùng chốt kế hoạch, chỉ viết mã sau khi có xác nhận chốt."
---

# Chốt kế hoạch trước khi viết mã

Áp dụng cho mọi lần người dùng phản hồi hoặc đưa yêu cầu, kể cả khi họ dán bản kế hoạch dài. Đọc cùng skill `dms-engineering-principles`.

Mục đích: mỗi thay đổi phải là phương án **tốt nhất** đã được kiểm chứng và được người dùng đồng ý, không phải phương án làm nhanh nhất.

## 1. Khi nào áp dụng

Áp dụng khi người dùng: yêu cầu thay đổi, góp ý về thiết kế, gửi bản kế hoạch hoặc phản hồi về kế hoạch trước.

Được miễn chỉ trong ba trường hợp, và phải hẹp:
- Câu hỏi chỉ cần đọc để trả lời (tra trạng thái, đọc log, đếm số liệu). Chỉ dùng lệnh chỉ đọc.
- Lệnh vận hành người dùng đã duyệt từng bước cụ thể (ví dụ "khởi động lại container X").
- Sửa lỗi chính tả hoặc chú thích, không đổi hành vi.

Nếu không chắc có thuộc miễn trừ không, coi là áp dụng.

## 2. Quy trình bắt buộc

1. **Hiểu đúng.** Tóm tắt yêu cầu bằng lời của mình. Nêu giả định. Nếu chỗ nào mơ hồ, hỏi trước.
2. **Kiểm chứng bằng mã và số đo.** Trước khi đề xuất, đọc mã liên quan (ghi đường dẫn và dòng) và đo thật khi có liên quan đến tài nguyên (RAM, dung lượng, số bản ghi). Không dựa vào số trong tài liệu cũ.
3. **Suy luận ít nhất hai phương án.** Gồm phương án của người dùng và ít nhất một phương án khác. Đánh giá cùng các tiêu chí ở mục 3.
4. **Chọn phương án tốt nhất** và nói rõ lý do. Nếu phương án của người dùng có rủi ro, nói rõ rủi ro, đừng chỉ làm theo vì họ yêu cầu.
5. **Trình kế hoạch** theo mẫu ở mục 4.
6. **Hỏi quyết định thật sự cần người dùng chọn** (tối đa ba câu, có lựa chọn cụ thể).
7. **Chờ xác nhận chốt rõ ràng** ("chốt", "duyệt", "làm đi" hoặc tương đương). Im lặng hoặc câu hỏi thêm không phải là chốt.

## 3. Tiêu chí chọn phương án (theo thứ tự ưu tiên)

1. Không mất dữ liệu, không ghi sai âm thầm. Phải xét mọi trường hợp lỗi trong bảng sự cố của `dms-engineering-principles`.
2. Đúng trong các sự cố đã liệt kê, có kịch bản kiểm thử chứng minh.
3. Đảo ngược được (có đường lùi đã kiểm chứng).
4. Đo được: có số đo trước và sau.
5. Phù hợp tài nguyên thật của máy (RAM Windows đo bằng `Win32_OperatingSystem`, không dùng con số ước tính).
6. Đơn giản nhất đạt được các tiêu chí trên.

Nêu rõ chi phí và đánh đổi của phương án được chọn (thời gian dừng, tài nguyên, độ phức tạp, rủi ro còn lại).

## 4. Mẫu trình kế hoạch

- **Mục tiêu:** một câu.
- **Phương án đề xuất và lý do:** đối chiếu với tiêu chí mục 3.
- **Phương án khác đã xét:** một đến hai phương án và lý do loại.
- **Điểm lệch so với yêu cầu của người dùng:** nếu có, nêu rõ và lý do.
- **Các bước:** từng bước, file sẽ đổi, lệnh sẽ chạy (đánh dấu lệnh nào thay đổi hệ thống đang chạy).
- **Kiểm chứng:** từng ca kiểm thử, số đo, tiêu chí "xong".
- **Rủi ro và đường lùi:** cụ thể, không chung chung.
- **Quyết định cần chốt:** câu hỏi cụ thể.

## 5. Ràng buộc khi chưa chốt

Trước khi có xác nhận chốt, không được:
- sửa file mã, cấu hình, script, tài liệu thiết kế;
- build image, recreate hoặc restart container, đổi cấu hình compose;
- ghi dữ liệu vào CSDL (INSERT, UPDATE, DELETE, ALTER, TRUNCATE);
- xóa hoặc di chuyển file dữ liệu, sao lưu.

Chỉ được chạy lệnh chỉ đọc để kiểm chứng.

Ngoại lệ duy nhất: thao tác ngăn mất dữ liệu đang xảy ra (ví dụ dừng một tiến trình đang ghi sai). Phải báo ngay và nêu lý do.

## 6. Sau khi chốt

- Thực hiện đúng kế hoạch đã chốt. Nếu phát hiện kế hoạch sai, dừng, báo, trình kế hoạch sửa, và chờ chốt lại. Không tự đổi kế hoạch đã chốt.
- Ghi kế hoạch đã chốt và kết quả đo thật vào tài liệu (`docs/07-implementation-status.md`) cùng lúc với thay đổi.
- Báo cáo kết quả theo tiêu chí "xong" đã chốt. Nêu rõ phần nào đã kiểm chứng và phần nào chưa.
