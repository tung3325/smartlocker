// orderService.js - Logic nghiệp vụ tạo đơn gửi hàng (dùng chung cho web công khai
// và luồng bàn phím fallback khi shipper không có Internet).

const { nanoid } = require("nanoid");
const pool = require("../data/postgres");
const antifraud = require("./antifraud");

async function pickRandomEmptyLocker() {
  const result = await pool.query(`
      SELECT *
      FROM lockers
      WHERE status='trong'
      ORDER BY RANDOM()
      LIMIT 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

// input: { recipientPhone, recipientName, room, shipperPhone, trackingCode, viaKeypad }
// Trả về { success, message, order?, locker? }
async function createOrder(input) {
  const recipientPhone = (input.recipientPhone || "").trim();
  const shipperPhone = (input.shipperPhone || "").trim();

  if (!recipientPhone) {
    return { success: false, message: "Vui lòng nhập số điện thoại người nhận." };
  }

  // 1. SĐT người nhận phải nằm trong danh sách cư dân/sinh viên được phép nhận hàng
  const residentResult = await pool.query(
    `
  SELECT *
  FROM residents
  WHERE phone = $1
    AND active = true
  LIMIT 1
  `,
    [recipientPhone]
  );

  if (residentResult.rows.length === 0) {
    return {
      success: false,
      message:
        "Số điện thoại người nhận không có trong danh sách cư dân.",
    };
  }

  const resident = residentResult.rows[0];


  const recipientEmail = resident.email;

  if (!recipientEmail) {
    return {
      success: false,
      message: "Người nhận chưa có email.",
    };
  }

  // 2. Nếu có SĐT shipper -> kiểm tra khóa tạm + rate limit
  /*****
  if (shipperPhone) {
    const blockCheck = antifraud.isShipperBlocked(data, shipperPhone);
    if (blockCheck.blocked) {
      return {
        success: false,
        message: `Số điện thoại của bạn đang bị tạm khóa do có nhiều lần mở tủ không đặt hàng. Vui lòng thử lại sau ${new Date(
          blockCheck.until
        ).toLocaleString("vi-VN")} hoặc liên hệ admin.`,
      };
    }
    const rateCheck = antifraud.checkAndRecordShipperOrder(data, shipperPhone);
    if (!rateCheck.allowed) {
      return { success: false, message: rateCheck.reason };
    }
  }
  *****/
  // 3. Chỉ 1 yêu cầu xử lý tại một thời điểm & phải còn ngăn trống
  const locker = await pickRandomEmptyLocker();
  if (!locker) {
    return { success: false, message: "Hiện không còn ngăn tủ trống, vui lòng quay lại sau." };
  }

  const now = new Date().toISOString();
  const order = {
    id: `DH-${Date.now()}-${nanoid(4)}`,
    trackingCode: input.trackingCode || null,

    recipientPhone,
    recipientEmail,                // <-- thêm dòng này

    recipientName: input.recipientName || resident.name,
    room: input.room || resident.room,

    shipperPhone: shipperPhone || null,

    lockerId: locker.id,

    status: "cho_dat_hang",

    viaKeypad: !!input.viaKeypad,

    otpHash: null,
    otpCreatedAt: null,
    otpExpiresAt: null,
    otpUsed: false,

    doorOpenedAt: now,
    createdAt: now,
    updatedAt: now,

    cancelReason: null,
  };

  await pool.query(

    `
INSERT INTO orders (
  id,
  tracking_code,
  recipient_phone,
  recipient_email,
  recipient_name,
  room,
  shipper_phone,
  locker_id,
  status,
  via_keypad,
  otp_hash,
  otp_created_at,
  otp_expires_at,
  otp_used,
  door_opened_at,
  created_at,
  updated_at,
  cancel_reason
)
VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
  $11,$12,$13,$14,$15,$16,$17,$18
)
`,

    [
      order.id,
      order.trackingCode,
      recipientPhone,
      recipientEmail,
      order.recipientName,
      order.room,
      order.shipperPhone,
      order.lockerId,
      order.status,
      order.viaKeypad,
      null,
      null,
      null,
      false,
      order.doorOpenedAt,
      order.createdAt,
      order.updatedAt,
      null
    ]
  );
  const pendingCommand = JSON.stringify({
    id: `cmd-${Date.now()}-${nanoid(4)}`,
    type: "mo_tu_gui_hang",
    lockerId: locker.id,
    orderId: order.id,
    issuedAt: now,
  });

  await pool.query(
    `
UPDATE lockers
SET
    status = $1,
    current_order_id = $2,
    pending_command = $3,
    updated_at = $4
WHERE id = $5
`,
    [
      "dang_mo",
      order.id,
      pendingCommand,
      now,
      locker.id,
    ]
  );

  await pool.query(
    `
INSERT INTO events (
    id,
    locker_id,
    order_id,
    type,
    note,
    created_at
)
VALUES ($1,$2,$3,$4,$5,$6)
`,
    [
      `ev-${Date.now()}-${nanoid(4)}`,
      locker.id,
      order.id,
      "mo_tu_gui_hang",
      `Mở ${locker.id} cho đơn ${order.id} (${input.viaKeypad ? "qua bàn phím" : "qua web"})`,
      now,
    ]
  );

  locker.status = "dang_mo";
  locker.currentOrderId = order.id;
  locker.pendingCommand = JSON.parse(pendingCommand);
  locker.updatedAt = now;
  return { success: true, order, locker };
}

module.exports = { createOrder, pickRandomEmptyLocker };
