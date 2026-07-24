// backend/services/email.js

const nodemailer = require("nodemailer");

function createTransporter() {
  const user = String(process.env.EMAIL_USER || "").trim();
  const pass = String(process.env.EMAIL_APP_PASSWORD || "")
    .replace(/\s/g, "")
    .trim();

  if (!user || !pass) {
    throw new Error(
      "Thiếu EMAIL_USER hoặc EMAIL_APP_PASSWORD trong file .env",
    );
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user,
      pass,
    },
  });
}

async function verifyEmailConnection() {
  const transporter = createTransporter();
  await transporter.verify();
  return true;
}

async function sendLockerOtpEmail({
  email,
  otp,
  lockerId,
  orderId,
  expiresHours = 48,
}) {
  const receiver = String(email || "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiver)) {
    throw new Error(`Email người nhận không hợp lệ: ${receiver}`);
  }

  if (!/^\d{6}$/.test(String(otp))) {
    throw new Error("OTP phải gồm đúng 6 chữ số");
  }

  const transporter = createTransporter();

  const subject = `Mã nhận hàng Smart Locker - Tủ ${lockerId}`;

  const text = [
    "SMART LOCKER",
    "",
    `Bạn có một kiện hàng tại tủ ${lockerId}.`,
    `Mã nhận hàng: ${otp}`,
    `Mã có hiệu lực trong ${expiresHours} giờ và chỉ dùng một lần.`,
    `Mã đơn hàng: ${orderId}`,
    "",
    "Không chia sẻ mã này cho người khác.",
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2>SMART LOCKER</h2>

      <p>
        Bạn có một kiện hàng tại tủ
        <strong>${lockerId}</strong>.
      </p>

      <p>Mã nhận hàng của bạn:</p>

      <div style="
        padding:18px;
        background:#f3f4f6;
        border-radius:8px;
        text-align:center;
        font-size:32px;
        font-weight:bold;
        letter-spacing:8px;
      ">
        ${otp}
      </div>

      <p>
        Mã có hiệu lực trong
        <strong>${expiresHours} giờ</strong>
        và chỉ dùng một lần.
      </p>

      <p>Mã đơn hàng: <strong>${orderId}</strong></p>

      <p style="color:#b00020">
        Không chia sẻ mã này cho người khác.
      </p>
    </div>
  `;

  const result = await transporter.sendMail({
    from: `"Smart Locker" <${process.env.EMAIL_USER}>`,
    to: receiver,
    subject,
    text,
    html,
  });

  console.log("[EMAIL] Đã gửi OTP tới:", receiver);
  console.log("[EMAIL] Message ID:", result.messageId);

  return {
    success: true,
    email: receiver,
    messageId: result.messageId,
  };
}

module.exports = {
  verifyEmailConnection,
  sendLockerOtpEmail,
};