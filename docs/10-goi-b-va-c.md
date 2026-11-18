# 10. Gói B và Gói C: review kế hoạch và lộ trình đã hiệu chỉnh

Trạng thái: **Gói P0 đã xong** (xem `docs/07` mục 2k). Gói B và C vẫn là kế hoạch, chưa triển khai. Ngày review: 2026-11-19.

Tài liệu này làm ba việc:
1. Đối chiếu kế hoạch B/C (8 lỗ hổng, Q1–Q7) với **mã nguồn và số đo thật**, nói rõ chỗ đúng, chỗ sai, chỗ cần chỉnh.
2. Bổ sung các lỗ hổng mà kế hoạch chưa nhắc, trong đó có những lỗ hổng quan trọng hơn các mục đã nêu.
3. Đưa ra lộ trình đã hiệu chỉnh và **ma trận sự cố → phương án xử lý** để mỗi loại sự cố đều có câu trả lời.

---

## 0. Một giới hạn phải nói thẳng

Toàn bộ hệ thống chạy trên **một máy**. Dù thêm bao nhiêu bản sao, nếu máy, ổ đĩa hay Docker Desktop hỏng thì mọi thứ dừng cùng lúc (đã gặp thực tế ngày 2026-11-18: Docker Desktop tắt giữa lúc chạy e2e). Vì vậy:

- Trên máy này, Gói B **chứng minh cơ chế** (bầu lại leader, tự chuyển primary, không mất sự kiện), không phải chứng minh chịu lỗi phần cứng.
- Chống mất dữ liệu thật khi hỏng máy chỉ có một cách: **sao lưu ra ngoài máy** (mục N1 bên dưới). Bản sao (replica) không thay được sao lưu, vì lệnh xóa nhầm cũng được nhân bản.

---

## 1. Số đo thật trước khi quyết định (Q1)

Đo bằng `docker stats --no-stream` và `docker info` lúc 2026-11-19, stack đầy đủ đang chạy:

| Chỉ số | Giá trị |
|---|---|
| RAM của máy ảo Docker (WSL) | **9,71 GiB** (không phải 16 GB; đây là giới hạn thật cho container) |
| RAM Windows còn trống | **0,6 GB** (máy đang chịu áp lực bộ nhớ) |
| Toàn bộ container DMS | khoảng 2,5 GiB |
| `kafka` (1 broker, heap mặc định 1 GB) | 673 MiB |
| `debezium` | 553 MiB |
| `k8s-lab-control-plane` (không thuộc DMS, cụm kind của bạn) | 821 MiB |
| `enterprise_*` (dự án khác) | khoảng 56 MiB |

Hệ quả: Kafka 3 broker với heap 384 MB mỗi broker ước tính 450–550 MiB RSS mỗi broker (heap cộng bộ nhớ ngoài heap), tức **1,4–1,6 GiB**, không phải 1,1 GiB như kế hoạch ghi. Vẫn vừa trong 9,71 GiB của Docker, nhưng Windows chỉ còn 0,6 GB trống nên máy có thể bắt đầu dùng bộ nhớ ảo và chậm. **Đề xuất:** tắt `k8s-lab` khi demo (giải phóng 821 MiB) nếu bạn không dùng nó lúc đó. Đây là quyết định của bạn vì cụm đó là của bạn.

---

## 2. Đối chiếu 8 lỗ hổng trong kế hoạch với mã nguồn

