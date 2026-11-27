# Đề xuất: triển khai trên 3 máy

**Trạng thái:** đề xuất, chưa làm. Chờ nhóm chốt sau buổi nghiệm thu.

Hiện mọi thành phần chạy trên một môi trường: các bài kiểm chứng minh **cơ chế** (chuyển máy chính, quorum, đứt mạng, tự co giãn) nhưng chưa chống được việc hỏng trọn một máy. Có 3 máy thì mục tiêu đổi thành: **mất trọn một máy bất kỳ, hệ thống vẫn ghi được, không mất dữ liệu đã xác nhận, tự hồi phục khi máy quay lại**.

## 1. Bố trí: lõi trải đều, phòng ban xếp vòng

| Thành phần | Máy 1 | Máy 2 | Máy 3 | Mất một máy |
|---|---|---|---|---|
| etcd | nút 1 | nút 2 | nút 3 | Còn quorum 2/3 |
| Kafka (KRaft) | broker 1 | broker 2 | broker 3 | RF 3, min ISR 2: vẫn ghi; đặt `broker.rack` theo máy để bản sao nằm ở 3 máy |
| Debezium | worker 1 | worker 2 | worker 3 | Task chuyển sang worker còn lại |
| CSDL trung tâm (Patroni) | node 1 | node 2 | node 3 | Commit theo quorum (`synchronous_mode: quorum`, Patroni 4): luôn còn một bản sao đã xác nhận |
| HAProxy, gateway, search | 1 bản | 1 bản | 1 bản | Địa chỉ ảo VRRP trên mạng LAN (keepalived): client không đổi địa chỉ |
| Redis | Sentinel + bản chính | Sentinel + bản sao | Sentinel + bản sao | Sentinel bầu bản chính mới |
| Phòng HR | máy chính CSDL, node 1, kho tệp | bản sao CSDL, node 2, bản chép kho tệp | | Patroni chuyển sang máy 2 |
| Phòng ACC | | máy chính CSDL, node 1, kho tệp | bản sao CSDL, node 2, bản chép kho tệp | Patroni chuyển sang máy 3 |
| Phòng SALES | bản sao CSDL, node 2, bản chép kho tệp | | máy chính CSDL, node 1, kho tệp | Patroni chuyển sang máy 1 |
| Sao lưu mã hóa | giữ bản của máy 2 | giữ bản của máy 3 | giữ bản của máy 1 | Luôn có bản ở máy khác |

Xếp vòng nghĩa là mỗi máy giữ máy chính của một phòng và bản sao của phòng kế bên. Mất một máy thì đúng một phòng chuyển máy chính, các phòng khác không bị ảnh hưởng.

## 2. Cách triển khai: Docker Swarm (đề xuất)

| Cách | Ưu | Nhược |
|---|---|---|
| **Docker Swarm** (đề xuất) | Có sẵn trong Docker; mạng overlay nối 3 máy; ràng buộc vị trí theo nhãn máy (`node.labels.site == hr`); `docker secret` thay cho `.env` (giải quyết luôn việc bí mật nằm trong tệp); cập nhật cuốn chiếu có sẵn | Một số khóa compose không dùng được trong stack (`build`, `container_name`, `depends_on` có điều kiện, `profiles`): phải tách tệp stack |
| Compose trên từng máy + mạng riêng (WireGuard) | Gần với hiện tại nhất | Tự lo DNS giữa các máy, tự lo cập nhật; dễ lệch cấu hình giữa máy |
| k3s (Kubernetes gọn) | Có operator cho Postgres, Kafka | ADR-005 đã gỡ Kubernetes vì tài nguyên; học và chuyển đổi tốn nhiều thời gian nhất |

## 3. Những điểm đặc sắc có thể trình diễn

1. **Rút điện một máy giữa buổi demo.** Chạy bảng điểm (`acceptance-scorecard.sh`) trước và sau, đo RTO/RPO từng tầng trên phần cứng thật, thay cho dừng container.
2. **Đứt mạng thật giữa các máy** (tường lửa chặn một máy) để chứng minh site tự trị và hội tụ, kèm số đo thời gian hội tụ.
3. **Giả lập khoảng cách địa lý** (`tc netem` thêm 20–80 ms giữa các máy): đo cái giá của ghi đồng bộ theo độ trễ, minh họa đánh đổi nhất quán và độ trễ.
4. **Commit theo quorum cho CSDL trung tâm**: 3 node, ghi chờ 1 trong 2 bản sao, mất máy nào cũng không mất dòng đã xác nhận.
5. **Rào chắn chống ghi hai nơi bằng watchdog phần cứng/softdog** cho Patroni trên máy Linux (hiện tắt vì môi trường container không có).
6. **Đọc gần**: mỗi bản search đọc bản sao CSDL trung tâm trên cùng máy; đo độ trễ tìm kiếm trước và sau.
7. **Bảng giám sát sống trong lúc demo**: trang hệ thống của Ban Giám đốc đã đọc Patroni, etcd, worker Debezium; thêm bảng theo máy để thấy máy nào sập và việc tự chuyển.
8. **Nâng cấp không gián đoạn**: rút một máy khỏi cụm, nâng cấp, đưa vào, lặp lại cho máy khác; đo số yêu cầu lỗi bằng 0.

## 4. Thứ tự làm (đề xuất)

1. Đo tài nguyên từng máy và mạng giữa các máy (độ trễ, băng thông). Chốt bố trí ở mục 1 theo số đo.
2. Dựng Swarm, nhãn máy, mạng overlay; chuyển bí mật sang `docker secret`.
3. Chuyển lõi trước (etcd, Kafka, CSDL trung tâm), rồi từng phòng (theo đúng cách đã làm với HR: chép dữ liệu, giữ slot, so băm).
4. Chạy bảng điểm sau mỗi bước; cuối cùng chạy kịch bản rút điện từng máy.
