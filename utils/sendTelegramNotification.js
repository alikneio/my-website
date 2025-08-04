const axios = require('axios');

/**
 * يرسل رسالة Telegram عبر البوت.
 * @param {string|number} chatId
 * @param {string} message
 * @param {string} botToken
 * @returns {Promise}
 */
function sendTelegramMessage(chatId, message, botToken) {
  if (!chatId || !message || !botToken) {
    console.error("⚠️ Missing parameters in sendTelegramMessage", { chatId, message, botToken });
    return Promise.reject(new Error("Missing parameters"));
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  return axios.post(url, {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML"
  }).then((res) => {
    console.log("✅ Telegram message sent");
    return res;
  }).catch((err) => {
    console.error("❌ Telegram send failed:", err.message);
    throw err;
  });
}

module.exports = sendTelegramMessage;
