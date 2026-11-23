# Tài liệu hệ thống DMS phân tán

| File | Nội dung |
|---|---|
| [07-implementation-status.md](07-implementation-status.md) | **Đọc trước**: cái gì đã làm, đã kiểm chứng thế nào, cái gì chưa, khác thiết kế ở đâu |
| [01-architecture-review.md](01-architecture-review.md) | Review kiến trúc v1 (vấn đề và bằng chứng) |
| [02-target-architecture.md](02-target-architecture.md) | Kiến trúc đích: Hybrid Federated Search, Registry, Outbox |
| [03-database-design.md](03-database-design.md) | Thiết kế CSDL đích (+ [sql/](sql/)) |
| [04-deployment.md](04-deployment.md) | Triển khai: Docker Compose (đã làm), Kubernetes/Helm (thiết kế) |
| [05-adr/](05-adr/README.md) | Các quyết định kiến trúc |
| [06-demo-and-test-plan.md](06-demo-and-test-plan.md) | Kế hoạch demo/kiểm thử (thiết kế, gồm cả phần Kubernetes) |
| [08-demo-script.md](08-demo-script.md) | **Kịch bản demo chạy được ngay bằng Docker Compose** |

## Chạy nhanh

```bash
bash scripts/setup.sh                                     # cài đặt đầy đủ: .env, build giao diện và 3 image, chạy stack
bash infrastructure/scripts/e2e-smoke.sh                  # kiểm thử đầu-cuối
bash scripts/add-department.sh SALES "Phòng Kinh doanh"   # thêm phòng ban, không sửa node cũ
```

Cài thủ công từng bước: xem mục "Cài đặt thủ công" trong [README.md](../README.md). Lưu ý: image `content-worker` cũng phải được build, không chỉ hai image của `department-service` và `search-engine-service`.

Tài khoản demo (khi `SEED_DEMO_USERS=true` trong `.env`): `<mã>_staff`, `<mã>_manager`, `admin` (Ban Giám đốc); mật khẩu theo `DEMO_*` trong `.env`.

Địa chỉ khi chạy: giao diện `http://localhost:<cổng nginx>`, Grafana `http://localhost:<cổng Grafana>`, Prometheus `http://localhost:<cổng Prometheus>`, Jaeger (tracing) `http://localhost:<cổng Jaeger>`. Các cổng được khai báo trong `docker-compose.yml`.
