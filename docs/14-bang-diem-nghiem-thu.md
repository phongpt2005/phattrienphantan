# Bảng điểm nghiệm thu (P3 C3)

Sinh bằng `bash infrastructure/scripts/acceptance-scorecard.sh` (chạy lần lượt mọi bộ kiểm trên hệ thống thật, đọc dòng kết quả của từng bộ). Một mục **ĐẠT** khi có ít nhất một kiểm tra và không có lỗi.

**Kết quả: 21/21 mục đạt; 456 kiểm tra đạt, 0 lỗi** (2026-11-27, sau khi thêm Redis Sentinel, Keepalived và sửa client Redis).

Số liệu lấy từ các lượt sau, đều trên image dịch vụ hiện tại trừ hai mục ghi rõ:
- Lượt `20261127_172120`: `e2e`, `central`, `kafka`, `debezium`, `partition` (lượt đầy đủ, dừng sau mục `replica`, xem mục 3).
- Lượt `20261127_193334`: `hr`, `replica`, `chaos-redis`, `sentinel`, `idem`, `retry`, `monitor`, `revoke` (9/9, 181 kiểm tra).
- Lượt `20261127_200709`: `vip` 19/19 (thêm ca bộ cân bằng tự khởi động lại, mục 3).
- Lượt `20261127_195115`: `chaos-central`, `chaos-minio`, `approval`, `provenance`, `epoch` (5/5, 53 kiểm tra).
- `autoscale` (lượt `20261127_052231`) và `restore` (lượt `20261127_124527`): chạy trên image trước khi sửa client Redis. Hai mục này không đi qua mã đã đổi: bộ co giãn điều khiển content-worker (image riêng, không đổi), bộ sao lưu và khôi phục làm việc trực tiếp với CSDL và kho tệp.

## 1. Từng mục

