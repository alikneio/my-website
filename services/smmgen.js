// /app/services/smmgen.js
const axios = require("axios");

const API_URL = "https://smmgen.com/api/v2";
const API_KEY = process.env.SMMGEN_API_KEY;

if (!API_KEY) {
  console.warn("⚠️ SMMGEN_API_KEY is not set in .env");
}

// دالة صغيرة مشتركة للـ API
async function callSmmgen(body) {
  const params = new URLSearchParams({
    key: API_KEY,
    ...body,
  });

  const { data } = await axios.post(API_URL, params);
  return data;
}

// 1) جلب الخدمات
async function getSmmServices() {
  const data = await callSmmgen({ action: "services" });
  if (!Array.isArray(data)) {
    throw new Error("Invalid SMMGEN services response");
  }
  return data;
}

// 2) إنشاء طلب جديد
async function createSmmOrder({ service, link, quantity }) {
  const url = process.env.SMMGEN_URL; // حسب ما عندك
  const key = process.env.SMMGEN_KEY;

  const { data } = await axios.post(url, {
    key,
    action: 'add',
    service,
    link,
    quantity,
  });

  console.log('SMMGEN add response:', data);

  // إذا في Error من المزود نفسه
  if (data.error) {
    throw new Error(data.error);
  }

  // لازم يرجع order id
  const orderId = Number(data.order);
  if (!orderId) {
    throw new Error('No order id returned from SMMGEN');
  }

  return orderId;
}


module.exports = {
  getSmmServices,
  createSmmOrder,
};
