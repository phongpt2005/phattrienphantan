# ADR-014: CSDL trung tâm dùng Patroni, ghi đồng bộ không chặn

**Trạng thái:** Accepted (2026-11-26, P1 B2)

## Bối cảnh

CSDL trung tâm có một máy chính và một bản sao; máy chính chết thì phải chuyển tay. ADR-010 đã làm cho tìm kiếm chạy được khi trung tâm sập, nhưng yêu cầu xin quyền, danh bạ và lịch sử thì không. Chỉ mục tìm kiếm dựng lại được từ các phòng; yêu cầu xin quyền, lịch sử tìm kiếm và sự kiện trạng thái phòng thì không, và không đi qua Kafka.

## Quyết định

- Patroni 2 node, một etcd, HAProxy chọn máy chính bằng `GET /primary`. Ứng dụng nối `central-db`.
- `synchronous_mode: true`, không strict: ghi chờ bản sao xác nhận; bản sao chết thì lùi về bất đồng bộ để không dừng ghi.
- `failsafe_mode: true`: mất etcd thì máy chính vẫn ghi khi các node còn thấy nhau.
- `ttl` 20 giây, `loop_wait` 5 giây, `retry_timeout` 5 giây: mục tiêu ghi lại được trong 30 giây.
- Phân giải tên trong node Patroni giới hạn 1 giây, 1 lần thử: khi etcd mất, tên của nó không còn; nếu việc hỏi tên chậm, vòng lặp Patroni vượt ttl và máy chính tự mất quyền dù đang bật `failsafe_mode`.

## Đã cân nhắc

- pg_auto_failover: ít thành phần hơn, nhưng bộ giám sát chết thì không tự chuyển, và vẫn cần proxy vì thư viện kết nối không nhận nhiều máy chủ.
- Chuyển tay bằng script: không chống ghi hai nơi.
- Bỏ B2, dựa vào ADR-010: duyệt quyền dừng khi trung tâm sập.

## Hệ quả

- Đo được: sập đột ngột 17–23 giây, treo 15–20 giây, không mất dòng đã xác nhận (nhiều lượt `central-failover-test.sh`).
- Mỗi lần ghi chờ thêm một lượt mạng tới bản sao.
- Ban đầu HAProxy và etcd mỗi thứ một bản. Từ 2026-11-26: etcd 3 nút (mất 1 nút vẫn còn quorum) và HAProxy 2 bản cùng tên DNS; mất quorum etcd thì không tự chuyển được nhưng vẫn ghi được (đo trong `central-failover-test.sh` ca 4, 4b, 5, 5b).
- Trên một môi trường: chứng minh cơ chế, không chống hỏng máy.
