// public.js - Trang "GỬI HÀNG KHÔNG CẦN ĐĂNG NHẬP" dành cho shipper.
// Không yêu cầu xác thực (đúng theo yêu cầu: shipper không cần tài khoản).

console.log("✅ public.js loaded");
const express = require("express");
const router = express.Router();
const pool = require("../data/postgres");
const orderService = require("../services/orderService");

// Xem nhanh số ngăn còn trống (để hiển thị trên trang, không lộ thông tin nội bộ)
router.get("/lockers/tinh-trang", async (req, res) => {
  try {

    const totalResult = await pool.query(
      "SELECT COUNT(*) FROM lockers"
    );

    const emptyResult = await pool.query(
      "SELECT COUNT(*) FROM lockers WHERE status='trong'"
    );

    res.json({
      success: true,
      total: Number(totalResult.rows[0].count),
      trong: Number(emptyResult.rows[0].count),
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "Không đọc được trạng thái tủ",
    });
  }
});

// Tạo đơn gửi hàng (bước "MỞ TỦ ĐỂ GỬI HÀNG")
router.post("/guihang", async (req, res) => {
  console.log("🔥 POST /api/guihang");
  const { recipientPhone, recipientName, room, shipperPhone, trackingCode } = req.body || {};

  if (!shipperPhone) {
    return res.status(400).json({ success: false, message: "Vui lòng nhập số điện thoại shipper." });
  }

  const result = await orderService.createOrder({
    recipientPhone,
    recipientName,
    room,
    shipperPhone,
    trackingCode,
    viaKeypad: false,
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
router.get("/guihang/:orderId/trang-thai", async (req, res) => {

  const result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE id = $1
    `,
    [req.params.orderId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({
      success: false,
      message: "Không tìm thấy đơn hàng."
    });
  }

  const order = result.rows[0];

  let message = "";

  if (order.status === "cho_dat_hang")
    message = `Tủ ${order.locker_id} đang mở, vui lòng đặt hàng và đóng cửa.`;

  else if (order.status === "co_hang")
    message = "Giao hàng thành công! OTP đã được gửi tới người nhận.";

  else if (order.status === "huy")
    message = `Đơn đã bị hủy.`;

  else
    message = order.status;

  res.json({
    success: true,
    status: order.status,
    lockerId: order.locker_id,
    message,
  });

});
module.exports = router;
