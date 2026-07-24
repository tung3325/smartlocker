// device.js - API dành cho thiết bị ESP32 gắn tại tủ khóa.
// Mọi request đều phải kèm header X-Device-Key (xem middleware/auth.js).
// Đây là nơi hiện thực hoá phần "cảm biến xác nhận" mà web/app không tự làm được:
//   - Xác nhận đóng cửa sau khi GỬI hàng (door + load cell + object sensor)
//   - Mở tủ đúng ngăn khi người nhận bấm OTP trên keypad 4x4
//   - Xác nhận đóng cửa sau khi NHẬN hàng (huỷ OTP, giải phóng ngăn)
//   - Bàn phím fallback A/B/*/#/D khi shipper không có Internet
//   - Upload ảnh camera khi tủ mở
//   - Poll lệnh từ admin (mở khẩn cấp / khóa lại / vô hiệu hoá ngăn lỗi)

const emailService = require("../services/email");
const pool = require("../data/postgres");
const express = require("express");
const router = express.Router();
const { nanoid } = require("nanoid");
const { requireDeviceKey } = require("../middleware/auth");
const otpService = require("../services/otp");
const orderService = require("../services/orderService");

router.use(requireDeviceKey);




// ============ 1. GỬI HÀNG - xác nhận cảm biến sau khi shipper đóng cửa ============
// body: { doorClosed: bool, weightIncreased: bool, objectDetected: bool }
router.post("/:lockerId/dong-cua-gui", async (req, res) => {
  const { lockerId } = req.params;
  const {
  doorClosed,
  objectDetected,
} = req.body || {};

  try {

    const lockerResult = await pool.query(
      `
      SELECT *
      FROM lockers
      WHERE id = $1
      `,
      [lockerId]
    );

    if (lockerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy ngăn tủ.",
      });
    }

    const locker = lockerResult.rows[0];

    const orderResult = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      AND status = 'cho_dat_hang'
      `,
      [locker.current_order_id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Ngăn tủ này hiện không có đơn nào đang chờ.",
      });
    }

    const order = orderResult.rows[0];

    const now = new Date().toISOString();

    const hasPackage =
  Boolean(doorClosed) &&
  Boolean(objectDetected);
    if (hasPackage) {

      const otpRec = otpService.makeOtpRecord();

      await pool.query(
        `
        UPDATE orders
        SET
          status='co_hang',
          otp_hash=$1,
          otp_created_at=$2,
          otp_expires_at=$3,
          otp_used=false,
          updated_at=$4
        WHERE id=$5
        `,
        [
          otpRec.otpHash,
          otpRec.otpCreatedAt,
          otpRec.otpExpiresAt,
          now,
          order.id,
        ]
      );

      await pool.query(
        `
        UPDATE lockers
        SET
          status='co_hang',
          updated_at=$1
        WHERE id=$2
        `,
        [now, lockerId]
      );

      await pool.query(
        `
        INSERT INTO events(
          id,
          locker_id,
          order_id,
          type,
          note,
          created_at
        )
        VALUES($1,$2,$3,$4,$5,$6)
        `,
        [
          `ev-${Date.now()}-${nanoid(4)}`,
          lockerId,
          order.id,
          "xac_nhan_co_hang",
          `Xác nhận có kiện hàng tại ${lockerId}`,
          now,
        ]
      );

      try {
        await emailService.sendLockerOtpEmail({
          email: order.recipient_email,
          otp: otpRec.otp,
          lockerId,
          orderId: order.id,
          expiresHours: 48,
        });

        console.log("Đã gửi OTP tới:", order.recipient_email);

      } catch (err) {
        console.error("Gửi email thất bại:");
        console.error(err);
      }

      return res.json({
        success: true,
        hasPackage: true,
      });

    } else {

      await pool.query(
        `
        UPDATE orders
        SET
          status='huy',
          cancel_reason=$1,
          updated_at=$2
        WHERE id=$3
        `,
        [
          "Không phát hiện kiện hàng.",
          now,
          order.id,
        ]
      );

      await pool.query(
        `
        UPDATE lockers
        SET
          status='trong',
          current_order_id=NULL,
          pending_command=NULL,
          updated_at=$1
        WHERE id=$2
        `,
        [now, lockerId]
      );

      await pool.query(
        `
        INSERT INTO events(
          id,
          locker_id,
          order_id,
          type,
          note,
          created_at
        )
        VALUES($1,$2,$3,$4,$5,$6)
        `,
        [
          `ev-${Date.now()}-${nanoid(4)}`,
          lockerId,
          order.id,
          "canh_bao_khong_co_hang",
          "Không phát hiện kiện hàng.",
          now,
        ]
      );

      return res.json({
        success: true,
        hasPackage: false,
      });

    }

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });

  }
});

// ============ 2. NHẬN HÀNG - người nhận bấm OTP trên keypad ============
// body: { otp: "583921" }
router.post(
  "/keypad/mo-tu-nhan-hang",
  async (req, res) => {
    const { otp } = req.body || {};

    if (!otp) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mã OTP.",
      });
    }

    try {
      const otpHash =
        otpService.hashOtp(otp);

      const orderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE status = 'co_hang'
            AND otp_hash = $1
            AND otp_used = false
            AND otp_expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [otpHash]
        );

      if (
        orderResult.rows.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Mã OTP không đúng, đã hết hạn hoặc đã được sử dụng.",
        });
      }

      const order =
        orderResult.rows[0];

      const now =
        new Date().toISOString();

      await pool.query(
        `
        UPDATE orders
        SET
          status = 'da_mo_cho_nhan',
          door_opened_at = $1,
          updated_at = $1
        WHERE id = $2
        `,
        [now, order.id]
      );

      await pool.query(
        `
        UPDATE lockers
        SET
          status = 'dang_mo_nhan',
          updated_at = $1
        WHERE id = $2
        `,
        [now, order.locker_id]
      );

      await pool.query(
        `
        INSERT INTO events (
          id,
          locker_id,
          order_id,
          type,
          note,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [
          `ev-${Date.now()}-${nanoid(4)}`,
          order.locker_id,
          order.id,
          "mo_tu_nhan_hang",
          `Người nhận nhập đúng OTP, mở ${order.locker_id} để lấy hàng.`,
          now,
        ]
      );

      return res.json({
        success: true,
        lockerId: order.locker_id,
      });
    } catch (error) {
      console.error(
        "[OTP] Lỗi kiểm tra OTP:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Không thể kiểm tra mã OTP.",
      });
    }
  }
);

