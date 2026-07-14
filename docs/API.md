# API Reference

Base URL mặc định: `http://localhost:3000`

## A. API công khai (không cần đăng nhập) — `/api/*`

### GET /api/lockers/tinh-trang
Trả về số ngăn trống / tổng số ngăn, hiển thị trên trang shipper.

### POST /api/guihang
Tạo đơn gửi hàng, chọn ngẫu nhiên ngăn trống và "mở tủ".

Body:
```json
{
  "recipientPhone": "0901234567",
  "recipientName": "Nguyễn Văn A",
  "room": "502 - Tòa A",
  "shipperPhone": "0987654321",
  "trackingCode": "SPX123456"
}
```
Response thành công:
```json
{ "success": true, "message": "Tủ A03 đã mở...", "orderId": "DH-...", "lockerId": "A03" }
```
Các lý do từ chối: SĐT người nhận không có trong danh sách cư dân, shipper đang bị
khóa tạm, shipper vượt quá số đơn cho phép trong khung giờ, hết ngăn trống.

### GET /api/guihang/:orderId/trang-thai
Shipper poll (gợi ý mỗi 2–3 giây) để biết đơn đã "co_hang" (thành công, OTP đã
gửi) hay "huy" (bị hủy do không phát hiện kiện hàng).

---

## B. API thiết bị (ESP32) — `/api/device/*`
Yêu cầu header `X-Device-Key: <DEVICE_API_KEY trong .env>`.

### POST /api/device/:lockerId/dong-cua-gui
Gọi sau khi shipper đóng cửa, kèm dữ liệu cảm biến thực tế.
```json
{ "doorClosed": true, "weightIncreased": true, "objectDetected": true }
```
Nếu cả 3 đều true → tạo OTP, gửi SMS, đơn chuyển "co_hang".
Nếu không → hủy đơn, ghi cảnh báo, cộng 1 "strike" cho SĐT shipper (nếu có).

### POST /api/device/keypad/mo-tu-nhan-hang
Người nhận nhập OTP trên bàn phím, thiết bị gửi lên để xác thực & biết mở ngăn nào.
```json
{ "otp": "583921" }
```

### POST /api/device/:lockerId/dong-cua-nhan
Xác nhận cảm biến sau khi người nhận lấy hàng xong.
```json
{ "doorClosed": true, "weightBackToZero": true, "objectCleared": true }
```

### POST /api/device/keypad/gui-hang
Luồng fallback không cần Internet của shipper (nhập số điện thoại trực tiếp
bằng bàn phím vật lý, thiết bị tự gọi API này khi có Internet).
```json
{ "recipientPhone": "0901234567" }
```

### POST /api/device/:lockerId/camera  (multipart/form-data, field `image`)
Upload ảnh chụp khi tủ mở, phục vụ tra soát trong admin.

### GET /api/device/:lockerId/lenh
Thiết bị poll định kỳ để nhận lệnh từ admin: `mo_khan_cap`, `khoa_lai`.

### POST /api/device/:lockerId/lenh/hoan-thanh
Thiết bị báo đã thực hiện xong lệnh.

---

## C. API admin — `/api/admin/*`
Yêu cầu header `Authorization: Bearer <token>` (lấy từ `/login`).

- `POST /login` — `{ username, password }` → trả `token`
- `POST /doi-mat-khau` — đổi mật khẩu admin
- `GET/POST/PUT/DELETE /residents` — quản lý danh sách cư dân
- `GET /lockers`, `POST /lockers` (thêm ngăn mới)
- `POST /lockers/:id/mo-khan-cap`, `/khoa`, `/mo-khoa`
- `GET /orders?status=...`
- `POST /orders/:id/huy-otp`, `POST /orders/:id/cap-lai-otp`
- `GET /canh-bao` — sự kiện cảnh báo + danh sách ngăn đang mở quá lâu
- `GET /lich-su?lockerId=&limit=` — lịch sử sự kiện / ảnh camera
- `GET /shippers`, `POST /shippers/:phone/mo-khoa`
- `GET /sms-log`
- `GET /tong-quan` — số liệu tổng quan dashboard

---

## Kịch bản kiểm thử end-to-end bằng curl (không cần phần cứng)

```bash
# 1. Shipper tạo đơn
curl -X POST http://localhost:3000/api/guihang -H "Content-Type: application/json" \
  -d '{"recipientPhone":"0901234567","shipperPhone":"0987654321","trackingCode":"SPX123456"}'
# -> lấy lockerId, orderId từ response

# 2. Giả lập thiết bị xác nhận cảm biến sau khi đóng cửa (CÓ hàng)
curl -X POST http://localhost:3000/api/device/A0X/dong-cua-gui \
  -H "Content-Type: application/json" -H "X-Device-Key: doi-khoa-thiet-bi-nay" \
  -d '{"doorClosed":true,"weightIncreased":true,"objectDetected":true}'

# 3. Xem OTP vừa "gửi" (vì SMS_PROVIDER=console mặc định chỉ log ra terminal
#    và lưu vào backend/data/db.json -> smsLog)

# 4. Người nhận nhập OTP
curl -X POST http://localhost:3000/api/device/keypad/mo-tu-nhan-hang \
  -H "Content-Type: application/json" -H "X-Device-Key: doi-khoa-thiet-bi-nay" \
  -d '{"otp":"XXXXXX"}'

# 5. Xác nhận đóng cửa sau khi lấy hàng
curl -X POST http://localhost:3000/api/device/A0X/dong-cua-nhan \
  -H "Content-Type: application/json" -H "X-Device-Key: doi-khoa-thiet-bi-nay" \
  -d '{"doorClosed":true,"weightBackToZero":true,"objectCleared":true}'
```
