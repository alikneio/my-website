const db = require('../database'); // الاتصال بقاعدة البيانات
const axios = require('axios');

// بيانات البوت
const BOT_TOKEN = '8205085707:AAFCb4bsiwEIXDMe4pGYEruMBsK4aWSp40I';
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * إرسال رسالة إلى الزبون في حال تغيّر حالة طلبه
 * @param {number} orderId - رقم الطلب
 * @param {string} newStatus - الحالة الجديدة (Accepted / Rejected / Waiting)
 */
async function sendOrderStatusTelegram(orderId, newStatus) {
  try {
    // 1. جلب معلومات الطلب مع chat_id
    const [order] = await new Promise((resolve, reject) => {
      db.query(`
        SELECT o.id, o.productName, o.order_details, o.admin_reply, u.telegram_chat_id
        FROM orders o
        JOIN users u ON o.userId = u.id
        WHERE o.id = ?
      `, [orderId], (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });

    if (!order || !order.telegram_chat_id) {
      console.log(`ℹ️ No telegram_chat_id found for order #${orderId}`);
      return;
    }

    // 2. إعداد الرسالة بالتفاصيل
   const message = `
<b>📦 تم تحديث حالة طلبك!</b>

🔢 <b>رقم الطلب:</b> ${order.id}
🛍️ <b>المنتج:</b> ${order.productName}
📋 <b>التفاصيل:</b> ${order.order_details || 'لا يوجد'}
📌 <b>الحالة الجديدة:</b> ${newStatus}
🔐 <b>معلومات حسابك:</b> ${order.admin_reply || 'لا يوجد'}

🤖 شكراً لاستخدامك منصتنا 💖
`.trim();


    // 3. إرسال الرسالة
    await axios.post(`${BASE_URL}/sendMessage`, {
      chat_id: order.telegram_chat_id,
      text: message,
      parse_mode: 'HTML'
    });

    console.log(`✅ Telegram message sent for order #${orderId}`);
  } catch (err) {
    console.error("❌ Error sending Telegram message:", err.response?.data || err.message);
  }
}

module.exports = sendOrderStatusTelegram;
