# ADR-012: Phòng ban tự trị khi đứt mạng và tự hội tụ khi phục hồi

**Trạng thái:** Accepted (đã triển khai và đo bằng runbook `infrastructure/scripts/partition-test.sh`: 17/17)
**Liên quan:** ADR-002 (outbox), ADR-004 (Registry), ADR-010 (chỉ mục trung tâm tùy chọn), ADR-011 (sổ chia sẻ tại node chủ)

## Bối cảnh

Feature 2 yêu cầu: khi một phòng bị cắt khỏi mạng chung, nhân viên vẫn làm việc được ở node cục bộ; khi nối lại, mọi thay đổi phải hội tụ về trung tâm không mất dữ liệu, không ghi đè bằng sự kiện cũ, và Registry phải tự đưa node về `ACTIVE` mà không cần khởi động lại Gateway.

Lần chạy runbook đầu cho thấy hai lỗi thiết kế:
1. Node đăng ký lại Registry rất chậm (khoảng 90 giây). Nguyên nhân: mỗi lần heartbeat lỗi lại gọi `registerLoop()` mà không dừng vòng cũ, nên nhiều vòng đăng ký và nhiều heartbeat timer chạy song song; backoff lên tới 15 giây.
2. Đường dẫn tạm `mktemp` của shell không đọc được bằng Python và curl trên môi trường phát triển, làm `docId` rỗng và bước chia sẻ lỗi giả.

## Quyết định

1. **Cô lập đúng đường lên, giữ đường nội bộ.** Phòng HR có mạng riêng `dms-site-hr` (172.29.10.0/24) chứa `dept-hr`, `postgres-hr-primary`, `minio-hr`. Chỉ `dept-hr` và `postgres-hr-primary` có thêm mạng `dms-network`. Cắt `dms-network` tương đương đứt đường lên mà không mất CSDL cục bộ.
2. **Cổng nội bộ `hr-site-edge`** (nginx) nằm trên `dms-site-hr`, publish `localhost:<cổng HR edge>`. Nhân viên làm việc qua cổng này, nên vẫn truy cập được khi đứt mạng chung.
3. **Tự trị = ghi cục bộ + outbox trong cùng transaction.** Mọi thay đổi nghiệp vụ và dòng `outbox` được ghi trong một transaction. Debezium Outbox Router đẩy về Kafka khi nối lại. Không dùng cột trạng thái `PENDING`: đo backlog bằng WAL của slot `dbz_hr_outbox` (`pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)`) là đủ.
4. **Trạng thái đồng bộ tại node.** `GET /sync/status` trả `mode ONLINE|OFFLINE` dựa trên việc probe Registry (timeout 2 giây) và thời điểm liên lạc cuối (ngưỡng 30 giây). Giao diện `GET /console` hiển thị huy hiệu `CHẾ ĐỘ TỰ TRỊ (OFFLINE) - DỮ LIỆU ĐANG LƯU NỘI BỘ`.
5. **Registry: một vòng đăng ký, một heartbeat timer, backoff tối đa 5 giây.** Vòng đăng ký có cờ `registering` (single-flight); mỗi lần bật heartbeat đều thay timer cũ.
6. **Hội tụ theo thứ tự phiên bản.** Projector so sánh `source_version` (row_version của node). Sự kiện cũ đến muộn bị bỏ qua, không ghi đè.
7. **Watchdog cho Kafka Connect.** Container `connector-watchdog` định kỳ liệt kê connector và restart task `FAILED` (`restart?includeTasks=true&onlyFailed=true`).

## Phương án đã cân nhắc

- **Cột `PENDING` trong bảng nghiệp vụ** (theo DoD ban đầu): bị loại vì trùng với outbox, thêm trạng thái phải đồng bộ hai nơi. Backlog WAL đo được trực tiếp và không cần thêm cột.
- **Chỉ tắt tiến trình** thay vì cắt mạng: bị loại. Không mô phỏng đúng đứt mạng, vì DB và MinIO vẫn truy cập được.
- **Cắt `dms-network` của dept-hr một mình:** bị loại. Làm mất kết nối tới CSDL cục bộ và MinIO (đã gặp thực tế: mất DB, task Debezium FAILED khi khởi động lại). Đó là lý do có mạng `dms-site-hr`.

## Kết quả đo (runbook 17/17)

| Chỉ số | Giá trị |
|---|---|
| Backlog WAL lúc đứt mạng | 214 048 byte, 4 sự kiện outbox (3 tài liệu + 1 chia sẻ) |
| Phát hiện DEGRADED | 30 giây (đúng ngưỡng mất nhịp tim) |
| HR về ACTIVE sau T0 | 8 giây |
| T_convergence (T0 → trung tâm thấy đủ dữ liệu) | 12 giây |
| Tài liệu hội tụ | 3/3 |
| Sổ chia sẻ hội tụ | 1/1 |
| Sự kiện cũ (rowVersion thấp hơn) | bị bỏ qua; `source_version` giữ nguyên |

Lần chạy trước (trước khi sửa `registry-client`): HR về ACTIVE sau 90 giây.

## Hệ quả

- Đánh đổi: khi đứt mạng, phòng không duyệt được yêu cầu xin quyền mới (duyệt cần trung tâm); bản sao chia sẻ ở trung tâm chỉ nhất quán cuối cùng.
- Tên bảng thật là `outbox`, không phải `transactional_outbox` như DoD ghi. Giữ tên `outbox` để không đổi schema đang chạy.
- Số liệu phụ thuộc vào môi trường chạy Docker và tải của hệ thống; cần đo lại khi đổi môi trường.
- Cần thêm cảnh báo CSDL cục bộ lỗi (phần watchdog) nếu thử nghiệm mất DB chứng minh task `FAILED` không tự phục hồi.
