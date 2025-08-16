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
  try {
    // بعض المزودين بدهم body، وبعضهم querystring. جرّب اللي تحت أولاً:
    const { data } = await dailycardAPI.post('/api-keys/orders/details/', {
      id: Number(providerOrderId)
    });

    // توقّعات شكل الرد (عدّل المابينغ تحت حسب اللي بيرجع):
    // مثال: { success:true, data:{ id:..., status:"completed" | "processing" | "canceled", message:"..." } }
    const raw = data?.data || data;

    const statusText = String(raw?.status || '').toLowerCase();
    let mapped = { local: 'Waiting', adminReply: null };

    if (['completed', 'done', 'success', 'finished'].includes(statusText)) {
      mapped.local = 'Accepted';
      mapped.adminReply = 'Your order has been approved and completed successfully.';
    } else if (['canceled', 'rejected', 'failed', 'error'].includes(statusText)) {
      mapped.local = 'Rejected';
      // لو في سبب من المزود ضمّنه:
      const reason = raw?.message || raw?.reason || 'Your order has been rejected.';
      mapped.adminReply = /^[A-Za-z0-9]/.test(reason)
        ? reason
        : 'Your order has been rejected.'; // ضمان إنكليزي قصير
    } else {
      mapped.local = 'Waiting'; // لسه قيد التنفيذ
      mapped.adminReply = null;
    }

    return { ok: true, mapped, raw };
  } catch (err) {
    console.error('❌ DailyCard status error:', err.response?.data || err.message);
    return { ok: false, error: err.response?.data || err.message };
  }
}


module.exports = {
  dailycardAPI,
  verifyPlayerId,
    getOrderStatusFromDailycard,
};
