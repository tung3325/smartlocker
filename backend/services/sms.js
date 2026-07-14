// sms.js - Trừu tượng hoá việc gửi SMS để dễ đổi nhà cung cấp.
// Mặc định dùng "console" (chỉ log ra terminal + lưu vào db.smsLog) để bạn test
// toàn bộ luồng nghiệp vụ mà KHÔNG cần tài khoản SMS thật.
// Khi triển khai thật, đổi SMS_PROVIDER trong .env sang "esms" hoặc "twilio"
// và điền API key tương ứng — không cần sửa gì ở routes/services khác.

const { transaction } = require("../data/db");

async function sendViaConsole(phone, message) {
  console.log(`\n[SMS-MOCK] Gửi tới ${phone}:\n${message}\n`);
  return { ok: true, provider: "console", providerMessageId: null };
}

async function sendViaEsms(phone, message) {
  // eSMS.vn (https://esms.vn) - nhà cung cấp SMS phổ biến tại Việt Nam.
  // Cần cấu hình ESMS_API_KEY, ESMS_SECRET_KEY, ESMS_BRANDNAME trong .env
  const apiKey = process.env.ESMS_API_KEY;
  const secretKey = process.env.ESMS_SECRET_KEY;
  const brandname = process.env.ESMS_BRANDNAME || "SmartLocker";
  if (!apiKey || !secretKey) {
    throw new Error("Thiếu ESMS_API_KEY / ESMS_SECRET_KEY trong .env");
  }
  const res = await fetch("https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ApiKey: apiKey,
      SecretKey: secretKey,
      Content: message,
      Phone: phone,
      Brandname: brandname,
      SmsType: "2",
    }),
  });
  const json = await res.json();
  return { ok: json.CodeResult === "100", provider: "esms", raw: json };
}

async function sendViaTwilio(phone, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new Error("Thiếu TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER trong .env");
  }
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: phone, From: from, Body: message }),
  });
  const json = await res.json();
  return { ok: res.ok, provider: "twilio", raw: json };
}

async function sendSms(phone, message) {
  const provider = process.env.SMS_PROVIDER || "console";
  let result;
  try {
    if (provider === "esms") result = await sendViaEsms(phone, message);
    else if (provider === "twilio") result = await sendViaTwilio(phone, message);
    else result = await sendViaConsole(phone, message);
  } catch (err) {
    result = { ok: false, provider, error: err.message };
  }

  await transaction(async (data) => {
    data.smsLog.push({
      id: `sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phone,
      message,
      provider: result.provider,
      ok: result.ok,
      error: result.error || null,
      createdAt: new Date().toISOString(),
    });
  });

  return result;
}

module.exports = { sendSms };
