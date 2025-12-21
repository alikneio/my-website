// utils/sendTelegramNotification.js
const axios = require('axios');

/**
 * Send a Telegram message safely.
 * @param {string|number} chatId
 * @param {string} message
 * @param {string} botToken
 * @param {{
 *   timeoutMs?: number,
 *   parseMode?: 'HTML' | 'MarkdownV2',
 *   disablePreview?: boolean
 * }} [opts]
 * @returns {Promise<any>}
 */
function sendTelegramMessage(chatId, message, botToken, opts = {}) {
  const {
    timeoutMs = 4000,
    parseMode, // ⬅️ بدون default (مهم!)
    disablePreview = true,
  } = opts;

  if (!chatId || !message || !botToken) {
    console.error("⚠️ Missing parameters in sendTelegramMessage", {
      chatId,
      hasMessage: !!message,
      hasToken: !!botToken,
    });
    return Promise.reject(new Error("Missing parameters"));
  }

  // Telegram max length = 4096
  const text = String(message).slice(0, 4096);

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: disablePreview,
  };

  // 🔐 parse_mode فقط إذا كان مطلوب صراحة
  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  return axios
    .post(url, payload, { timeout: timeoutMs })
    .then((res) => {
      console.log("✅ Telegram message sent");
      return res.data;
    })
    .catch((err) => {
      const tgError = err.response?.data;
      console.error(
        "❌ Telegram send failed:",
        tgError || err.code || err.message
      );
      throw err;
    });
}

module.exports = sendTelegramMessage;
