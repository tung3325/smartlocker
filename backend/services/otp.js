// otp.js - Sinh mã OTP 6 số, băm (hash) trước khi lưu, kiểm tra hạn dùng và dùng-một-lần.
const crypto = require("crypto");

const OTP_LENGTH = parseInt(process.env.OTP_LENGTH || "6", 10);
const OTP_EXPIRE_HOURS = parseInt(process.env.OTP_EXPIRE_HOURS || "48", 10);

function generateOtp() {
  const max = 10 ** OTP_LENGTH;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(OTP_LENGTH, "0");
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function makeOtpRecord() {
  const otp = generateOtp();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_EXPIRE_HOURS * 3600 * 1000);
  return {
    otp, // trả về 1 lần để gửi SMS, KHÔNG lưu bản rõ vào DB
    otpHash: hashOtp(otp),
    otpCreatedAt: now.toISOString(),
    otpExpiresAt: expiresAt.toISOString(),
    otpUsed: false,
  };
}

function verifyOtp(order, otpInput) {
  if (!order) return { ok: false, reason: "khong_tim_thay_don" };
  if (order.otpUsed) return { ok: false, reason: "otp_da_su_dung" };
  if (!order.otpExpiresAt || new Date(order.otpExpiresAt) < new Date()) {
    return { ok: false, reason: "otp_het_han" };
  }
  if (order.otpHash !== hashOtp(otpInput)) {
    return { ok: false, reason: "otp_sai" };
  }
  return { ok: true };
}

module.exports = { generateOtp, hashOtp, makeOtpRecord, verifyOtp };
