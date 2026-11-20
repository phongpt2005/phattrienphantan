---
name: dms-engineering-principles
description: "BẮT BUỘC đọc trước mọi tác vụ trong dự án DMS (hệ thống quản trị tài liệu phân tán). Quy định về chính trực, phản biện có căn cứ, kiểm chứng trước khi báo xong, an toàn dữ liệu, và yêu cầu mọi sự cố phân tán đều có phương án xử lý đã kiểm thử."
---

# Nguyên tắc kỹ thuật của dự án DMS

Skill này ghi lại các yêu cầu của người dùng về cách làm việc và chất lượng hệ thống. Đọc trước mọi tác vụ: sửa mã, viết script, chạy triển khai, viết tài liệu, trả lời câu hỏi về kiến trúc.

Phần 1 đến 4 là yêu cầu của người dùng, diễn đạt lại theo ý gốc. Phần 5 trở đi là quy trình kỹ thuật được bổ sung để áp dụng các yêu cầu đó; người dùng có quyền sửa hoặc bỏ.

---

## 1. Chính trực và công tâm (ưu tiên cao nhất)

- Báo đúng sự thật, kể cả khi kết quả xấu hoặc khi chính mình gây lỗi. Không làm đẹp số liệu, không tuyên bố "xong" khi chưa có bằng chứng.
- Nêu rõ mỗi kết quả thuộc loại nào: **đã làm và đã kiểm chứng** (kèm lệnh hoặc số đo), **đã làm nhưng chưa kiểm chứng**, hoặc **chưa làm**.
- Nếu một lệnh báo "thành công" nhưng kết quả cho thấy khác, tin kết quả, không tin thông báo. Ví dụ đã gặp: build thất bại nhưng container vẫn được tạo lại bằng image cũ.
- Khi phát hiện sai sót của chính mình, báo ngay trong câu trả lời, sửa, và ghi vào tài liệu nếu ảnh hưởng đến kết luận.

## 2. Không làm theo mù quáng: phản biện có căn cứ

Người dùng không yêu cầu làm theo mọi điều họ nói. Yêu cầu là **đảm bảo hệ thống đúng và tốt nhất**. Vì vậy:

- Nếu một yêu cầu sai về kỹ thuật, mâu thuẫn với mã nguồn, hoặc có cách tốt hơn: nêu rõ vấn đề, dẫn chứng bằng mã (đường dẫn và dòng), số đo, hoặc tài liệu, đề xuất phương án tốt hơn, và để người dùng quyết định.
- Không im lặng làm theo khi biết yêu cầu sai. Không tự ý đổi hướng lớn khi chưa được đồng ý.
- Nếu thông tin người dùng đưa vào (bản dán, kế hoạch, con số) không khớp với mã hoặc số đo thực tế, nói rõ chỗ không khớp và dùng số thật. Ví dụ đã gặp: RAM máy ghi 16 GB nhưng Docker thực tế chỉ có 9,71 GiB; số đếm bản ghi trong tài liệu đã cũ.
- Khi một ý kiến có thể được cải thiện, đề xuất ít nhất một phương án thay thế và đánh giá đánh đổi (chi phí, độ phức tạp, rủi ro, tài nguyên).

## 3. Hệ thống phải xử lý được mọi loại sự cố, từ nhỏ đến lớn

Mọi tính năng mới hoặc thay đổi hạ tầng phải có **bảng sự cố**: với mỗi loại sự cố, ghi phát hiện thế nào, hệ thống tự xử lý ra sao, người vận hành làm gì, và kịch bản kiểm thử nào chứng minh. Nếu chưa có phương án cho một sự cố, ghi rõ là khoảng trống và đưa vào kế hoạch, không bỏ qua.

Bảng tối thiểu phải xét các loại sau:

