// database.js
const mysql = require('mysql2');

const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'ak_cell_db',
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
