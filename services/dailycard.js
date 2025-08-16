const axios = require('axios');
require('dotenv').config();

console.log("🔑 Loaded API KEY:", process.env.DAILYCARD_API_KEY);
console.log("🔒 Loaded API SECRET:", process.env.DAILYCARD_API_SECRET);

const dailycardAPI = axios.create({
  baseURL: 'https://dailycard.shop/UAPI',
    timeout: 20000,
  headers: {
    // ✅ تم تصحيح هذا السطر لاستخدام backticks
    'Authorization': `Bearer ${process.env.DAILYCARD_API_KEY}`,
    'X-API-KEY': process.env.DAILYCARD_API_KEY,
    'X-API-SECRET': process.env.DAILYCARD_API_SECRET,
    'Content-Type': 'application/json'
  }
});




async function verifyPlayerId(productId, playerId) {
  try {
    const body = {
      product_id: parseInt(productId),
      player_id: playerId.toString()
    };

    console.log("✅ Sending to API:", body); // طباعة محتوى الطلب

    const res = await dailycardAPI.post('/api-keys/check-player/', body);

    console.log("🔽 API Raw Response:");
    console.dir(res.data, { depth: null }); // طباعة الرد كاملاً

    return res.data;
  } catch (error) {
    console.error('❌ Error verifying player ID:', error.response?.data || error.message);
    return { success: false, message: "Failed to verify player ID" };
  }
}

// =================== getOrderStatusFromDailycard ==================
// دالة مرنة تجرب عدة مسارات/طرق حتى تجد واحد يشتغل.
async function getOrderStatusFromDailycard(providerOrderId) {
  const id = String(providerOrderId).trim();

  // دوال صغيرة تساعدنا نلتقط الحالة من أي شكل رد
  const pickStatus = (data) => {
    if (!data) return null;
    // احتمالات شائعة
    return (
      data.status ||                  // { status: "Accepted" }
      data.order_status ||            // { order_status: "Completed" }
      data.state ||                   // { state: "success" }
      data?.data?.status ||           // { data: { status: "..." } }
      data?.result?.status ||         // { result: { status: "..." } }
      null
    );
  };

  // محاولات مختلفة (ترتيب مدروس):
  const attempts = [
    // 1) POST body variants لنفس المسار
    { method: 'post', url: '/api-keys/orders/details/', data: { order_id: id } },
    { method: 'post', url: '/api-keys/orders/details/', data: { id } },
    { method: 'post', url: '/api-keys/orders/details/', data: { order: id } },

    // 2) GET مع Path Param مع/بدون سلاش
    { method: 'get', url: `/api-keys/orders/details/${id}/` },
    { method: 'get', url: `/api-keys/orders/details/${id}` },

    // 3) مسارات بديلة محتملة
    { method: 'post', url: '/api-keys/orders/status/', data: { order_id: id } },
    { method: 'post', url: '/api-keys/order/status/',  data: { order_id: id } },
    { method: 'post', url: '/api-keys/orders/view/',   data: { order_id: id } },
    { method: 'post', url: '/api-keys/orders/get/',    data: { order_id: id } },
  ];

  for (const attempt of attempts) {
    try {
      const res = await dailycardAPI.request(attempt);
      const status = pickStatus(res.data);
      if (status) {
        return { ok: true, status, raw: res.data };
      }
      // إذا ما لقينا status واضح، خلّيها محاولة فاشلة لنجرب اللي بعدها
      console.warn(`⚠️ DailyCard details ambiguous on ${attempt.method.toUpperCase()} ${attempt.url}:`, JSON.stringify(res.data).slice(0, 300));
    } catch (err) {
      const code = err.response?.status || 'ERR';
      const body = typeof err.response?.data === 'string'
        ? err.response.data.slice(0, 200)
        : JSON.stringify(err.response?.data || '').slice(0, 200);
      console.error(`❌ DailyCard status error on ${attempt.method.toUpperCase()} ${attempt.url} [${code}]: ${body}`);
    }
  }

  return { ok: false, error: 'All status endpoint attempts returned no result' };
}

module.exports = {
  dailycardAPI,
  verifyPlayerId,
  getOrderStatusFromDailycard,
};