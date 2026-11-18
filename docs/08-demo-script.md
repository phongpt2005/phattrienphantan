# 08. Kịch bản demo (Docker Compose, khoảng 26 phút)

Chuẩn bị: stack đang chạy (`docker compose up -d --no-build`), mở sẵn 3 tab:
giao diện `http://localhost:8000`, Grafana `http://localhost:3000` (admin / `GRAFANA_ADMIN_PASSWORD` trong `.env`, dashboard **DMS - Federated Search & CDC**), Prometheus `http://localhost:9090/alerts`.
Mọi bước dưới đây đã chạy thật; bộ kiểm thử `bash infrastructure/scripts/e2e-smoke.sh` tự động hóa phần lớn chúng (96 kiểm tra).

## D1. Dữ liệu phân đoạn theo phòng ban (R1) - 2 phút
1. Đăng nhập `hr_manager`, tạo một tài liệu. Đăng nhập `acc_manager` ở cửa sổ ẩn danh: không thấy tài liệu đó.
2. Cho xem lệnh: token của HR gọi thẳng node ACC bị chặn.
   `curl -H "Authorization: Bearer <token HR>" http://localhost:8000/api/dept/acc/documents` → **403**.
3. Cho xem hạ tầng: mỗi phòng ban có Postgres và MinIO riêng (`docker ps`).

## D2. Thêm phòng ban mới không sửa node cũ (R3) - 3 phút
1. `docker ps --format "{{.Names}} {{.CreatedAt}}"` (ghi lại thời điểm khởi động của các node hiện có).
2. `bash scripts/add-department.sh KHO "Phòng Kho vận"` (khoảng 35 giây).
3. Tải lại giao diện: **Phòng Kho vận** đã có trong màn đăng nhập (đọc từ Registry). Đăng nhập `kho_manager`.
4. Chạy lại bước 1: `dept-hr`, `dept-acc`, `search-engine-service`, `nginx` **không bị khởi động lại**.
5. Dashboard Grafana: số node tăng thêm 1 (Prometheus tự nạp target).
6. Gỡ: `bash scripts/remove-department.sh KHO --purge`.

## D3. Tìm kiếm hợp nhất và chịu lỗi (R2) - 3 phút
Chuẩn bị: đăng nhập `acc_manager`, tải lên một tài liệu có phạm vi **công khai** (ví dụ "Mau hop dong dich vu"), để phòng khác nhìn thấy được.
1. Đăng nhập `hr_manager`, tab *Tra Cứu*, gõ `hop dong` (không dấu): ra kết quả của nhiều phòng ban, mỗi phòng một màu.
2. `docker stop dept-acc`. Tìm lại bằng **từ khóa khác** (ví dụ `dich vu`; cùng từ khóa trong 30 giây sẽ trả từ cache Redis): vẫn ra kết quả; phần của ACC có nhãn **DỮ LIỆU TỪ CHỈ MỤC TRUNG TÂM** và có banner "Kết quả một phần".
3. Grafana: biểu đồ *fallback* của ACC tăng, Prometheus báo `SearchUsingFallback` và `DepartmentNodeDown`.
4. `docker start dept-acc`: khoảng 10 giây sau banner biến mất, node tự đăng ký lại Registry.

## D4. Quy trình xin quyền và thông báo thời gian thực - 2 phút
1. Cửa sổ A: `hr_manager` (chuông thông báo đang xanh). Cửa sổ B: `acc_staff`, mở một tài liệu HR và bấm *Xin quyền xem*.
2. Chuông ở cửa sổ A hiện huy hiệu đỏ **ngay lập tức**: "acc_staff (phòng ACC) xin xem một tài liệu của phòng bạn".
3. A duyệt với quyền **CHỈ XEM**. Chuông bên B báo "Yêu cầu đã được duyệt". B mở được tài liệu nhưng nút tải bị khóa (DLP).
4. A đổi sang quyền **TẢI VỀ** → B tải được; mở file tải về, SHA-256 khớp bản gốc.

