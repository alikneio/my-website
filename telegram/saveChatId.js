// telegram/saveChatId.js
const TelegramBot = require('node-telegram-bot-api');
const token = '8205085707:AAFCb4bsiwEIXDMe4pGYEruMBsK4aWSp40I';
const bot = new TelegramBot(token, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'مستخدم';

  console.log(`📨 رسالة من ${firstName} (ID: ${chatId})`);

  const message = `
✅ تم تفعيل البوت يا ${firstName}!

📩 لتوصلك إشعارات الطلبات على تيليغرام:
1. تأكد أنك مسجّل دخول على الموقع
2. ثم اضغط الزر بالأسفل لتأكيد ربط حسابك
`.trim();

  const verificationUrl = `http://localhost:3000/set-telegram/${chatId}`; // غيّره إذا عندك دومين خارجي

  bot.sendMessage(chatId, message, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔗 اضغط هنا لتأكيد الربط", url: verificationUrl }]
      ]
    }
  }).then(() => {
    console.log("✅ Sent confirmation link");
  }).catch(err => {
    console.error("❌ Failed to send message:", err.message);
  });
});
