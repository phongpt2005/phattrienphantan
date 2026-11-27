# Hướng dẫn cài đặt cụm 3 máy (cho cả nhóm)

Ba máy của ba thành viên được nối thành **một cụm Docker Swarm**. Mỗi thành phần của hệ thống có 3 bản, mỗi máy giữ một bản, nên tắt hẳn một máy bất kỳ thì hệ thống vẫn chạy.

- **Đang làm việc ở xa nhau:** ba máy nối qua **Tailscale** (mạng riêng ảo, miễn phí).
- **Lúc demo ngồi chung một Wi-Fi:** thêm một **địa chỉ ảo trên LAN**, client chỉ cần nhớ địa chỉ đó.

Quy ước trong tài liệu:
- **Máy 1** là máy của người dựng cụm (giữ mã nguồn và build image).
- **Máy 2, Máy 3** là máy của hai bạn còn lại.

---

## 0. Yêu cầu mỗi máy

| Hạng mục | Tối thiểu | Nên có |
|---|---|---|
| RAM cấp cho máy ảo | 6 GB | 8 GB |
| Ổ trống cho máy ảo | 30 GB | 40 GB |
| CPU cấp cho máy ảo | 2 luồng | 4 luồng |
| Mạng | Có Internet (để cài và kéo image) | |

Kiểm nhanh trên Windows (mở PowerShell, dán lệnh, gửi kết quả cho người dựng cụm):

```powershell
$o=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_Processor; "$($o.Caption) | RAM $([math]::Round($o.TotalVisibleMemorySize/1MB)) GB | CPU $($c.NumberOfLogicalProcessors) luồng | ổ trống $([math]::Round((Get-PSDrive C).Free/1GB)) GB"
```

---

## 1. Cài máy ảo Ubuntu (cả 3 người)

Docker Swarm cần Linux để nối nhiều máy ổn định (Docker Desktop trên Windows chạy Docker sau NAT, không nối cụm được). Mỗi người cài một máy ảo Ubuntu.

1. Tải và cài **VirtualBox**: https://www.virtualbox.org/wiki/Downloads (bản Windows hosts).
2. Tải **Ubuntu Server 24.04 LTS** (tệp `.iso`): https://ubuntu.com/download/server
3. Trong VirtualBox, bấm **New**:
   - Name `dms-may-1` (người 2 đặt `dms-may-2`, người 3 đặt `dms-may-3`), chọn tệp iso vừa tải, tích **Skip Unattended Installation**.
   - RAM 8192 MB (tối thiểu 6144), CPU 4 (tối thiểu 2), ổ 40 GB.
4. Trước khi bật máy ảo: **Settings → Network → Adapter 1 → Attached to: Bridged Adapter**, chọn card Wi-Fi hoặc card mạng đang dùng. Chế độ này cho máy ảo một địa chỉ thật trong mạng LAN, cần cho buổi demo.
5. Bật máy ảo, cài Ubuntu theo mặc định:
   - Đặt tên máy `dms-may-1`, `dms-may-2` hoặc `dms-may-3`.
   - Tạo tài khoản, và **tích chọn Install OpenSSH server**.
6. Cài xong, đăng nhập, rồi cài git và tải mã nguồn:

```bash
sudo apt update && sudo apt install -y git curl
git clone -b nghiem-thu https://github.com/phongpt2005/phattrienphantan.git dms
cd dms
```

> Mẹo: dùng SSH từ Windows (`ssh <tài-khoản>@<địa-chỉ-máy-ảo>`) để dán lệnh dễ hơn gõ trong cửa sổ VirtualBox. Địa chỉ máy ảo xem bằng lệnh `ip -4 addr`.

---

## 2. Chuẩn bị từng máy (cả 3 người)

Trong thư mục `dms` của máy ảo:

```bash
bash scripts/swarm/00-prepare-node.sh
```

Script làm các việc sau:
- Kiểm tra RAM và ổ đĩa.
- Cài Docker Engine và Tailscale.
- Mở cổng cho Swarm.
- In ra **tên máy, địa chỉ Tailscale, địa chỉ LAN**.

Khi script in ra một đường link Tailscale, mở link đó trên trình duyệt và **đăng nhập cùng một tài khoản Tailscale cho cả 3 máy**. Nhóm nên tạo chung một tài khoản.

Chạy xong, **đăng xuất rồi đăng nhập lại** máy ảo để dùng `docker` không cần `sudo`. Sau đó gửi ba dòng thông tin script in ra cho người dựng cụm.

Kiểm tra ba máy đã thấy nhau qua Tailscale:

