# 11. P1: Cụm Kafka 3 broker KRaft (Hướng A, cutover có kiểm soát)

Trạng thái: **đã thi công B1 bản gọn ngày 2026-11-24** (người dùng chốt "B1 bản gọn"; kết quả ở mục 6). Phần còn lại: worker Debezium thứ hai, kiểm lại ca mất quorum, dọn broker cũ. Tài liệu này hiệu chỉnh đặc tả P1 sau khi kiểm chứng trên hệ thống thật. Mỗi điểm lệch so với đặc tả đều có bằng chứng.

## 1. Điều kiện trước khi cutover (chưa thỏa)

| # | Điều kiện | Trạng thái | Bằng chứng |
|---|---|---|---|
| C1 | Bộ nhớ trống của môi trường đủ cho 3 broker | **Chưa thỏa** (ba lần đo gần nhất đều dưới ngưỡng, kể cả sau khi giảm giới hạn bộ nhớ máy ảo, dừng Jaeger/Grafana và xóa bộ đệm ngày 2026-11-24); cần ≥ 2 GB ổn định | Phép đo của hệ điều hành; khi bận, broker đã bị `REQUEST_TIMED_OUT` và bầu lại leader |
| C2 | Có cửa sổ bảo trì được thông báo | **Đã dùng** ngày 2026-11-24 (người dùng chốt B1 bản gọn, gồm cửa sổ này); CDC dừng từ khi tạm dừng connector đến khi đăng ký lại, khoảng 5 phút | Ước tính dừng CDC và chỉ mục khoảng **10 phút**, không phải 15–30 giây như đặc tả |
| C3 | Sao lưu log Kafka hiện tại ra ngoài container | **Đã đạt** (commit `35909b1`) | `backup-kafka-logs.sh` ghi vào thư mục sao lưu ngoài môi trường, mã hóa AES-256. `kafka-logs-restore-test.sh` trên bản `kafka_20261120_221415`: 543/543 tệp khớp SHA-256 và kích thước; segment `__cluster_metadata-0` đọc được 73.980 bản ghi |
| C4 | Projector có cơ chế tự phục hồi khi topic bị tạo lại | **Đã đạt** (P0.6, commit `c4ff399`) | `projector-epoch-test.sh` 18/18; đã xảy ra thật ngày 19/11: tiến độ 5 ≥ log-end 2 của SALES p0 được đọc lại và hội tụ, chỉ mục khớp node |

## 2. Phát hiện làm thay đổi đặc tả

**2.1. Kafka không lưu log vào volume.** Image `apache/kafka` ghi log vào `/tmp/kafka-logs` trong container (`kafka-configs --describe` xác nhận `log.dir=/tmp/kafka-logs`). Compose mount volume `dms-kafka-data` vào `/var/lib/kafka/data` nhưng không đặt `KAFKA_LOG_DIRS`, nên volume đó **trống**. Hệ quả:
- Mỗi lần **tạo lại container** Kafka (ví dụ `docker compose up --force-recreate`) là mất toàn bộ topic. Lần tạo lại khi áp dụng P0.4 đã gây ra lệch tiến độ projector.
- Đặc tả cũ "giữ volume `dms-kafka-data` để rollback" là **không có tác dụng**, vì volume đó không chứa dữ liệu.
- Broker mới **bắt buộc** khai báo `KAFKA_LOG_DIRS=/var/lib/kafka/data` và mount volume mới.

**2.2. Không có lệnh thêm hay bớt controller trên Kafka 3.7.0.** `kafka-metadata-quorum.sh` chỉ có `describe`. Vì vậy không thể nâng cluster 1 voter thành 3 voter tại chỗ. Cutover sang cluster mới là cách duy nhất (hoặc nâng lên Kafka 3.9 và dùng voter động, chưa kiểm chứng).

**2.3. Connector phải đăng ký lại.** Cấu hình connector nằm trong topic `debezium_configs`, sẽ trống trên cluster mới. Dịch vụ `connect-init` đã làm việc này (PUT idempotent) và **tự gọi resync** sau khi đăng ký (`RESYNC_AFTER_REGISTER=true`). Đã kiểm chứng: đăng ký lại `outbox-hr` (HTTP 200), `outbox-acc` (HTTP 200), `outbox-sales` (HTTP 201), resync HR 289, ACC 4, SALES 1.

