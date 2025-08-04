// database.js
const mysql = require('mysql2');

const connection = mysql.createConnection({
  host: 'mysql.railway.internal',
  user: 'root',
  password: 'fdePcPFIvkhaDDuIpuGyelSTNucMVQMn',
  database: 'railway',
  port: 3306
});

connection.connect(err => {
  if (err) {
    console.error('❌ Error connecting to MySQL:', err.stack);
  } else {
    console.log('✅ Connected to MySQL successfully.');
  }
});

module.exports = connection;
