const axios = require('axios');

/**
 * يرسل رسالة Telegram عبر البوت (مع timeout افتراضي 4s)
 * بيرجع true/false بدل ما يعلّق الراوت.
 */
async function sendTelegramMessage(chatId, message, botToken, opts = {}) {
  const { timeoutMs = 4000, parseMode = 'HTML' } = opts;

  if (!chatId || !message || !botToken) {
    console.error("⚠️ Missing parameters in sendTelegramMessage", {
      chatId,
      hasMessage: !!message,
      hasToken: !!botToken,
    });
    return false;
  }

  const text = String(message).slice(0, 4096);
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    await axios.post(
      url,
      { chat_id: chatId, text, parse_mode: parseMode },
      { timeout: timeoutMs }
    );
    console.log("✅ Telegram message sent");
    return true;
  } catch (err) {
    console.error("❌ Telegram send failed:", err.code || err.message);
    return false;
  }
}

module.exports = sendTelegramMessage;
