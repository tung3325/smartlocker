require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const { nanoid } = require("nanoid");
const { transaction } = require("./data/db");
const antifraud = require("./services/antifraud");

const publicRoutes = require("./routes/public");
const deviceRoutes = require("./routes/device");
const adminRoutes = require("./routes/admin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Ảnh chụp camera khi mở tủ
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Trang web tĩnh: công khai cho shipper + trang admin
app.use("/", express.static(path.join(__dirname, "public")));
app.use("/admin", express.static(path.join(__dirname, "admin")));

// API
app.use("/api", publicRoutes);
app.use("/api/device", deviceRoutes);
app.use("/api/admin", adminRoutes);

app.get("/api/health", (req, res) => res.json({ success: true, time: new Date().toISOString() }));

app.use((req, res) => res.status(404).json({ success: false, message: "Không tìm thấy endpoint." }));

// ---- Bộ kiểm tra định kỳ: tủ mở quá lâu -> ghi cảnh báo + ra lệnh khóa lại cho thiết bị ----
const CHECK_INTERVAL_MS = 15 * 1000;
setInterval(async () => {
  try {
    await transaction(async (data) => {
      const now = Date.now();
      const timeoutMs = antifraud.DOOR_OPEN_TIMEOUT_SECONDS * 1000;
      for (const locker of data.lockers) {
        const isOpenState = locker.status === "dang_mo" || locker.status === "dang_mo_nhan";
        if (!isOpenState || !locker.updatedAt) continue;
        const openedFor = now - new Date(locker.updatedAt).getTime();
        if (openedFor > timeoutMs && (!locker.pendingCommand || locker.pendingCommand.type !== "khoa_lai")) {
          locker.pendingCommand = {
            type: "khoa_lai",
            issuedAt: new Date().toISOString(),
            reason: "Cửa mở quá thời gian cho phép",
          };
          data.events.push({
            id: `ev-${Date.now()}-${nanoid(4)}`,
            lockerId: locker.id,
            orderId: locker.currentOrderId,
            type: "canh_bao_mo_qua_lau",
            note: `Ngăn ${locker.id} mở quá ${antifraud.DOOR_OPEN_TIMEOUT_SECONDS}s, đã gửi lệnh khóa lại cho thiết bị.`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    });
  } catch (err) {
    console.error("Lỗi kiểm tra timeout cửa mở:", err.message);
  }
}, CHECK_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Smart Locker backend đang chạy tại http://localhost:${PORT}`);
  console.log(`- Trang shipper (công khai): http://localhost:${PORT}/`);
  console.log(`- Trang admin:               http://localhost:${PORT}/admin/`);
});
