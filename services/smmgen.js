const axios = require("axios");

const API_URL = process.env.SMM_API_URL;
const API_KEY = process.env.SMM_API_KEY;

const smmAPI = axios.create({
  baseURL: 'https://smmgen.com/api/v2',
  timeout: 15000
});

// طلب موحد
async function smmRequest(params) {
  const body = new URLSearchParams({
    key: API_KEY,
    ...params,
  });

  const { data } = await axios.post(API_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  return data;
}

// جلب الخدمات
async function getSmmServices() {
  return smmRequest({ action: "services" });
}

// إنشاء طلب
async function createSmmOrder(service, link, quantity) {
  return smmRequest({
    action: "add",
    service,
    link,
    quantity,
  });
}

// حالة الطلب
async function getSmmOrderStatus(orderId) {
  return smmRequest({
    action: "status",
    order: orderId,
  });
}

// رصيد المزود
async function getSmmBalance() {
  return smmRequest({
    action: "balance",
  });
}

async function smmAddOrder({ service, link, quantity }) {
  const params = new URLSearchParams({
    key: process.env.SMMGEN_API_KEY,
    action: 'add',
    service: String(service),
    link,
    quantity: String(quantity)
  });

  const { data } = await smmAPI.post('', params);

  if (data.error) {
    throw new Error(data.error);
  }
  if (!data.order) {
    throw new Error('No order id returned from SMMGEN');
  }
  return data.order; // provider order id
}

module.exports = {
  getSmmServices,
  createSmmOrder,
  getSmmOrderStatus,
  getSmmBalance
};
