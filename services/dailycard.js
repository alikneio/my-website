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

async function getOrderStatusFromDailycard(providerOrderId) {
  const id = String(providerOrderId).trim();
  // المرشّحات اللي رح نجربها بالترتيب
  const attempts = [
    // POST body
    { method: 'post', url: '/api-keys/orders/details/', data: { order_id: id } },
    { method: 'post', url: '/api-keys/orders/details',  data: { order_id: id } },
    { method: 'post', url: '/api-keys/order/details/',  data: { order_id: id } }, // بعض الأنظمة تستعمل المفرد
    { method: 'post', url: '/api-keys/order/details',   data: { order_id: id } },

    // GET path param
    { method: 'get',  url: `/api-keys/orders/details/${encodeURIComponent(id)}/` },
    { method: 'get',  url: `/api-keys/orders/details/${encodeURIComponent(id)}` },
    { method: 'get',  url: `/api-keys/order/details/${encodeURIComponent(id)}/` },
    { method: 'get',  url: `/api-keys/order/details/${encodeURIComponent(id)}` },
  ];

  // دالة مساعدة لاستخراج الحالة من أشكال ردود مختلفة
  const extractStatus = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    // محاولات شائعة
    if (payload.status && typeof payload.status === 'string') return payload.status;
    if (payload.order_status) return payload.order_status;
    if (payload.data && typeof payload.data.status === 'string') return payload.data.status;
    if (payload.result && typeof payload.result.status === 'string') return payload.result.status;
    if (payload.order && typeof payload.order.status === 'string') return payload.order.status;
    // fallback: إذا كلشي فشل، رجّع النص كله
    return null;
  };

  let lastErr = null;

  for (const a of attempts) {
    try {
      const res = await dailycardAPI.request({
        method: a.method,
        url: a.url,
        ...(a.data ? { data: a.data } : {}),
        timeout: 20000,
      });

      // إذا الـ API بيرجع success بوَجه آخر
      const data = res?.data;
      const status = extractStatus(data) || (typeof data === 'string' ? data : null);
      if (status) {
        console.log(`ℹ️ DailyCard status via ${a.method.toUpperCase()} ${a.url}:`, status);
        return { ok: true, status, raw: data };
      }

      // أحياناً بيرجع {success: true, message: "..."} وفيها كلمة النجاح
      if (data && data.success && data.message) {
        console.log(`ℹ️ DailyCard msg via ${a.method.toUpperCase()} ${a.url}:`, data.message);
        return { ok: true, status: String(data.message), raw: data };
      }

      // إذا وصلنا لهون وما عرفنا نقرأ الحالة، جرّب محاولة تانية
      lastErr = new Error('Unrecognized status shape');
    } catch (e) {
      const body = e?.response?.data;
      const http = e?.response?.status;
      // useful logs للتشخيص
      console.error(`❌ DailyCard status error on ${a.method.toUpperCase()} ${a.url} [${http || 'no-http'}]:`,
        typeof body === 'string' ? body.slice(0, 200) : body || e.message);
      lastErr = e;
      // كمّل لباقي المحاولات
    }
  }

  return { ok: false, status: null, error: lastErr?.message || 'All attempts failed' };
}

module.exports = {
  dailycardAPI,
  verifyPlayerId,
  getOrderStatusFromDailycard, // ⬅️ مهم
};