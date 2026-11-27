# Bảng điểm nghiệm thu (P3 C3)

Sinh bằng `bash infrastructure/scripts/acceptance-scorecard.sh` (chạy lần lượt mọi bộ kiểm trên hệ thống thật, đọc dòng kết quả của từng bộ). Một mục **ĐẠT** khi có ít nhất một kiểm tra và không có lỗi.

**Kết quả: 18/18 mục đạt; 405 kiểm tra đạt, 0 lỗi** (2026-11-27).

Số liệu lấy từ hai lượt chạy:
- Lượt `20261127_052231`: 14 mục đạt ngay.
- Lượt `20261127_124527`: chạy lại 4 mục sau khi tìm nguyên nhân và sửa (mục 3 bên dưới).

## 1. Từng mục

| Mục | Nhóm | Nội dung | Đạt | Lỗi | Số đo chính |
|---|---|---|---|---|---|
| `e2e` | Chức năng | Tạo, duyệt, chia sẻ, tìm kiếm, CDC, nội dung tệp | 100 | 0 | Tìm kiếm: lần đầu sau khi trung tâm sập 142 ms, các lần sau 121 ms (lượt 28) |
| `central` | Chịu lỗi dữ liệu | CSDL trung tâm: Patroni, etcd 3 nút, HAProxy 2 bản | 35 | 0 | Máy chính sập: ghi lại sau 19 giây; bị treo: 21 giây; mất 1 nút etcd: ghi 0 lỗi; mất quorum etcd: vẫn ghi; 1 HAProxy sập: vẫn ghi |
| `hr` | Chịu lỗi dữ liệu | CSDL HR: Patroni, slot Debezium đi theo máy chính | 27 | 0 | Mọi tài liệu đã xác nhận lên chỉ mục trung tâm sau khi chuyển máy chính |
| `kafka` | Chịu lỗi dữ liệu | Kafka 3 broker, RF 3, min ISR 2 | 18 | 0 | Mất 1 broker vẫn ghi; mất 2 broker không xác nhận ghi |
| `debezium` | Chịu lỗi dữ liệu | 2 worker Debezium | 7 | 0 | Task chuyển sang worker còn lại |
| `partition` | Phân tán | Phòng HR đứt mạng | 19 | 0 | Tự trị và ghi được khi mất etcd; hội tụ sau khi nối lại 17–46 giây (theo tải của máy) |
| `replica` | Phân tán | Mỗi phòng 2 bản node | 42 | 0 | Một bản dừng: đăng nhập, xem, tạo tài liệu vẫn được ở cả 3 phòng |
| `chaos-central` | Phân tán | Trung tâm sập, các phòng vẫn chạy | 8 | 0 | Tìm kiếm HTTP 200 khi sập; đầy đủ lại sau khi cụm bật lại |
| `chaos-minio` | Phân tán | Kho tệp HR sập | 7 | 0 | |
| `approval` | Tính đúng | Đua duyệt yêu cầu xin quyền | 6 | 0 | |
| `provenance` | Tính đúng | Truy vết lượt chia sẻ | 14 | 0 | |
| `epoch` | Tính đúng | Projector tự phục hồi tiến độ | 18 | 0 | |
| `idem` | Tính đúng | Idempotency-Key cho tạo tài liệu | 23 | 0 | 8 yêu cầu đồng thời cùng khóa: đúng 1 tài liệu |
| `retry` | Tính đúng | CSDL lỗi tạm thời: 503 + Retry-After | 10 | 0 | Không để tệp mồ côi trong kho tệp |
| `monitor` | Quan sát | Trang giám sát đọc Patroni, etcd, worker Debezium | 15 | 0 | |
| `revoke` | Bảo mật | Thu hồi token có hiệu lực ngay | 18 | 0 | |
| `autoscale` | Co giãn | Tự co giãn content-worker theo lag | 16 | 0 | Thêm bản khi lag tăng, bớt khi lag 0, khôi phục khi mọi bản chết |
| `restore` | Sao lưu | Sao lưu mã hóa ra ngoài, khôi phục thử | 22 | 0 | 4 CSDL và kho tệp 3 phòng; khôi phục thử 260 giây |

## 2. Cách chạy lại

```
bash infrastructure/scripts/acceptance-scorecard.sh                 # tất cả (khoảng 1 giờ)
bash infrastructure/scripts/acceptance-scorecard.sh central restore # chỉ các mục nêu tên
```

Kết quả nằm ở `logs/scorecard-<thời điểm>/BANG-DIEM.md`, kèm log từng mục. Máy phải thức suốt lượt chạy.

## 3. Lỗi tìm ra khi chạy bảng điểm và cách đã xử lý

| Lượt | Hiện tượng | Nguyên nhân gốc | Xử lý |
|---|---|---|---|
| `001413` | Một ca đo khoảng ngắt 1005 giây | Máy ngủ giữa lượt chạy | Không tính lượt này; giữ máy thức khi chạy |
| `001413` | Dừng sau 4 mục | Bài kiểm Kafka đọc stdin của vòng lặp bảng điểm | Mỗi bài kiểm chạy với `< /dev/null`; danh sách mục đọc qua fd 3 |
| `042046` | Bản sao lưu thiếu kho tệp 3 phòng | Script sao lưu đưa đường dẫn kiểu Unix cho chương trình chạy ngoài môi trường shell; khi tắt việc tự đổi đường dẫn thì lỗi | Dùng đường dẫn tường minh |
| `051644` | Đọc máy chính trả rỗng giữa lúc khôi phục | Máy tải nặng, vòng lặp Patroni chạy quá giờ, `GET /primary` tạm không trả 200 | Hàm tìm máy chính hỏi lại tới 15 giây |
| `052231` | Chuyển máy chính khi bị treo mất 46 giây | etcd ghi đĩa chậm (fdatasync 1,4–4,7 giây) vì 3 nút etcd dùng chung đĩa với các CSDL và Kafka | Thêm giám sát độ trễ đĩa của etcd và cảnh báo `EtcdSlowDisk`, `EtcdNoLeader`, `PatroniNoPrimary`. Chạy lại: 19–21 giây. Khắc phục hẳn: etcd trên đĩa riêng (triển khai nhiều máy, `docs/13`) |
| `052231` | Chaos: tìm kiếm chưa đầy đủ ngay khi cụm bật lại | Bài kiểm đòi đầy đủ ngay lập tức; còn bầu máy chính, HAProxy kiểm lại, mạch ngắt nghỉ | Đo thời gian hồi phục, giới hạn 60 giây |
| `052231` | Giám sát: worker chưa `ok` sau 60 giây | JVM của Debezium khởi động lâu khi máy tải nặng | Chờ worker sẵn sàng rồi mới kiểm trang giám sát |

## 4. Giới hạn cần nói rõ khi nghiệm thu

- Mọi thành phần chạy trên một môi trường: các bài kiểm chứng minh cơ chế (chuyển máy chính, quorum, đứt mạng, co giãn), không chống được việc hỏng trọn một máy. Thời gian chuyển máy chính phụ thuộc tốc độ đĩa (mục 3, lượt `052231`).
- Hội tụ sau đứt mạng dao động 17–46 giây theo tải của máy.
- Tự co giãn đã kiểm bằng bài kiểm, chưa chạy thường trực.