| # | Lỗ hổng theo kế hoạch | Kết quả kiểm tra | Kết luận |
|---|---|---|---|
| 1 | Postgres chỉ failover đọc, ghi chết đứng | **Đúng**, nhưng kế hoạch chỉ xử lý CSDL **trung tâm**. `ResilientDatabaseService` (`packages/database/src/index.ts`) chuyển đọc sang replica khi primary chết; ghi thì không. Điều này áp dụng cho **CSDL node** (nguồn sự thật), là chỗ quan trọng hơn trung tâm. | Giữ, mở rộng sang CSDL node (xem N2) |
| 2 | Đọc ngay sau ghi bị 404 do replica trễ | **Không xảy ra với mã hiện tại.** `readClient` trả về primary khi primary còn sống (`packages/database/src/index.ts:54`); chỉ đọc từ replica khi primary đã chết, lúc đó cũng không ghi được. | Bỏ khỏi danh sách. Chỉ cần nếu sau này chủ động đọc từ replica để giảm tải |
| 3 | Kafka và Debezium là điểm chết | **Đúng.** 1 broker, `REPLICATION_FACTOR: 1` cho offsets và transaction log. Debezium cũng là 1 worker, và ba topic lưu trạng thái của nó (`debezium_configs`, `debezium_offsets`, `debezium_statuses`) có RF = 1. Kế hoạch chỉ nhắc Kafka, **chưa nhắc Debezium**. | Giữ, bổ sung Debezium (xem B1) |
| 4 | MinIO một bản, hỏng sector là mất file | **Đúng.** Nhưng bucket replication sang một container khác **trên cùng ổ đĩa** không chống được hỏng ổ. Nó chỉ chống được hỏng volume hoặc xóa nhầm (nếu bật versioning). | Đổi hướng: sao lưu ra ngoài máy + quét đối chiếu SHA-256 (xem N4) |
| 5 | Nginx là điểm chết L7 | **Đúng.** Với một máy, chấp nhận là hợp lý. Đã có đường thay thế cho HR qua `hr-site-edge` (:3001). | Đồng ý. Thêm healthcheck; Keepalived chỉ khi có ≥ 2 máy |
| 6 | Mở quá nhiều cổng | **Đúng một phần.** Không được đóng **tất cả** trừ 8000: cổng `3001` của `hr-site-edge` là chủ đích của tự trị khi đứt mạng (ADR-012). Grafana, Prometheus, Jaeger dùng cho demo nên bind `127.0.0.1` thay vì xóa. Các script kiểm thử dùng `docker exec psql` nên đóng cổng DB không ảnh hưởng; các script `.js` cũ cần kiểm tra lại. | Giữ, sửa phạm vi |
| 7 | Outbox phình do `deleteMany` | **Sai tên bảng và mức độ.** Bảng thật là `outbox` (không phải `transactional_outbox`); không có `audit_events`, bảng audit là `audit_log` ở node. Outbox đã được dọn theo hạn 168 giờ (`outbox.service.ts:149`). Ở quy mô hiện tại, autovacuum xử lý được; chưa có số đo `n_dead_tup` nào cho thấy vấn đề. Chia partition `outbox` còn đòi hỏi publication của Debezium `publish_via_partition_root`. Chia partition `audit_log` sẽ **phá chuỗi hash** khi xóa partition cũ, trừ khi có điểm neo (checkpoint hash). | Hạ ưu tiên: đo trước, làm sau |
| 8 | Hai trưởng phòng duyệt cùng lúc | **Đúng một phần, và có lỗi thật.** Câu `UPDATE ... WHERE status = 'PENDING'` đã là compare-and-set, không cần thêm cột `row_version`. Nhưng mã hiện tại **gọi node cấp quyền trước rồi mới cập nhật**, và **không kiểm tra số dòng bị ảnh hưởng** (`share.service.ts:242–246`). Hai người duyệt cùng lúc thì cả hai đều nhận "thành công" và cả hai thông báo đều được gửi; quyền ở node không bị nhân đôi nhờ upsert. | Sửa: giữ chỗ trước (`PENDING → APPROVING` có kiểm số dòng), gọi node, rồi `APPROVED`; lỗi thì trả về `PENDING` |

---

## 3. Đối chiếu Q1–Q7

