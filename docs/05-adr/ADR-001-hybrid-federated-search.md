# ADR-001: Hybrid Federated Search

**Trạng thái:** Accepted · **Liên quan:** R2

## Bối cảnh

Đề bài R2 yêu cầu dịch vụ tìm kiếm hợp nhất *truy vấn đồng thời nhiều node phòng ban*.

Thiết kế v1 không làm vậy. Nó chép metadata về một Central DB qua CDC rồi chỉ tìm ở đó. Cách này nhanh nhưng có hai vấn đề:

1. Nó không đúng nghĩa federated.
2. Kết quả có thể chậm hơn dữ liệu thật, do độ trễ đồng bộ cộng thêm TTL của cache.

Ngược lại, nếu chỉ dùng federated thuần thì một node sập là mất toàn bộ kết quả của phòng ban đó, và độ trễ của cả request bị kéo theo node chậm nhất.

## Quyết định

Dùng **scatter-gather song song** tới mọi node đang `ACTIVE` trong Registry làm đường chính. **Central Metadata Index** làm đường dự phòng cho từng node riêng lẻ:

- Mỗi lời gọi tới node có timeout 800 ms, circuit breaker riêng cho node đó, và bulkhead giới hạn tối đa 8 lời gọi đồng thời.
- Node nào timeout hoặc đang mở circuit thì phần kết quả của nó được lấy từ Central Index, gắn `stale=true` kèm `synced_at`.
- Kết quả từ các nguồn được gộp bằng Reciprocal Rank Fusion và khử trùng lặp theo `(department_id, document_id)`.
- Response luôn có trường `partial` và trạng thái của từng node.

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| Centralized index (v1) | Nhanh, đơn giản | Không đáp ứng R2. Dữ liệu stale | Không đúng đề |
| Federated thuần | Đúng đề, dữ liệu luôn mới | Không chịu được node lỗi. Latency bằng node chậm nhất | Kém sẵn sàng |
| Elasticsearch/OpenSearch tập trung | FTS mạnh | Cũng là centralized. Thêm một cụm nặng 2–4 GB | Không đúng đề, tốn tài nguyên |
| **Hybrid** | Đúng R2. Sẵn sàng cao. Trình bày được trade-off CAP | Phức tạp hơn (breaker, merge) | **Chọn** |

## Hệ quả

- **Tích cực.** Hệ thống chọn AP khi có phân mảnh mạng: vẫn trả kết quả, nhưng đánh dấu rõ phần nào là dữ liệu cũ. Đây là một điểm trình bày mạnh trước hội đồng.
- **Tiêu cực.**
  - Mọi node phải tuân thủ hợp đồng `/internal/search v1`, nên cần có contract test.
  - Xếp hạng giữa các node chỉ ở mức xấp xỉ, vì RRF là kỹ thuật hợp nhất dựa trên thứ hạng chứ không phải điểm số.
