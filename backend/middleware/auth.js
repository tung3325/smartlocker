const jwt = require("jsonwebtoken");
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: "Thiếu token đăng nhập admin" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Token không hợp lệ hoặc đã hết hạn" });
  }
}

// Thiết bị ESP32 (tủ khóa) phải gửi kèm header X-Device-Key trùng với DEVICE_API_KEY
// trong .env. Đây là lớp bảo vệ tối thiểu để tránh người ngoài gọi thẳng API
// giả lập cảm biến/mở tủ mà không qua phần cứng thật.
function requireDeviceKey(req, res, next) {


  const key = req.headers["x-device-key"];

  if (!key || key !== process.env.DEVICE_API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Sai hoặc thiếu khóa thiết bị (X-Device-Key)"
    });
  }

  next();
}
module.exports = {
  requireAdmin,
  requireDeviceKey
};