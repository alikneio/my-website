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
// داخل services/dailycard.js

async function getOrderStatusFromDailycard(providerOrderId) {
  const id = String(providerOrderId).trim();

  const pickStatus = (data) => {
    if (!data) return null;
    return (
      data.status ||
      data.order_status ||
      data.state ||
      data?.data?.status ||
      data?.result?.status ||
      null
    );
  };

  // محاولات جديدة مبنية على اللوج (GET مسموح على /orders/status/)
  const attempts = [
    // 1) GET /orders/status/ مع باراميترات
    { method: 'get', url: '/api-keys/orders/status/', params: { order_id: id } },
    { method: 'get', url: '/api-keys/orders/status/', params: { id } },
    { method: 'get', url: '/api-keys/orders/status/', params: { order: id } },

    // 2) نفس الشي بدون السلاش الختامي
    { method: 'get', url: '/api-keys/orders/status', params: { order_id: id } },
    { method: 'get', url: '/api-keys/orders/status', params: { id } },
    { method: 'get', url: '/api-keys/orders/status', params: { order: id } },

    // 3) احتمال يكون في اندبوينت لائحة + تصفية
    { method: 'get', url: '/api-keys/orders/', params: { order_id: id } },
    { method: 'get', url: '/api-keys/orders',  params: { order_id: id } },
    { method: 'get', url: '/api-keys/orders/', params: { id } },
    { method: 'get', url: '/api-keys/orders',  params: { id } },
  ];

  for (const attempt of attempts) {
    try {
      const res = await dailycardAPI.request(attempt);
      // جرّب نقرأ الحالة مباشرة
      let status = pickStatus(res.data);

      // إذا الرد عبارة عن لائحة، جرّب لاقي الطلب ونقرأ حالته
      if (!status && Array.isArray(res.data)) {
        const match = res.data.find(
          (o) =>
            String(o.id) === id ||
            String(o.order_id) === id ||
            String(o.provider_order_id) === id
        );
        if (match) status = pickStatus(match) || match.status || match.order_status || match.state || null;
      }

      // أحيانًا بيرجع {data: {...}} أو {result: {...}}
      if (!status && res.data?.data) {
        status = pickStatus(res.data.data);
      }
      if (!status && res.data?.result) {
        status = pickStatus(res.data.result);
      }

      if (status) {
        return { ok: true, status, raw: res.data };
      }

      console.warn(
        `⚠️ DailyCard status ambiguous on ${attempt.method.toUpperCase()} ${attempt.url} params=${JSON.stringify(attempt.params || {})}:`,
        JSON.stringify(res.data).slice(0, 300)
      );
    } catch (err) {
      const code = err.response?.status || 'ERR';
      const body =
        typeof err.response?.data === 'string'
          ? err.response.data.slice(0, 200)
          : JSON.stringify(err.response?.data || '').slice(0, 200);
      console.error(
        `❌ DailyCard status error on ${attempt.method.toUpperCase()} ${attempt.url} [${code}]: ${body}`
      );
    }
  }

  // محاولة أخيرة: جيب لستة عامة (من غير باراميترات) وفتّش
  try {
    const res = await dailycardAPI.get('/api-keys/orders/');
    if (Array.isArray(res.data)) {
      const match = res.data.find(
        (o) =>
          String(o.id) === id ||
          String(o.order_id) === id ||
          String(o.provider_order_id) === id
      );
      const status =
        pickStatus(match) ||
        match?.status ||
        match?.order_status ||
        match?.state ||
        null;
      if (status) return { ok: true, status, raw: match };
    }
  } catch (err) {
    const code = err.response?.status || 'ERR';
    const body =
      typeof err.response?.data === 'string'
        ? err.response.data.slice(0, 200)
        : JSON.stringify(err.response?.data || '').slice(0, 200);
    console.error(`❌ DailyCard fallback list error [${code}]: ${body}`);
  }

  return { ok: false, error: 'All status endpoint attempts returned no result' };
}

module.exports = {
  dailycardAPI,
  verifyPlayerId,
  getOrderStatusFromDailycard,
};