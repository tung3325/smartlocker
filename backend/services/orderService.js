// orderService.js - Logic nghiệp vụ tạo đơn gửi hàng (dùng chung cho web công khai
// và luồng bàn phím fallback khi shipper không có Internet).

const { nanoid } = require("nanoid");
const antifraud = require("./antifraud");

function pickRandomEmptyLocker(data) {
  const emptyLockers = data.lockers.filter((l) => l.status === "trong");
  if (emptyLockers.length === 0) return null;
  const idx = Math.floor(Math.random() * emptyLockers.length);
  return emptyLockers[idx];
}

// input: { recipientPhone, recipientName, room, shipperPhone, trackingCode, viaKeypad }
// Trả về { success, message, order?, locker? }
function createOrder(data, input) {
  const recipientPhone = (input.recipientPhone || "").trim();
  const shipperPhone = (input.shipperPhone || "").trim();

  if (!recipientPhone) {
    return { success: false, message: "Vui lòng nhập số điện thoại người nhận." };
  }

  // 1. SĐT người nhận phải nằm trong danh sách cư dân/sinh viên được phép nhận hàng
  const resident = antifraud.findActiveResident(data, recipientPhone);
  if (!resident) {
    return {
      success: false,
      message: "Số điện thoại người nhận không có trong danh sách cư dân/sinh viên được phép nhận hàng.",
    };
  }

  // 2. Nếu có SĐT shipper -> kiểm tra khóa tạm + rate limit
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

  // 3. Chỉ 1 yêu cầu xử lý tại một thời điểm & phải còn ngăn trống
  const locker = pickRandomEmptyLocker(data);
  if (!locker) {
    return { success: false, message: "Hiện không còn ngăn tủ trống, vui lòng quay lại sau." };
  }

  const now = new Date().toISOString();
  const order = {
    id: `DH-${Date.now()}-${nanoid(4)}`,
    trackingCode: input.trackingCode || null,
    recipientPhone,
    recipientName: input.recipientName || resident.name,
    room: input.room || resident.room,
    shipperPhone: shipperPhone || null,
    lockerId: locker.id,
    status: "cho_dat_hang", // đã mở tủ, chờ shipper đặt hàng & đóng cửa
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

  data.orders.push(order);
  locker.status = "dang_mo";
  locker.currentOrderId = order.id;
  locker.updatedAt = now;
  locker.pendingCommand = null;

  data.events.push({
    id: `ev-${Date.now()}-${nanoid(4)}`,
    lockerId: locker.id,
    orderId: order.id,
    type: "mo_tu_gui_hang",
    note: `Mở ${locker.id} cho đơn ${order.id} (${input.viaKeypad ? "qua bàn phím" : "qua web"})`,
    createdAt: now,
  });

  return { success: true, order, locker };
}

module.exports = { createOrder, pickRandomEmptyLocker };
