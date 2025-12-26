
const axios = require('axios');

(async () => {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  const res = await axios.get(`https://api.telegram.org/bot${t}/deleteWebhook?drop_pending_updates=true`);
  console.log(res.data);
})();
