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

async function getOrderStatus(providerOrderId) {
  try {
    // ⛳️ قد يلزم تعديل المسار حسب وثيقة DailyCard (احتمال: /api-keys/orders/status/)
    const { data } = await dailycardAPI.post('/api-keys/orders/status/', {
      id: providerOrderId
    });

    // توحيد الاستاتسات لأسماء بسيطة
    const raw = (data?.status || data?.data?.status || '').toString().toLowerCase();
    return { ok: true, status: raw, raw };
  } catch (err) {
    console.error('❌ getOrderStatus error:', err.response?.data || err.message);
    return { ok: false, status: null };
  }
}

module.exports = {
  dailycardAPI,
  verifyPlayerId,
  getOrderStatus
};
