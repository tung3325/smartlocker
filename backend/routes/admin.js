// admin.js - Toàn bộ nghiệp vụ dành cho admin (yêu cầu đăng nhập bằng JWT).
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { nanoid } = require("nanoid");
const { transaction, readOnly } = require("../data/db");
const pool = require("../data/postgres");
const { requireAdmin } = require("../middleware/auth");
const otpService = require("../services/otp");
const smsService = require("../services/sms");
const antifraud = require("../services/antifraud");

// ---------- Đăng nhập ----------
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    const result = await pool.query(
      "SELECT * FROM admins WHERE username=$1 LIMIT 1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Sai tên đăng nhập hoặc mật khẩu.",
      });
    }

    const admin = result.rows[0];
    console.log(admin);

    // Cho phép đăng nhập nếu đúng mật khẩu thô hoặc khớp bcrypt
    let ok = false;
    if (admin.password_hash === password) {
      ok = true;
    } else {
      try {
        ok = bcrypt.compareSync(password || "", admin.password_hash);
      } catch (e) {
        ok = false;
      }
    }

    if (!ok) {
      return res.status(401).json({
        success: false,
        message: "Sai tên đăng nhập hoặc mật khẩu.",
      });
    }

    const token = jwt.sign(
      {
        id: admin.id,
        username: admin.username,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "12h",
      }
    );

    res.json({
      success: true,
      token,
      username: admin.username,
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "Lỗi máy chủ",
    });
  }
});

router.post("/doi-mat-khau", requireAdmin, async (req, res) => {
  const { matKhauCu, matKhauMoi } = req.body || {};
  const result = await transaction(async (data) => {
    const admin = data.admins.find((a) => a.id === req.admin.id);
    if (!admin) return { success: false, message: "Không tìm thấy tài khoản." };
    if (!bcrypt.compareSync(matKhauCu || "", admin.passwordHash)) {
      return { success: false, message: "Mật khẩu cũ không đúng." };
    }
    if (!matKhauMoi || matKhauMoi.length < 6) {
      return { success: false, message: "Mật khẩu mới phải từ 6 ký tự trở lên." };
    }
    admin.passwordHash = bcrypt.hashSync(matKhauMoi, 10);
    return { success: true };
  });
  res.json(result);
});

router.use(requireAdmin);

// ---------- 1. Quản lý danh sách cư dân / sinh viên ----------
router.get("/residents", (req, res) => {
  const data = readOnly((d) => d);
  res.json({ success: true, residents: data.residents });
});

router.post("/residents", async (req, res) => {
  const { phone, name, room } = req.body || {};
  if (!phone || !name) return res.status(400).json({ success: false, message: "Thiếu số điện thoại hoặc tên." });
  const result = await transaction(async (data) => {
    if (data.residents.some((r) => r.phone === phone)) {
      return { success: false, message: "Số điện thoại này đã tồn tại trong danh sách." };
    }
    const resident = { id: `res-${nanoid(8)}`, phone, name, room: room || "", active: true };
    data.residents.push(resident);
    return { success: true, resident };
  });
  res.json(result);
});

router.put("/residents/:id", async (req, res) => {
  const { name, room, active } = req.body || {};
  const result = await transaction(async (data) => {
    const resident = data.residents.find((r) => r.id === req.params.id);
    if (!resident) return { success: false, message: "Không tìm thấy cư dân." };
    if (name !== undefined) resident.name = name;
    if (room !== undefined) resident.room = room;
    if (active !== undefined) resident.active = active;
    return { success: true, resident };
  });
  res.json(result);
});

router.delete("/residents/:id", async (req, res) => {
  const result = await transaction(async (data) => {
    const idx = data.residents.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return { success: false, message: "Không tìm thấy cư dân." };
    data.residents.splice(idx, 1);
    return { success: true };
  });
  res.json(result);
});

// ---------- 2. Trạng thái các ngăn tủ ----------
router.get("/lockers", (req, res) => {
  const data = readOnly((d) => d);
  res.json({ success: true, lockers: data.lockers });
});

// Thêm ngăn tủ mới (mở rộng hệ thống thêm cabinet/ngăn)
router.post("/lockers", async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ success: false, message: "Thiếu mã ngăn tủ." });
  const result = await transaction(async (data) => {
    if (data.lockers.some((l) => l.id === id)) {
      return { success: false, message: "Mã ngăn tủ đã tồn tại." };
    }
    data.lockers.push({
      id,
      status: "trong",
      currentOrderId: null,
      pendingCommand: null,
      updatedAt: new Date().toISOString(),
    });
    return { success: true };
  });
  res.json(result);
});

