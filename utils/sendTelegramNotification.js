// utils/sendTelegramNotification.js
const axios = require("axios");

/**
 * Safe Telegram sender using Cloudflare Worker relay.
 *
 * Required env on Railway:
 * - TG_RELAY_URL
 * - TG_RELAY_SECRET
 *
 * NOTE:
 * - Direct Telegram calls (api.telegram.org) are DISABLED because Railway times out for you.
 * - Function returns true/false and never throws to avoid breaking routes.
 *
 * @param {string|number} chatId
 * @param {string} message
 * @param {string} botToken  // kept for compatibility but NOT used (no direct fallback)
 * @param {{
 *   timeoutMs?: number,
 *   parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown',
 *   disablePreview?: boolean
 * }} [opts]
 * @returns {Promise<boolean>}
 */
async function sendTelegramMessage(chatId, message, botToken, opts = {}) {
  const {
    timeoutMs = 15000,
    parseMode,
    disablePreview = true,
  } = opts;

  try {
    // -------------------------
    // Validate inputs
    // -------------------------
    if (!chatId || !message) {
      console.error("⚠️ sendTelegramMessage: Missing parameters", {
        chatId,
        hasMessage: !!message,
      });
      return false;
    }

    // -------------------------
    // Build payload (Telegram-compatible)
    // -------------------------
    const text = String(message).slice(0, 4096);

    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: disablePreview,
    };

    if (parseMode) payload.parse_mode = parseMode;

    // -------------------------
    // Relay config (required)
    // -------------------------
    const relayUrl = (process.env.TG_RELAY_URL || "").trim();
   const relaySecret = (
  process.env.TG_RELAY_SECRET ||
  process.env.RELAY_SECRET ||
  ""
).trim();


    if (!relayUrl) {
      console.error("⚠️ sendTelegramMessage: TG_RELAY_URL missing (relay disabled).");
      return false;
    }

    if (!relaySecret) {
      console.error("⚠️ sendTelegramMessage: TG_RELAY_SECRET missing.");
      return false;
    }

    // -------------------------
    // Send via Cloudflare relay
    // -------------------------
    const res = await axios.post(relayUrl, payload, {
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "x-relay-secret": relaySecret,
      },
      // don't throw on non-2xx, we handle it ourselves
      validateStatus: () => true,
    });

    if (res.status >= 200 && res.status < 300) {
      console.log("✅ Telegram message sent (via relay)");
      return true;
    }

    console.error("❌ Relay returned non-2xx:", {
      status: res.status,
      data: res.data,
    });
    return false;

  } catch (err) {
    // Axios/network errors
    console.error("❌ sendTelegramMessage failed:", {
      code: err.code,
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
    });
    return false;
  }
}

module.exports = sendTelegramMessage;
