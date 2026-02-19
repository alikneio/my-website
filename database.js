// database.js
// NOTE: إذا عم تحمّل dotenv بــ server.js، ما يلزم تحمّله هون.
// require('dotenv').config();

const mysql = require('mysql2');
const isProduction = process.env.NODE_ENV === 'production';

// يدعم متغيّرات Railway أو .env
const host     = process.env.MYSQLHOST     || process.env.DB_HOST;
const user     = process.env.MYSQLUSER     || process.env.DB_USER;
const password = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD;
const database = process.env.MYSQLDATABASE || process.env.DB_NAME;
const port     = Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306);

// لوج آمن (ما نطبع قيم حساسة كاملة)
console.log('🔍 DB CONFIG:', {
  database,
  port,
  NODE_ENV: process.env.NODE_ENV,
  host: host ? '[set]' : '[missing]',
  user: user ? '[set]' : '[missing]',
});

const pool = mysql.createPool({
  host,
  user,
  password,
  database,
  port,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  // keep-alive
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,

  // وقت أطول للاتصال (يفيد مع blips)
  connectTimeout: 20_000,

  // بعض المزودين يتطلب SSL بالـ production
  ...(isProduction && {
    ssl: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
  }),

  timezone: 'Z',
  dateStrings: true,
});

// إعدادات لكل connection جديدة + لوج للأخطاء
pool.on('connection', (conn) => {
  // مدّد مهلة الخمول (يساعد أحيانًا مع MySQL نفسه)
  conn.query('SET SESSION wait_timeout = 3600;', () => {});
  conn.query('SET SESSION interactive_timeout = 3600;', () => {});
  conn.query("SET time_zone = '+00:00';", () => {});

  conn.on('error', (err) => {
    console.error('MySQL connection error:', err.code, err.message);
  });
});

const promisePool = pool.promise();

// Ping دوري حتى ما ينام الاتصال
// نحميه من التكرار لو صار reload بالعملية
const PING_MS = 60_000;

if (!global.__DB_PING_INTERVAL__) {
  global.__DB_PING_INTERVAL__ = setInterval(async () => {
    try {
      await promisePool.query('SELECT 1');
    } catch (e) {
      console.warn('DB ping failed:', e.code || e.message);
    }
  }, PING_MS);

  // حتى ما يمنع الخروج بتجارب/اختبارات
  if (typeof global.__DB_PING_INTERVAL__.unref === 'function') {
    global.__DB_PING_INTERVAL__.unref();
  }
}

// helper مع إعادة محاولة مرّة واحدة عند أخطاء الاتصال المؤقتة
async function query(sql, params = []) {
  try {
    const [rows] = await promisePool.query(sql, params);
    return rows;
  } catch (e) {
    const code = String(e.code || e.message || '').toUpperCase();

    const retriable =
      code.includes('PROTOCOL_CONNECTION_LOST') ||
      code.includes('ECONNRESET') ||
      code.includes('ETIMEDOUT') ||
      code.includes('ER_SERVER_SHUTDOWN');

    if (retriable) {
      // محاولة ثانية واحدة مع انتظار بسيط
      await new Promise((r) => setTimeout(r, 300));
      const [rows] = await promisePool.query(sql, params);
      return rows;
    }

    throw e;
  }
}

module.exports = { pool, promisePool, query };
