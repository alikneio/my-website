// jobs/syncProviderOrders.js
const { getOrderStatusFromDailycard } = require('../services/dailycard');
const sendTelegramMessage = require('../utils/sendTelegramNotification');

let recalcUserLevel = null;
try {
  recalcUserLevel = require('../utils/recalcUserLevel');
} catch (_) {
  // ignore if not present as a module
}

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

  function isDbDisconnect(err) {
    const code = err?.code;
    return (
      code === 'PROTOCOL_CONNECTION_LOST' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR' ||
      code === 'PROTOCOL_ENQUEUE_AFTER_QUIT'
    );
  }

  async function dbHealthy() {
    try {
      await promisePool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async function safeQuery(sql, params) {
    try {
      return await promisePool.query(sql, params);
    } catch (err) {
      if (isDbDisconnect(err)) {
        console.error('❌ syncProviderOrders: DB lost (retry once):', err.message || err);
        await new Promise(r => setTimeout(r, 1500));
        return await promisePool.query(sql, params);
      }
      throw err;
    }
  }

  async function safeGetConnection() {
    try {
      return await promisePool.getConnection();
    } catch (err) {
      if (isDbDisconnect(err)) {
        console.error('❌ syncProviderOrders: cannot get DB connection (skip):', err.message || err);
        return null;
      }
      throw err;
    }
  }

  async function sendOrderUpdateTelegram(orderId, statusLabel) {
    try {
      const [rows] = await safeQuery(
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
      console.error(`⚠️ Telegram notify error for order #${orderId}:`, e.message || e);
    }
  }

  async function handleOne(row) {
    const orderId = row.id;
    const providerOrderId = row.provider_order_id;
    if (!providerOrderId) return;

    // 1) fetch provider status (شبكة خارج DB)
    let providerStatus = null;
    try {
      const { ok, status } = await getOrderStatusFromDailycard(providerOrderId);
      if (!ok) return;
      providerStatus = status || '';
    } catch (e) {
      console.error(`❌ DailyCard status fetch error for provider_order_id=${providerOrderId}:`, e.message || e);
      return;
    }

    // 2) ignore pending-ish
    if (!looksAccepted(providerStatus) && !looksRejected(providerStatus)) {
      return;
    }

    // 3) Transaction per order
    const conn = await safeGetConnection();
    if (!conn) return; // DB مش جاهزة

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
        if (oldStatus === 'Accepted') {
          await conn.rollback();
          return;
        }

        const [upd] = await conn.query(
          `UPDATE orders
              SET status = 'Accepted',
                  admin_reply = ?
            WHERE id = ? AND status <> 'Accepted'`,
          [APPROVE_MSG_EN, orderId]
        );

        if (upd.affectedRows > 0) {
          await conn.query(
            `UPDATE users SET total_spent = total_spent + ? WHERE id = ?`,
            [price, userId]
          );
        }

        await conn.commit();

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
        if (oldStatus === 'Rejected') {
          await conn.rollback();
          return;
        }

        const [updOrder] = await conn.query(
          `UPDATE orders
              SET status = 'Rejected',
                  admin_reply = ?
            WHERE id = ?
              AND status IN ('Waiting','Processing','Pending')`,
          [REJECT_MSG_EN, orderId]
        );

        if (updOrder.affectedRows > 0) {
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

      await conn.rollback();
    } catch (e) {
      // لو DB قطعت خلال tx
      if (isDbDisconnect(e)) {
        console.error(`❌ syncProviderOrders: DB lost during tx for order #${orderId} (will retry next run):`, e.message || e);
      } else {
        console.error(`❌ sync tx error for order #${orderId}:`, e.message || e);
      }

      try { await conn.rollback(); } catch (_) {}
    } finally {
      try { conn.release(); } catch (_) {}
    }
  }

  return async function runOnce() {
    // Gate سريع: إذا DB مش جاهزة، ما نبلش
    if (!(await dbHealthy())) {
      console.log('⏭️ syncProviderOrders skipped: DB not ready');
      return;
    }

    try {
      const [rows] = await safeQuery(
        `SELECT id, provider_order_id
           FROM orders
          WHERE source = 'api'
            AND provider = 'dailycard'
            AND provider_order_id IS NOT NULL
            AND status IN ('Waiting','Processing','Pending')
          ORDER BY id DESC
          LIMIT 20`
      );

      if (!rows || rows.length === 0) return;

      for (const row of rows) {
        try {
          await handleOne(row);
        } catch (e) {
          console.error(`❌ sync error for order #${row.id}:`, e.message || e);
        }
      }
    } catch (e) {
      if (isDbDisconnect(e)) {
        console.error('❌ syncProviderOrders runOnce DB lost (skipping):', e.message || e);
        return;
      }
      console.error('❌ syncProviderOrders runOnce error:', e.message || e);
    }
  };
};
