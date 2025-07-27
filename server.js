const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const cookieParser = require('cookie-parser');

const app = express();
const port = 3000;

app.set('view engine', 'ejs');

const db = new sqlite3.Database('./akcell.db');

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(session({
    secret: 'a_very_secret_key_that_you_should_change',
    resave: false,
    saveUninitialized: true,
}));

// Middlewares
const checkAuth = (req, res, next) => {
    if (req.session.user) next();
    else res.redirect('/login.html');
};

const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') next();
    else res.status(403).send('Access Denied');
};

// =============================================
//                  ROUTES
// =============================================

// --- الصفحة الرئيسية ---
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

// --- صفحة الحسابات (تعرض المنتجات مباشرة) ---
app.get('/accounts', (req, res) => {
    res.render('accounts', { user: req.session.user || null });
});

// --- صفحة الألعاب (تعرض المنتجات مباشرة) ---
app.get('/games', (req, res) => {
    res.render('games', { user: req.session.user || null });
});

// --- صفحة الدفع الخاصة بمنتج معين ---
app.get('/checkout/:id', checkAuth, (req, res) => {
    const productId = req.params.id;
    const sql = "SELECT * FROM products WHERE id = ?";
    db.get(sql, [productId], (err, product) => {
        if (err || !product) {
            return res.status(404).send('Product not found.');
        }
        res.render('checkout', { user: req.session.user, product: product });
    });
});

// --- صفحة طلباتي ---
app.get('/my-orders', checkAuth, (req, res) => {
    const userId = req.session.user.id;
    const sql = `SELECT * FROM orders WHERE userId = ? ORDER BY purchaseDate DESC`;
    db.all(sql, [userId], (err, orders) => {
        if (err) return console.error(err.message);
        res.render('my-orders', { user: req.session.user, orders: orders });
    });
});

