// public.js - Trang "GỬI HÀNG KHÔNG CẦN ĐĂNG NHẬP" dành cho shipper.
// Không yêu cầu xác thực (đúng theo yêu cầu: shipper không cần tài khoản).

const express = require("express");
const router = express.Router();
const { transaction, readOnly } = require("../data/db");
const orderService = require("../services/orderService");

// Xem nhanh số ngăn còn trống (để hiển thị trên trang, không lộ thông tin nội bộ)
router.get("/lockers/tinh-trang", (req, res) => {
  const data = readOnly((d) => d);
  const total = data.lockers.length;
  const trong = data.lockers.filter((l) => l.status === "trong").length;
  res.json({ success: true, total, trong });
});

// Tạo đơn gửi hàng (bước "MỞ TỦ ĐỂ GỬI HÀNG")
router.post("/guihang", async (req, res) => {
  const { recipientPhone, recipientName, room, shipperPhone, trackingCode } = req.body || {};

  if (!shipperPhone) {
    return res.status(400).json({ success: false, message: "Vui lòng nhập số điện thoại shipper." });
  }

  const result = await transaction(async (data) => {
    return orderService.createOrder(data, {
      recipientPhone,
      recipientName,
      room,
      shipperPhone,
      trackingCode,
      viaKeypad: false,
    });
  });

  if (!result.success) return res.status(400).json(result);

  res.json({
    success: true,
    message: `Tủ ${result.order.lockerId} đã mở. Vui lòng đặt kiện hàng vào và đóng cửa.`,
    orderId: result.order.id,
    lockerId: result.order.lockerId,
  });
});

// Shipper (hoặc trang web) theo dõi trạng thái đơn theo thời gian thực bằng polling.
// Trạng thái thực sự được cập nhật bởi thiết bị (ESP32) sau khi đọc cảm biến,
// xem routes/device.js -> POST /api/device/:lockerId/dong-cua-gui
router.get("/guihang/:orderId/trang-thai", (req, res) => {
  const data = readOnly((d) => d);
  const order = data.orders.find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: "Không tìm thấy đơn hàng." });

  let message = "";
  if (order.status === "cho_dat_hang") message = `Tủ ${order.lockerId} đang mở, vui lòng đặt hàng và đóng cửa.`;
  else if (order.status === "co_hang") message = "Giao hàng thành công! OTP đã được gửi tới người nhận.";
  else if (order.status === "huy") message = `Đơn đã bị hủy: ${order.cancelReason || "không phát hiện kiện hàng"}.`;
  else message = order.status;

  res.json({
    success: true,
    status: order.status,
    lockerId: order.lockerId,
    message,
  });
});

module.exports = router;
