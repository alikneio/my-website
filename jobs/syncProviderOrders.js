// jobs/syncProviderOrders.js
const { getOrderStatusFromDailycard } = require('../services/dailycard');
const sendTelegramMessage = require('../utils/sendTelegramNotification');

/**
 * Auto-sync provider orders (DailyCard) into local `orders` table.
 * - Reads api-sourced orders with provider='dailycard' and status Waiting/Processing/Pending
 * - Fetches provider status
 * - If completed => set Accepted (+ admin_reply EN) + Telegram message
 * - If rejected/canceled/failed => refund (once) + set Rejected (+ admin_reply EN) + Telegram message
 *
 * Usage in server.js:
 *   const makeSyncJob = require('./jobs/syncProviderOrders');
 *   const syncJob = makeSyncJob(null, promisePool); // مرّر promisePool من database.js
 *   setInterval(() => syncJob().catch(()=>{}), 2 * 60 * 1000);
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

    // 1) اسحب حالة الطلب من DailyCard
    let providerStatus = null;
    try {
      const { ok, status } = await getOrderStatusFromDailycard(providerOrderId);
      if (!ok) return; // خليها للمحاولة القادمة
      providerStatus = status || '';
    } catch (e) {
      console.error(`❌ DailyCard status fetch error for provider_order_id=${providerOrderId}:`, e.message);
      return;
    }

    // 2) إذا بعدها Pending/Processing/Waiting اتركها
    if (!looksAccepted(providerStatus) && !looksRejected(providerStatus)) {
      return;
    }

    // 3) حمّل معلومات الطلب
    const [ordRows] = await promisePool.query(
      `SELECT userId, price, productName, order_details, status
         FROM orders
        WHERE id = ?
        LIMIT 1`,
      [orderId]
    );
    const orderRow = ordRows?.[0];
    if (!orderRow) return;

    // ----- حالة Accepted -----
    if (looksAccepted(providerStatus)) {
      // حدّث فقط إذا ما كانت Accepted سابقًا
      const [upd] = await promisePool.query(
        `UPDATE orders
            SET status = 'Accepted',
                admin_reply = ?
          WHERE id = ? AND status <> 'Accepted'`,
        [APPROVE_MSG_EN, orderId]
      );
      if (upd.affectedRows > 0) {
        await sendOrderUpdateTelegram(orderId, 'Accepted');
        console.log(`✅ Order #${orderId} set to Accepted (provider status: ${providerStatus})`);
      }
      return;
    }

    // ----- حالة Rejected / Canceled / Failed -----
    if (looksRejected(providerStatus)) {
      const userId = orderRow.userId;
      const price  = parseFloat(orderRow.price || 0) || 0;

      // نفّذها داخل Transaction لتكون Idempotent (نستند على تغيير حالة الطلب)
      const conn = await promisePool.getConnection();
      try {
        await conn.beginTransaction();

        // غيّر الحالة فقط لو ما زالت بانتظار/معالجة/معلّقة
        const [updOrder] = await conn.query(
          `UPDATE orders
              SET status = 'Rejected',
                  admin_reply = ?
            WHERE id = ?
              AND status IN ('Waiting','Processing','Pending')`,
          [REJECT_MSG_EN, orderId]
        );

        if (updOrder.affectedRows > 0) {
          // Refund مرّة واحدة فقط (مش رح يتكرر لأن الحالة تغيّرت)
          await conn.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [price, userId]);
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
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        console.error(`❌ refund/rollback error for order #${orderId}:`, e.message);
      } finally {
        conn.release();
      }
      return;
    }
  }

  // الدالة العامة اللي بيستدعيها السيرفر كل فترة
  return async function runOnce() {
    try {
      // السحب من الحالات الثلاث: Waiting/Processing/Pending
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
      // لو طلع الخطأ السابق “not a promise” فالمشكلة من تمرير pool خاطئ:
      // تأكد إنك مرّرت promisePool من database.js (mysql2/promise أو pool.promise())
      console.error('❌ syncProviderOrders runOnce error:', e.message || e);
    }
  };
};