| Câu | Kế hoạch | Review | Quyết định đề xuất |
|---|---|---|---|
| Q1 | Kafka 3 broker, ép heap 256–384 MB, tổng ~1,1 GB | Đồng ý hướng. Hai chỉnh sửa: (a) dùng biến `KAFKA_HEAP_OPTS` cho `-Xms/-Xmx`; `KAFKA_JVM_PERFORMANCE_OPTS` dành cho cờ GC; (b) ước tính đúng là 1,4–1,6 GiB, phải đo sau khi chạy | Làm, kèm Debezium 2 worker và RF = 3 cho ba topic trạng thái |
| Q2 | Patroni, 2 node + 1 etcd | Đồng ý Patroni. Ba điểm bắt buộc kế hoạch chưa có: (a) **một etcd là điểm chết của bầu cử**: mặc định, khi mất etcd Patroni sẽ hạ primary xuống chỉ đọc; phải bật `failsafe_mode: true` (Patroni ≥ 3.0); (b) cần **HAProxy** kiểm tra `GET /primary` của Patroni để ứng dụng luôn kết nối đúng primary, nếu không thì Gateway vẫn gọi tên container cũ và không "tự kết nối lại"; (c) chưa có image Patroni chính thức, phải build image riêng | Làm, thêm (a)(b)(c) |
| Q2 DoD | Chuyển primary ≤ 10 giây | Mặc định Patroni `ttl=30`, `loop_wait=10`, thực tế khoảng 30 giây. Giảm `ttl` để đạt 10 giây làm tăng nguy cơ chuyển nhầm khi máy chậm (máy này đang thiếu RAM) | DoD ≤ 30 giây; đo thật rồi mới hạ |
| Q3 | Bất đồng bộ, "Feature 3 tự động resync trong 5 giây" | Đồng ý bất đồng bộ, nhưng **lý do đúng khác với lý do trong kế hoạch**. `rebuild-central-index.sh` là script chạy tay, không tự động. Lý do thật mạnh hơn: Projector lưu offset Kafka **cùng transaction** với dữ liệu (`cdc_partition_progress`) và khi khởi động thì seek theo offset trong DB (`projector.service.ts:111–142`). Nếu failover làm mất vài transaction cuối, offset trong DB cũng lùi theo, Projector tự đọc lại các sự kiện đó từ Kafka; `source_version` chặn ghi đè. **Không mất gì, không cần thao tác tay**, miễn là Kafka còn giữ sự kiện (168 giờ). Quá 168 giờ thì mới cần Feature 3 | Bất đồng bộ. Ghi đúng lý do vào ADR |
| Q4 | Redis HA tùy chọn | Đồng ý về tính khả dụng. Nhưng cần nói rõ: khi Redis chết, **thu hồi token ở gateway mất hiệu lực** (fail-open, ADR-013). Đây là rủi ro bảo mật | Tùy chọn; nếu không làm thì thêm cảnh báo Prometheus khi Redis chết |
| Q5 | stop → disconnect → pause | Đồng ý | Giữ |
| Q6 | Controller chạy trên host, không mount docker.sock | Đồng ý. Hai lỗi kỹ thuật: (a) content-worker **không** đọc topic `dms.content.extract`; nó đọc `dms.dept.<mã>.document` (group `content-indexer`); (b) Prometheus **chưa có** metric `kafka_consumergroup_lag`; phải thêm `kafka-exporter` (khoảng 20 MB). Ngoài ra, số worker hữu ích tối đa bằng tổng số partition | Làm, thêm kafka-exporter, sửa tên topic |
| Q7 | Chaos phần đã có trước, chờ B1/B2 cho hạ tầng | Đồng ý | Giữ |

---

## 4. Lỗ hổng kế hoạch chưa nhắc (xếp theo mức nghiêm trọng)

### N1. Không có sao lưu nào (nghiêm trọng nhất)
Không có `pg_dump`, `pgBackRest` hay `wal-g` ở đâu trong repo. Replica và Patroni **không** cứu được: xóa nhầm, mã lỗi ghi hỏng dữ liệu, ransomware, hỏng ổ đĩa của máy. Đề xuất:
- Sao lưu định kỳ CSDL node (nguồn sự thật) và MinIO ra **ngoài máy** (ổ ngoài hoặc dịch vụ lưu trữ). CSDL trung tâm không cần ưu tiên vì dựng lại được từ node.
- WAL archiving để khôi phục theo thời điểm (PITR) cho CSDL node.
- **Diễn tập khôi phục** bằng script, đo RTO thật. Sao lưu chưa từng khôi phục thử thì coi như chưa có.

### N2. CSDL node (nguồn sự thật) không tự chuyển primary
Kế hoạch B2 chỉ làm cho trung tâm, là thành phần **dựng lại được**. CSDL node mới là nơi mất là mất thật. Ngoài ra có một bẫy kỹ thuật: slot logical replication của Debezium (`dbz_<mã>_outbox`) **chỉ nằm ở primary**; PostgreSQL 16 không sao slot sang replica. Sau khi chuyển primary, slot mất và các sự kiện chưa gửi bị mất theo.

