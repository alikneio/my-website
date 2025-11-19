// /app/services/smmgen.js
const axios = require("axios");

const API_URL = process.env.SMMGEN_API_URL || "https://smmgen.com/api/v2";
const API_KEY = process.env.SMMGEN_API_KEY;

if (!API_KEY) {
  console.warn("⚠️ SMMGEN_API_KEY is not set in .env");
}

// -----------------------------
//  دالة مشتركة لاستدعاء SMMGEN
// -----------------------------
async function callSmmgen(body) {
  if (!API_KEY) {
    throw new Error("SMMGEN_API_KEY is missing");
  }

  const params = new URLSearchParams({
    key: API_KEY,
    ...body,
  });

  const { data } = await axios.post(API_URL, params.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 20000,
  });

  return data;
}

// -----------------------------
//  1) جلب الخدمات
// -----------------------------
async function getSmmServices() {
  const data = await callSmmgen({ action: "services" });

  console.log("SMMGEN services sample:", Array.isArray(data) ? data[0] : data);

  if (!Array.isArray(data)) {
    throw new Error(
      "Invalid SMMGEN services response: " + JSON.stringify(data)
    );
  }

  return data;
}

// -----------------------------
//  2) جلب حالة طلب واحد
//  (مهم لـ syncSMM)
// -----------------------------
async function getSmmOrderStatus(orderId) {
  if (!orderId) throw new Error("orderId is required");

  const data = await callSmmgen({
    action: "status",
    order: String(orderId),
  });

  console.log("SMMGEN status response:", data);

  return data;
}

// -----------------------------
//  3) إنشاء طلب جديد
// -----------------------------
async function createSmmOrder({ service, link, quantity }) {
  if (!API_KEY) {
    throw new Error("SMMGEN_API_KEY is missing");
  }

  const cleanService = String(service || "").trim();
  const cleanLink = String(link || "").trim();
  const cleanQty = String(quantity || "").trim();

  if (!cleanService || !cleanLink || !cleanQty) {
    throw new Error("Missing parameters for SMM order");
  }

  const data = await callSmmgen({
    action: "add",
    service: cleanService,
    link: cleanLink,
    quantity: cleanQty,
  });

  console.log("SMMGEN add response:", data);

  if (data && data.error) {
    throw new Error(data.error);
  }

  const orderId = Number(data.order || data.order_id);
  if (!orderId) {
    throw new Error("No order id returned from SMMGEN: " + JSON.stringify(data));
  }

  return orderId;
}

// -----------------------------
module.exports = {
  getSmmServices,
  createSmmOrder,
  getSmmOrderStatus,
};
