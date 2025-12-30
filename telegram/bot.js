// telegram/bot.js ✅ WEBHOOK VERSION + RELAY SENDER
const TelegramBot = require("node-telegram-bot-api");
const db = require("../database");

// 🔁 هذا الملف صار يرسل رسائل عبر Cloudflare Relay (utils/sendTelegramNotification.js)
const sendTelegramMessage = require("../utils/sendTelegramNotification");

console.log("🤖 Starting Telegram bot (webhook)... PID:", process.pid);

if (global.__TG_BOT__) {
  console.log("ℹ️ Telegram bot already initialized, reusing instance.");
  module.exports = global.__TG_BOT__;
  return;
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing. Bot will not start.");
  module.exports = null;
  return;
}

// ✅ Webhook mode
const bot = new TelegramBot(token, { polling: false });
global.__TG_BOT__ = bot;

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const e = new Error(`${label} timeout after ${ms}ms`);
        e.code = "DB_TIMEOUT";
        reject(e);
      }, ms)
    ),
  ]);
}

// ✅ Send via Relay (so Railway doesn't need to reach Telegram)
async function safeSend(chatId, text) {
  try {
    return await sendTelegramMessage(chatId, text, token, {
      timeoutMs: 15000,
      parseMode: "Markdown",
      disablePreview: true,
    });
  } catch (e) {
    console.error("❌ safeSend (relay) failed:", e.code || e.message);
    return null;
  }
}

bot.onText(/\/start(?:@[\w_]+)?/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || "User";

  const code = genCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await safeSend(chatId, `🔄 Hi ${firstName}, generating your 6-digit code...`);

  try {
    await withTimeout(
      db.query(
        "INSERT INTO telegram_link_codes (code, chat_id, expires_at) VALUES (?, ?, ?)",
        [code, chatId, expiresAt]
      ),
      8000,
      "DB insert"
    );

    await safeSend(
      chatId,
      `🔑 Your linking code is: ${code}\n\nGo to your Profile page and enter the code within 10 minutes.`
    );

    console.log("🔑 CODE SAVED:", { code, chatId });
  } catch (err) {
    console.error("❌ Insert failed:", err.code || err.message);

    if (err.code === "DB_TIMEOUT") {
      await safeSend(chatId, "❌ DB timeout. Please try again.");
      return;
    }

    await safeSend(chatId, `❌ DB Error: ${err.code || err.message}`);
  }
});

console.log("🤖 Telegram bot ready (webhook mode)");

module.exports = bot;
