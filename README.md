# Smart Locker – Hệ thống tủ khóa thông minh gửi/nhận hàng

Đây là phần **backend + web + firmware mẫu** hiện thực hoá toàn bộ nghiệp vụ mô tả
trong tài liệu yêu cầu của bạn (shipper gửi hàng không cần đăng nhập, OTP gửi qua
SMS, người nhận bấm OTP trên bàn phím vật lý, admin quản trị, chống phá hệ thống...).

## 1. Cấu trúc thư mục

```
smartlocker-system/
├── backend/                 # Server Node.js + Express (API + web tĩnh)
│   ├── server.js
│   ├── data/                 # Lớp lưu trữ JSON + seed dữ liệu mẫu
│   ├── routes/
│   │   ├── public.js         # API công khai cho shipper (không cần đăng nhập)
│   │   ├── device.js         # API cho thiết bị ESP32 (cần X-Device-Key)
│   │   └── admin.js          # API cho admin (cần đăng nhập JWT)
│   ├── services/              # OTP, gửi SMS, chống gian lận, tạo đơn
│   ├── middleware/            # Xác thực admin + thiết bị
│   ├── public/                 # Trang web công khai cho shipper
│   └── admin/                   # Trang quản trị (dashboard)
├── firmware/smart_locker_esp32/  # Code mẫu ESP32 (.ino) gọi vào backend
└── docs/                          # Tài liệu API chi tiết
```

## 2. Cài đặt & chạy thử (trên máy tính / VPS)

```bash
cd backend
npm install
cp .env.example .env      # đã có sẵn, chỉnh lại các khóa bí mật trước khi triển khai thật
npm run seed               # tạo tài khoản admin mặc định + dữ liệu mẫu
npm start
```

Mặc định:
- Trang shipper (công khai): `http://localhost:3000/`
- Trang admin: `http://localhost:3000/admin/` — đăng nhập `admin / admin123`
  **(đổi mật khẩu ngay sau khi đăng nhập lần đầu, ở mục "Đổi mật khẩu" qua API
  `POST /api/admin/doi-mat-khau`)**

Toàn bộ dữ liệu lưu ở `backend/data/db.json` (dạng file JSON, không cần cài
MySQL/Postgres để chạy thử). Muốn nâng cấp lên database thật, chỉ cần thay
`backend/data/db.js`, các routes/services phía trên không cần sửa.

## 3. Những gì đã được xây dựng đầy đủ (phần 60–70% còn thiếu so với 5 repo cũ)

| Hạng mục | Trạng thái |
|---|---|
| Web công khai cho shipper, không cần đăng nhập | ✅ `backend/public/` |
| Kiểm tra SĐT người nhận nằm trong danh sách cư dân | ✅ `services/antifraud.js` |
| Chọn ngẫu nhiên ngăn tủ trống | ✅ `services/orderService.js` |
| Sinh OTP 6 số, băm lưu trữ, hết hạn, dùng 1 lần | ✅ `services/otp.js` |
| Gửi OTP qua SMS (có thể cắm eSMS.vn / Twilio / hoặc log console để test) | ✅ `services/sms.js` |
| Xác nhận cảm biến: cửa đóng + khối lượng tăng + vật thể phát hiện | ✅ `routes/device.js` |
| Người nhận mở đúng tủ bằng OTP qua bàn phím | ✅ `routes/device.js` |
| Hủy OTP + giải phóng ngăn khi lấy hàng xong | ✅ `routes/device.js` |
| Bàn phím fallback A/B/*/#/D khi shipper không có Internet | ✅ `routes/device.js` + `firmware/*.ino` |
| Rate-limit số đơn / SĐT shipper trong khoảng thời gian | ✅ `services/antifraud.js` |
| Khóa tạm SĐT shipper sau nhiều lần mở không đặt hàng | ✅ `services/antifraud.js` |
| Hủy đơn + ghi cảnh báo khi đóng cửa không có hàng | ✅ `routes/device.js` |
| Tủ tự khóa lại nếu mở quá lâu | ✅ `server.js` (bộ kiểm tra định kỳ) |
| Chỉ 1 yêu cầu xử lý tại 1 thời điểm | ✅ `data/db.js` (hàng đợi ghi tuần tự) |
| Camera lưu ảnh khi tủ mở | ✅ API `routes/device.js` (`/camera`), cần gắn ESP32-CAM thực tế |
| Admin: quản lý cư dân, xem trạng thái tủ, đơn chờ, SĐT shipper, mã vận đơn | ✅ `routes/admin.js` + `admin/` |
| Admin: xem lịch sử mở cửa / ảnh camera / cảnh báo | ✅ tab "Lịch sử", "Cảnh báo" |
| Admin: hủy / cấp lại OTP, mở khẩn cấp, khóa ngăn lỗi | ✅ |

## 4. Những phần BẠN vẫn cần tự làm (phần cứng thật)

Đây là mã nguồn **backend + web** — phần đã khó nhất và thiếu nhiều nhất. Phần
firmware trong `firmware/smart_locker_esp32/` chỉ là **code khung minh hoạ cách
gọi API**, bạn cần:
1. Đấu nối thực tế cảm biến HX711 (load cell), cảm biến IR, công tắc cửa, relay
   theo đúng chân trên board ESP32 của bạn, hiệu chỉnh ngưỡng khối lượng.
2. Nếu dùng camera, gắn thêm module ESP32-CAM riêng, gọi API
   `POST /api/device/:lockerId/camera` (multipart field `image`).
3. Đăng ký một nhà cung cấp SMS thật (eSMS.vn, Twilio, Speedsms...) và điền
   API key vào `.env` (`SMS_PROVIDER=esms` hoặc `twilio`). Trước khi có tài khoản
   thật, hệ thống mặc định `SMS_PROVIDER=console` chỉ log ra terminal để bạn
   test toàn bộ luồng mà không tốn phí SMS.
4. Triển khai backend lên server/VPS có domain thật (vd `smartlocker.vn`) và
   HTTPS, thay vì chạy localhost.
5. Đổi toàn bộ giá trị bí mật trong `.env` (`JWT_SECRET`, `DEVICE_API_KEY`,
   mật khẩu admin) trước khi đưa vào sử dụng thật.

## 5. Tài liệu API

Xem chi tiết từng endpoint tại [`docs/API.md`](docs/API.md).

## 6. Kiểm thử nhanh không cần phần cứng

Bạn có thể giả lập toàn bộ luồng bằng `curl` (không cần ESP32 thật) — xem ví dụ
đầy đủ trong `docs/API.md` mục "Kịch bản kiểm thử end-to-end".
