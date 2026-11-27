# ADR-015: CSDL phòng ban trên Patroni, slot Debezium đi theo máy chính

**Trạng thái:** Accepted (2026-11-26, P2 N2)

## Bối cảnh

CSDL phòng HR có một máy chính và một bản sao bất đồng bộ; máy chính chết thì phòng không ghi được và phải chuyển tay. Debezium đọc sự kiện outbox qua slot logic `dbz_hr_outbox`, và slot chỉ có trên máy chính. Nếu chuyển sang bản sao mà không có slot, CDC dừng; nếu tạo slot mới, các sự kiện giữa hai lần bị bỏ qua.

Debezium 2.7 hỗ trợ chính thức PostgreSQL 12 đến 16. Tính năng đồng bộ slot của PostgreSQL 17 (`sync_replication_slots`) cần Debezium 3.x.

## Quyết định

- Giữ PostgreSQL 16. Lên 17 là gói riêng, đi cùng Debezium 3.x.
- Patroni 2 node (`hr-pg-1`, `hr-pg-2`) dùng chung cụm etcd 3 nút với CSDL trung tâm (khác `scope`), ghi đồng bộ không chặn, `failsafe_mode`.
- Hai bản HAProxy cùng tên `hr-db`: cổng 5432 tới máy chính (ghi và Debezium), cổng 5433 tới bản sao (đọc khi máy chính lỗi).
- `dbz_hr_outbox` là slot logic cố định của Patroni: Patroni chép slot sang bản sao và đẩy vị trí theo máy chính.
- Chuyển dữ liệu bằng cách chép nguyên thư mục dữ liệu cho Patroni nhận lại: cùng system id, cùng vị trí WAL, giữ slot. Debezium đọc tiếp đúng offset, không chụp lại.
- Bộ canh slot (`infrastructure/patroni/slot-guard.py`) chạy trong mỗi node Patroni. Trên bản sao, nó kiểm bản chép slot còn đủ WAL không; nếu không, và slot trên máy chính đã đi tới đoạn WAL bản sao có, nó bỏ bản chép để Patroni chép lại; nếu chưa sửa được thì báo `UNSAFE`.
- Connector chạy `heartbeat.action.query` ghi vào bảng `debezium_heartbeat` (nằm trong publication, không nằm trong `table.include.list`), để vị trí slot đi theo WAL cả khi phòng không tạo tài liệu.
- Chuyển máy chính có kế hoạch (`patroni-roll.sh`) chỉ chạy khi bộ canh báo bản chép slot dùng được.

## Lỗi tìm ra khi kiểm, là lý do của hai quyết định cuối

1. Bản sao được dựng lúc Debezium đang dừng: bản chép slot trỏ vào đoạn WAL mà bản sao không bao giờ có. Patroni không đẩy vị trí được nhưng vẫn báo slot "safe to be used after a failover". Chuyển máy chính xong, Debezium kẹt: lượt 1 của `hr-failover-test.sh` thiếu 11/16 tài liệu ở chỉ mục trung tâm. Phục hồi bằng cách tạo lại slot và resync phòng (407/407).
2. Debezium chỉ xác nhận vị trí khi có giao dịch thuộc publication. Phòng không có hoạt động thì slot đứng yên (đo: còn 37 kB chưa xác nhận sau 25 giây; sau khi thêm nhịp tim, còn dưới 1 kB), nên lỗi 1 có thể xảy ra bất cứ khi nào bản sao được dựng lại vào lúc vắng.

## Đã cân nhắc

- Lên PostgreSQL 17 và Debezium 3.x ngay: đổi hai thành phần lõi của CDC cùng lúc, phải kiểm lại toàn bộ.
- Tạo slot mới sau mỗi lần chuyển rồi resync: luôn có một khoảng sự kiện bị bỏ qua, phải phát lại cả phòng.
- `pg_dump` sang cụm mới: đổi vị trí WAL, offset của Debezium thành vô nghĩa, phải chụp lại.

## Hệ quả

- Phòng HR tự chuyển máy chính; số đo ở `docs/12`, giai đoạn N.
- Bộ canh slot và nhịp tim là phần phải có, không phải tùy chọn, khi dùng slot logic cố định trên PostgreSQL 16.
- Thêm bảng `debezium_heartbeat` và quyền ghi cho người dùng của connector trên mọi CSDL phòng.
- Lần chuyển dữ liệu, HR không ghi được 218 giây (chủ yếu do chép 257 MB WAL).
