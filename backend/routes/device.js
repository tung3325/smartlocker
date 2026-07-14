// device.js - API dành cho thiết bị ESP32 gắn tại tủ khóa.
// Mọi request đều phải kèm header X-Device-Key (xem middleware/auth.js).
// Đây là nơi hiện thực hoá phần "cảm biến xác nhận" mà web/app không tự làm được:
//   - Xác nhận đóng cửa sau khi GỬI hàng (door + load cell + object sensor)
//   - Mở tủ đúng ngăn khi người nhận bấm OTP trên keypad 4x4
//   - Xác nhận đóng cửa sau khi NHẬN hàng (huỷ OTP, giải phóng ngăn)
//   - Bàn phím fallback A/B/*/#/D khi shipper không có Internet
//   - Upload ảnh camera khi tủ mở
//   - Poll lệnh từ admin (mở khẩn cấp / khóa lại / vô hiệu hoá ngăn lỗi)

const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { nanoid } = require("nanoid");
const { transaction } = require("../data/db");
const { requireDeviceKey } = require("../middleware/auth");
const otpService = require("../services/otp");
const smsService = require("../services/sms");
const antifraud = require("../services/antifraud");
const orderService = require("../services/orderService");

router.use(requireDeviceKey);

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "camera");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `${req.params.lockerId}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function addEvent(data, { lockerId, orderId, type, note, imagePath }) {
  data.events.push({
    id: `ev-${Date.now()}-${nanoid(4)}`,
    lockerId,
    orderId: orderId || null,
    type,
    note,
    imagePath: imagePath || null,
    createdAt: new Date().toISOString(),
  });
}

// ============ 1. GỬI HÀNG - xác nhận cảm biến sau khi shipper đóng cửa ============
// body: { doorClosed: bool, weightIncreased: bool, objectDetected: bool }
router.post("/:lockerId/dong-cua-gui", async (req, res) => {
  const { lockerId } = req.params;
  const { doorClosed, weightIncreased, objectDetected } = req.body || {};

  const result = await transaction(async (data) => {
    const locker = data.lockers.find((l) => l.id === lockerId);
    if (!locker) return { success: false, message: "Không tìm thấy ngăn tủ." };
    const order = data.orders.find((o) => o.id === locker.currentOrderId && o.status === "cho_dat_hang");
    if (!order) return { success: false, message: "Ngăn tủ này hiện không có đơn nào đang chờ đặt hàng." };

    const now = new Date().toISOString();
    const hasPackage = !!doorClosed && !!weightIncreased && !!objectDetected;

    if (hasPackage) {
      const otpRec = otpService.makeOtpRecord();
      order.status = "co_hang";
      order.otpHash = otpRec.otpHash;
      order.otpCreatedAt = otpRec.otpCreatedAt;
      order.otpExpiresAt = otpRec.otpExpiresAt;
      order.otpUsed = false;
      order.updatedAt = now;

      locker.status = "co_hang";
      locker.updatedAt = now;

      addEvent(data, {
        lockerId,
        orderId: order.id,
        type: "xac_nhan_co_hang",
        note: `Xác nhận có kiện hàng tại ${lockerId}, đã tạo OTP.`,
      });

      if (order.shipperPhone) antifraud.resetStrikes(data, order.shipperPhone);

      return { success: true, hasPackage: true, order: { ...order }, otpPlain: otpRec.otp };
    } else {
      order.status = "huy";
      order.cancelReason = "Đóng cửa nhưng không phát hiện kiện hàng hợp lệ (cảm biến).";
      order.updatedAt = now;

      locker.status = "trong";
      locker.currentOrderId = null;
      locker.updatedAt = now;

      addEvent(data, {
        lockerId,
        orderId: order.id,
        type: "canh_bao_khong_co_hang",
        note: `CẢNH BÁO: đóng cửa ${lockerId} nhưng không phát hiện kiện hàng. Đơn ${order.id} bị hủy.`,
      });

      let strikeInfo = null;
      if (order.shipperPhone) {
        strikeInfo = antifraud.recordFailedDelivery(data, order.shipperPhone);
        if (strikeInfo.blocked) {
          addEvent(data, {
            lockerId,
            orderId: order.id,
            type: "khoa_tam_shipper",
            note: `SĐT shipper ${order.shipperPhone} bị khóa tạm do nhiều lần mở tủ không đặt hàng.`,
          });
        }
      }

      return { success: true, hasPackage: false, order: { ...order }, strikeInfo };
    }
  });

  if (!result.success) return res.status(400).json(result);

  if (result.hasPackage) {
    const order = result.order;
    const message = `SMART LOCKER: Ban co kien hang tai tu ${order.lockerId}. Ma mo tu: ${result.otpPlain}. Ma chi dung mot lan.`;
    await smsService.sendSms(order.recipientPhone, message);
  }

  res.json({ success: true, hasPackage: result.hasPackage });
});

// ============ 2. NHẬN HÀNG - người nhận bấm OTP trên keypad ============
// body: { otp: "583921" }
router.post("/keypad/mo-tu-nhan-hang", async (req, res) => {
  const { otp } = req.body || {};
  if (!otp) return res.status(400).json({ success: false, message: "Thiếu mã OTP." });

  const result = await transaction(async (data) => {
    const matched = data.orders.find((o) => o.status === "co_hang" && otpService.verifyOtp(o, otp).ok);

    if (!matched) {
      return { success: false, message: "Mã OTP không đúng, đã hết hạn, hoặc đã được sử dụng." };
    }

    const locker = data.lockers.find((l) => l.id === matched.lockerId);
    const now = new Date().toISOString();
    matched.status = "da_mo_cho_nhan";
    matched.updatedAt = now;
    matched.doorOpenedAt = now;
    if (locker) {
      locker.status = "dang_mo_nhan";
      locker.updatedAt = now;
    }

    addEvent(data, {
      lockerId: matched.lockerId,
      orderId: matched.id,
      type: "mo_tu_nhan_hang",
      note: `Người nhận nhập đúng OTP, mở ${matched.lockerId} để lấy hàng.`,
    });

    return { success: true, lockerId: matched.lockerId };
  });

  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// ============ 3. Xác nhận cảm biến sau khi người nhận lấy hàng & đóng cửa ============
// body: { doorClosed: bool, weightBackToZero: bool, objectCleared: bool }
router.post("/:lockerId/dong-cua-nhan", async (req, res) => {
  const { lockerId } = req.params;
  const { doorClosed, weightBackToZero, objectCleared } = req.body || {};

  const result = await transaction(async (data) => {
    const locker = data.lockers.find((l) => l.id === lockerId);
    if (!locker) return { success: false, message: "Không tìm thấy ngăn tủ." };
    const order = data.orders.find((o) => o.id === locker.currentOrderId && o.status === "da_mo_cho_nhan");
    if (!order) return { success: false, message: "Ngăn tủ này hiện không ở trạng thái chờ nhận hàng." };

    if (!doorClosed || !weightBackToZero || !objectCleared) {
      addEvent(data, {
        lockerId,
        orderId: order.id,
        type: "canh_bao_lay_hang_khong_hoan_tat",
        note: `Cảm biến chưa xác nhận lấy hết hàng khỏi ${lockerId}, giữ nguyên trạng thái chờ.`,
      });
      return { success: true, completed: false };
    }

    const now = new Date().toISOString();
    order.status = "hoan_thanh";
    order.otpUsed = true;
    order.updatedAt = now;

    locker.status = "trong";
    locker.currentOrderId = null;
    locker.updatedAt = now;

    addEvent(data, {
      lockerId,
      orderId: order.id,
      type: "hoan_tat_nhan_hang",
      note: `Đã lấy hàng khỏi ${lockerId}, hủy OTP, giải phóng ngăn.`,
    });

    return { success: true, completed: true };
  });

  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// ============ 4. Bàn phím fallback (shipper không có Internet) ============
// Quy ước: A = gửi hàng, B = nhận hàng, * = xóa, # = xác nhận, D = xóa 1 ký tự.
// Thiết bị tự xử lý việc đọc phím, chỉ gọi API này khi đã có đủ SĐT người nhận.
// body: { recipientPhone }
router.post("/keypad/gui-hang", async (req, res) => {
  const { recipientPhone } = req.body || {};

  const result = await transaction(async (data) => {
    return orderService.createOrder(data, { recipientPhone, viaKeypad: true });
  });

  if (!result.success) return res.status(400).json(result);
  res.json({
    success: true,
    lockerId: result.order.lockerId,
    orderId: result.order.id,
    lcdLine1: `MO TU ${result.order.lockerId}`,
    lcdLine2: "HAY DAT HANG",
  });
});

// ============ 5. Upload ảnh camera khi tủ mở ============
router.post("/:lockerId/camera", upload.single("image"), async (req, res) => {
  const { lockerId } = req.params;
  if (!req.file) return res.status(400).json({ success: false, message: "Thiếu file ảnh (field 'image')." });

  await transaction(async (data) => {
    const locker = data.lockers.find((l) => l.id === lockerId);
    addEvent(data, {
      lockerId,
      orderId: locker ? locker.currentOrderId : null,
      type: "chup_anh_camera",
      note: `Chụp ảnh khi mở ${lockerId}.`,
      imagePath: `/uploads/camera/${req.file.filename}`,
    });
  });

  res.json({ success: true, path: `/uploads/camera/${req.file.filename}` });
});

// ============ 6. Heartbeat + lấy lệnh đang chờ từ admin ============
router.get("/:lockerId/lenh", async (req, res) => {
  const { lockerId } = req.params;
  const result = await transaction(async (data) => {
    const locker = data.lockers.find((l) => l.id === lockerId);
    if (!locker) return { success: false, message: "Không tìm thấy ngăn tủ." };
    locker.lastSeenAt = new Date().toISOString();
    return { success: true, pendingCommand: locker.pendingCommand || null, lockerStatus: locker.status };
  });
  res.json(result);
});

router.post("/:lockerId/lenh/hoan-thanh", async (req, res) => {
  const { lockerId } = req.params;
  await transaction(async (data) => {
    const locker = data.lockers.find((l) => l.id === lockerId);
    if (!locker) return;
    addEvent(data, {
      lockerId,
      type: "hoan_tat_lenh",
      note: `Thiết bị đã thực hiện xong lệnh: ${locker.pendingCommand ? locker.pendingCommand.type : "?"}`,
    });
    locker.pendingCommand = null;
  });
  res.json({ success: true });
});

module.exports = router;