// ============ 3. Xác nhận cảm biến sau khi người nhận lấy hàng & đóng cửa ============
// body: { doorClosed: bool, weightBackToZero: bool, objectCleared: bool }
router.post(
  "/:lockerId/dong-cua-nhan",
  async (req, res) => {
    const { lockerId } = req.params;

    const {
      doorClosed,
      objectCleared,
    } = req.body || {};

    try {
      const lockerResult =
        await pool.query(
          `
          SELECT *
          FROM lockers
          WHERE id = $1
          `,
          [lockerId]
        );

      if (
        lockerResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy ngăn tủ.",
        });
      }

      const locker =
        lockerResult.rows[0];

      const orderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE id = $1
            AND status = 'da_mo_cho_nhan'
          LIMIT 1
          `,
          [locker.current_order_id]
        );

      if (
        orderResult.rows.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Ngăn tủ này hiện không ở trạng thái chờ nhận hàng.",
        });
      }

      const order =
        orderResult.rows[0];

      if (
        !Boolean(doorClosed) ||
        !Boolean(objectCleared)
      ) {
        return res.json({
          success: true,
          completed: false,
        });
      }

      const now =
        new Date().toISOString();

      await pool.query(
        `
        UPDATE orders
        SET
          status = 'hoan_thanh',
          otp_used = true,
          updated_at = $1
        WHERE id = $2
        `,
        [now, order.id]
      );

      await pool.query(
        `
        UPDATE lockers
        SET
          status = 'trong',
          current_order_id = NULL,
          pending_command = NULL,
          updated_at = $1
        WHERE id = $2
        `,
        [now, lockerId]
      );

      await pool.query(
        `
        INSERT INTO events (
          id,
          locker_id,
          order_id,
          type,
          note,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [
          `ev-${Date.now()}-${nanoid(4)}`,
          lockerId,
          order.id,
          "hoan_tat_nhan_hang",
          `Đã lấy hàng khỏi ${lockerId}, hủy OTP và giải phóng ngăn.`,
          now,
        ]
      );

      return res.json({
        success: true,
        completed: true,
      });
    } catch (error) {
      console.error(
        "[DEVICE] Lỗi xác nhận nhận hàng:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Không thể xác nhận hoàn thành nhận hàng.",
      });
    }
  }
);