| Mục | Nhóm | Nội dung | Đạt | Lỗi | Số đo chính |
|---|---|---|---|---|---|
| `e2e` | Chức năng | Tạo, duyệt, chia sẻ, tìm kiếm, CDC, nội dung tệp, cảnh báo node | 100 | 0 | Tìm kiếm sau khi trung tâm sập: lần đầu 48 ms, các lần sau 49 ms; CDC lên chỉ mục 1082 ms |
| `central` | Chịu lỗi tầng dữ liệu | CSDL trung tâm: Patroni, etcd 3 nút, HAProxy 2 bản | 35 | 0 | Máy chính sập: ghi lại sau 22 giây; bị treo: 20 giây; bản sao sập, mất 1 nút etcd, mất quorum etcd, 1 HAProxy sập: vẫn ghi |
| `hr` | Chịu lỗi tầng dữ liệu | CSDL HR: Patroni, slot Debezium đi theo máy chính | 27 | 0 | Mọi tài liệu đã xác nhận lên chỉ mục trung tâm sau khi chuyển máy chính; bản sao dựng lại lúc Debezium dừng được bộ canh tự sửa |
| `kafka` | Chịu lỗi tầng dữ liệu | Kafka 3 broker, RF 3, min ISR 2 | 18 | 0 | Mất 1 broker vẫn ghi; mất 2 broker không xác nhận ghi |
| `debezium` | Chịu lỗi tầng dữ liệu | 2 worker Debezium | 7 | 0 | Task chuyển sang worker còn lại |
| `sentinel` | Chịu lỗi tầng dữ liệu | Redis bản sao và 3 Sentinel | 22 | 0 | Bản chính bị kill: chuyển sau 9 giây; thu hồi token và kênh thông báo theo bản chính mới; chuyển ngược có kế hoạch |
| `partition` | Phân tán | Phòng HR đứt mạng | 19 | 0 | Tự trị và ghi được khi mất etcd; hội tụ sau khi nối lại 32 giây (các lượt: 17–46 giây) |
| `replica` | Phân tán | Mỗi phòng 2 bản node | 42 | 0 | Một bản dừng: đăng nhập, xem, tạo tài liệu vẫn được ở cả 3 phòng |
| `vip` | Phân tán | 2 gateway, 2 bộ cân bằng giữ địa chỉ ảo | 19 | 0 | Gateway sập: ngắt dài nhất 2–9 giây; bộ cân bằng giữ địa chỉ sập: địa chỉ chuyển sau 4–6 giây; HAProxy trong bộ cân bằng chết: tự khởi động lại, khỏe lại |
| `chaos-central` | Phân tán | Trung tâm sập, các phòng vẫn chạy | 8 | 0 | Tìm kiếm HTTP 200 khi sập; đầy đủ lại sau khi cụm bật lại |
| `chaos-minio` | Phân tán | Kho tệp HR sập | 7 | 0 | |
| `chaos-redis` | Phân tán | Cả hai bản Redis sập | 10 | 0 | Đăng nhập và tìm kiếm vẫn chạy |
| `approval` | Tính đúng | Đua duyệt yêu cầu xin quyền | 6 | 0 | |
| `provenance` | Tính đúng | Truy vết lượt chia sẻ | 14 | 0 | |
| `epoch` | Tính đúng | Projector tự phục hồi tiến độ | 18 | 0 | |
| `idem` | Tính đúng | Idempotency-Key cho tạo tài liệu | 23 | 0 | 8 yêu cầu đồng thời cùng khóa: đúng 1 tài liệu |
| `retry` | Tính đúng | CSDL lỗi tạm thời: 503 + Retry-After | 10 | 0 | Không để tệp mồ côi trong kho tệp |
| `monitor` | Quan sát | Trang giám sát đọc Patroni, etcd, worker Debezium | 15 | 0 | |
| `revoke` | Bảo mật | Thu hồi token có hiệu lực ngay | 18 | 0 | |
| `autoscale` | Co giãn | Tự co giãn content-worker theo lag | 16 | 0 | Thêm bản khi lag tăng, bớt khi lag 0, khôi phục khi mọi bản chết (lượt `052231`) |
| `restore` | Sao lưu | Sao lưu mã hóa ra ngoài, khôi phục thử | 22 | 0 | 4 CSDL và kho tệp 3 phòng (lượt `124527`) |

## 2. Cách chạy lại

```
bash infrastructure/scripts/acceptance-scorecard.sh                 # tất cả 21 mục
bash infrastructure/scripts/acceptance-scorecard.sh central restore # chỉ các mục nêu tên
SKIP="restore autoscale" bash infrastructure/scripts/acceptance-scorecard.sh
```

Kết quả nằm ở `logs/scorecard-<thời điểm>/BANG-DIEM.md`, kèm log từng mục. Máy phải thức suốt lượt chạy. Nếu một lượt bị dừng giữa chừng, bẫy dọn dẹp của bài kiểm đang chạy không chạy: kiểm container nào còn dừng và bật lại trước lượt sau.

## 3. Lỗi tìm ra khi chạy bảng điểm và cách đã xử lý

