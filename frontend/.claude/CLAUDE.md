# CLAUDE

Hướng dẫn cho tác tử AI khi sửa giao diện frontend của DMS Enterprise.

## Nguồn quy chuẩn

- Đọc `../AGENTS.md` trước khi đổi giao diện: quy chuẩn chống dáng "AI", mật độ bảng, bảng màu doanh nghiệp, phân quyền ba vai trò.
- Không dùng Astryx. Gói `@astryxdesign/*` đã được gỡ khỏi dự án theo quyết định của chủ dự án; không thêm lại.

## Hệ thống thiết kế hiện có

- Token và thang chữ: `tailwind.config.js`. Màu `brand-*` là xanh navy doanh nghiệp (500 = `#0064e0`, 700 = `#075985`). Cỡ chữ `text-micro` (11px, nhãn) và `text-data` (13px, dữ liệu bảng). Bóng `shadow-drawer` và `shadow-menu`.
- Thành phần dùng chung: `src/components/ui.tsx`. Gồm `Pill`, `DeptBadge`, `DocStatusPill`, `AccessPill`, `PermissionPill`, `RequestStatusPill`, `StatusDot`, `Kbd`, `Avatar`, `PageHeader`, `Panel`, `Kpi`, `Th`, `Td`, `ROW`, `EmptyState`, `LoadingRows`, `Bar`, `INPUT`, `SELECT`, `TEXTAREA`, `SearchField`, `Field`, `Button`, `IconButton`, `Segmented`, `Tabs`, `Modal`, `Drawer`.
- Chi tiết tài liệu luôn mở bằng `Drawer` (trượt từ phải, giữ nguyên danh sách phía sau). Xác nhận và nhập liệu nhỏ dùng `Modal`.

## Quy tắc

- Hàng bảng cao 40px (`ROW`), tiêu đề bảng 36px (`Th`). Không bọc mỗi dòng trong thẻ riêng.
- Không gradient, không phát sáng, không biểu tượng kiểu AI (sparkle, robot, não). Góc bo tối đa `rounded-lg`.
- Màu trạng thái theo AGENTS.md: `success` (đã duyệt, được tải), `info` (chỉ xem DLP), `warning` (chờ duyệt), `danger` (thu hồi, từ chối). Dùng `<Pill tone=...>`.
- Mã tài liệu, ngày giờ và mã băm dùng `font-mono`.
- Không hard-code màu hex trong component; dùng token `brand-*` hoặc thang `slate-*`, `emerald-*`, `amber-*`, `red-*`, `blue-*`.
- Khi chỉ đổi giao diện, không đổi gọi API trong `src/services/api.ts` và không đổi logic trong context.
- Phân quyền hiển thị: Nhân viên không có nút chia sẻ và không có tab phê duyệt. Trưởng phòng có chia sẻ và phê duyệt. Ban Giám đốc có giám sát và báo cáo.
- Trước khi kết thúc một thay đổi, `npm run build` trong thư mục `frontend` phải chạy qua.
