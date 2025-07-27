const sqlite3 = require('sqlite3').verbose();

// أدخل هنا الإيميل الخاص بالحساب الذي تريد جعله Admin
const adminEmail = 'alikneio71@gmail.com'; 

// --- لا تعدل أي شيء تحت هذا السطر ---

const db = new sqlite3.Database('./akcell.db', (err) => {
    if (err) {
        return console.error('Error connecting to database:', err.message);
    }
    console.log('Connected to the SQLite database.');
});

const sql = `UPDATE users SET role = 'admin' WHERE email = ?`;

db.run(sql, [adminEmail], function(err) {
    if (err) {
        return console.error('Error updating user:', err.message);
    }
    if (this.changes > 0) {
        console.log(`Success! User with email "${adminEmail}" is now an admin.`);
    } else {
        console.log(`Error: Could not find a user with the email "${adminEmail}". Please check the email and try again.`);
    }
});

db.close((err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Closed the database connection.');
});