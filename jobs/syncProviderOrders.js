const { getOrderStatus } = require('../services/dailycard');
const sendTelegramMessage = require('../utils/sendTelegramNotification');

module.exports = function makeSyncJob(db, promisePool) {
  // رسائل الإنكليزي بحسب طلبك
  const APPROVE_MSG_EN = "✅ Your order has been approved and completed successfully.";
  const REJECT_MSG_EN  = "❌ Your order has been rejected. The amount has been refunded to your balance.";

  async function handleOrder(row) {
    const orderId = row.id;
    const providerOrderId = row.provider_order_id;
    if (!providerOrderId) return;

    const { ok, status } = await getOrderStatus(providerOrderId);
    if (!ok || !status) return;

    // توحيد أشهر الحالات
    const s = status.toLowerCase();
    const isDone =
      s.includes('success') || s.includes('completed') || s.includes('done') || s === 'accepted';
    const isFail =
      s.includes('fail') || s.includes('canceled') || s.includes('rejected') || s.includes('cancelled');

    if (isDone) {
      // تحديث الحالة إلى Accepted
      await promisePool.query(
        `UPDATE orders SET status = 'Accepted', admin_reply = ? WHERE id = ?`,
        [APPROVE_MSG_EN, orderId]
      );

      // إشعار تلغرام للمستخدم
      const [rows] = await promisePool.query(
        `SELECT u.telegram_chat_id, o.productName 
           FROM orders o JOIN users u ON u.id = o.userId WHERE o.id = ?`,
        [orderId]
      );
      const chatId = rows?.[0]?.telegram_chat_id;
      const productName = rows?.[0]?.productName || 'Your product';
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `✅ <b>Order Approved</b>\n\n🛍️ <b>Product:</b> ${productName}\n📌 <b>Status:</b> Completed`,
          process.env.TELEGRAM_BOT_TOKEN
        );
      }
      return;
    }

    if (isFail) {
      // استرجاع المبلغ + رفض الطلب
      const [[o]] = await promisePool.query(
        `SELECT userId, price FROM orders WHERE id = ? LIMIT 1`,
        [orderId]
      );
      const userId = o.userId;
      const price  = parseFloat(o.price || 0) || 0;

      await promisePool.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [price, userId]);
      await promisePool.query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, price, `Refund: Provider rejected order #${orderId}`]
      );
      await promisePool.query(
        `UPDATE orders SET status = 'Rejected', admin_reply = ? WHERE id = ?`,
        [REJECT_MSG_EN, orderId]
      );

      // إشعار تلغرام
      const [rows] = await promisePool.query(
        `SELECT u.telegram_chat_id, o.productName 
           FROM orders o JOIN users u ON u.id = o.userId WHERE o.id = ?`,
        [orderId]
      );
      const chatId = rows?.[0]?.telegram_chat_id;
      const productName = rows?.[0]?.productName || 'Your product';
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `❌ <b>Order Rejected</b>\n\n🛍️ <b>Product:</b> ${productName}\n💵 <b>Refund:</b> Added to your balance`,
          process.env.TELEGRAM_BOT_TOKEN
        );
      }
      return;
    }

    // باقي الحالات (processing/pending) → نتركها لمرّة لاحقة
  }

  return async function runOnce() {
    try {
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
        await handleOrder(row);
      }
    } catch (e) {
      console.error('❌ syncProviderOrders runOnce error:', e.message);
    }
  };
};
