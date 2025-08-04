// database.js
const mysql = require('mysql2');
require('dotenv').config();

const connection = mysql.createConnection(process.env.DATABASE_URL);

connection.connect(err => {
  if (err) {
    console.error('❌ Error connecting to MySQL:', err.stack);
  } else {
    console.log('✅ Connected to MySQL successfully.');
  }
});

module.exports = connection;