**2.4. Resync phụ thuộc MinIO.** Khi `minio-hr` bị dừng, resync của HR trả **HTTP 500** (`getaddrinfo ... minio-hr`) và không phát lại được gì. Đây là thiết kế sai: sự kiện chỉ mục không cần đọc tệp từ MinIO. Cần sửa trước khi dựa vào resync làm đường phục hồi (xem mục 4). **Đã sửa (cập nhật 2026-11-20):** `resyncAll` chỉ đọc CSDL node và ghi outbox, không gọi MinIO. Kiểm ngày 2026-11-19: khi `minio-hr` dừng, `POST /internal/resync` trả **HTTP 201**, `{"replayed":294}`, log `dept-hr` không có lỗi MinIO trong 3 phút.

**2.5. Kiểm thử `NOT_ENOUGH_REPLICAS` trong đặc tả không đúng như mô tả.** Với 3 controller kết hợp broker, tắt 2 broker làm **mất quorum KRaft**: không bầu được leader mới và không cập nhật được ISR, nên lỗi ghi sẽ là timeout hoặc `NOT_LEADER`, không phải `NOT_ENOUGH_REPLICAS`. Cách kiểm chứng đúng:
- Tạo topic thử `ha-minisr-test` với `replication.factor=3`, `min.insync.replicas=3`.
- Tắt **một** broker (quorum còn 2/3), ghi với `acks=all`: kỳ vọng `NOT_ENOUGH_REPLICAS`.
- Tắt **hai** broker: kỳ vọng **không có ack thành công** (ghi lại mã lỗi thực tế).

**2.6. Giới hạn bộ nhớ.** Heap `-Xms256m -Xmx384m` với `limits.memory: 512M` có nguy cơ bị OOMKill (RSS của JVM thường lớn hơn heap). Đề xuất `limits.memory: 640M` và đo `docker stats` sau khi chạy ổn định.

## 3. Sơ đồ cutover (đã hiệu chỉnh)

1. Kiểm tra C1–C4. Nếu C1 chưa thỏa, **dừng**.
2. Sao lưu: `cdc_partition_progress`, log Kafka (`docker cp`), trạng thái connector.
3. Tạm dừng connector: `PUT /connectors/<tên>/pause` cho `outbox-hr`, `outbox-acc`, `outbox-sales`. Cửa sổ tạm dừng tối đa 5 phút (tránh WAL phình).
4. `docker compose stop kafka` (**dừng, không xóa** container cũ, để quay lui bằng `docker start kafka`).
5. Khởi động `kafka-1`, `kafka-2`, `kafka-3` (volume mới, `KAFKA_LOG_DIRS` đúng). Chờ cả 3 healthy và `kafka-metadata-quorum describe --status` cho thấy đủ voter.
6. Cập nhật `KAFKA_BROKERS`/`BOOTSTRAP_SERVERS` cho search, content-worker, debezium, kafka-exporter; cập nhật `depends_on`.
7. Khởi động lại `debezium` với bootstrap mới.
8. Đặt lại tiến độ projector về -1 (`UPDATE cdc_partition_progress SET last_offset = -1`), không xóa bảng. **Không cần nữa (2026-11-24):** projector P0.6 tự phát hiện tiến độ vượt log-end và đọc lại.

**Bài học khi thi công (2026-11-24): dừng Debezium trước khi dừng broker cũ.** Khi broker cũ dừng, một broker mới nhận lại địa chỉ IP của nó; Debezium cũ nối lại theo IP đã lưu đệm và làm broker mới tự tạo `debezium_configs`, `debezium_offsets`, `debezium_statuses` theo mặc định (3 partition, `cleanup.policy=delete`), sai yêu cầu của Kafka Connect. Đã xử lý bằng cách dừng Debezium, xóa ba topic này (chưa có connector nào) và tạo lại Debezium.
9. `docker compose up -d --no-build connect-init`: đăng ký lại connector và resync cả ba phòng.
10. Gỡ tạm dừng connector và kiểm tra: lag về 0, số tài liệu từng node khớp chỉ mục trung tâm (so theo từng ID).
11. Chạy `kafka-failover-test.sh` (đã sửa theo mục 2.5), rồi `e2e-smoke.sh` 96/96.

