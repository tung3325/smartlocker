const API = "/api/admin";
let TOKEN = localStorage.getItem("sl_admin_token") || null;
// Lưu ý: localStorage chỉ dùng ở đây (trang admin desktop, không phải artifact),
// hợp lệ cho một ứng dụng web thông thường chạy trên trình duyệt của bạn.

const loginScreen = document.getElementById("loginScreen");
const dashboard = document.getElementById("dashboard");
const toastEl = document.getElementById("toast");

function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.style.background = isError ? "#b3432f" : "#1c3144";
  toastEl.hidden = false;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.hidden = true), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({ success: false, message: "Phản hồi không hợp lệ." }));
  if (res.status === 401) {
    logout();
    throw new Error("Phiên đăng nhập hết hạn.");
  }
  return data;
}

function fmt(dt) {
  if (!dt) return "-";
  return new Date(dt).toLocaleString("vi-VN");
}
function badge(status) {
  const labels = {
    trong: "Trống", co_hang: "Có hàng", dang_mo: "Đang mở", dang_mo_nhan: "Đang mở (nhận)",
    loi: "Lỗi / khoá", cho_dat_hang: "Chờ đặt hàng", da_mo_cho_nhan: "Đang mở cho nhận",
    hoan_thanh: "Hoàn thành", huy: "Đã huỷ",
  };
  return `<span class="badge b-${status}">${labels[status] || status}</span>`;
}

// ---------------- LOGIN ----------------
function showLogin() { loginScreen.hidden = false; dashboard.hidden = true; }
function showDashboard() { loginScreen.hidden = true; dashboard.hidden = false; loadTab(currentTab); }
function logout() { TOKEN = null; localStorage.removeItem("sl_admin_token"); showLogin(); }

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.hidden = true;
  try {
    const res = await fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!data.success) {
      errEl.textContent = data.message;
      errEl.hidden = false;
      return;
    }
    TOKEN = data.token;
    localStorage.setItem("sl_admin_token", TOKEN);
    showDashboard();
  } catch {
    errEl.textContent = "Không thể kết nối máy chủ.";
    errEl.hidden = false;
  }
});
document.getElementById("logoutBtn").addEventListener("click", logout);

// ---------------- TABS ----------------
let currentTab = "tongquan";
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = true));
    currentTab = btn.dataset.tab;
    document.getElementById(`tab-${currentTab}`).hidden = false;
    loadTab(currentTab);
  });
});

function loadTab(tab) {
  const loaders = {
    tongquan: loadTongQuan, donhang: loadOrders, tu: loadLockers,
    cudan: loadResidents, shipper: loadShippers, canhbao: loadWarnings,
    lichsu: loadHistory, sms: loadSmsLog,
  };
  (loaders[tab] || (() => {}))().catch((e) => toast(e.message, true));
}

// ---------------- TỔNG QUAN ----------------
async function loadTongQuan() {
  const d = await api("/tong-quan");
  if (!d.success) return;
  document.getElementById("statGrid").innerHTML = `
    <div class="stat-card"><div class="num">${d.tongNgan}</div><div class="label">Tổng số ngăn tủ</div></div>
    <div class="stat-card"><div class="num">${d.ngangTrong}</div><div class="label">Ngăn trống</div></div>
    <div class="stat-card"><div class="num">${d.ngangCoHang}</div><div class="label">Ngăn có hàng</div></div>
    <div class="stat-card"><div class="num">${d.ngangLoi}</div><div class="label">Ngăn lỗi / khoá</div></div>
    <div class="stat-card"><div class="num">${d.donChoXuLy}</div><div class="label">Đơn đang xử lý</div></div>
    <div class="stat-card"><div class="num">${d.tongCuDan}</div><div class="label">Cư dân trong hệ thống</div></div>
  `;
}

// ---------------- ĐƠN HÀNG ----------------
document.getElementById("refreshOrders").addEventListener("click", loadOrders);
document.getElementById("orderFilter").addEventListener("change", loadOrders);