| Loại sự cố | Câu hỏi bắt buộc phải trả lời |
|---|---|
| CSDL primary chết | Ghi có tiếp tục không? Ai chuyển primary, mất bao lâu (RTO)? Mất bao nhiêu dữ liệu (RPO)? |
| CSDL replica chết hoặc trễ | Đọc có bị sai không? Có đọc ngay sau ghi được không? |
| Cổng hoặc dịch vụ không phản hồi | Client có timeout không? Có thử lại sang bản khác không? Có circuit breaker không? |
| Kafka broker chết | Producer có mất tin không (acks, min ISR)? Consumer có tự bầu lại không? |
| Debezium hoặc connector FAILED | Ai phát hiện, ai restart, có mất sự kiện không? |
| Redis chết | Thu hồi token có còn hiệu lực không? Cache có fail-open đúng không? |
| MinIO chết hoặc hỏng tệp | Tải có trả mã lỗi rõ không? Có phát hiện tệp hỏng không (SHA-256)? |
| Nginx hoặc gateway chết | Có đường thay thế không? |
| Node phòng ban đứt mạng | Node có tự trị được không? Hội tụ thế nào khi nối lại? Có ghi đè bằng sự kiện cũ không? |
| Chỉ mục trung tâm sập hoặc lệch | Tìm kiếm có còn chạy không? Có phát hiện lệch và tự sửa không? |
| Hai người cùng thao tác một bản ghi | Có chặn xung đột ở mức cơ sở dữ liệu không (compare-and-set, khóa)? |
| Split-brain | Có cơ chế quorum không? Primary cũ có bị từ chối ghi không? |
| Ghi trùng khi client thử lại | Có khóa idempotency không? |
| Mất dữ liệu, xóa nhầm, ransomware | Có sao lưu ra ngoài máy và đã diễn tập khôi phục chưa? |
| Lộ bí mật | Đã xoay chưa? Có nằm trong git hoặc mã nguồn không? |

Quy tắc: **chỉ tuyên bố một sự cố "đã xử lý" khi có kịch bản kiểm thử đã chạy và có số đo**.

## 4. Kiểm chứng trước khi báo cáo

- Mọi thay đổi phải có bằng chứng chạy thật: kết quả script, số đo `docker stats`, truy vấn đối soát, hoặc log. Tài liệu viết trước khi có kết quả phải ghi rõ là chưa kiểm chứng.
- Sau mỗi thay đổi ảnh hưởng đường xử lý chính, chạy lại bộ hồi quy: `infrastructure/scripts/e2e-smoke.sh` (96 kiểm tra). Các runbook riêng: `partition-test.sh` (17), `revoke-test.sh` (16), `rolling-upgrade-test.sh`, `approval-race-test.sh` (6), `restore-test.sh` (21), `rebuild-central-index.sh`.
- Kiểm tra build trước khi dùng image. Nếu `docker compose build` báo lỗi, không recreate container với mong đợi đã có bản mới. Kiểm tra lại image bằng cách đọc mã trong image.
- Lệnh kiểm tra phải chạy đủ biến môi trường (`. ./.env`). Một lệnh chẩn đoán thiếu biến có thể cho kết quả sai rồi bị hiểu nhầm là lỗi hệ thống.

## 5. An toàn dữ liệu và thao tác phá hủy

- Trước mọi thao tác xóa, TRUNCATE, DROP, hoặc đổi khóa ngoại: sao lưu trước, kiểm tra khóa ngoại và các bảng tham chiếu, và chỉ làm sau khi người dùng đồng ý. Không dùng `CASCADE` khi chưa biết nó xóa những gì.
- Sao lưu phải ra ngoài máy (`backup-offsite.sh`). Một bản sao lưu chưa được khôi phục thử thì coi như chưa có (`restore-test.sh`).
- Dữ liệu sao lưu chứa mã băm mật khẩu và tài liệu: không đưa lên dịch vụ đám mây khi chưa mã hóa, trừ khi người dùng đã chọn rõ.
- Các thay đổi trên đĩa trong thư mục làm việc là đảo ngược được; thao tác trên dữ liệu thật thì không.

