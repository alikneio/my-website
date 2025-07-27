const sqlite3 = require('sqlite3').verbose();

// إنشاء أو فتح ملف قاعدة البيانات
const db = new sqlite3.Database('./akcell.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
});

// db.serialize يضمن أن الأوامر ستنفذ بالترتيب
db.serialize(() => {
    // 1. إنشاء جدول المستخدمين (users table)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        balance REAL DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'user'
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Users table created or already exists.');
    });

    // 2. إنشاء جدول الطلبات (orders table)
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        productName TEXT,
        price REAL,
        purchaseDate TEXT,
        order_details TEXT,
        FOREIGN KEY (userId) REFERENCES users (id)
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Orders table created or already exists.');
    });

    // 3. إنشاء جدول المنتجات (products table) بالهيكل الجديد
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        image TEXT,
        main_category TEXT NOT NULL,
        sub_category TEXT NOT NULL,
        sub_category_image TEXT,
        requires_player_id INTEGER DEFAULT 0
    )`, (err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Products table created or already exists with new structure.');
    });
});

// إغلاق الاتصال بقاعدة البيانات
db.close((err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Closed the database connection.');
});