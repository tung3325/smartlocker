// seed.js - Khởi tạo dữ liệu mẫu: tài khoản admin, danh sách cư dân, các ngăn tủ.
// Chạy: npm run seed
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { transaction } = require("./db");

async function main() {
  await transaction(async (data) => {
    // ---- Admin mặc định ----
    if (data.admins.length === 0) {
      const username = process.env.ADMIN_DEFAULT_USERNAME || "admin";
      const password = process.env.ADMIN_DEFAULT_PASSWORD || "admin123";
      data.admins.push({
        id: "admin-1",
        username,
        passwordHash: bcrypt.hashSync(password, 10),
        createdAt: new Date().toISOString(),
      });
      console.log(`Đã tạo tài khoản admin: ${username} / ${password} (hãy đổi mật khẩu sau khi đăng nhập lần đầu)`);
    }

    // ---- Danh sách cư dân mẫu (SĐT phải nằm trong danh sách này mới nhận được hàng) ----
    if (data.residents.length === 0) {
      data.residents = [
        { id: "res-1", phone: "0901234567", name: "Nguyễn Văn A", room: "502 - Tòa A", active: true },
        { id: "res-2", phone: "0912345678", name: "Trần Thị B", room: "204 - Tòa B", active: true },
        { id: "res-3", phone: "0923456789", name: "Lê Văn C", room: "311 - Tòa A", active: true },
      ];
      console.log("Đã tạo 3 cư dân mẫu. Vào trang Admin > Cư dân để thêm/xoá.");
    }

    // ---- 4 ngăn tủ mẫu A01 - A04 ----
    if (data.lockers.length === 0) {
      data.lockers = ["A01", "A02", "A03", "A04"].map((id) => ({
        id,
        status: "trong", // trong | co_hang | dang_mo | loi (khoá do admin)
        currentOrderId: null,
        updatedAt: new Date().toISOString(),
      }));
      console.log("Đã tạo 4 ngăn tủ: A01, A02, A03, A04");
    }
  });

  console.log("Seed dữ liệu hoàn tất.");
}

main();