## D5. Nhật ký audit chống sửa đổi - 2 phút
1. Cho xem chuỗi nguyên vẹn: `GET /api/dept/hr/audit/verify` (Trưởng phòng) → `"intact": true`.
2. Giả lập kẻ tấn công có quyền DB sửa một dòng:
   `docker exec postgres-hr-primary psql -U hr_admin -d dms_hr -c "UPDATE audit_log SET detail='da sua' WHERE log_id=1"`
   → bị **từ chối** (bảng chỉ-ghi). Muốn vượt qua phải tắt trigger, và khi đó `verify` báo `"intact": false` kèm `firstBrokenLogId`.

## D6. Hàng đợi Kafka: tìm theo nội dung bên trong tệp - 3 phút
1. Đăng nhập `hr_manager`, tải lên một tệp PDF hoặc Word có một cụm từ **không** nằm trong tiêu đề hay mô tả (có sẵn `infrastructure/scripts/fixtures/sample.pdf`, chứa "dieu khoan thanh toan").
2. Tab *Tra Cứu*, gõ `dieu khoan thanh toan`: tài liệu hiện ra với nhãn **KHỚP TRONG NỘI DUNG TỆP** và đoạn trích tô sáng từ khóa.
3. Cho xem worker làm việc: `docker compose logs --tail 5 content-worker` (dòng `HR #.. -> indexed (pdf, .. ms, dms.dept.hr.document[..]@..)`).
4. Nhân bản: `docker compose up -d --no-build --scale content-worker=3`. Trên Grafana, biểu đồ *Partition Kafka được giao cho từng bản content-worker* tách thành 3 đường (9 partition chia 3).
5. Tắt một bản (`docker stop <tên một worker>`): khoảng 10–30 giây sau partition của nó được giao cho các bản còn lại, không mất việc.
6. Nói rõ đánh đổi: nội dung tệp chỉ nằm ở node của phòng ban, nên khi node sập phần dự phòng chỉ tìm theo tiêu đề và mô tả.

## D7. Không còn điểm chết ở tầng tìm kiếm - 2 phút
1. `docker compose ps search-engine-service`: đang có 2 bản.
2. Mở hai cửa sổ: `hr_manager` và `acc_manager` (chuông xanh ở cả hai).
3. `docker stop <tên một bản search>`: tìm kiếm vẫn chạy; chuông tự nối lại sau vài giây.
4. HR chia sẻ một tài liệu cho ACC: chuông bên ACC vẫn báo, kể cả khi hai người đang nối vào hai bản khác nhau (thông báo đi qua Redis).
5. `docker start <bản vừa tắt>`: Grafana hiện lại 2 bản.

## D8. Nhìn thấy truy vấn liên hợp bằng distributed tracing - 3 phút
1. Mở Jaeger `http://localhost:16686`, chọn service `search-gateway`, operation `GET /search`, bấm *Find Traces*.
2. Thực hiện một lần tìm kiếm trên giao diện, mở trace mới nhất: thấy `GET /search` ở trên cùng và ba thanh `federated.query HR/ACC/SALES` **xếp chồng theo thời gian** (chạy song song), bên dưới mỗi thanh là `POST /internal/search` của đúng node đó. Đây là hình ảnh trực tiếp của mô hình scatter-gather.
3. `docker stop dept-acc`, tìm lại bằng từ khóa khác. Trace mới: thanh `federated.query ACC` màu đỏ, thuộc tính `dms.node.status=FALLBACK`, `dms.fallback.reason=lifecycle=DRAINING`; không còn span của `dept-acc`, thay vào đó là câu `pg.query` vào Central Index.
4. `docker start dept-acc`.
5. Mẹo: phản hồi của `GET /api/search` có trường `traceId`, mở thẳng `http://localhost:16686/trace/<traceId>`.

