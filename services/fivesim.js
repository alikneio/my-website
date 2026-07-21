const axios = require('axios');

const API_URL =
  process.env.FIVESIM_API_URL || 'https://5sim.net/v1';

const API_KEY = process.env.FIVESIM_API_KEY;

if (!API_KEY) {
  console.warn('⚠️ FIVESIM_API_KEY is not set in environment variables');
}

const fiveSimClient = axios.create({
  baseURL: API_URL,
  timeout: 20_000,
  headers: {
    Accept: 'application/json',
  },
});

function getAuthHeaders() {
  if (!API_KEY) {
    throw new Error('FIVESIM_API_KEY is missing');
  }

  return {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
  };
}

function getProviderErrorMessage(data) {
  if (data === undefined || data === null || data === '') {
    return 'Empty response from 5SIM';
  }

  if (typeof data === 'string') {
    return data;
  }

  if (typeof data.message === 'string') {
    return data.message;
  }

  if (typeof data.error === 'string') {
    return data.error;
  }

  if (data.error?.message) {
    return String(data.error.message);
  }

  try {
    return JSON.stringify(data);
  } catch (_) {
    return 'Unknown 5SIM error';
  }
}

async function callFiveSim({
  method = 'GET',
  url,
  params,
  auth = true,
}) {
  if (!url) {
    throw new Error('5SIM request URL is required');
  }

  try {
    const response = await fiveSimClient.request({
      method,
      url,
      params,
      headers: auth
        ? getAuthHeaders()
        : { Accept: 'application/json' },
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status < 200 || status >= 300) {
      const error = new Error(
        `5SIM HTTP ${status}: ${getProviderErrorMessage(data)}`
      );

      error.httpStatus = status;
      error.providerPayload = data;

      throw error;
    }

    if (data === undefined || data === null) {
      throw new Error('5SIM returned an empty response');
    }

    return data;
  } catch (error) {
    // الخطأ تم تجهيزه مسبقًا داخل الدالة
    if (error.providerPayload !== undefined) {
      throw error;
    }

    const responseData = error.response?.data;

    const message =
      responseData !== undefined
        ? getProviderErrorMessage(responseData)
        : error.message || 'Unknown request error';

    const wrappedError = new Error(
      `5SIM request failed: ${message}`
    );

    wrappedError.code = error.code;
    wrappedError.httpStatus = error.response?.status;
    wrappedError.providerPayload = responseData;

    throw wrappedError;
  }
}

// =====================================
// User
// =====================================

async function getFiveSimProfile() {
  const data = await callFiveSim({
    url: '/user/profile',
    auth: true,
  });

  if (
    typeof data !== 'object' ||
    data === null ||
    !Object.prototype.hasOwnProperty.call(data, 'balance')
  ) {
    throw new Error(
      `Invalid 5SIM profile response: ${JSON.stringify(data)}`
    );
  }

  return {
    id: data.id ?? null,
    email: data.email ?? null,
    vendor: data.vendor ?? null,
    balance: Number(data.balance || 0),
    frozenBalance: Number(data.frozen_balance || 0),
    rating: Number(data.rating || 0),
    defaultCountry: data.default_country || null,
    defaultOperator: data.default_operator || null,
    raw: data,
  };
}

// =====================================
// Countries
// =====================================

async function getCountries() {
  return callFiveSim({
    url: '/guest/countries',
    auth: false,
  });
}

// =====================================
// Products
// Endpoint:
// /guest/products/{country}/{operator}
// =====================================

async function getProducts({
  country = 'any',
  operator = 'any',
} = {}) {
  const cleanCountry =
    String(country || 'any')
      .trim()
      .toLowerCase();

  const cleanOperator =
    String(operator || 'any')
      .trim()
      .toLowerCase();

  if (!cleanCountry) {
    throw new Error('5SIM country is required');
  }

  if (!cleanOperator) {
    throw new Error('5SIM operator is required');
  }

  return callFiveSim({
    url:
      `/guest/products/${encodeURIComponent(cleanCountry)}` +
      `/${encodeURIComponent(cleanOperator)}`,
    auth: false,
  });
}

// =====================================
// Prices
// Endpoint:
// /guest/prices
// Optional query: country, product
// =====================================

async function getPrices({
  country,
  product,
} = {}) {
  const params = {};

  if (country) {
    params.country = String(country)
      .trim()
      .toLowerCase();
  }

  if (product) {
    params.product = String(product)
      .trim()
      .toLowerCase();
  }

  return callFiveSim({
    url: '/guest/prices',
    params,
    auth: false,
  });
}

function cleanPathValue(value, fieldName) {
  const clean = String(value || '')
    .trim()
    .toLowerCase();

  if (!clean) {
    throw new Error(`${fieldName} is required`);
  }

  return encodeURIComponent(clean);
}

async function buyFiveSimActivation({
  country,
  operator,
  product
}) {
  const cleanCountry = cleanPathValue(
    country,
    'country'
  );

  const cleanOperator = cleanPathValue(
    operator,
    'operator'
  );

  const cleanProduct = cleanPathValue(
    product,
    'product'
  );

  const data = await callFiveSim({
    url:
      `/user/buy/activation/${cleanCountry}` +
      `/${cleanOperator}/${cleanProduct}`,
    auth: true,
  });

  if (
    !data ||
    typeof data !== 'object' ||
    !data.id ||
    !data.phone
  ) {
    throw new Error(
      `Invalid 5SIM purchase response: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function getFiveSimOrder(orderId) {
  const id = Number(orderId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Valid 5SIM order ID is required');
  }

  return callFiveSim({
    url: `/user/check/${id}`,
    auth: true,
  });
}

async function finishFiveSimOrder(orderId) {
  const id = Number(orderId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Valid 5SIM order ID is required');
  }

  return callFiveSim({
    url: `/user/finish/${id}`,
    auth: true,
  });
}

async function cancelFiveSimOrder(orderId) {
  const id = Number(orderId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Valid 5SIM order ID is required');
  }

  return callFiveSim({
    url: `/user/cancel/${id}`,
    auth: true,
  });
}

async function banFiveSimOrder(orderId) {
  const id = Number(orderId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Valid 5SIM order ID is required');
  }

  return callFiveSim({
    url: `/user/ban/${id}`,
    auth: true,
  });
}

module.exports = {
  getFiveSimProfile,
  getCountries,
  getProducts,
  getPrices,

  buyFiveSimActivation,
  getFiveSimOrder,
  finishFiveSimOrder,
  cancelFiveSimOrder,
  banFiveSimOrder,
};