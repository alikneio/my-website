// telegram/bot.js
const TelegramBot = require("node-telegram-bot-api");
const db = require("../database"); // { pool, promisePool, query }

console.log("🤖 Starting Telegram bot... PID:", process.pid);

// ✅ Prevent double-init inside same Node process (in case of duplicate imports)
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

// ✅ Use more stable polling config
const bot = new TelegramBot(token, {
  polling: {
    interval: 1000,
    params: { timeout: 30 }, // long polling timeout
  },
});

global.__TG_BOT__ = bot;

// ---------- Helpers ----------
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

// ✅ Prevent sendMessage errors from crashing / spamming logs
async function safeSend(chatId, text, extra) {
  try {
    return await bot.sendMessage(chatId, text, extra);
  } catch (e) {
    console.error("❌ sendMessage failed:", {
      message: e.message,
      code: e.code,
      statusCode: e.response?.statusCode,
      body: e.response?.body,
    });
    return null;
  }
}

// ---------- Connection check ----------
bot.getMe()
  .then((me) => console.log("✅ Bot connected:", me.username))
  .catch((e) => console.error("❌ getMe failed:", e.message));

// ---------- Polling error handling (FULL + backoff restart) ----------
let restarting = false;
let backoffMs = 2000; // starts at 2s, grows to max

bot.on("polling_error", async (err) => {
  console.error("❌ polling_error FULL:", {
    name: err.name,
    message: err.message,
    code: err.code,
    statusCode: err.response?.statusCode,
    body: err.response?.body,
  });

  // If already restarting, don't stack restarts
  if (restarting) return;
  restarting = true;

  // Exponential backoff up to 30s
  backoffMs = Math.min(backoffMs * 2, 30000);

  try {
    await bot.stopPolling();
  } catch (_) {}

  setTimeout(async () => {
    try {
      await bot.startPolling();
      console.log("✅ polling restarted (backoff:", backoffMs, "ms)");
      backoffMs = 2000; // reset on success
    } catch (e) {
      console.error("❌ restart polling failed:", e.message);
    } finally {
      restarting = false;
    }
  }, backoffMs);
});

// ---------- Commands ----------
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

console.log("🤖 Telegram bot started (polling)");

module.exports = bot;
