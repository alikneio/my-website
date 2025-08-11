const axios = require('axios');

/**
 * يرسل رسالة Telegram عبر البوت.
 * @param {string|number} chatId
 * @param {string} message
 * @param {string} botToken
 * @param {{ timeoutMs?: number, parseMode?: 'HTML'|'MarkdownV2' }} [opts]
 * @returns {Promise<any>}
 */
function sendTelegramMessage(chatId, message, botToken, opts = {}) {
  const { timeoutMs = 4000, parseMode = 'HTML' } = opts;

  if (!chatId || !message || !botToken) {
    console.error("⚠️ Missing parameters in sendTelegramMessage", {
      chatId,
      hasMessage: !!message,
      hasToken: !!botToken, // لا تطبع التوكن نفسه
    });
    return Promise.reject(new Error("Missing parameters"));
  }

  // حد طول الرسالة حسب تيليغرام
  const text = String(message).slice(0, 4096);

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  return axios.post(
    url,
    {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      // ممكن تضيف خيارات مثل:
      // disable_web_page_preview: true,
    },
    {
      timeout: timeoutMs, // ⏱️ مهم جداً
    }
  )
  .then((res) => {
    console.log("✅ Telegram message sent");
    return res.data;
  })
  .catch((err) => {
    console.error("❌ Telegram send failed:", err.code || err.message);
    throw err;
  });
}

module.exports = sendTelegramMessage;
