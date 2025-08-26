// database.js
// ملاحظة: إذا عم تحمّل dotenv بــ server.js، فيك تشيل هالسطر التالي.
// require('dotenv').config();

const mysql = require('mysql2');
const isProduction = process.env.NODE_ENV === 'production';

// يدعم متغيّرات Railway أو .env
const host     = process.env.MYSQLHOST     || process.env.DB_HOST;
const user     = process.env.MYSQLUSER     || process.env.DB_USER;
const password = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD;
const database = process.env.MYSQLDATABASE || process.env.DB_NAME;
const port     = Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306);

console.log('🔍 DB CONFIG:', { host, user, database, port, NODE_ENV: process.env.NODE_ENV });

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

  // Railway/مزودات كثير تطلب SSL بالـ production
  ...(isProduction && {
    ssl: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
  }),

  timezone: 'Z',
  dateStrings: true,
});

// إعدادات للجلسة + لوج للأخطاء
pool.on('connection', (conn) => {
  // مدّد مهلة الخمول لكل اتصال (1 ساعة مثالاً)
  conn.query('SET SESSION wait_timeout = 3600;').catch(() => {});
  conn.query('SET SESSION interactive_timeout = 3600;').catch(() => {});
  conn.query("SET time_zone = '+00:00';").catch(() => {});

  conn.on('error', (err) => {
    console.error('MySQL connection error:', err.code, err.message);
  });
});

const promisePool = pool.promise();

// Ping دوري حتى ما ينام الاتصال
const PING_MS = 60_000;
setInterval(async () => {
  try { await promisePool.query('SELECT 1'); }
  catch (e) { console.warn('DB ping failed:', e.code || e.message); }
}, PING_MS);

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
      code.includes('ER_SERVER_SHUTDOWN') ||
      code.includes('READ ECONNRESET');

    if (retriable) {
      // محاولة ثانية واحدة
      const [rows] = await promisePool.query(sql, params);
      return rows;
    }
    throw e;
  }
}

module.exports = { pool, promisePool, query };