Phương án phục hồi đã có sẵn trong hệ thống: sau failover, tạo lại slot và gọi `POST /internal/resync` (Feature 3) để phát lại toàn bộ tài liệu; Projector bỏ qua bản cũ nhờ `source_version`. Phương án tốt hơn về lâu dài: nâng lên PostgreSQL 17 và dùng **failover slot** (`failover = true`, `sync_replication_slots = on`).

Đề xuất thứ tự: làm Patroni cho **trung tâm trước** (rủi ro thấp, để học cách vận hành), rồi áp dụng cho **HR** kèm bước tạo lại slot và resync tự động.

### N3. Không có cơ chế tự phát hiện và tự sửa lệch dữ liệu (anti-entropy)
Hiện tại muốn biết trung tâm có lệch với node không, phải chạy tay. Đề xuất một tiến trình đối soát định kỳ: so số tài liệu và tổng `row_version` từng phòng giữa node và trung tâm; lệch quá ngưỡng thì gọi `/internal/resync` cho phòng đó và ghi sự kiện vào trang giám sát. Đây là thứ biến "có script sửa" thành "tự sửa".

### N4. Hỏng tệp âm thầm trong MinIO
Mỗi tài liệu đã có SHA-256. Đề xuất một tác vụ quét định kỳ: đọc đối tượng, so hash, báo những tệp hỏng hoặc thiếu. Kết hợp với sao lưu ở N1 để khôi phục tệp hỏng.

### N5. Lỗi duyệt đồng thời (mục 8 ở trên)
Đây là lỗi thật trong mã, không phải giả thuyết. Sửa nhỏ, nên làm ngay.

### N6. Ghi lặp khi client thử lại trong lúc failover
Khi primary đang chuyển, client có thể bị timeout dù lệnh tạo tài liệu đã thành công, rồi thử lại và tạo bản trùng. Đề xuất `Idempotency-Key` cho `POST /documents` (lưu khóa trong bảng node, trả lại kết quả cũ khi trùng khóa).

### N7. Không có metric độ trễ Kafka
Không có `kafka-exporter`, nên không có cảnh báo khi Projector hay content-worker tụt lại, và không làm được C2. Rẻ, nên làm sớm.

### N8. Bí mật đã nằm trong lịch sử git
`.env` đã được commit (commit `94b2dc6`). Repo hiện chỉ ở máy này. Nếu sau này đẩy lên remote thì phải đổi toàn bộ mật khẩu, `JWT_SECRET` và `INTERNAL_SERVICE_TOKEN` trước.

---

## 5. Lộ trình đã hiệu chỉnh

Nguyên tắc sắp xếp: rẻ và giá trị cao làm trước; thứ gì phá được dữ liệu thật phải có sao lưu trước khi làm.

| Ưu tiên | Hạng mục | Lý do thứ tự |
|---|---|---|
| **P0** | N5 sửa lỗi duyệt đồng thời | Lỗi thật, sửa nhỏ |
| **P0** | N1 sao lưu CSDL node và MinIO + diễn tập khôi phục | Mọi thay đổi hạ tầng sau đó đều cần đường lùi |
| **P0** | N7 kafka-exporter + cảnh báo độ trễ | Rẻ; là điều kiện của C2 và của việc đo B1 |
| **P0** | Mục 6: đóng cổng (giữ 8000, 3001; bind 127.0.0.1 cho Grafana, Prometheus, Jaeger) | Rẻ, giảm bề mặt tấn công |
| **P1** | B1: Kafka 3 broker + Debezium 2 worker + RF = 3 cho topic trạng thái | Điểm chết lớn nhất của đường CDC |
| **P1** | B2: Patroni cho CSDL trung tâm (failsafe_mode, HAProxy) | Học vận hành Patroni trên phần dựng lại được |
| **P1** | N3: đối soát tự động | Biến Feature 3 thành tự sửa |
| **P2** | N2: Patroni cho CSDL HR + tạo lại slot + resync tự động | Rủi ro cao nhất, làm khi đã có P0 và B2 |
| **P2** | C1: khung chaos YAML (kịch bản đã có hạ tầng trước) | Dùng để chứng minh P0–P1 |
| **P2** | C2: autoscaler trên host theo lag | Cần N7 |
| **P3** | N4 quét SHA-256, N6 Idempotency-Key, B4 bản sao ACC/SALES, C3 bảng điểm | Giá trị tốt, không chặn việc khác |
| **P3** | Redis Sentinel, partition outbox/audit, Keepalived | Chỉ khi có số đo cho thấy cần, hoặc có ≥ 2 máy |

