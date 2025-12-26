const axios = require('axios');
const fs = require('fs');
const path = require('path');
fig();
const { dailycardAPI } = require('../services/dailycard');

const CACHE_DIR = path.join(__dirname, '../cache');
const CACHE_FILE = path.join(CACHE_DIR, 'products.json');
const CACHE_INTERVAL_MS = 10 * 60 * 1000; // 10 دقائق


let productCache = {
  products: null,
  lastUpdated: 0,
  isInitialized: false,
  isFetching: false
};

function ensureCacheDirectoryExists() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      console.log(`✅ Cache directory created at: ${CACHE_DIR}`);
    }
    return true;
  } catch (err) {
    console.error(`❌ Failed to create cache directory: ${err.message}`);
    return false;
  }
}

function saveCacheToFile() {
  if (!ensureCacheDirectoryExists() || !productCache.products) {
    console.error("❌ Aborting cache save: No products or directory missing.");
    return;
  }
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      products: productCache.products,
      lastUpdated: productCache.lastUpdated
    }, null, 2));
    console.log("💾 Product cache saved to file.");
  } catch (err) {
    console.error("❌ Failed to write cache file:", err.message);
  }
}

function loadCacheFromFile() {
  if (!fs.existsSync(CACHE_FILE)) {
    console.warn("⚠️ No cache file found.");
    return;
  }
  try {
    const raw = fs.readFileSync(CACHE_FILE);
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.products) && (Date.now() - data.lastUpdated < CACHE_INTERVAL_MS)) {
      productCache.products = data.products;
      productCache.lastUpdated = data.lastUpdated;
      console.log("📁 Loaded product cache from file.");
    } else {
      console.warn("⚠️ Cache file is old or invalid.");
    }
  } catch (err) {
    console.warn("⚠️ Failed to load cache file:", err.message);
  }
}

async function refreshCache() {
  if (productCache.isFetching) {
    console.log("🟡 Already fetching.");
    return;
  }

  productCache.isFetching = true;

  try {
    let allProducts = [];
    const pageSize = 100;

    console.log("📥 Fetching products from page 1 to 5000...");

    for (let page = 1; page <= 5000; page++) {
      console.log(`🔄 Fetching page ${page}`);
      const res = await dailycardAPI.get(`/api-keys/products?page=${page}&page_size=${pageSize}`, {
        timeout: 20000,
      });

      const results = res.data?.results;

      if (!results || !Array.isArray(results)) {
        console.error("❌ Unexpected response format:", res.data);
        break;
      }

      allProducts.push(...results);

      if (results.length < pageSize) {
        console.log(`✅ Last page reached at page ${page}.`);
        break;
      }
    }

    productCache.products = allProducts;
    productCache.lastUpdated = Date.now();
    saveCacheToFile();
    console.log(`✅ Loaded ${allProducts.length} products from API.`);
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      console.error("⏱️ Request timed out.");
    } else if (err.response) {
      console.error("❌ API Error:", err.response.data);
    } else {
      console.error("⚠️ Network error:", err.message);
    }
  } finally {
    productCache.isFetching = false;
  }
}

async function getCachedAPIProducts() {
  if (!productCache.isInitialized) {
    loadCacheFromFile();
    productCache.isInitialized = true;
  }

  const now = Date.now();
  const isExpired = now - productCache.lastUpdated > CACHE_INTERVAL_MS;

  if (!productCache.products || isExpired) {
    console.log("🔄 Cache is expired or missing. Refreshing...");
    await refreshCache();
  } else {
    console.log("✅ Using valid product cache.");
  }

  return productCache.products || [];
}

ensureCacheDirectoryExists();
loadCacheFromFile();

module.exports = {
  getCachedAPIProducts
};
