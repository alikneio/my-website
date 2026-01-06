// jobs/syncProviderOrders.js
const { getOrderStatusFromDailycard } = require('../services/dailycard');
const sendTelegramMessage = require('../utils/sendTelegramNotification');

// ✅ إذا موجود عندك recalcUserLevel كـ require، ضيفه
// إذا هو global عندك، شيل هالسطر وخلي الاستدعاء مثل ما هو
let recalcUserLevel = null;
try {
  recalcUserLevel = require('../utils/recalcUserLevel');
} catch (_) {
  // ignore if not present as a module
}

/**
 * Auto-sync provider orders (DailyCard) into local `orders` table.
 */
module.exports = function makeSyncJob(_db, promisePool) {
  const APPROVE_MSG_EN = '✅ Your order has been approved and completed successfully.';
  const REJECT_MSG_EN  = '❌ Your order has been rejected. The amount has been refunded to your balance.';

  const ACCEPT_KEYWORDS = [
    'success','completed','done','accepted','approved','finish','finished',
    'مكتمل','ناجح'
  ];
  const REJECT_KEYWORDS = [
    'fail','failed','canceled','cancelled','rejected','error',
    'ملغي','مرفوض','أُلغي','الغيت'
  ];

  function looksAccepted(status = '') {
    const s = String(status || '').toLowerCase();
    return ACCEPT_KEYWORDS.some(k => s.includes(k));
  }

  function looksRejected(status = '') {
    const s = String(status || '').toLowerCase();
    return REJECT_KEYWORDS.some(k => s.includes(k));
  }

  async function sendOrderUpdateTelegram(orderId, statusLabel) {
    try {
      const [rows] = await promisePool.query(
        `SELECT o.productName, o.order_details, o.admin_reply, u.telegram_chat_id
           FROM orders o
           JOIN users u ON u.id = o.userId
          WHERE o.id = ?
          LIMIT 1`,
        [orderId]
      );
      const info = rows?.[0];
      if (!info || !info.telegram_chat_id) return;

      const productName = info.productName || 'غير معروف';
      const details     = info.order_details && String(info.order_details).trim() !== '' ? info.order_details : 'لا يوجد';
      const note        = info.admin_reply && String(info.admin_reply).trim() !== '' ? info.admin_reply : 'لا يوجد';

      const message =
`📦 تم تحديث حالة طلبك!

🔢 رقم الطلب: ${orderId}
🛍️ المنتج: ${productName}
📋 التفاصيل: ${details}
📌 الحالة الجديدة: ${statusLabel}
📝 ملاحظة: ${note}

🤖 شكراً لاستخدامك منصتنا 💖`;

      await sendTelegramMessage(info.telegram_chat_id, message, process.env.TELEGRAM_BOT_TOKEN);
    } catch (e) {
      console.error(`⚠️ Telegram notify error for order #${orderId}:`, e.message);
    }
  }

  async function handleOne(row) {
    const orderId = row.id;
    const providerOrderId = row.provider_order_id;
    if (!providerOrderId) return;

    // 1) fetch provider status
    let providerStatus = null;
    try {
      const { ok, status } = await getOrderStatusFromDailycard(providerOrderId);
      if (!ok) return;
      providerStatus = status || '';
    } catch (e) {
      console.error(`❌ DailyCard status fetch error for provider_order_id=${providerOrderId}:`, e.message);
      return;
    }

    // 2) ignore pending-ish statuses
    if (!looksAccepted(providerStatus) && !looksRejected(providerStatus)) {
      return;
    }

    // 3) Transaction per order to be safe/idempotent
    const conn = await promisePool.getConnection();
    let userId = null;
    let price = 0;

    try {
      await conn.beginTransaction();

      // 🔒 lock the order row
      const [[orderRow]] = await conn.query(
        `SELECT id, userId, price, status, productName
           FROM orders
          WHERE id = ?
          LIMIT 1
          FOR UPDATE`,
        [orderId]
      );
      if (!orderRow) {
        await conn.rollback();
        return;
      }

      userId = orderRow.userId;
      price = Number(orderRow.price || 0) || 0;
      const oldStatus = orderRow.status;

      // ----- Accepted -----
      if (looksAccepted(providerStatus)) {
        // إذا أصلًا Accepted، ما نعمل شي
        if (oldStatus === 'Accepted') {
          await conn.rollback();
          return;
        }

        // حدّث الطلب إلى Accepted
        const [upd] = await conn.query(
          `UPDATE orders
              SET status = 'Accepted',
                  admin_reply = ?
            WHERE id = ? AND status <> 'Accepted'`,
          [APPROVE_MSG_EN, orderId]
        );

        if (upd.affectedRows > 0) {
          // ✅ زِد total_spent مرة واحدة فقط عند أول قبول
          await conn.query(
            `UPDATE users SET total_spent = total_spent + ? WHERE id = ?`,
            [price, userId]
          );
        }

        await conn.commit();

        // after commit
        if (upd.affectedRows > 0) {
          try {
            if (typeof recalcUserLevel === 'function') {
              await recalcUserLevel(userId);
            }
          } catch (lvlErr) {
            console.error('⚠️ recalcUserLevel error (sync accept):', lvlErr.message || lvlErr);
          }

          await sendOrderUpdateTelegram(orderId, 'Accepted');
          console.log(`✅ Order #${orderId} set to Accepted (provider status: ${providerStatus})`);
        }
        return;
      }

      // ----- Rejected/Canceled/Failed -----
      if (looksRejected(providerStatus)) {
        // إذا أصلًا Rejected، ما نعمل شي
        if (oldStatus === 'Rejected') {
          await conn.rollback();
          return;
        }

        // غيّر الحالة فقط لو كانت بعدا بالحالات اللي عم نراقبها
        const [updOrder] = await conn.query(
          `UPDATE orders
              SET status = 'Rejected',
                  admin_reply = ?
            WHERE id = ?
              AND status IN ('Waiting','Processing','Pending')`,
          [REJECT_MSG_EN, orderId]
        );

        if (updOrder.affectedRows > 0) {
          // Refund مرة واحدة فقط (بسبب تغيير الحالة)
          await conn.query(
            `UPDATE users SET balance = balance + ? WHERE id = ?`,
            [price, userId]
          );
          await conn.query(
            `INSERT INTO transactions (user_id, type, amount, reason)
             VALUES (?, 'credit', ?, ?)`,
            [userId, price, `Refund: Provider rejected order #${orderId}`]
          );
        }

        await conn.commit();

        if (updOrder.affectedRows > 0) {
          await sendOrderUpdateTelegram(orderId, 'Rejected');
          console.log(`♻️ Order #${orderId} set to Rejected and refunded (provider status: ${providerStatus})`);
        }
        return;
      }

      // fallback
      await conn.rollback();
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      console.error(`❌ sync tx error for order #${orderId}:`, e.message || e);
    } finally {
      conn.release();
    }
  }

  return async function runOnce() {
    try {
      const [rows] = await promisePool.query(
        `SELECT id, provider_order_id
           FROM orders
          WHERE source = 'api'
            AND provider = 'dailycard'
            AND provider_order_id IS NOT NULL
            AND status IN ('Waiting','Processing','Pending')
          ORDER BY id DESC
          LIMIT 50`
      );

      if (!rows || rows.length === 0) return;

      for (const row of rows) {
        try {
          await handleOne(row);
        } catch (e) {
          console.error(`❌ sync error for order #${row.id}:`, e.message);
        }
      }
    } catch (e) {
      console.error('❌ syncProviderOrders runOnce error:', e.message || e);
    }
  };
};