---

## 6. Ma trận sự cố → phương án

Cột "Hiện có" là đã kiểm chứng bằng kiểm thử. Cột "Sau lộ trình" là mục tiêu.

| Sự cố | Hiện có | Sau lộ trình |
|---|---|---|
| Một bản node phòng ban chết | HR: bản còn lại phục vụ (rolling test 0 lỗi 5xx). ACC/SALES: phòng đó dùng chỉ mục trung tâm, cờ `stale` | B4: cả ba phòng có 2 bản |
| CSDL node chết | Đọc chuyển sang replica; **ghi ngừng** tới khi promote tay | N2: Patroni tự chuyển, tạo lại slot, resync tự động |
| MinIO node chết | Tải file trả 503 có mã lỗi rõ; tìm kiếm vẫn chạy | N1 sao lưu, N4 quét |
| Phòng đứt mạng | Tự trị qua :3001, hội tụ 12 giây (ADR-012) | Giữ nguyên, đưa vào C1 |
| CSDL trung tâm chết | Tìm kiếm vẫn chạy qua node (ADR-010); chỉ mục ngừng cập nhật, tự bù khi trở lại | B2: tự chuyển primary ≤ 30 giây |
| Mất vài transaction cuối khi failover trung tâm | Projector đọc lại từ Kafka theo offset trong DB | Như cũ, đã đủ |
| Chỉ mục trung tâm hỏng hoặc bị xóa | `rebuild-central-index.sh` (tay, 5 giây) | N3: tự phát hiện và tự resync |
| Kafka broker chết | **Toàn bộ CDC dừng** | B1: 3 broker, bầu leader tự động |
| Debezium chết | Watchdog chỉ restart task, không thay tiến trình | B1: 2 worker, task tự chuyển |
| Task Debezium FAILED | Watchdog restart sau ~11 giây | Như cũ |
| Sự kiện độc (poison) | Vào DLQ sau 3 lần thử | Thêm công cụ phát lại DLQ (nhỏ, nên làm) |
| Redis chết | Cache miss, tìm kiếm vẫn chạy; thu hồi token mất hiệu lực ở gateway | Cảnh báo Prometheus; Sentinel nếu cần |
| Nginx chết | Mất cổng vào :8000; HR còn :3001 | Healthcheck + restart; Keepalived khi có ≥ 2 máy |
| Một bản search gateway chết | Bản còn lại phục vụ (D7) | Như cũ |
| content-worker tụt lại | Nhân bản tay | C2 tự co giãn |
| Xóa nhầm, ghi hỏng dữ liệu, ransomware | **Không có phương án** | N1: sao lưu ngoài máy + PITR |
| Hỏng ổ đĩa hoặc máy | **Không có phương án** | N1 khôi phục trên máy khác; HA thật cần ≥ 2 máy |
| Đổi schema khi rolling update | Quy tắc Expand/Contract (docs/07 mục 2i) | Như cũ |
| Lộ token / nhân sự bị đình chỉ | Thu hồi ngay ở gateway (ADR-013); đường nội bộ node còn hở tới 8 giờ | Cân nhắc kiểm Redis ở node |
| Lộ `.env` | Repo chỉ ở máy này | Đổi khóa trước khi đẩy remote |

---

## 7. Quyết định cần bạn chốt trước khi viết mã

1. Thứ tự P0 có đúng ý bạn không (đặc biệt: sao lưu trước Kafka 3 broker).
2. Sao lưu ra đâu: ổ ngoài, thư mục đồng bộ đám mây, hay dịch vụ S3. Phải là nơi ngoài máy này.
3. Có tắt `k8s-lab` khi chạy Gói B để giải phóng 821 MiB không.
4. Có chấp nhận nâng PostgreSQL 16 lên 17 cho CSDL node (để dùng failover slot) không, hay giữ 16 và dùng tạo lại slot + resync.
