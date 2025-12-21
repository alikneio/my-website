require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

console.log("🔥 BOT VERSION: UNIVERSAL-REPLY v4 (DB-TIMEOUT)");
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

// ✅ تشخيص: أي رسالة بتوصل نطبعها ونرد عليها
bot.on('message', (msg) => {
  const chatId = msg.chat?.id;
  const text = msg.text || '';

  console.log("📩 GOT MESSAGE:", { chatId, text });

  // حتى ما يطلع spam على /start، خلّي الرد العام فقط لغير الأوامر
  if (!text.startsWith('/')) {
    bot.sendMessage(chatId, `✅ Bot received: ${text}`);
  }
});

// ✅ /start: يولّد كود ويحاول يخزنه بالـ DB
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Insert with timeout + retry for duplicate code
function insertCodeWithTimeout(db, code, chatId, expiresAt, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let finished = false;

    const t = setTimeout(() => {
      if (finished) return;
      finished = true;
      const err = new Error(`DB INSERT TIMEOUT after ${timeoutMs}ms`);
      err.code = 'DB_TIMEOUT';
      reject(err);
    }, timeoutMs);

    db.query(
      "INSERT INTO telegram_link_codes (code, chat_id, expires_at) VALUES (?, ?, ?)",
      [code, chatId, expiresAt],
      (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(t);
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

async function saveCode(db, chatId, expiresAt, maxTries = 5) {
  for (let i = 0; i < maxTries; i++) {
    const code = genCode();
    try {
      await insertCodeWithTimeout(db, code, chatId, expiresAt, 4000);
      return code;
    } catch (err) {
      // لو تصادم كود (Duplicate)
      const isDuplicate =
        err?.code === 'ER_DUP_ENTRY' ||
        String(err?.message || '').toLowerCase().includes('duplicate');

      if (isDuplicate) {
        console.log("⚠️ Code collision, retrying...", { try: i + 1 });
        continue;
      }

      // أي خطأ آخر نوقف
      throw err;
    }
  }

  const e = new Error("Too many code collisions");
  e.code = "CODE_COLLISION";
  throw e;
}

bot.onText(/\/start(?:@[\w_]+)?/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // رد سريع
  await bot.sendMessage(chatId, `🔄 Hi ${firstName}, generating your 6-digit code...`);

  let db;
  try {
    db = require('../database');
    console.log("✅ DB loaded for /start");
  } catch (e) {
    console.error("❌ DB require failed:", e.message);
    return bot.sendMessage(chatId, "❌ DB module error on server.");
  }

  try {
    const code = await saveCode(db, chatId, expiresAt, 5);

    await bot.sendMessage(
      chatId,
      `🔑 Your linking code is: ${code}\n\nGo to your Profile page and enter the code within 10 minutes.`
    );

    console.log("🔑 CODE SAVED:", { code, chatId });
  } catch (err) {
    console.error("❌ INSERT FAILED FULL:", err);

    if (err.code === 'DB_TIMEOUT') {
      return bot.sendMessage(
        chatId,
        "❌ DB timeout. The server can't save the code right now.\nPlease try again in a minute."
      );
    }

    if (err.code === 'CODE_COLLISION') {
      return bot.sendMessage(
        chatId,
        "❌ Could not generate a unique code. Please try again."
      );
    }

    return bot.sendMessage(chatId, `❌ DB Error: ${err.code || err.message}`);
  }
});

console.log("🤖 Telegram bot started (polling)");