async function loadOrders() {
  const status = document.getElementById("orderFilter").value;
  const d = await api(`/orders${status ? `?status=${status}` : ""}`);
  if (!d.success) return;
  const tbody = document.querySelector("#orderTable tbody");
  tbody.innerHTML = d.orders.map((o) => `
    <tr>
      <td>${o.id}</td>
      <td>${o.lockerId}</td>
      <td>${o.recipientPhone}${o.recipientName ? ` (${o.recipientName})` : ""}</td>
      <td>${o.room || "-"}</td>
      <td>${o.shipperPhone || "-"}</td>
      <td>${o.trackingCode || "-"}</td>
      <td>${badge(o.status)}</td>
      <td>${fmt(o.createdAt)}</td>
      <td>
        ${o.status === "co_hang" ? `
          <button class="btn-secondary small" data-act="capLaiOtp" data-id="${o.id}">Cấp lại OTP</button>
          <button class="btn-secondary small btn-danger" data-act="huyOtp" data-id="${o.id}">Huỷ OTP</button>
        ` : ""}
      </td>
    </tr>
  `).join("") || `<tr><td colspan="9" class="hint">Không có đơn hàng nào.</td></tr>`;

  tbody.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const endpoint = act === "capLaiOtp" ? `/orders/${id}/cap-lai-otp` : `/orders/${id}/huy-otp`;
      const res = await api(endpoint, { method: "POST" });
      toast(res.success ? "Thực hiện thành công." : res.message, !res.success);
      loadOrders();
    });
  });
}

// ---------------- NGĂN TỦ ----------------
document.getElementById("addLockerBtn").addEventListener("click", async () => {
  const id = document.getElementById("newLockerId").value.trim();
  if (!id) return;
  const res = await api("/lockers", { method: "POST", body: JSON.stringify({ id }) });
  toast(res.success ? `Đã thêm ngăn ${id}.` : res.message, !res.success);
  if (res.success) { document.getElementById("newLockerId").value = ""; loadLockers(); }
});

async function loadLockers() {
  const d = await api("/lockers");
  if (!d.success) return;
  document.getElementById("lockerGrid").innerHTML = d.lockers.map((l) => `
    <div class="locker-card">
      <div class="id">${l.id}</div>
      <div>${badge(l.status)}</div>
      <div class="hint" style="margin-top:6px;font-size:12px;">Cập nhật: ${fmt(l.updatedAt)}</div>
      <div class="actions">
        <button class="btn-secondary small" data-act="emergency" data-id="${l.id}">Mở khẩn cấp</button>
        ${l.status === "loi"
          ? `<button class="btn-secondary small btn-ok" data-act="unlock" data-id="${l.id}">Mở khoá ngăn</button>`
          : `<button class="btn-secondary small btn-danger" data-act="lock" data-id="${l.id}">Khoá ngăn lỗi</button>`}
      </div>
    </div>
  `).join("");

  document.querySelectorAll("#lockerGrid button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const endpoint = act === "emergency" ? `/lockers/${id}/mo-khan-cap`
        : act === "lock" ? `/lockers/${id}/khoa`
        : `/lockers/${id}/mo-khoa`;
      const body = act === "emergency" ? JSON.stringify({ reason: "Admin yêu cầu mở khẩn cấp" }) : undefined;
      const res = await api(endpoint, { method: "POST", body });
      toast(res.success ? "Đã gửi lệnh tới thiết bị." : res.message, !res.success);
      loadLockers();
    });
  });
}

// ---------------- CƯ DÂN ----------------
document.getElementById("addResidentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = document.getElementById("resPhone").value.trim();
  const name = document.getElementById("resName").value.trim();
  const room = document.getElementById("resRoom").value.trim();
  const res = await api("/residents", { method: "POST", body: JSON.stringify({ phone, name, room }) });
  toast(res.success ? "Đã thêm cư dân." : res.message, !res.success);
  if (res.success) { e.target.reset(); loadResidents(); }
});

