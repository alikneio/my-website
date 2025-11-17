const axios = require('axios');

const API_URL = "https://smmgen.com/api/v2";
const API_KEY = process.env.SMMGEN_API_KEY;


if (!API_KEY) {
  console.error("❌ Missing SMMGEN_API_KEY in .env");
}

/**
 * جلب جميع الخدمات من SMMGEN
 */
async function getSmmServices() {
  try {
    const body = new URLSearchParams({
      key: API_KEY,       // الانتباه هون!!
      action: "services"
    });

    const { data } = await axios.post(API_URL, body);

    if (data.error) {
      console.error("❌ SMMGEN returned error:", data);
      throw new Error(data.error);
    }

    return data;
  } catch (err) {
    console.error("❌ getSmmServices() error:", err.message);
    throw err;
  }
}

/**
 * إنشاء طلب على SMMGEN
 */
async function smmAddOrder({ service, link, quantity }) {
  try {
    const body = new URLSearchParams({
      key: API_KEY,
      action: "add",
      service,
      link,
      quantity
    });

    const { data } = await axios.post(API_URL, body);

    if (data.error) {
      throw new Error(data.error);
    }

    return data.order; // حسب الدوكومنت
  } catch (err) {
    throw err;
  }
}

module.exports = {
  getSmmServices,
  smmAddOrder
};