| Lượt | Hiện tượng | Nguyên nhân gốc | Xử lý |
|---|---|---|---|
| `001413` | Một ca đo khoảng ngắt 1005 giây | Máy ngủ giữa lượt chạy | Không tính lượt này; giữ máy thức khi chạy |
| `001413` | Dừng sau 4 mục | Bài kiểm Kafka đọc stdin của vòng lặp bảng điểm | Mỗi bài kiểm chạy với `< /dev/null`; danh sách mục đọc qua fd 3 |
| `042046` | Bản sao lưu thiếu kho tệp 3 phòng | Script sao lưu đưa đường dẫn kiểu Unix cho chương trình chạy ngoài môi trường shell; khi tắt việc tự đổi đường dẫn thì lỗi | Dùng đường dẫn tường minh |
| `051644` | Đọc máy chính trả rỗng giữa lúc khôi phục | Máy tải nặng, vòng lặp Patroni chạy quá giờ, `GET /primary` tạm không trả 200 | Hàm tìm máy chính hỏi lại tới 15 giây |
| `052231` | Chuyển máy chính khi bị treo mất 46 giây | etcd ghi đĩa chậm (fdatasync 1,4–4,7 giây) vì 3 nút etcd dùng chung đĩa với các CSDL và Kafka | Thêm giám sát độ trễ đĩa của etcd và cảnh báo `EtcdSlowDisk`, `EtcdNoLeader`, `PatroniNoPrimary`. Chạy lại: 19–22 giây. Khắc phục hẳn: etcd trên đĩa riêng (triển khai nhiều máy, `docs/13`) |
| `052231` | Chaos: tìm kiếm chưa đầy đủ ngay khi cụm bật lại | Bài kiểm đòi đầy đủ ngay lập tức; còn bầu máy chính, HAProxy kiểm lại, mạch ngắt nghỉ | Đo thời gian hồi phục, giới hạn 60 giây |
| `052231` | Giám sát: worker chưa `ok` sau 60 giây | JVM của Debezium khởi động lâu khi máy tải nặng | Chờ worker sẵn sàng rồi mới kiểm trang giám sát |
| `162233` | e2e: Ban Giám đốc không nhận đủ cảnh báo node | Lỗi thật của sản phẩm: một bản Search Gateway mất Redis vĩnh viễn sau lần chuyển bản chính đầu tiên (`failoverDetector` của ioredis) | Bỏ `failoverDetector`, thêm lớp giữ sống cho mọi client; bài kiểm Sentinel kiểm số bản nghe kênh thông báo (ADR-016) |
| `200709` | Sau các lượt kiểm, `keepalived-1` khởi động lại liên tục ("daemon is already running") | Script khởi động thoát ngay sau khi dừng keepalived (HAProxy chết hoặc bộ kia đổi địa chỉ), keepalived chưa kịp xóa tệp pid; restart policy bật lại trên cùng hệ thống tệp, pid cũ trùng tiến trình mới | Xóa tệp pid cũ khi khởi động, chờ keepalived dừng hẳn rồi mới thoát; thêm ca 5 vào `keepalived-test.sh` (HAProxy chết, container tự bật lại, không kẹt): 19/19 |
| `162233`, `172120` | `e2e`, `hr`, `replica` đứng yên tới hết giờ, không in thêm dòng nào | Lệnh `docker` trong môi trường shell của bài kiểm là script bọc (thêm một shell và hai tiến trình con, không thay thế tiến trình): 4,7 giây mỗi lệnh khi máy thiếu bộ nhớ, và có lúc không trả về; `timeout` giết shell bọc thì CLI con vẫn giữ ống dẫn | Bài kiểm gọi thẳng CLI (hàm `docker` trong `lib-central.sh`, bảng điểm truyền xuống mọi bài kiểm con): 1,1 giây mỗi lệnh. Truy vấn ngắn dùng `dx` có giới hạn thời gian. Lượt sau: `hr` 315 giây (trước: hết giờ 1800 giây) |

## 4. Giới hạn cần nói rõ khi nghiệm thu

- Mọi thành phần chạy trên một môi trường: các bài kiểm chứng minh cơ chế (chuyển máy chính, quorum, đứt mạng, co giãn, địa chỉ ảo), không chống được việc hỏng trọn một máy. Thời gian chuyển máy chính phụ thuộc tốc độ đĩa (mục 3, lượt `052231`).
- Hội tụ sau đứt mạng dao động 17–46 giây theo tải của máy.
- Địa chỉ ảo của gateway phục vụ lưu lượng bên trong mạng; cổng ra ngoài vẫn gắn vào một gateway (địa chỉ ảo thật cho bên ngoài cần từ hai máy).
- Tự co giãn đã kiểm bằng bài kiểm, chưa chạy thường trực.