// Mở tủ khẩn cấp (ví dụ: kỹ thuật viên cần lấy hàng ra khi lỗi hệ thống)
router.post("/lockers/:id/mo-khan-cap", async (req, res) => {
  const { reason } = req.body || {};
  const result = await transaction(async (data) => {
    const locker = data.lockers.find((l) => l.id === req.params.id);
    if (!locker) return { success: false, message: "Không tìm thấy ngăn tủ." };
    locker.pendingCommand = { type: "mo_khan_cap", issuedAt: new Date().toISOString(), reason: reason || "" };
    data.events.push({
      id: `ev-${Date.now()}-${nanoid(4)}`,
      lockerId: locker.id,
      orderId: locker.currentOrderId,
      type: "lenh_mo_khan_cap",
      note: `Admin ${req.admin.username} ra lệnh mở khẩn cấp ${locker.id}: ${reason || "không nêu lý do"}`,
      createdAt: new Date().toISOString(),
    });
    return { success: true };
  });
  res.json(result);
});

// Khóa ngăn bị lỗi (không cho hệ thống chọn ngăn này khi random nữa)
router.post("/lockers/:id/khoa", async (req, res) => {
  const result = await transaction(async (data) => {
    const locker = data.lockers.find((l) => l.id === req.params.id);
    if (!locker) return { success: false, message: "Không tìm thấy ngăn tủ." };
    locker.status = "loi";
    locker.pendingCommand = { type: "khoa_lai", issuedAt: new Date().toISOString() };
    data.events.push({
      id: `ev-${Date.now()}-${nanoid(4)}`,
      lockerId: locker.id,
      type: "khoa_ngan_loi",
      note: `Admin ${req.admin.username} khóa ngăn ${locker.id} do lỗi.`,
      createdAt: new Date().toISOString(),
    });
    return { success: true };
  });
  res.json(result);
});

router.post("/lockers/:id/mo-khoa", async (req, res) => {
  const result = await transaction(async (data) => {
    const locker = data.lockers.find((l) => l.id === req.params.id);
    if (!locker) return { success: false, message: "Không tìm thấy ngăn tủ." };
    locker.status = "trong";
    locker.currentOrderId = null;
    data.events.push({
      id: `ev-${Date.now()}-${nanoid(4)}`,
      lockerId: locker.id,
      type: "mo_khoa_ngan",
      note: `Admin ${req.admin.username} mở khóa, đưa ngăn ${locker.id} về trạng thái trống.`,
      createdAt: new Date().toISOString(),
    });
    return { success: true };
  });
  res.json(result);
});

// ---------- 3. Đơn hàng đang chờ / tất cả đơn ----------
router.get("/orders", (req, res) => {
  const { status } = req.query;
  const data = readOnly((d) => d);
  let orders = data.orders;
  if (status) orders = orders.filter((o) => o.status === status);
  orders = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // Không trả otpHash ra ngoài
  orders = orders.map(({ otpHash, ...rest }) => rest);
  res.json({ success: true, orders });
});

// ---------- 4. Hủy / cấp lại OTP ----------
router.post("/orders/:id/huy-otp", async (req, res) => {
  const result = await transaction(async (data) => {
    const order = data.orders.find((o) => o.id === req.params.id);
    if (!order) return { success: false, message: "Không tìm thấy đơn hàng." };
    if (order.status !== "co_hang") return { success: false, message: "Đơn hàng không ở trạng thái có thể hủy OTP." };
    order.status = "huy";
    order.cancelReason = `Admin ${req.admin.username} hủy OTP thủ công.`;
    order.updatedAt = new Date().toISOString();

    const locker = data.lockers.find((l) => l.id === order.lockerId);
    if (locker) {
      locker.status = "loi"; // chờ admin kiểm tra thực tế trước khi mở lại cho khách khác
    }
    data.events.push({
      id: `ev-${Date.now()}-${nanoid(4)}`,
      lockerId: order.lockerId,
      orderId: order.id,
      type: "huy_otp",
      note: `Admin ${req.admin.username} hủy OTP của đơn ${order.id}.`,
      createdAt: new Date().toISOString(),
    });
    return { success: true };
  });
  res.json(result);
});

