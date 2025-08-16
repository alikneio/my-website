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

// =================== getOrderStatusFromDailycard (improved) ===================
async function getOrderStatusFromDailycard(providerOrderId) {
  const id = String(providerOrderId || '').trim();
  if (!id) return { ok: false, error: 'missing id' };

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

  // إذا الرد HTML (404 template) بنتجاهله مباشرة
  const looksHTML = (x) =>
    typeof x === 'string' && /<html|<!DOCTYPE html/i.test(x);

  // محاولات GET مع باراميترات مختلفة
  const attempts = [
    // endpoint المُرجّح
    { method: 'get', url: '/api-keys/orders/status/', params: { order_id: id } },
    { method: 'get', url: '/api-keys/orders/status/', params: { id } },
    { method: 'get', url: '/api-keys/orders/status/', params: { order: id } },
    { method: 'get', url: '/api-keys/orders/status/', params: { provider_order_id: id } },

    { method: 'get', url: '/api-keys/orders/status', params: { order_id: id } },
    { method: 'get', url: '/api-keys/orders/status', params: { id } },
    { method: 'get', url: '/api-keys/orders/status', params: { order: id } },
    { method: 'get', url: '/api-keys/orders/status', params: { provider_order_id: id } },

    // لائحة + تصفية
    { method: 'get', url: '/api-keys/orders/', params: { order_id: id } },
    { method: 'get', url: '/api-keys/orders/', params: { provider_order_id: id } },
    { method: 'get', url: '/api-keys/orders',  params: { order_id: id } },
    { method: 'get', url: '/api-keys/orders',  params: { provider_order_id: id } },

    // REST detail style (بدون params)
    { method: 'get', url: `/api-keys/orders/${encodeURIComponent(id)}/` },
    { method: 'get', url: `/api-keys/orders/${encodeURIComponent(id)}` },
    { method: 'get', url: `/api-keys/order/${encodeURIComponent(id)}/` },
    { method: 'get', url: `/api-keys/order/${encodeURIComponent(id)}` },
  ];

  for (const attempt of attempts) {
    try {
      const res = await dailycardAPI.request(attempt);

      if (looksHTML(res.data)) {
        // صفحة HTML -> تجاهلها
        continue;
      }

      // جرّب نقرأ الحالة مباشرة
      let status = pickStatus(res.data);

      // إذا الرد Array، دور على الطلب
      if (!status && Array.isArray(res.data)) {
        const match = res.data.find(
          (o) =>
            String(o.id) === id ||
            String(o.order_id) === id ||
            String(o.provider_order_id) === id
        );
        if (match) status = pickStatus(match) || match.status || match.order_status || match.state || null;
        if (status) return { ok: true, status, raw: match };
      }

      // بنى شائعة أخرى
      if (!status && res.data?.data) status = pickStatus(res.data.data);
      if (!status && res.data?.result) status = pickStatus(res.data.result);

      if (status) {
        return { ok: true, status, raw: res.data };
      }

      // ما لقينا status صريح
      // نحذر بدون ضجيج كبير
      // console.warn('⚠️ Ambiguous provider status payload:', JSON.stringify(res.data).slice(0, 300));
    } catch (err) {
      const code = err.response?.status || 'ERR';
      const bodyRaw = err.response?.data;
      const body = looksHTML(bodyRaw)
        ? '[HTML]'
        : typeof bodyRaw === 'string'
          ? bodyRaw.slice(0, 200)
          : JSON.stringify(bodyRaw || '').slice(0, 200);
      console.error(
        `❌ DailyCard status error on ${attempt.method.toUpperCase()} ${attempt.url} [${code}]: ${body}`
      );
    }
  }

  // محاولة أخيرة: لستة عامة بلا params ونفتّش
  try {
    const res = await dailycardAPI.get('/api-keys/orders/');
    if (!looksHTML(res.data) && Array.isArray(res.data)) {
      const match = res.data.find(
        (o) =>
          String(o.id) === id ||
          String(o.order_id) === id ||
          String(o.provider_order_id) === id
      );
      if (match) {
        const status =
          pickStatus(match) || match.status || match.order_status || match.state || null;
        if (status) return { ok: true, status, raw: match };
      }
    }
  } catch (err) {
    const code = err.response?.status || 'ERR';
    const bodyRaw = err.response?.data;
    const body = looksHTML(bodyRaw)
      ? '[HTML]'
      : typeof bodyRaw === 'string'
        ? bodyRaw.slice(0, 200)
        : JSON.stringify(bodyRaw || '').slice(0, 200);
    console.error(`❌ DailyCard fallback list error [${code}]: ${body}`);
  }

  return { ok: false, error: 'All status endpoint attempts returned no result' };
}
