# CLAUDE

Hướng dẫn cho tác tử AI khi sửa giao diện frontend của **Hệ thống quản lý phòng ban** (tên hiển thị lấy từ `APP_NAME` trong `src/theme.ts`).

## Nguồn quy chuẩn

- Giao diện theo mẫu **Shadcn Admin** do chủ dự án chọn: thanh bên sáng có nhóm menu, thẻ bo góc `rounded-xl` viền mảnh bóng nhẹ, tab dạng viên, có chế độ sáng/tối. Quy định này thay cho phần thẩm mỹ của `../AGENTS.md` (góc bo, mật độ, nhãn viết hoa); phần phân quyền ba vai trò, nhãn bảo mật DLP và ngăn chi tiết trượt từ phải của AGENTS.md vẫn giữ.
- Không dùng Astryx. Gói `@astryxdesign/*` đã được gỡ khỏi dự án theo quyết định của chủ dự án; không thêm lại.

## Hệ thống thiết kế hiện có

- Màu lấy từ biến CSS trong `src/index.css` (`:root` cho sáng, `.dark` cho tối), khai báo trong `tailwind.config.js`: `card`, `sidebar`, thang `slate-*`, `brand-*` (xanh, 500 = `#2563eb`), `emerald-*`, `amber-*`, `red-*`, `blue-*`. Dùng `bg-card` cho nền thẻ (không dùng `bg-white`, vì không đổi theo chế độ tối). Màu luôn tối dù ở chế độ nào thì dùng thang `zinc-*`.
- Chế độ sáng/tối: `useTheme()` trong `src/theme.ts`, nút ở thanh đầu; `index.html` đặt lớp `dark` trước khi vẽ trang.
- Thành phần dùng chung: `src/components/ui.tsx`. Gồm `Pill`, `DeptBadge`, `DocStatusPill`, `AccessPill`, `PermissionPill`, `RequestStatusPill`, `StatusDot`, `Kbd`, `Avatar`, `PageHeader`, `Panel`, `Kpi` (có thể truyền `icon`), `Th`, `Td`, `ROW`, `EmptyState`, `LoadingRows`, `Bar`, `INPUT`, `SELECT`, `TEXTAREA`, `SearchField`, `Field`, `Button`, `IconButton`, `Segmented`, `Tabs`, `Modal`, `Drawer`.
- Chi tiết tài liệu luôn mở bằng `Drawer` (trượt từ phải, giữ nguyên danh sách phía sau). Xác nhận và nhập liệu nhỏ dùng `Modal`.

## Quy tắc

- Hàng bảng cao 48px (`ROW`), tiêu đề bảng 40px (`Th`), chữ thường (không viết hoa dàn chữ).
- Không biểu tượng kiểu AI (sparkle, robot, não), không gradient tím–hồng.
- Màu trạng thái: `success` (đã duyệt, được tải), `info` (chỉ xem DLP), `warning` (chờ duyệt), `danger` (thu hồi, từ chối). Dùng `<Pill tone=...>`.
- Mã tài liệu, ngày giờ và mã băm dùng `font-mono`.
- Không hard-code màu hex trong component; dùng các token ở trên.
- Khi chỉ đổi giao diện, không đổi gọi API trong `src/services/api.ts` và không đổi logic trong context.
- Phân quyền hiển thị: Nhân viên không có nút chia sẻ và không có tab phê duyệt. Trưởng phòng có chia sẻ và phê duyệt. Ban Giám đốc có giám sát và báo cáo.
- Trước khi kết thúc một thay đổi, `npm run build` trong thư mục `frontend` phải chạy qua.
