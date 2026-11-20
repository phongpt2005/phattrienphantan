# 11. P1: Cụm Kafka 3 broker KRaft (Hướng A, cutover có kiểm soát)

Trạng thái: **đã chuẩn bị, CHƯA thi công**. Tài liệu này hiệu chỉnh đặc tả P1 sau khi kiểm chứng trên hệ thống thật. Mỗi điểm lệch so với đặc tả đều có bằng chứng.

## 1. Điều kiện trước khi cutover (chưa thỏa)

| # | Điều kiện | Trạng thái | Bằng chứng |
|---|---|---|---|
| C1 | RAM trống của Windows đủ cho 3 broker | **Chưa thỏa** (đo 2026-11-20, ba lần cách nhau 15 giây): 1,52 / 1,80 / 1,45 GB trên 15,63 GB; cần ≥ 2 GB ổn định | `Win32_OperatingSystem`; khi bận, broker đã bị `REQUEST_TIMED_OUT` và bầu lại leader |
| C2 | Có cửa sổ bảo trì được thông báo | Chờ quyết định | Ước tính dừng CDC và chỉ mục khoảng **10 phút**, không phải 15–30 giây như đặc tả |
| C3 | Sao lưu log Kafka hiện tại ra ngoài container | **Đã đạt** (commit `35909b1`) | `backup-kafka-logs.sh` ghi vào OneDrive\dms_backups, mã hóa AES-256. `kafka-logs-restore-test.sh` trên bản `kafka_20261120_221415`: 543/543 tệp khớp SHA-256 và kích thước; segment `__cluster_metadata-0` đọc được 73.980 bản ghi |
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
8. Đặt lại tiến độ projector về -1 (`UPDATE cdc_partition_progress SET last_offset = -1`), không xóa bảng.
9. `docker compose up -d --no-build connect-init`: đăng ký lại connector và resync cả ba phòng.
10. Gỡ tạm dừng connector và kiểm tra: lag về 0, số tài liệu từng node khớp chỉ mục trung tâm (so theo từng ID).
11. Chạy `kafka-failover-test.sh` (đã sửa theo mục 2.5), rồi `e2e-smoke.sh` 96/96.

**Quay lui (tối đa 15 phút):** `docker compose stop kafka-1 kafka-2 kafka-3`; `docker start kafka` (container cũ còn nguyên dữ liệu trong writable layer); cập nhật bootstrap về `kafka:9092`; khởi động lại debezium; đặt lại tiến độ về -1; `connect-init`. Thời gian quay lui thực tế là vài phút, không phải 10 giây.

## 4. Lỗ hổng cần sửa trước hoặc cùng P1

**4.1. Tiến độ projector không tự phục hồi khi topic bị tạo lại.** Upsert dùng `GREATEST(last_offset, mới)`, nên giá trị đã lưu chỉ tăng. Khi offset đã lưu lớn hơn log-end, projector seek tới offset không tồn tại, bị "out of range", reset, và tiến độ không bao giờ hội tụ. Đề xuất sửa: trước khi seek, so `last_offset + 1` với high watermark của partition (qua admin client); nếu vượt thì seek về 0 và đặt tiến độ về -1. Việc này làm cho bước 8 của cutover không còn cần thiết thủ công. **Đã làm (P0.6, commit `c4ff399`); kiểm bằng `projector-epoch-test.sh` 18/18.**

**4.2. Resync không được phụ thuộc MinIO.** Sự kiện đồng bộ chỉ mục cần metadata (đã có trong CSDL node), không cần đọc tệp. Đề xuất: không đọc MinIO khi phát sự kiện resync; nội dung tệp được lập chỉ mục bởi content-worker theo phiên bản. **Đã làm, kiểm chứng 2026-11-19 (xem mục 2.4).**

**4.3. Đăng ký SALES thiếu trong `connect-init`.** Đã sửa trong lượt này (xem commit tiếp theo): thêm `SALES` vào `CONNECTORS`, mật khẩu replication riêng theo phòng (`REPL_PASSWORD_<MÃ>`). Trước đó thay đổi của SALES không đi tới CDC và slot giữ 10 MB WAL.

## 5. Quyết định cần bạn chọn

1. Đóng ứng dụng khác để giải phóng RAM Windows (đến khi trống ≥ 2 GB), rồi báo tôi thi công.
2. Cửa sổ bảo trì ~10 phút, có thông báo cho người dùng.
3. Có làm mục 4.1 và 4.2 trước P1 không (khuyến nghị: có). **Đã làm cả hai** (xem 4.1 và 4.2); không còn cần quyết định.
