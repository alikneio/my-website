const mysql = require('mysql2');

// ↓↓↓ ضع هنا إيميل الحساب الذي تريد ترقيته ↓↓↓
const adminEmail = 'alikneio71@gmail.com';

// --- بيانات الاتصال ---
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'ak_cell_db',
    port: 3306 // تأكد من أنه نفس البورت
};

const connection = mysql.createConnection(dbConfig);

connection.connect(err => {
    if (err) return console.error('Error connecting:', err.stack);

    const sql = `UPDATE users SET role = 'admin' WHERE email = ?`;

    connection.query(sql, [adminEmail], (err, result) => {
        if (err) throw err;

        if (result.affectedRows > 0) {
            console.log(`Success! User with email "${adminEmail}" is now an admin.`);
        } else {
            console.log(`Error: Could not find a user with the email "${adminEmail}".`);
        }
        
        connection.end();
    });
});