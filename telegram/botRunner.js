
const TelegramBot = require('node-telegram-bot-api');

console.log("🔥 BOT VERSION: RAILWAY-DB-PROMISE v1");
console.log("🔥 TOKEN EXISTS:", !!process.env.TELEGRAM_BOT_TOKEN);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.getMe()
  .then((me) => console.log("✅ getMe:", { id: me.id, username: me.username, name: me.first_name }))
  .catch((e) => console.error("❌ getMe failed:", e.message));

bot.on('polling_error', (err) => console.error("❌ polling_error:", err.message));

// ✅ استيراد قاعدة البيانات (وهي Promise-based)
const db = require('../database');

// كود 6 أرقام
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ✅ helper للـ timeout الحقيقي على Promise
function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const e = new Error(`${label} timeout after ${ms}ms`);
        e.code = 'DB_TIMEOUT';
        reject(e);
      }, ms)
    )
  ]);
}

bot.onText(/\/start(?:@[\w_]+)?/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';

  const code = genCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await bot.sendMessage(chatId, `🔄 Hi ${firstName}, generating your 6-digit code...`);

  try {
    // ✅ هذا السطر هو الأهم: db.query هي async (Promise)
    await withTimeout(
      db.query(
        "INSERT INTO telegram_link_codes (code, chat_id, expires_at) VALUES (?, ?, ?)",
        [code, chatId, expiresAt]
      ),
      6000,
      "DB insert"
    );

    await bot.sendMessage(
      chatId,
      `🔑 Your linking code is: ${code}\n\nGo to your Profile page and enter the code within 10 minutes.`
    );

    console.log("🔑 CODE SAVED:", { code, chatId });
  } catch (err) {
    console.error("❌ INSERT FAILED FULL:", err);

    if (err.code === 'DB_TIMEOUT') {
      return bot.sendMessage(chatId, "❌ DB timeout. Please try again in a minute.");
    }

    // أخطاء شائعة مفيدة
    return bot.sendMessage(chatId, `❌ DB Error: ${err.code || err.message}`);
  }
});

console.log("🤖 Telegram bot started (polling)");
