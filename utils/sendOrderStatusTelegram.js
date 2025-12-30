// utils/sendOrderStatusTelegram.js
const { query } = require('../database');            // Promise-based query
const sendTelegramMessage = require('./sendTelegramNotification');

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;      // من ENV
const ADMIN_CHAT  = process.env.ADMIN_TELEGRAM_CHAT_ID;  // من ENV

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * يبعت تحديث حالة الطلب على تيليغرام للمستخدم (ولو موجود) للأدمن.
 * newStatus: Accepted / Rejected / Waiting ...
 * يرجّع true/false وما بيفشّل الراوت.
 */
async function sendOrderStatusTelegram(orderId, newStatus, adminReplyFromRoute = '') {
  try {
    // جيب الطلب + chat_id
    const rows = await query(
      `SELECT o.id, o.productName, o.order_details, o.admin_reply, u.telegram_chat_id, u.id AS userId
       FROM orders o
       JOIN users u ON o.userId = u.id
       WHERE o.id = ?`,
      [orderId]
    );

    if (!rows.length) {
      console.warn(`sendOrderStatusTelegram: order not found #${orderId}`);
      return true;
    }

    if (!BOT_TOKEN) {
      console.warn('sendOrderStatusTelegram: TELEGRAM_BOT_TOKEN missing');
      return true;
    }

    const o = rows[0];

    // لو الإدمن عدّل الملاحظة بهالراوت ومش بعدّلت بعد بالـ SELECT
    const rawReply  = (adminReplyFromRoute || o.admin_reply || '').replace(/\\n/g, '\n');

    const safeProduct = escapeHtml(o.productName || '');
    const safeDetails = escapeHtml(o.order_details || 'لا يوجد');
    const safeReply   = escapeHtml(rawReply || 'لا يوجد');
    const safeStatus  = escapeHtml(newStatus || '');

    // رسالة المستخدم
    const userMsg = (
`<b>📦 تم تحديث حالة طلبك!</b>

🔢 <b>رقم الطلب:</b> ${o.id}
🛍️ <b>المنتج:</b> ${safeProduct}
📋 <b>التفاصيل:</b> ${safeDetails}
📌 <b>الحالة الجديدة:</b> ${safeStatus}
📝 <b>ملاحظة:</b> ${safeReply}

🤖 شكراً لاستخدامك منصتنا 💖`
    );

    // رسالة الأدمن (اختياري)
    const adminMsg =
`📝 <b>تحديث حالة طلب</b>
#${o.id} • ${safeProduct}
👤 UID: ${o.userId}
📌 الحالة: <b>${safeStatus}</b>${rawReply ? `\n📝 ملاحظة: ${escapeHtml(rawReply)}` : ''}`;

    const tasks = [];

    // أرسل للمستخدم إذا عنده chat id
    if (o.telegram_chat_id) {
      tasks.push(
        sendTelegramMessage(o.telegram_chat_id, userMsg, BOT_TOKEN, { timeoutMs: 4000, parseMode: 'HTML' })
      );
    }

    // وأرسل للأدمن إذا معرّف
    if (ADMIN_CHAT) {
      tasks.push(
        sendTelegramMessage(ADMIN_CHAT, adminMsg, BOT_TOKEN, { timeoutMs: 4000, parseMode: 'HTML' })
      );
    }

    if (tasks.length === 0) {
      console.log('ℹ️ No Telegram targets for order', orderId);
      return true;
    }

    // مننتظر الكل لكن ما منرمي خطأ — منشان ما يعلّق الراوت
    await Promise.allSettled(tasks);
    return true;

  } catch (err) {
    console.error('sendOrderStatusTelegram failed:', err.message);
    return false;
  }
}

module.exports = sendOrderStatusTelegram;
