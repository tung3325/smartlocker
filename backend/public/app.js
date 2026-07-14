const API = "/api";

const formCard = document.getElementById("formCard");
const statusCard = document.getElementById("statusCard");
const shipForm = document.getElementById("shipForm");
const submitBtn = document.getElementById("submitBtn");
const formError = document.getElementById("formError");
const stockLine = document.getElementById("stockLine");
const lockerBadge = document.getElementById("lockerBadge");
const statusTitle = document.getElementById("statusTitle");
const statusMessage = document.getElementById("statusMessage");
const spinner = document.getElementById("spinner");
const newOrderBtn = document.getElementById("newOrderBtn");

let pollTimer = null;

async function loadStock() {
  try {
    const res = await fetch(`${API}/lockers/tinh-trang`);
    const data = await res.json();
    if (data.success) {
      stockLine.textContent = `Hiện có ${data.trong}/${data.total} ngăn tủ trống.`;
    }
  } catch {
    stockLine.textContent = "Không thể kết nối máy chủ.";
  }
}
loadStock();

shipForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "ĐANG XỬ LÝ…";

  const body = {
    recipientPhone: document.getElementById("recipientPhone").value.trim(),
    recipientName: document.getElementById("recipientName").value.trim(),
    room: document.getElementById("room").value.trim(),
    shipperPhone: document.getElementById("shipperPhone").value.trim(),
    trackingCode: document.getElementById("trackingCode").value.trim(),
  };

  try {
    const res = await fetch(`${API}/guihang`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!data.success) {
      formError.textContent = data.message || "Có lỗi xảy ra, vui lòng thử lại.";
      formError.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "MỞ TỦ ĐỂ GỬI HÀNG";
      return;
    }

    showStatusCard(data.lockerId, "Vui lòng đặt kiện hàng vào và đóng cửa.", true);
    startPolling(data.orderId);
  } catch (err) {
    formError.textContent = "Không thể kết nối máy chủ. Vui lòng thử lại.";
    formError.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "MỞ TỦ ĐỂ GỬI HÀNG";
  }
});

function showStatusCard(lockerId, message, showSpinner) {
  formCard.hidden = true;
  statusCard.hidden = false;
  lockerBadge.textContent = lockerId;
  statusTitle.textContent = `Tủ ${lockerId} đã mở`;
  statusMessage.textContent = message;
  spinner.style.display = showSpinner ? "block" : "none";
  newOrderBtn.hidden = !!showSpinner;
}

function startPolling(orderId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API}/guihang/${orderId}/trang-thai`);
      const data = await res.json();
      if (!data.success) return;

      if (data.status === "co_hang") {
        clearInterval(pollTimer);
        statusTitle.textContent = "Giao hàng thành công!";
        statusMessage.textContent = "OTP đã được gửi tới người nhận qua SMS. Cảm ơn bạn.";
        spinner.style.display = "none";
        newOrderBtn.hidden = false;
      } else if (data.status === "huy") {
        clearInterval(pollTimer);
        statusTitle.textContent = "Đơn hàng đã bị hủy";
        statusMessage.textContent = data.message;
        spinner.style.display = "none";
        newOrderBtn.hidden = false;
      }
    } catch {
      /* bỏ qua lỗi mạng tạm thời, tiếp tục thử ở lần poll sau */
    }
  }, 2500);
}

newOrderBtn.addEventListener("click", () => {
  shipForm.reset();
  formError.hidden = true;
  submitBtn.disabled = false;
  submitBtn.textContent = "MỞ TỦ ĐỂ GỬI HÀNG";
  statusCard.hidden = true;
  formCard.hidden = false;
  loadStock();
});

document.getElementById("helpLink").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("helpModal").hidden = false;
});
document.getElementById("closeHelp").addEventListener("click", () => {
  document.getElementById("helpModal").hidden = true;
});
