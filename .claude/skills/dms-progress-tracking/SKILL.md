---
name: dms-progress-tracking
description: "BẮT BUỘC sau mỗi tác vụ, mỗi lần người dùng chốt kế hoạch, mỗi lần commit, mỗi lần chạy e2e hoặc epoch test, và mỗi sự cố hoặc sai sót trong dự án DMS: ghi nhật ký vào docs/12-nhat-ky-tien-trinh.md theo mẫu cố định, cập nhật docs/07 và docs/11 khi trạng thái đổi, và gắn nhãn đã kiểm chứng hoặc chưa kiểm chứng cho từng kết quả."
---

# Ghi nhật ký tiến trình DMS

Mục đích: người đọc sau (kể cả chính tôi ở phiên khác) phải hiểu được việc đã làm, vì sao làm, kết quả đo và việc còn mở, mà không cần lật lại cuộc trò chuyện. Nhật ký chính: `docs/12-nhat-ky-tien-trinh.md`.

## 1. Khi nào phải ghi

- **Khi người dùng chốt kế hoạch:** ghi quyết định và trích đúng câu chốt. Không ghi "đã duyệt" nếu chưa có câu chốt.
- **Khi thay đổi mã, cấu hình, image hoặc container:** ghi file, commit, image ID, container đã recreate.
- **Khi chạy e2e hoặc epoch test:** ghi số đếm PASS/FAIL, mọi lần FAIL và nguyên nhân, kể cả lần đã được sửa sau đó.
- **Khi gặp sự cố hoặc phát hiện sai sót của mình:** ghi triệu chứng, nguyên nhân, cách xử lý và bài học.
- **Khi commit:** ghi hash và phạm vi file.
- **Khi đóng một tác vụ:** đối chiếu với tiêu chí "xong" đã chốt.

## 2. Mẫu một mục (đủ mọi trường)

```
### <số thứ tự>. <tên tác vụ> (<ngày UTC>; giờ địa phương nếu cần đối chiếu log)
- **Mục tiêu:** một câu.
- **Quyết định:** đề xuất → người dùng chốt bằng câu gì. Nếu chưa chốt, ghi "chờ chốt".
- **Thay đổi:** đường dẫn file; commit; image; container đã recreate (kèm lệnh nếu khác thường).
- **Kiểm chứng:** mỗi dòng gắn nhãn `[đã kiểm chứng]`, `[đã làm, chưa kiểm chứng]` hoặc `[chưa làm]`; có số đo, lệnh hoặc file kết quả.
- **Sự cố và sai sót:** triệu chứng → nguyên nhân → xử lý → bài học. Ghi cả việc đã làm mà chưa hỏi.
- **Còn mở:** việc, điều kiện, người quyết định.
```

## 3. Quy tắc viết

- Số đo thật, đủ đơn vị và thời điểm. Không làm tròn cho đẹp.
- Không ghi giá trị bí mật (mật khẩu, khóa, token, nội dung `.env`); chỉ ghi tên biến.
- Không ghi thông tin cá nhân của người dùng (email, họ tên); dùng "người dùng".
- Đường dẫn trong repo dùng tương đối. Đường dẫn scratchpad phải viết đầy đủ.
- Thời gian ghi UTC; ghi thêm giờ địa phương (+07) khi đối chiếu log.
- Kết quả trong scratchpad không bền. Số liệu quan trọng phải chép vào `docs/12`.
- Khi số trong tài liệu cũ sai: sửa và ghi "đính chính" kèm ngày.
- Nếu nguyên nhân chưa rõ: ghi "chưa xác định" và nêu thí nghiệm sẽ phân định được. Không viết suy đoán như kết luận.

## 4. Cập nhật tài liệu khác

- `docs/07-implementation-status.md`: bảng trạng thái và các mục theo gói. Mục mới đặt phía trên mục gần nhất theo đúng thứ tự đang dùng.
- `docs/11-p1-kafka-cutover.md`: điều kiện C1–C4. Ghi ngày đo khi cập nhật.
- `docs/10-goi-b-va-c.md`: chỉ sửa lộ trình khi người dùng chốt đổi thứ tự.
- `docs/12-nhat-ky-tien-trinh.md`: thêm mục vào dòng thời gian (phần 1) và cập nhật trạng thái hiện tại (phần 0).

## 5. Lệnh thu thập bằng chứng

- Commit: `git log --date=short --format='%h %ad %s' -20`; `git show --stat <hash>`.
- Container: `docker ps --format '{{.Names}} | {{.Status}}'`.
- Image: `docker image inspect -f '{{.Id}}' dms/search-engine-service:2.0`.
- Mã đã biên dịch trong image: `docker run --rm --entrypoint sh <image> -c 'grep -c "<dấu hiệu>" <đường dẫn dist>'`.
- RAM (PowerShell): `Get-CimInstance Win32_OperatingSystem`.
- Kết quả e2e hoặc epoch: bỏ mã màu rồi đếm dòng `PASS` và `FAIL`; lấy dòng `KẾT QUẢ` và dòng `exit=` bên trong file.
- Lag và tiến độ: `kafka-consumer-groups.sh --describe --group index-projector`; bảng `cdc_partition_progress`.
- Log: đếm theo mẫu trong file đã xuất. Không grep toàn bộ log khi máy thiếu RAM.

## 6. Kiểm tra trước khi lưu

- [ ] Mỗi kết luận có số đo hoặc lệnh đi kèm.
- [ ] Mỗi kết quả có nhãn đã kiểm chứng hoặc chưa kiểm chứng.
- [ ] Đã ghi lần FAIL và nguyên nhân (nếu có).
- [ ] Không có bí mật, không có email hay tên người dùng.
- [ ] Commit (nếu có) ghi đúng hash và phạm vi.
- [ ] Mục "Còn mở" đủ để người đọc sau biết bước tiếp theo và điều kiện.
