// utils/sendTelegramNotification.js
const axios = require("axios");

/**
 * Send a Telegram message safely.
 * Uses Cloudflare Worker relay if TG_RELAY_URL is set.
 *
 * Railway env:
 * - TG_RELAY_URL
 * - TG_RELAY_SECRET
 *
 * @param {string|number} chatId
 * @param {string} message
 * @param {string} botToken // kept for fallback (direct telegram)
 * @param {{
 *   timeoutMs?: number,
 *   parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown',
 *   disablePreview?: boolean
 * }} [opts]
 */
async function sendTelegramMessage(chatId, message, botToken, opts = {}) {
  const {
    timeoutMs = 15000,
    parseMode,
    disablePreview = true,
  } = opts;

  if (!chatId || !message) {
    console.error("⚠️ Missing parameters in sendTelegramMessage", {
      chatId,
      hasMessage: !!message,
    });
    throw new Error("Missing parameters");
  }

  const text = String(message).slice(0, 4096);

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: disablePreview,
  };

  if (parseMode) payload.parse_mode = parseMode;

  // ✅ Prefer relay
  const relayUrl = process.env.TG_RELAY_URL;
  const relaySecret = process.env.TG_RELAY_SECRET;

  if (relayUrl) {
    if (!relaySecret) throw new Error("TG_RELAY_SECRET missing");

    const res = await axios.post(relayUrl, payload, {
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "x-relay-secret": relaySecret,
      },
      validateStatus: () => true,
    });

    if (res.status >= 200 && res.status < 300) {
      console.log("✅ Telegram message sent (via relay)");
      return res.data;
    }

    console.error("❌ Relay returned non-2xx:", res.status, res.data);
    throw new Error(`RelayError: ${res.status}`);
  }

  // ⚠️ Fallback (direct telegram) - likely fails on Railway for you
  if (!botToken) throw new Error("botToken missing and TG_RELAY_URL not set");

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const res = await axios.post(url, payload, {
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (res.status >= 200 && res.status < 300) {
    console.log("✅ Telegram message sent (direct)");
    return res.data;
  }

  console.error("❌ Telegram returned non-2xx:", res.status, res.data);
  throw new Error(`TelegramError: ${res.status}`);
}

module.exports = sendTelegramMessage;