router.post("/orders/:id/cap-lai-otp", async (req, res) => {
  const result = await transaction(async (data) => {
    const order = data.orders.find((o) => o.id === req.params.id);
    if (!order) return { success: false, message: "Không tìm thấy đơn hàng." };
    if (order.status !== "co_hang") return { success: false, message: "Chỉ cấp lại OTP cho đơn đang có hàng chờ nhận." };
    const otpRec = otpService.makeOtpRecord();
    order.otpHash = otpRec.otpHash;
    order.otpCreatedAt = otpRec.otpCreatedAt;
    order.otpExpiresAt = otpRec.otpExpiresAt;
    order.otpUsed = false;
    order.updatedAt = new Date().toISOString();
    data.events.push({
      id: `ev-${Date.now()}-${nanoid(4)}`,
      lockerId: order.lockerId,
      orderId: order.id,
      type: "cap_lai_otp",
      note: `Admin ${req.admin.username} cấp lại OTP cho đơn ${order.id}.`,
      createdAt: new Date().toISOString(),
    });
    return { success: true, order: { ...order }, otpPlain: otpRec.otp };
  });

  if (!result.success) return res.status(400).json(result);

  const message = `SMART LOCKER: Ma mo tu moi cua ban tai tu ${result.order.lockerId} la: ${result.otpPlain}. Ma chi dung mot lan.`;
  await smsService.sendSms(result.order.recipientPhone, message);

  res.json({ success: true });
});

// ---------- 5. Cảnh báo (mở nhưng không đặt hàng, cửa mở quá lâu) ----------
router.get("/canh-bao", (req, res) => {
  const data = readOnly((d) => d);
  const warningEvents = data.events.filter((e) =>
    ["canh_bao_khong_co_hang", "khoa_tam_shipper", "canh_bao_lay_hang_khong_hoan_tat", "canh_bao_mo_qua_lau"].includes(
      e.type
    )
  );

  // Kiểm tra realtime các ngăn đang mở quá lâu
  const now = Date.now();
  const timeoutMs = antifraud.DOOR_OPEN_TIMEOUT_SECONDS * 1000;
  const openTooLong = data.lockers
    .filter((l) => (l.status === "dang_mo" || l.status === "dang_mo_nhan") && l.updatedAt)
    .filter((l) => now - new Date(l.updatedAt).getTime() > timeoutMs)
    .map((l) => ({ lockerId: l.id, status: l.status, openSince: l.updatedAt }));

  res.json({
    success: true,
    warningEvents: [...warningEvents].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    openTooLong,
  });
});

// ---------- 6. Lịch sử mở cửa / camera ----------
router.get("/lich-su", (req, res) => {
  const { lockerId, limit } = req.query;
  const data = readOnly((d) => d);
  let events = data.events;
  if (lockerId) events = events.filter((e) => e.lockerId === lockerId);
  events = [...events].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (limit) events = events.slice(0, parseInt(limit, 10));
  res.json({ success: true, events });
});

// ---------- 7. Danh sách SĐT shipper + số lần vi phạm + trạng thái khóa ----------
router.get("/shippers", (req, res) => {
  const data = readOnly((d) => d);
  const shippers = Object.entries(data.shipperStats).map(([phone, stat]) => ({
    phone,
    soLanTaoDon: stat.history.length,
    strikes: stat.strikes,
    blockedUntil: stat.blockedUntil,
    dangBiKhoa: !!(stat.blockedUntil && new Date(stat.blockedUntil) > new Date()),
  }));
  res.json({ success: true, shippers });
});

router.post("/shippers/:phone/mo-khoa", async (req, res) => {
  const result = await transaction(async (data) => {
    const stat = data.shipperStats[req.params.phone];
    if (!stat) return { success: false, message: "Không tìm thấy SĐT shipper này." };
    stat.blockedUntil = null;
    stat.strikes = 0;
    return { success: true };
  });
  res.json(result);
});

// ---------- 8. Nhật ký SMS đã gửi (phục vụ kiểm tra/đối soát) ----------
router.get("/sms-log", (req, res) => {
  const data = readOnly((d) => d);
  const log = [...data.smsLog].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, log });
});

// ---------- 9. Tổng quan dashboard ----------
router.get("/tong-quan", (req, res) => {
  const data = readOnly((d) => d);
  res.json({
    success: true,
    tongNgan: data.lockers.length,
    ngangTrong: data.lockers.filter((l) => l.status === "trong").length,
    ngangCoHang: data.lockers.filter((l) => l.status === "co_hang").length,
    ngangLoi: data.lockers.filter((l) => l.status === "loi").length,
    donChoXuLy: data.orders.filter((o) => ["cho_dat_hang", "co_hang", "da_mo_cho_nhan"].includes(o.status)).length,
    tongCuDan: data.residents.length,
  });
});

module.exports = router;