## 6. Bảo mật và bí mật

- Không viết mật khẩu, khóa, token vào mã nguồn hoặc tài liệu. Nếu phát hiện, báo người dùng và đề xuất xoay khóa.
- `.env` và `departments/*.env` chứa bí mật. Chúng có trong repo cục bộ theo quyết định của người dùng; không đẩy lên remote khi chưa xoay khóa.
- Không mount `/var/run/docker.sock` vào container.
- Chỉ mở ra ngoài máy các cổng cần thiết: `8000` (gateway) và `3001` (cổng nội bộ phòng HR). Giám sát chỉ bind `127.0.0.1`.
- Node không được tin danh tính từ tham số do client gửi. Danh tính lấy từ JWT đã xác minh.

## 7. Git và thay đổi mã

- Không commit khi người dùng chưa yêu cầu. Khi được yêu cầu, commit đúng phạm vi đã làm, thông điệp nêu rõ thay đổi và bằng chứng kiểm thử.
- Dòng `Co-Authored-By` trong commit theo đúng dòng mà hệ thống yêu cầu cho lần commit đó.
- Không dùng `git add -f` cho file bí mật trừ khi người dùng yêu cầu rõ, và phải nêu rõ là đã làm vậy.

## 8. Quy trình làm việc theo gói

- Thứ tự gói là **P0 → P1 → P2 → P3** như trong `docs/10-goi-b-va-c.md`. Không nhảy bước khi bước trước chưa xong. Nếu bước trước có lỗi chưa xử lý, dừng và báo.
- Trước khi bắt đầu một tác vụ: đọc `docs/07-implementation-status.md` (hiện trạng), `docs/10-goi-b-va-c.md` (kế hoạch), và các ADR liên quan trong `docs/05-adr/`.
- Với mỗi tác vụ, nêu trước: mục tiêu, các rủi ro chính, và cách kiểm chứng. Nếu rủi ro lớn hoặc phải thay đổi dữ liệu thật, hỏi người dùng trước.
- Cập nhật tài liệu cùng lúc với thay đổi, và ghi số đo thật, không ghi số ước tính như số đo.

## 9. Môi trường Windows và Docker (đã gặp trong thực tế)

- Lệnh bash chạy trong Git Bash. Đường dẫn tạm của `mktemp` không đọc được bằng Python hoặc curl của Windows: dùng `cygpath -m` cho đường dẫn.
- Python in tiếng Việt có thể lỗi trên console cp1258. Đặt `PYTHONIOENCODING=utf-8` hoặc chạy `python -X utf8`. Ghi file thì luôn thêm `encoding='utf-8'`.
- Docker Desktop có thể tắt giữa chừng. Trước khi chạy kiểm thử dài, kiểm tra `docker info`.
- Build image cần mạng tới registry. Lỗi `DeadlineExceeded` khi kéo base image là lỗi mạng, không phải lỗi mã. Thử lại, và không tái tạo container khi build chưa thành công.
- `docker compose up -d --no-build --force-recreate` tạo lại container với image hiện có. Luôn kiểm tra image đã được build và mã đã có trong image.
- Không dùng `sleep` dài trong lệnh bash. Với tác vụ chạy lâu, dùng chạy nền rồi chờ thông báo hoàn tất.
- Nginx dùng biến trong `proxy_pass` sẽ đọc lại DNS theo `resolver`; upstream có `resolve` đọc lại DNS khi container được tạo lại.

## 10. Trước khi trả lời người dùng

- Đối chiếu từng con số trong câu trả lời với kết quả lệnh vừa chạy.
- Nếu không kiểm chứng được một điều, nói rõ là không kiểm chứng được và lý do.
- Nếu có điều người dùng nên biết nhưng họ chưa hỏi (rủi ro, nợ kỹ thuật, bí mật lộ, quyết định cần chốt), nêu ngắn gọn ở cuối.
- Câu hỏi cuối cùng chỉ hỏi về quyết định thật sự cần người dùng chọn.
