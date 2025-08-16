// jobs/syncProviderOrders.js
const { getOrderStatusFromDailycard } = require('../services/dailycard');
const sendTelegramMessage = require('../utils/sendTelegramNotification');

/**
 * Auto-sync provider orders (DailyCard) into local `orders` table.
 * - Reads api-sourced orders with provider = 'dailycard' and status Waiting/Pending
 * - Fetches provider status
 * - If completed => set Accepted (+ admin_reply EN) + Telegram message
 * - If rejected/canceled/failed => refund + set Rejected (+ admin_reply EN) + Telegram message
 *
 * Usage in server.js:
 *   const makeSyncJob = require('./jobs/syncProviderOrders');
 *   const syncJob = makeSyncJob(db, promisePool);
 *   setInterval(() => syncJob().catch(()=>{}), 2 * 60 * 1000);
 */
module.exports = function makeSyncJob(_db, promisePool) {
  // Admin reply (بالإنكليزي كما طلبت سابقاً)
  const APPROVE_MSG_EN = '✅ Your order has been approved and completed successfully.';
  const REJECT_MSG_EN  = '❌ Your order has been rejected. The amount has been refunded to your balance.';

  // الكلمات الدالة لتحديد الحالة
  const ACCEPT_KEYWORDS = ['success', 'completed', 'done', 'accepted', 'approved', 'finish', 'finished'];
  const REJECT_KEYWORDS = ['fail', 'failed', 'canceled', 'cancelled', 'rejected', 'error'];

  // قالب رسالة التيليغرام (العربية) — نفس القالب اللي عطيتني ياه
  async function sendOrderUpdateTelegram(orderId, statusLabel) {
    try {
      const [[info]] = await promisePool.query(
        `SELECT o.productName, o.order_details, o.admin_reply, u.telegram_chat_id
           FROM orders o
           JOIN users u ON u.id = o.userId
          WHERE o.id = ?
          LIMIT 1`,
        [orderId]
      );

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

  function looksAccepted(status = '') {
    const s = String(status || '').toLowerCase();
    return ACCEPT_KEYWORDS.some(k => s.includes(k));
  }

  function looksRejected(status = '') {
    const s = String(status || '').toLowerCase();
    return REJECT_KEYWORDS.some(k => s.includes(k));
  }

  async function handleOne(row) {
    const orderId = row.id;
    const providerOrderId = row.provider_order_id;
    if (!providerOrderId) return;

    // استعلام حالة الطلب من DailyCard
    let providerStatus = null;
    try {
      const { ok, status } = await getOrderStatusFromDailycard(providerOrderId);
      if (!ok) {
        // ما قدرنا نقرأ الحالة — نخليها لمحاولة لاحقة
        return;
      }
      providerStatus = status || '';
    } catch (e) {
      console.error(`❌ DailyCard status fetch error for provider_order_id=${providerOrderId}:`, e.message);
      return;
    }

    // لا تغيّر شي إذا لسه بانتظار/قيد المعالجة
    if (!looksAccepted(providerStatus) && !looksRejected(providerStatus)) {
      return;
    }

    // حمّل معلومات الطلب من DB (لأغراض refund/التحديث)
    const [[orderRow]] = await promisePool.query(
      `SELECT userId, price, productName, order_details
         FROM orders
        WHERE id = ?
        LIMIT 1`,
      [orderId]
    );
    if (!orderRow) return;

    // ----- حالة Accepted -----
    if (looksAccepted(providerStatus)) {
      // إذا هو أصلاً Accepted، لا تعمل شي
      await promisePool.query(
        `UPDATE orders
            SET status = 'Accepted',
                admin_reply = ?
          WHERE id = ? AND status <> 'Accepted'`,
        [APPROVE_MSG_EN, orderId]
      );

      // إشعار تيليغرام بالقالب العربي
      await sendOrderUpdateTelegram(orderId, 'Accepted');

      console.log(`✅ Order #${orderId} set to Accepted (provider status: ${providerStatus})`);
      return;
    }

    // ----- حالة Rejected / Canceled / Failed -----
    if (looksRejected(providerStatus)) {
      const userId = orderRow.userId;
      const price  = parseFloat(orderRow.price || 0) || 0;

      // نفّذ الاسترجاع + ضبط الحالة + معاملة الائتمان
      await promisePool.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [price, userId]);
      await promisePool.query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, price, `Refund: Provider rejected order #${orderId}`]
      );
      await promisePool.query(
        `UPDATE orders
            SET status = 'Rejected',
                admin_reply = ?
          WHERE id = ?`,
        [REJECT_MSG_EN, orderId]
      );

      // إشعار تيليغرام بالقالب العربي
      await sendOrderUpdateTelegram(orderId, 'Rejected');

      console.log(`♻️ Order #${orderId} set to Rejected and refunded (provider status: ${providerStatus})`);
      return;
    }
  }

  // الدالة العامة اللي بيستدعيها السيرفر كل فترة
  return async function runOnce() {
    try {
      // هنسحب آخر 50 طلب بانتظار/قيد المعالجة، مصدر API، مزوّد dailycard
      const [rows] = await promisePool.query(
        `SELECT id, provider_order_id
           FROM orders
          WHERE source = 'api'
            AND provider = 'dailycard'
            AND provider_order_id IS NOT NULL
            AND status IN ('Waiting', 'Pending')
          ORDER BY id DESC
          LIMIT 50`
      );

      if (!rows || rows.length === 0) {
        // لا يوجد ما يحدّث
        return;
      }

      for (const row of rows) {
        try {
          await handleOne(row);
        } catch (e) {
          console.error(`❌ sync error for order #${row.id}:`, e.message);
        }
      }
    } catch (e) {
      console.error('❌ syncProviderOrders runOnce error:', e.message);
    }
  };
};
