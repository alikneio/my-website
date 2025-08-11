// database.js
const mysql = require('mysql2');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

// خُد من Railway إذا موجود، وإلا من .env تبعك
const host = process.env.MYSQLHOST || process.env.DB_HOST;
const user = process.env.MYSQLUSER || process.env.DB_USER;
const password = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD;
const database = process.env.MYSQLDATABASE || process.env.DB_NAME;
const port = Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306);

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
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  ...(isProduction && {
    ssl: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
  }),
  timezone: 'Z',
  dateStrings: true,
});

// event logging (اختياري)
pool.on('connection', (conn) => {
  conn.on('error', (err) => {
    console.error('MySQL connection error:', err.code, err.message);
  });
});

const promisePool = pool.promise();

// helper: await query(sql, params) -> rows
async function query(sql, params) {
  const [rows] = await promisePool.query(sql, params);
  return rows;
}

module.exports = { pool, promisePool, query };