// ============ 4. Bàn phím fallback (shipper không có Internet) ============
// Quy ước: A = gửi hàng, B = nhận hàng, * = xóa, # = xác nhận, D = xóa 1 ký tự.
// Thiết bị tự xử lý việc đọc phím, chỉ gọi API này khi đã có đủ SĐT người nhận.
// body: { recipientPhone }
router.post("/keypad/gui-hang", async (req, res) => {
  const { recipientPhone } = req.body || {};

  const result = await orderService.createOrder({
    recipientPhone,
    viaKeypad: true,
  });

  if (!result.success) return res.status(400).json(result);
  res.json({
    success: true,
    lockerId: result.order.lockerId,
    orderId: result.order.id,
    lcdLine1: `MO TU ${result.order.lockerId}`,
    lcdLine2: "HAY DAT HANG",
  });
});


// ============ 6. Heartbeat + lấy lệnh đang chờ từ admin ============
router.get(
  "/:lockerId/lenh",
  async (req, res) => {
    const { lockerId } = req.params;

    try {
      const result = await pool.query(
        `
        SELECT
          id,
          status,
          current_order_id,
          pending_command
        FROM lockers
        WHERE id = $1
        `,
        [lockerId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy ngăn tủ.",
        });
      }

      const locker = result.rows[0];

      let pendingCommand =
        locker.pending_command;

      // PostgreSQL JSONB thường trả object,
      // nhưng vẫn xử lý thêm trường hợp trả chuỗi.
      if (
        typeof pendingCommand === "string"
      ) {
        try {
          pendingCommand =
            JSON.parse(pendingCommand);
        } catch (error) {
          pendingCommand = null;
        }
      }

      /*
       * Nếu có lệnh mở tủ gửi hàng nhưng không còn
       * đơn cho_dat_hang hợp lệ thì đó là lệnh cũ.
       */
      if (
        pendingCommand &&
        pendingCommand.type ===
          "mo_tu_gui_hang"
      ) {
        const orderId =
          pendingCommand.orderId ||
          locker.current_order_id;

        const orderResult =
          await pool.query(
            `
            SELECT id
            FROM orders
            WHERE id = $1
              AND locker_id = $2
              AND status = 'cho_dat_hang'
            LIMIT 1
            `,
            [orderId, lockerId]
          );

        if (
          orderResult.rows.length === 0
        ) {
          console.log(
            `[DEVICE] Xóa lệnh cũ của ${lockerId}`
          );

          await pool.query(
            `
            UPDATE lockers
            SET
              pending_command = NULL,
              current_order_id = NULL,
              status = 'trong',
              updated_at = NOW()
            WHERE id = $1
            `,
            [lockerId]
          );

          pendingCommand = null;
          locker.status = "trong";
        }
      }

      await pool.query(
        `
        UPDATE lockers
        SET last_seen_at = NOW()
        WHERE id = $1
        `,
        [lockerId]
      );

      return res.json({
        success: true,
        pendingCommand,
        lockerStatus: locker.status,
      });
    } catch (error) {
      console.error(
        "[DEVICE] Lỗi lấy lệnh:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Không thể đọc lệnh của ngăn tủ.",
      });
    }
  }
);

router.post(
  "/:lockerId/lenh/hoan-thanh",
  async (req, res) => {
    const { lockerId } = req.params;

    try {
      const lockerResult = await pool.query(
        `
        SELECT
          current_order_id,
          pending_command
        FROM lockers
        WHERE id = $1
        `,
        [lockerId]
      );

      if (lockerResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy ngăn tủ.",
        });
      }

      const locker = lockerResult.rows[0];

      let pendingCommand =
        locker.pending_command;

      // Phòng trường hợp PostgreSQL trả về chuỗi JSON.
      if (
        typeof pendingCommand === "string"
      ) {
        try {
          pendingCommand =
            JSON.parse(pendingCommand);
        } catch (error) {
          pendingCommand = null;
        }
      }

      const commandType =
        pendingCommand &&
        pendingCommand.type
          ? pendingCommand.type
          : "?";

      const now =
        new Date().toISOString();

      // Xóa lệnh đúng trong PostgreSQL/Supabase.
      await pool.query(
        `
        UPDATE lockers
        SET
          pending_command = NULL,
          updated_at = $1
        WHERE id = $2
        `,
        [now, lockerId]
      );

      await pool.query(
        `
        INSERT INTO events (
          id,
          locker_id,
          order_id,
          type,
          note,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [
          `ev-${Date.now()}-${nanoid(4)}`,
          lockerId,
          locker.current_order_id || null,
          "hoan_tat_lenh",
          `Thiết bị đã thực hiện xong lệnh: ${commandType}`,
          now,
        ]
      );

      return res.json({
        success: true,
      });
    } catch (error) {
      console.error(
        "[DEVICE] Lỗi hoàn thành lệnh:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Không thể xác nhận hoàn thành lệnh.",
      });
    }
  }
);

module.exports = router;