## D9. Trang giám sát: biết node sập và phục hồi - 3 phút
Nên làm phần này **đầu tiên hoặc song song với D3**, vì nó cho thấy toàn cảnh.
1. Đăng nhập Ban Giám đốc (`admin`), mở *Giám sát hệ thống*: dải xanh "Mọi hệ thống hoạt động bình thường", mỗi node một dòng có thanh lịch sử 24 giờ.
2. **Dừng có trật tự**: `docker stop dept-acc`. Trong vài giây: dải chuyển vàng "suy giảm một phần", dòng ACC hiện "ĐÃ DỪNG từ hh:mm:ss", bảng sự cố có mục **ĐANG DIỄN RA** loại "Dừng có kế hoạch", chuông báo đỏ, thanh bên hiện "2/3 node".
3. `docker start dept-acc`: sự cố chuyển **ĐÃ PHỤC HỒI** kèm giờ phục hồi và thời lượng; chuông báo "đã phục hồi".
4. **Sập đột ngột**: `docker kill dept-sales`. Khoảng 30 giây sau (ngưỡng mất nhịp tim) dòng SALES chuyển "MẤT KẾT NỐI", sự cố loại "Sập ngoài ý muốn", mục *Cảnh báo đang bật* hiện `DepartmentNodeDown` từ Prometheus. Giờ bắt đầu sự cố là nhịp tim cuối cùng, không phải lúc phát hiện.
5. `docker start dept-sales`: mọi thứ về xanh.
6. Chỉ vào bảng *Thành phần nền tảng*: số bản Search/worker đang sống, từng connector, DLQ. Nói rõ nguồn: Registry, Prometheus, Kafka Connect.
7. Lưu ý khi demo: **đừng build image trong lúc trình bày**. Máy nghẽn làm node trễ nhịp tim thật và trang sẽ ghi nhận thành sự cố thật.

## D10. Tắt hẳn CSDL trung tâm mà tìm kiếm vẫn chạy - 3 phút
1. Mở *Tra cứu*, tìm `hop dong`: ba chip node xanh, 28 kết quả.
2. `docker stop postgres-central-primary postgres-central-replica`.
3. Tìm bằng từ khóa khác: **vẫn ra đủ kết quả**, các chip node vẫn xanh, có dải xanh dương "Chỉ mục trung tâm đang ngừng". Trang *Giám sát hệ thống* báo CSDL trung tâm `Ngừng hoạt động` nhưng tìm kiếm không đứt.
4. Tạo một tài liệu ở phòng HR trong lúc trung tâm đang sập: vẫn tạo được và tìm thấy ngay tại node.
5. `docker start postgres-central-primary postgres-central-replica`: vài giây sau tài liệu vừa tạo xuất hiện trong chỉ mục trung tâm (Outbox không mất sự kiện), dải xanh dương biến mất.
6. Nói rõ đánh đổi: lúc đó mất dự phòng khi một node sập và chưa cấp/thu hồi quyền chia sẻ mới được.
7. So sánh để hội đồng thấy giá trị: bản cũ trả **502** ở bước 3.

## D11. Phòng HR đứt mạng vẫn làm việc, nối lại tự hội tụ - 4 phút
Chạy: `bash infrastructure/scripts/partition-test.sh` (cắt thật `dms-network` của HR; cuối cùng luôn nối lại).
1. Cho xem trước: `http://localhost:3001/console` và `curl http://localhost:3001/sync/status` → `mode: ONLINE`.
2. Script cắt mạng. Đăng nhập và tạo 3 tài liệu, cấp 1 chia sẻ qua `localhost:3001`: vẫn được. Giao diện hiện huy hiệu `CHẾ ĐỘ TỰ TRỊ (OFFLINE)`.
3. Script in backlog WAL chưa gửi (byte) và số sự kiện outbox; trung tâm báo HR `DEGRADED` sau khoảng 30 giây.
4. Script nối lại (T0). HR về `ACTIVE` trong vài giây; đếm T_convergence đến khi trung tâm thấy đủ tài liệu và chia sẻ.
5. Script đưa một sự kiện cũ vào Kafka: tiêu đề không bị ghi đè (`source_version` giữ nguyên).
6. Nói rõ đánh đổi: khi đứt mạng không duyệt được yêu cầu xin quyền mới; bản sao chia sẻ ở trung tâm nhất quán cuối cùng.

## Phần chưa chứng minh được (nói thẳng với hội đồng)
- Kubernetes: Helm chart đã viết và lint sạch nhưng **chưa triển khai thử** do máy yếu và mạng tải image chậm (xem `07-implementation-status.md`).
- Failover Postgres tự động, Kafka 3 broker: thuộc phần Kubernetes, chưa làm. Redis và Kafka hiện chạy một bản, là hai điểm chết còn lại.
- Lập chỉ mục nội dung chưa đọc được ảnh quét (OCR), Excel, PowerPoint.