async function loadResidents() {
  const d = await api("/residents");
  if (!d.success) return;
  const tbody = document.querySelector("#residentTable tbody");
  tbody.innerHTML = d.residents.map((r) => `
    <tr>
      <td>${r.phone}</td><td>${r.name}</td><td>${r.room || "-"}</td>
      <td>${r.active !== false ? '<span class="badge b-trong">Hoạt động</span>' : '<span class="badge b-loi">Đã khoá</span>'}</td>
      <td>
        <button class="btn-secondary small" data-act="toggle" data-id="${r.id}" data-active="${r.active !== false}">${r.active !== false ? "Khoá" : "Kích hoạt"}</button>
        <button class="btn-secondary small btn-danger" data-act="del" data-id="${r.id}">Xoá</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="hint">Chưa có cư dân nào.</td></tr>`;

  tbody.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      let res;
      if (btn.dataset.act === "toggle") {
        const active = btn.dataset.active === "true";
        res = await api(`/residents/${id}`, { method: "PUT", body: JSON.stringify({ active: !active }) });
      } else {
        res = await api(`/residents/${id}`, { method: "DELETE" });
      }
      toast(res.success ? "Đã cập nhật." : res.message, !res.success);
      loadResidents();
    });
  });
}

// ---------------- SHIPPER ----------------
async function loadShippers() {
  const d = await api("/shippers");
  if (!d.success) return;
  const tbody = document.querySelector("#shipperTable tbody");
  tbody.innerHTML = d.shippers.map((s) => `
    <tr>
      <td>${s.phone}</td>
      <td>${s.soLanTaoDon}</td>
      <td>${s.strikes}</td>
      <td>${s.dangBiKhoa ? `<span class="badge b-loi">Bị khoá tới ${fmt(s.blockedUntil)}</span>` : '<span class="badge b-trong">Bình thường</span>'}</td>
      <td>${s.dangBiKhoa ? `<button class="btn-secondary small btn-ok" data-phone="${s.phone}">Mở khoá</button>` : "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="hint">Chưa có dữ liệu shipper.</td></tr>`;

  tbody.querySelectorAll("button[data-phone]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const res = await api(`/shippers/${btn.dataset.phone}/mo-khoa`, { method: "POST" });
      toast(res.success ? "Đã mở khoá shipper." : res.message, !res.success);
      loadShippers();
    });
  });
}

// ---------------- CẢNH BÁO ----------------
async function loadWarnings() {
  const d = await api("/canh-bao");
  if (!d.success) return;
  document.querySelector("#openTooLongTable tbody").innerHTML = d.openTooLong.map((o) => `
    <tr><td>${o.lockerId}</td><td>${badge(o.status)}</td><td>${fmt(o.openSince)}</td></tr>
  `).join("") || `<tr><td colspan="3" class="hint">Không có ngăn nào mở quá lâu.</td></tr>`;

  document.querySelector("#warningTable tbody").innerHTML = d.warningEvents.map((e) => `
    <tr><td>${fmt(e.createdAt)}</td><td>${e.lockerId || "-"}</td><td>${e.type}</td><td>${e.note}</td></tr>
  `).join("") || `<tr><td colspan="4" class="hint">Chưa có cảnh báo nào.</td></tr>`;
}

// ---------------- LỊCH SỬ ----------------
async function loadHistory() {
  const d = await api("/lich-su?limit=200");
  if (!d.success) return;
  document.querySelector("#historyTable tbody").innerHTML = d.events.map((e) => `
    <tr>
      <td>${fmt(e.createdAt)}</td><td>${e.lockerId || "-"}</td><td>${e.type}</td><td>${e.note}</td>
      <td>${e.imagePath ? `<a href="${e.imagePath}" target="_blank">Xem ảnh</a>` : "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="hint">Chưa có sự kiện nào.</td></tr>`;
}

// ---------------- SMS LOG ----------------
async function loadSmsLog() {
  const d = await api("/sms-log");
  if (!d.success) return;
  document.querySelector("#smsTable tbody").innerHTML = d.log.map((s) => `
    <tr>
      <td>${fmt(s.createdAt)}</td><td>${s.phone}</td><td>${s.message}</td>
      <td>${s.provider}</td><td>${s.ok ? '<span class="badge b-trong">OK</span>' : `<span class="badge b-loi">${s.error || "Lỗi"}</span>`}</td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="hint">Chưa gửi SMS nào.</td></tr>`;
}

// ---------------- INIT ----------------
if (TOKEN) showDashboard(); else showLogin();
