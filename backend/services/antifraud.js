// antifraud.js - Toàn bộ logic "Cách chống người lạ mở tủ phá hệ thống"
// theo đúng yêu cầu nghiệp vụ:
//  - SĐT người nhận phải nằm trong danh sách cư dân
//  - Mỗi SĐT shipper chỉ được tạo giới hạn số đơn / khoảng thời gian
//  - Mở tủ nhưng không đặt hàng nhiều lần -> khóa tạm SĐT shipper
//  - Tủ tự khóa lại nếu mở quá lâu (kiểm tra + cảnh báo)

const SHIPPER_MAX_ORDERS = parseInt(process.env.SHIPPER_MAX_ORDERS || "5", 10);
const SHIPPER_WINDOW_MINUTES = parseInt(process.env.SHIPPER_WINDOW_MINUTES || "60", 10);
const SHIPPER_STRIKE_LIMIT = parseInt(process.env.SHIPPER_STRIKE_LIMIT || "3", 10);
const SHIPPER_BLOCK_MINUTES = parseInt(process.env.SHIPPER_BLOCK_MINUTES || "120", 10);
const DOOR_OPEN_TIMEOUT_SECONDS = parseInt(process.env.DOOR_OPEN_TIMEOUT_SECONDS || "60", 10);

function getStat(data, phone) {
  if (!data.shipperStats[phone]) {
    data.shipperStats[phone] = { history: [], strikes: 0, blockedUntil: null };
  }
  return data.shipperStats[phone];
}

// Kiểm tra SĐT người nhận có trong danh sách cư dân đang hoạt động không
function findActiveResident(data, phone) {
  return data.residents.find((r) => r.phone === phone && r.active !== false) || null;
}

// Kiểm tra SĐT shipper có đang bị khóa tạm không
function isShipperBlocked(data, phone) {
  const stat = getStat(data, phone);
  if (stat.blockedUntil && new Date(stat.blockedUntil) > new Date()) {
    return { blocked: true, until: stat.blockedUntil };
  }
  return { blocked: false };
}

// Kiểm tra & ghi nhận việc shipper tạo 1 đơn mới - áp dụng rate limit
function checkAndRecordShipperOrder(data, phone) {
  const stat = getStat(data, phone);
  const now = Date.now();
  const windowMs = SHIPPER_WINDOW_MINUTES * 60 * 1000;
  stat.history = stat.history.filter((t) => now - t < windowMs);

  if (stat.history.length >= SHIPPER_MAX_ORDERS) {
    return {
      allowed: false,
      reason: `SĐT shipper đã tạo quá ${SHIPPER_MAX_ORDERS} đơn trong ${SHIPPER_WINDOW_MINUTES} phút. Vui lòng thử lại sau.`,
    };
  }
  stat.history.push(now);
  return { allowed: true };
}

// Ghi nhận 1 lần "mở tủ nhưng không đặt hàng" -> cộng dồn strike, tự khóa nếu vượt ngưỡng
function recordFailedDelivery(data, phone) {
  const stat = getStat(data, phone);
  stat.strikes = (stat.strikes || 0) + 1;
  let blocked = false;
  if (stat.strikes >= SHIPPER_STRIKE_LIMIT) {
    const until = new Date(Date.now() + SHIPPER_BLOCK_MINUTES * 60 * 1000).toISOString();
    stat.blockedUntil = until;
    stat.strikes = 0; // reset đếm sau khi đã khóa
    blocked = true;
  }
  return { blocked, strikes: stat.strikes };
}

function resetStrikes(data, phone) {
  const stat = getStat(data, phone);
  stat.strikes = 0;
}

module.exports = {
  SHIPPER_MAX_ORDERS,
  SHIPPER_WINDOW_MINUTES,
  SHIPPER_STRIKE_LIMIT,
  SHIPPER_BLOCK_MINUTES,
  DOOR_OPEN_TIMEOUT_SECONDS,
  findActiveResident,
  isShipperBlocked,
  checkAndRecordShipperOrder,
  recordFailedDelivery,
  resetStrikes,
};
