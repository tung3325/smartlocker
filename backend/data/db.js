// db.js
// Lớp lưu trữ dữ liệu đơn giản dựa trên file JSON.
// Dùng file JSON thay vì DB thật để hệ thống chạy được ngay (zero-config),
// dễ deploy trên chính ESP32 companion server / Raspberry Pi / VPS nhỏ.
// Nếu muốn nâng cấp lên MySQL/Postgres/Firebase sau này, chỉ cần thay lớp này,
// toàn bộ routes/services phía trên gọi qua db.* nên không cần sửa logic nghiệp vụ.

const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "db.json");

function defaultData() {
  return {
    admins: [],
    residents: [],
    lockers: [],
    orders: [],
    events: [],
    smsLog: [],
    shipperStats: {}, // { [phone]: { history: [timestamps], strikes: 0, blockedUntil: null } }
    meta: { orderSeq: 0 },
  };
}

function loadRaw() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData(), null, 2));
  }
  const raw = fs.readFileSync(DB_FILE, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("DB file bị lỗi định dạng, khởi tạo lại từ mặc định:", e.message);
    return defaultData();
  }
}

function saveRaw(data) {
  // Ghi ra file tạm rồi đổi tên, tránh hỏng file nếu tiến trình bị ngắt giữa chừng
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---- Hàng đợi ghi tuần tự (single-writer queue) ----
// Đây là cơ chế hiện thực hoá yêu cầu nghiệp vụ:
// "Chỉ một yêu cầu được xử lý tại một thời điểm"
// Mọi thao tác đổi trạng thái (tạo đơn, mở tủ, xác nhận đóng cửa...) đều
// phải đi qua transaction() để đảm bảo tuần tự, không có race-condition
// giữa hai shipper cùng bấm "GỬI HÀNG" một lúc.
let queue = Promise.resolve();

function transaction(fn) {
  const run = async () => {
    const data = loadRaw();
    const result = await fn(data);
    saveRaw(data);
    return result;
  };
  const p = queue.then(run, run);
  // giữ queue luôn "sống" kể cả khi 1 transaction lỗi
  queue = p.catch(() => {});
  return p;
}

function readOnly(fn) {
  const data = loadRaw();
  return fn(data);
}

module.exports = { transaction, readOnly, defaultData };
