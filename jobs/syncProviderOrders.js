// jobs/syncProviderOrders.js
const { getOrderStatusFromDailycard } = require('../services/dailycard');
const sendTelegramMessage = require('../utils/sendTelegramNotification');

module.exports = function makeSyncJob(db, promisePool) {
  // رسائل ثابتة بالإنكليزي
  const APPROVE_MSG_EN = "✅ Your order has been approved and completed successfully.";
  const REJECT_MSG_EN  = "❌ Your order has been rejected. The amount has been refunded to your balance.";

  function withTimeout(promise, ms = 4000) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
  }

  async function notifyUser(orderId, title, body) {
    try {
      const [rows] = await promisePool.query(
        `SELECT u.telegram_chat_id, o.productName 
           FROM orders o 
           JOIN users u ON u.id = o.userId 
          WHERE o.id = ?`,
        [orderId]
      );
      const chatId = rows?.[0]?.telegram_chat_id;
      const productName = rows?.[0]?.productName || 'Your product';
      if (!chatId) return;

      const text = `${title}\n\n🛍️ <b>Product:</b> ${productName}\n${body}`;
      await withTimeout(
        sendTelegramMessage(chatId, text, process.env.TELEGRAM_BOT_TOKEN),
        4000
      );
    } catch (e) {
      console.warn('⚠️ Telegram notify failed:', e.message);
    }
  }

  async function handleOrder(row) {
    const orderId = row.id;
    const providerOrderId = row.provider_order_id;
    if (!providerOrderId) return;

    // نسحب حالة الطلب من المزوّد
    const res = await getOrderStatusFromDailycard(providerOrderId);
    if (!res?.ok || !res.mapped) return;

    const { local, adminReply } = res.mapped; // local ∈ {Waiting, Accepted, Rejected}

    // Waiting → ما منعمل شي
    if (local === 'Waiting') return;

    if (local === 'Accepted') {
      // حدّث الحالة والردّ
      await promisePool.query(
        `UPDATE orders 
            SET status = 'Accepted', admin_reply = ? 
          WHERE id = ?`,
        [adminReply || APPROVE_MSG_EN, orderId]
      );

      // تيليغرام للمستخدم
      await notifyUser(
        orderId,
        '✅ <b>Order Approved</b>',
        '📌 <b>Status:</b> Completed'
      );

      return;
    }

    if (local === 'Rejected') {
      // حدد صاحب الطلب والمبلغ
      const [[o]] = await promisePool.query(
        `SELECT userId, price FROM orders WHERE id = ? LIMIT 1`,
        [orderId]
      );
      const userId = o?.userId;
      const price  = parseFloat(o?.price || 0) || 0;

      // ارجاع الرصيد + تسجيل حركة + تحديث الطلب
      if (userId && price > 0) {
        await promisePool.query(
          `UPDATE users SET balance = balance + ? WHERE id = ?`,
          [price, userId]
        );
        await promisePool.query(
          `INSERT INTO transactions (user_id, type, amount, reason)
           VALUES (?, 'credit', ?, ?)`,
          [userId, price, `Refund: Provider rejected order #${orderId}`]
        );
      }

      await promisePool.query(
        `UPDATE orders 
            SET status = 'Rejected', admin_reply = ? 
          WHERE id = ?`,
        [adminReply || REJECT_MSG_EN, orderId]
      );

      // تيليغرام للمستخدم
      await notifyUser(
        orderId,
        '❌ <b>Order Rejected</b>',
        '💵 <b>Refund:</b> Added to your balance'
      );

      return;
    }
  }

  return async function runOnce() {
    try {
      // التقط فقط طلبات API/dailycard المعلّقة
      const [rows] = await promisePool.query(
        `SELECT id, provider_order_id
           FROM orders
          WHERE source = 'api'
            AND provider = 'dailycard'
            AND provider_order_id IS NOT NULL
            AND status IN ('Waiting','Pending')
          ORDER BY id DESC
          LIMIT 50`
      );

      for (const row of rows) {
        try {
          await handleOrder(row);
        } catch (e) {
          console.error('⚠️ handleOrder error for id', row.id, ':', e.message);
        }
      }
    } catch (e) {
      console.error('❌ syncProviderOrders runOnce error:', e.message);
    }
  };
};