**Quay lui (tối đa 15 phút):** `docker compose stop kafka-1 kafka-2 kafka-3`; `docker start kafka` (container cũ còn nguyên dữ liệu trong writable layer); cập nhật bootstrap về `kafka:9092`; khởi động lại debezium; đặt lại tiến độ về -1; `connect-init`. Thời gian quay lui thực tế là vài phút, không phải 10 giây.

## 4. Lỗ hổng cần sửa trước hoặc cùng P1

**4.1. Tiến độ projector không tự phục hồi khi topic bị tạo lại.** Upsert dùng `GREATEST(last_offset, mới)`, nên giá trị đã lưu chỉ tăng. Khi offset đã lưu lớn hơn log-end, projector seek tới offset không tồn tại, bị "out of range", reset, và tiến độ không bao giờ hội tụ. Đề xuất sửa: trước khi seek, so `last_offset + 1` với high watermark của partition (qua admin client); nếu vượt thì seek về 0 và đặt tiến độ về -1. Việc này làm cho bước 8 của cutover không còn cần thiết thủ công. **Đã làm (P0.6, commit `c4ff399`); kiểm bằng `projector-epoch-test.sh` 18/18.**

**4.2. Resync không được phụ thuộc MinIO.** Sự kiện đồng bộ chỉ mục cần metadata (đã có trong CSDL node), không cần đọc tệp. Đề xuất: không đọc MinIO khi phát sự kiện resync; nội dung tệp được lập chỉ mục bởi content-worker theo phiên bản. **Đã làm, kiểm chứng 2026-11-19 (xem mục 2.4).**

**4.3. Đăng ký SALES thiếu trong `connect-init`.** Đã sửa trong lượt này (xem commit tiếp theo): thêm `SALES` vào `CONNECTORS`, mật khẩu replication riêng theo phòng (`REPL_PASSWORD_<MÃ>`). Trước đó thay đổi của SALES không đi tới CDC và slot giữ 10 MB WAL.

## 5. Quyết định cần bạn chọn

1. Đóng ứng dụng khác để giải phóng bộ nhớ (đến khi trống ≥ 2 GB), rồi báo tôi thi công.
2. Cửa sổ bảo trì ~10 phút, có thông báo cho người dùng.
3. Có làm mục 4.1 và 4.2 trước P1 không (khuyến nghị: có). **Đã làm cả hai** (xem 4.1 và 4.2); không còn cần quyết định.

Câu 1 và 2: người dùng chốt "B1 bản gọn" ngày 2026-11-24 thay cho việc chờ đủ bộ nhớ (mục 6).

## 6. Kết quả thi công B1 bản gọn (2026-11-24)

| Hạng mục | Kết quả |
|---|---|
| Cấu hình | 3 broker KRaft (broker + controller), heap 256 MB, giới hạn 512 MB; RF mặc định 3, `min.insync.replicas=2`; log trên volume; Debezium 1 worker, 3 topic trạng thái RF = 3 |
| Cutover | CDC dừng khoảng 5 phút. Trước và sau cutover digest node khớp chỉ mục trung tâm (HR 349, ACC 4, SALES 11, cùng mã băm); lag 0 trên 18 partition |
| Bước 8 (đặt tiến độ về -1) | Không cần: projector tự phát hiện tiến độ vượt log-end và đọc lại |
| `kafka-failover-test.sh` | 18/18. Mất 1 broker: `min.insync=3` bị từ chối `NOT_ENOUGH_REPLICAS`, `min.insync=2` vẫn ghi, CDC vẫn chạy. Mất 2 broker: không có ack (`NotEnoughReplicasException`). Hồi phục: quorum 3 voter, hết partition thiếu bản sao, connector RUNNING, CDC chạy lại |
| e2e | Lần 22: 100/0 |
| Phát hiện | Biến RF của Debezium phải có tiền tố `CONNECT_`; phải dừng Debezium trước khi dừng broker cũ (xem bước 8); công cụ Kafka không chạy bằng exec trong broker vì giới hạn bộ nhớ |
| Còn lại | Worker Debezium thứ hai; dọn broker cũ và volume `dms-kafka-data` khi người dùng chốt |

**Quay lui** (vẫn còn hiệu lực vì broker cũ chỉ dừng): tạm dừng connector; dừng `kafka-1..3`; trả `docker-compose.yml` về bản trước B1 hoặc bật profile `kafka-legacy`; `docker start kafka`; tạo lại debezium, search, content-worker, kafka-exporter; chạy `connect-init`.