```bash
tailscale status        # phải thấy cả dms-may-1, dms-may-2, dms-may-3
```

---

## 3. Dựng cụm (chỉ Máy 1)

```bash
bash scripts/swarm/10-init-cluster.sh
```

Script tạo cụm, tạo mạng `dms-net`, gắn nhãn máy `m1`, chạy kho image nội bộ, và cuối cùng **in ra một lệnh `11-join-cluster.sh ...`**. Gửi riêng lệnh này cho hai bạn (trong đó có token, không đăng công khai).

---

## 4. Tham gia cụm (Máy 2 và Máy 3)

Dán đúng lệnh Máy 1 gửi, dạng:

```bash
bash scripts/swarm/11-join-cluster.sh SWMTKN-1-xxxx 100.x.y.z
```

Sau đó Máy 1 gắn nhãn và kiểm tra:

```bash
bash scripts/swarm/12-label-nodes.sh
```

Kết quả đúng là 3 dòng `m1`, `m2`, `m3`, tất cả `ready` và `reachable`.

---

## 5. Triển khai hệ thống lên cụm (Máy 1)

Máy 1 cần tệp `.env` và `departments/*.env` (chứa mật khẩu, không có trong git). Chép từ máy đang chạy hệ thống sang máy ảo, ví dụ từ Windows:

```powershell
scp .env departments\*.env <tài-khoản>@<địa-chỉ-máy-ảo-1>:~/dms/
```

Rồi trên Máy 1:

```bash
bash scripts/swarm/20-build-push.sh     # build image, đẩy lên kho nội bộ (lần đầu khoảng 10-15 phút)
bash scripts/swarm/30-deploy.sh         # triển khai lõi và 3 phòng ban, chờ tất cả khỏe
```

`30-deploy.sh` in ra địa chỉ để mở giao diện: `http://<địa-chỉ-Tailscale-của-máy-bất-kỳ>:8000`. Gateway chạy trên cả 3 máy, nên vào qua máy nào cũng được.

Muốn mang dữ liệu đang có trên hệ thống một máy sang cụm, xem `scripts/swarm/40-import-data.sh` (đang hoàn thiện).

---

## 6. Ngày demo: ngồi chung một Wi-Fi

1. Cả ba bật máy ảo. Máy ảo ở chế độ Bridged nên tự có địa chỉ LAN (`ip -4 addr`).
2. Chọn một địa chỉ trống trong mạng làm **địa chỉ ảo**, ví dụ `192.168.1.250`.
3. Máy 1 chạy:

```bash
LAN_VIP=192.168.1.250 LAN_PEERS=<LAN máy 1>,<LAN máy 2>,<LAN máy 3> bash scripts/swarm/30-deploy.sh --lan-vip
```

Từ giờ mọi người vào `http://192.168.1.250:8000`. Tắt máy đang giữ địa chỉ này thì máy khác nhận thay sau vài giây.

---

## 7. Theo dõi khi demo

| Xem gì | Ở đâu |
|---|---|
| Máy nào sống, ai giữ vai trò chính, quy trình chuyển đổi từng bước | Giao diện, đăng nhập Ban Giám đốc, mục **Theo dõi chuyển đổi** |
| Dải thời gian vai trò của từng node | Grafana, bảng **Chuyển đổi và phục hồi** |
| Trạng thái từng service, máy nào đang chạy gì | `docker service ls`, `docker service ps <tên>` trên máy bất kỳ |

Kịch bản kiểm thử chịu lỗi (rút điện máy, chết CSDL, nhiều người tải tệp cùng lúc...): `docs/17-kich-ban-kiem-thu-chiu-loi.md`.

---

## 8. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `tailscale status` không thấy máy khác | Ba máy phải đăng nhập **cùng một tài khoản** Tailscale; chạy lại `sudo tailscale up` |
| `11-join-cluster.sh` báo không thấy máy 1 | Máy 1 phải đang bật và đã chạy bước 3; thử `ping <địa chỉ Tailscale máy 1>` |
| `permission denied` khi chạy `docker` | Chưa đăng xuất rồi đăng nhập lại sau bước 2 |
| Máy ảo không có địa chỉ LAN | VirtualBox → Settings → Network: chọn Bridged Adapter đúng card mạng đang dùng |
| Service kẹt `Pending` | Thiếu nhãn máy: chạy lại `12-label-nodes.sh`; hoặc máy đó đang tắt |
| Giao diện tải được nhưng gọi API lỗi lớn | Kiểm MTU: mạng phải tạo bằng `10-init-cluster.sh` (MTU 1230) |
