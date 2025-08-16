// jobs/syncProviderOrders.js
// ----------------------------------------------
// يزامن حالات طلبات المزود DailyCard ويحدّث أوامر الموقع
// - يقرأ الطلبات المعلّقة (Waiting/Pending)
// - يستعلم حالة الطلب من المزود
// - إذا Accepted: يحدّث الحالة ويرسل تلغرام للمستخدم
// - إذا Rejected: يرجّع المبلغ، يسجّل معاملة Refund، يحدّث الحالة، ويرسل تلغرام
// ----------------------------------------------

const { getOrderStatusFromDailycard } = require('../services/dailycard');
const sendTelegramMessage = require('../utils/sendTelegramNotification');

module.exports = function makeSyncJob(db, promisePool) {
  // رسائل إنكليزي حسب طلبك
  const APPROVE_MSG_EN =
    '✅ Your order has been approved and completed successfully.';
  const REJECT_MSG_EN =
    '❌ Your order has been rejected. The amount has been refunded to your balance.';

  // استنتاج النتيجة من نص الحالة
  function normalizeStatusText(status) {
    const s = String(status || '').toLowerCase();

    const isDone =
      s === 'accepted' ||
      s.includes('success') ||
      s.includes('completed') ||
      s.includes('done');

    const isFail =
      s === 'rejected' ||
      s.includes('fail') ||
      s.includes('canceled') ||
      s.includes('cancelled') ||
      s.includes('reject');

    return { isDone, isFail, raw: s };
  }

  async function notifyUser(orderId, messageHtml) {
    try {
      const [rows] = await promisePool.query(
        `SELECT u.telegram_chat_id, o.productName
           FROM orders o
           JOIN users u ON u.id = o.userId
          WHERE o.id = ?`,
        [orderId]
      );
      const chatId = rows?.[0]?.telegram_chat_id;
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          messageHtml,
          process.env.TELEGRAM_BOT_TOKEN
        );
      }
    } catch (e) {
      console.warn('⚠️ notifyUser error:', e.message);
    }
  }

  async function markAccepted(orderId) {
    await promisePool.query(
      `UPDATE orders
          SET status = 'Accepted',
              admin_reply = ?
        WHERE id = ?`,
      [APPROVE_MSG_EN, orderId]
    );

    // إشعار داخلي اختياري
    await promisePool.query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       SELECT o.userId,
              CONCAT('✅ Your order (', o.productName, ') has been completed.'),
              NOW(), 0
         FROM orders o WHERE o.id = ?`,
      [orderId]
    );

    // تلغرام للمستخدم
    await notifyUser(
      orderId,
      `✅ <b>Order Approved</b>\n\n🛍️ <b>Status:</b> Completed`
    );
  }

  async function markRejectedAndRefund(orderId) {
    // اجلب معلومات الطلب والمستخدم
    const [[o]] = await promisePool.query(
      `SELECT userId, price, productName
         FROM orders
        WHERE id = ?
        LIMIT 1`,
      [orderId]
    );
    if (!o) return;

    const userId = o.userId;
    const price = parseFloat(o.price || 0) || 0;

    // أرجع المبلغ
    await promisePool.query(
      `UPDATE users SET balance = balance + ? WHERE id = ?`,
      [price, userId]
    );

    // سجّل معاملة Refund
    await promisePool.query(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'credit', ?, ?)`,
      [userId, price, `Refund: Provider rejected order #${orderId}`]
    );

    // حدّث الطلب إلى Rejected + رسالة الأدمن الإنكليزية
    await promisePool.query(
      `UPDATE orders
          SET status = 'Rejected',
              admin_reply = ?
        WHERE id = ?`,
      [REJECT_MSG_EN, orderId]
    );

    // إشعار داخلي اختياري
    await promisePool.query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [
        userId,
        `❌ Your order (${o.productName}) was rejected by the provider. A refund of ${price}$ was added to your balance.`,
      ]
    );

    // تلغرام للمستخدم
    await notifyUser(
      orderId,
      `❌ <b>Order Rejected</b>\n\n💵 <b>Refund:</b> Added to your balance`
    );
  }

  async function handleOrder(row) {
    const orderId = row.id;
    const providerOrderId = row.provider_order_id;
    if (!providerOrderId) return;

    // اسأل المزوّد عن حالة الطلب
    const { ok, status, error } = await getOrderStatusFromDailycard(
      providerOrderId
    );

    if (!ok || !status) {
      if (error) {
        console.warn(
          `⚠️ Unable to read provider status for order #${orderId}: ${error}`
        );
      }
      return; // جرّب لاحقاً
    }

    const { isDone, isFail, raw } = normalizeStatusText(status);

    if (isDone) {
      await markAccepted(orderId);
      console.log(
        `✅ Order #${orderId} set to Accepted (provider status: ${raw})`
      );
      return;
    }

    if (isFail) {
      await markRejectedAndRefund(orderId);
      console.log(
        `♻️ Order #${orderId} set to Rejected and refunded (provider status: ${raw})`
      );
      return;
    }

    // حالات pending/processing/… منتركها للجولة الجاية
    console.log(
      `⏳ Order #${orderId} still pending at provider (status: ${raw})`
    );
  }

  // الدالة العامة التي يشغّلها الـ setInterval أو الراوت اليدوي
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

      if (!rows || rows.length === 0) {
        // لا يوجد شيء للمزامنة حالياً
        return;
      }

      for (const row of rows) {
        try {
          await handleOrder(row);
        } catch (e) {
          console.error(
            `❌ handleOrder error for #${row.id}:`,
            e?.message || e
          );
        }
      }
    } catch (e) {
      console.error('❌ syncProviderOrders runOnce error:', e.message);
    }
  };
};
