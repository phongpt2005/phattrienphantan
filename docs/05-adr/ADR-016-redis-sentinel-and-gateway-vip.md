# ADR-016: Redis có bản sao và Sentinel; gateway có địa chỉ ảo (Keepalived)

**Trạng thái:** Accepted (2026-11-27, P3, chỉ bổ sung thành phần)

## Bối cảnh

Sau P1 và P2, hai thành phần trên đường xử lý chính còn chạy một bản:

- Redis giữ khóa thu hồi token (`tv:<phòng>:<userId>`, ADR-013), cache tìm kiếm và kênh thông báo giữa các bản Search Gateway (`dms:notices`). Redis sập thì thu hồi token chuyển sang fail-open (đúng thiết kế, nhưng token đã thu hồi lại dùng được), cache trượt và thông báo chỉ đi trong từng bản.
- nginx là cổng vào duy nhất của các dịch vụ bên trong mạng.

Người dùng chốt phạm vi P3: "không muốn xóa các cái cũ ... không muốn thay đổi mô hình, chỉ muốn thêm các thành phần cho đầy đủ". Vì vậy không làm dọn outbox/audit theo thời gian và không chia partition, chỉ thêm Redis Sentinel và Keepalived.

## Quyết định

### Redis

- Thêm `redis-2` làm bản sao và ba Sentinel (`redis-sentinel-1..3`, quorum 2, `down-after-milliseconds 5000`, `failover-timeout 20000`). Bản `redis` cũ giữ nguyên volume và dữ liệu.
- Nhóm Redis dùng IP cố định trong mạng (`172.28.250.11`, `.12` cho Redis; `.21` đến `.23` cho Sentinel). Sentinel ghi và theo dõi bản chính bằng IP, không bằng tên.
- Script khởi động (`infrastructure/redis/start-redis.sh`) hỏi Sentinel bản chính hiện tại trước khi chạy: bản chính cũ bật lại thì tự vào làm bản sao, không thành hai bản chính.
- Không bật `appendonly`: một bản bật lại với tệp AOF rỗng có thể được chọn làm bản chính và xóa dữ liệu của bản kia.
- Mọi client Redis (thu hồi token ở node và gateway, cache, thông báo) dùng chung `redisConnectionOptions()` (`packages/common/src/config/redis.ts`): có `REDIS_SENTINELS` thì nối qua Sentinel, không có thì nối thẳng như trước.
- Không bật `failoverDetector` của ioredis, và mọi client có lớp giữ sống `keepRedisAlive()` (lý do ở mục lỗi 2).

### Gateway

- Thêm `nginx-2` (cùng cấu hình, không mở cổng ra ngoài máy) và hai bộ cân bằng `keepalived-1`, `keepalived-2`. Mỗi bộ chạy HAProxy (tới `nginx` và `nginx-2`, kiểm `/health`) và Keepalived (VRRP unicast, ưu tiên 150 và 100). Bộ nào khỏe và ưu tiên cao hơn giữ địa chỉ ảo `172.28.255.10`.
- Keepalived nằm trong chính container có HAProxy, không làm sidecar dùng chung mạng với nginx (lỗi 3).
- Cổng 8000 ra ngoài máy giữ nguyên trên `nginx`. Địa chỉ ảo phục vụ lưu lượng bên trong mạng và là cách bố trí sẵn cho nhiều máy (`docs/13`).

## Lỗi tìm ra khi kiểm, là lý do của các quyết định trên

1. **Sentinel chuyển bản chính mất 154 đến 284 giây.** Khi dùng tên container, bản chính bị kill thì tên không còn trong DNS. Sentinel phân giải tên đồng bộ trên vòng lặp chính; mỗi lần hỏi tên chờ hết thời gian, cả Sentinel bị chậm theo. Sửa: IP cố định và cấu hình theo IP. Sau khi sửa: 18 giây.
2. **Một bản Search Gateway mất Redis vĩnh viễn sau lần chuyển bản chính đầu tiên.** e2e báo "Ban Giám đốc không nhận đủ cảnh báo node"; chỉ còn 1 bản nghe `dms:notices`. Các ca thu hồi token vẫn đạt vì client của bản còn lại đọc được. Gốc: `failoverDetector` của ioredis 5.11 nhận tin Sentinel báo đổi bản chính đúng lúc client đang kết nối, gọi `disconnect()`; `Redis.connect()` bị từ chối và client chuyển sang trạng thái `end`, ioredis không thử lại nữa. Sửa: bỏ `failoverDetector` (client vẫn theo bản chính mới: mất kết nối thì hỏi lại Sentinel; nối nhầm bản chính cũ đã bị hạ thì lệnh ghi bị `READONLY` và client nối lại), và thêm `keepRedisAlive()`: client rơi vào `end` mà không do dịch vụ tắt thì nối lại sau 2 giây. Bài kiểm Sentinel thêm phép kiểm mọi bản Search Gateway nghe lại kênh thông báo sau mỗi lần chuyển.
3. **Keepalived dạng sidecar không sống lại.** Container dùng `network_mode: service:nginx` mất mạng khi nginx được tạo lại và Docker không tự khởi động lại nó. Sửa: bộ cân bằng là container riêng có HAProxy và Keepalived; nó tự thoát (để restart policy khởi động lại) khi HAProxy chết hoặc IP của bộ kia đổi.
4. **Bộ cân bằng kẹt vòng khởi động lại.** Script khởi động thoát ngay sau khi dừng keepalived (HAProxy chết, hoặc bộ kia đổi địa chỉ khi được tạo lại), keepalived chưa kịp xóa tệp pid. Restart policy bật lại container trên cùng hệ thống tệp; pid cũ trùng một tiến trình mới nên keepalived báo "daemon is already running" và thoát, lặp mãi. Sửa: xóa tệp pid cũ khi khởi động, chờ keepalived dừng hẳn rồi mới thoát; `keepalived-test.sh` thêm ca HAProxy chết.

## Kết quả kiểm

| Bài kiểm | Kết quả |
|---|---|
| `redis-sentinel-test.sh` 22/22 | Bản chính bị kill: chuyển sau 9 đến 18 giây (các lượt); dữ liệu ghi trước đó còn; thu hồi token ghi và đọc trên bản chính mới; cả hai bản Search Gateway nghe lại kênh thông báo; bản chính cũ vào làm bản sao; chuyển ngược có kế hoạch |
| `keepalived-test.sh` 19/19 | Một gateway sập: khoảng ngắt dài nhất 2 đến 9 giây (HAProxy kiểm sức khỏe rồi mới bỏ bản sập). Bộ cân bằng giữ địa chỉ sập: địa chỉ chuyển sau 4 đến 6 giây, khoảng ngắt 4 đến 5 giây |
| `chaos/scenarios/redis-down.yaml` 10/10 | Cả hai bản Redis dừng: đăng nhập và tìm kiếm vẫn chạy (fail-open), bình thường lại khi bật lại |

## Đã cân nhắc

- Redis Cluster: chia khóa theo slot, phải đổi client và cách dùng `SCAN`; vượt phạm vi "chỉ thêm thành phần".
- Giữ `failoverDetector` và chỉ thêm lớp giữ sống: vẫn có một khoảng client ở `end` cho tới lần nối lại; bỏ hẳn thì lỗi không còn chỗ xảy ra.
- Keepalived trực tiếp trên nginx bằng `network_mode`: lỗi 3.
- Địa chỉ ảo cho cổng ra ngoài máy: với một máy, cổng của Docker đã gắn vào một container; địa chỉ ảo thật chỉ có ý nghĩa khi có từ hai máy.