// --- مسارات التسجيل والدخول والخروج ---
app.post('/register', (req, res) => {
    const { username, email, password } = req.body;
    const sql = `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`;
    db.run(sql, [username, email, password], function(err) {
        if (err) { return res.status(400).send("Error registering user."); }
        res.redirect('/login.html');
    });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const sql = `SELECT * FROM users WHERE email = ?`;
    db.get(sql, [email], (err, user) => {
        if (user && user.password === password) {
            req.session.user = user;
            res.redirect('/');
        } else {
            res.send('Incorrect credentials. <a href="/login.html">Try again</a>.');
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// --- مسارات الشراء ---
app.post('/buy', checkAuth, (req, res) => {
    const { productName, price } = req.body;
    const user = req.session.user;
    const purchasePrice = parseFloat(price);

    if (user.balance >= purchasePrice) {
        const newBalance = user.balance - purchasePrice;
        const updateSql = `UPDATE users SET balance = ? WHERE id = ?`;
        const insertOrderSql = `INSERT INTO orders (userId, productName, price, purchaseDate) VALUES (?, ?, ?, ?)`;
        const purchaseDate = new Date().toISOString();

        db.serialize(() => {
            db.run(updateSql, [newBalance, user.id]);
            db.run(insertOrderSql, [user.id, productName, purchasePrice, purchaseDate]);
        });

        req.session.user.balance = newBalance;
        res.json({ success: true, message: 'Purchase successful!' });
    } else {
        res.status(400).json({ success: false, message: 'Insufficient balance!' });
    }
});

app.post('/process-checkout', checkAuth, (req, res) => {
    const { productName, price, player_id } = req.body;
    const user = req.session.user;
    const purchasePrice = parseFloat(price);

    if (user.balance >= purchasePrice) {
        const newBalance = user.balance - purchasePrice;
        const updateSql = `UPDATE users SET balance = ? WHERE id = ?`;
        const insertOrderSql = `INSERT INTO orders (userId, productName, price, purchaseDate, order_details) VALUES (?, ?, ?, ?, ?)`;
        const purchaseDate = new Date().toISOString();

        db.serialize(() => {
            db.run(updateSql, [newBalance, user.id]);
            db.run(insertOrderSql, [user.id, productName, purchasePrice, purchaseDate, `Player ID: ${player_id}`]);
        });

        req.session.user.balance = newBalance;
        res.redirect('/my-orders');
    } else {
        res.send('Insufficient balance!');
    }
});

// --- مسارات الأدمن ---
app.get('/admin', checkAdmin, (req, res) => {
    const sql = `SELECT * FROM users`;
    db.all(sql, [], (err, users) => {
        if (err) throw err;
        res.render('admin', { users: users });
    });
});

// مسار لعرض صفحة "إضافة منتج جديد"
app.get('/admin/products/new', checkAdmin, (req, res) => {
    res.render('admin-add-product', { user: req.session.user });
});

// مسار لاستقبال بيانات المنتج الجديد وحفظها
app.post('/admin/products', checkAdmin, (req, res) => {
    const { name, price, image, main_category, sub_category, sub_category_image } = req.body;
    
    // معالجة الـ checkbox بشكل صحيح
    // إذا تم تحديد الـ checkbox، ستكون قيمته '1'. إذا لم يتم تحديده، سنجعل قيمته 0.
    const requires_player_id = req.body.requires_player_id ? 1 : 0;
    
    const sql = `INSERT INTO products (name, price, image, main_category, sub_category, sub_category_image, requires_player_id) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;
                 
    const params = [name, price, image, main_category, sub_category, sub_category_image, requires_player_id];

    db.run(sql, params, function(err) {
        if (err) {
            // في حال حدوث خطأ، اطبعه في الـ terminal وأرسل رسالة خطأ
            console.error("DATABASE INSERT ERROR:", err.message);
            return res.send("An error occurred while adding the product. Please check the terminal.");
        }
        console.log(`A new product has been added: ${name}`);
        // بعد النجاح، أعد التوجيه إلى صفحة المنتجات
        res.redirect('/admin/products');
    });
});

// مسار جديد لعرض صفحة إدارة المنتجات
app.get('/admin/products', checkAdmin, (req, res) => {
    const sql = `SELECT * FROM products ORDER BY main_category, sub_category`;
    db.all(sql, [], (err, products) => {
        if (err) throw err;
        res.render('admin-products', { 
            user: req.session.user,
            products: products 
        });
    });
});

app.post('/admin/add-credit', checkAdmin, (req, res) => {
    console.log("--- Admin: Add Credit attempt received ---");
    console.log("Data received from form:", req.body); // لنرى البيانات القادمة

    const { userId, amount } = req.body;
    const amountToAdd = parseFloat(amount);

    console.log(`Attempting to add ${amountToAdd} to user ID ${userId}`);

    if (isNaN(amountToAdd) || amountToAdd <= 0) {
        return res.send('Invalid amount.');
    }

    const sql = `UPDATE users SET balance = balance + ? WHERE id = ?`;
    
    db.run(sql, [amountToAdd, userId], function(err) {
        if (err) {
            console.error("DATABASE UPDATE ERROR:", err.message);
            return res.send("An error occurred. Check the server terminal.");
        }
        
        console.log(`Update command finished. Rows affected: ${this.changes}`);
        res.redirect('/admin');
    });
});

// في server.js

// مسار الصفحة الرئيسية
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

// مسار صفحة الحسابات
app.get('/Accounts', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts'";
    db.all(sql, [], (err, products) => {
        if (err) throw err;
        res.render('Accounts', {
            user: req.session.user || null,
            products: products
        });
    });
});

// مسار صفحة الألعاب
app.get('/Games', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Games'";
    db.all(sql, [], (err, products) => {
        if (err) throw err;
        res.render('Games', {
            user: req.session.user || null,
            products: products
        });
    });
});

app.get('/netflix-section', (req, res) => {
    res.render('netflix-section', { user: req.session.user || null });
});

app.get('/shahid-section', (req, res) => {
    res.render('shahid-section', { user: req.session.user || null });
});
app.get('/osn-section', (req, res) => {
    res.render('osn-section', { user: req.session.user || null });
});
app.get('/primevideo', (req, res) => {
    res.render('primevideo', { user: req.session.user || null });
});
app.get('/disney-section', (req, res) => {
    res.render('disney-section', { user: req.session.user || null });
});
app.get('/free-fire-section', (req, res) => {
    res.render('disney-section', { user: req.session.user || null });
});


// مسار لعرض صفحة الدفع الخاصة بمنتج معين
app.get('/checkout/:id', checkAuth, (req, res) => {
    const productId = req.params.id;
    const sql = "SELECT * FROM products WHERE id = ?";
    db.get(sql, [productId], (err, product) => {
        if (err || !product) {
            return res.status(404).send('Product not found.');
        }
        res.render('checkout', { user: req.session.user, product: product });
    });
});

// مسار لمعالجة عملية الشراء من صفحة الدفع
app.post('/process-checkout', checkAuth, (req, res) => {
    const { productName, price, player_id } = req.body;
    const user = req.session.user;
    const purchasePrice = parseFloat(price);

    if (user.balance >= purchasePrice) {
        const newBalance = user.balance - purchasePrice;
        const updateSql = `UPDATE users SET balance = ? WHERE id = ?`;
        const insertOrderSql = `INSERT INTO orders (userId, productName, price, purchaseDate, order_details) VALUES (?, ?, ?, ?, ?)`;
        const purchaseDate = new Date().toISOString();

        db.serialize(() => {
            db.run(updateSql, [newBalance, user.id]);
            db.run(insertOrderSql, [user.id, productName, purchasePrice, purchaseDate, `Player ID: ${player_id}`]);
        });

        req.session.user.balance = newBalance;
        res.redirect('/my-orders'); // توجيهه لصفحة الطلبات ليرى طلبه الجديد
    } else {
        res.send('Insufficient balance!');
    }
});

// --- تشغيل السيرفر ---
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});