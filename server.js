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
app.use(express.json()); // Important for API routes
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
//                  PAGE ROUTES
// =============================================

// --- الصفحة الرئيسية ---
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

// --- صفحات الفئات الرئيسية (ثابتة) ---

app.get('/accounts', (req, res) => {
    res.render('accounts', { user: req.session.user || null });
});
app.get('/games', (req, res) => {
    res.render('games', { user: req.session.user || null });
});

// --- صفحات المنتجات (ديناميكية) ---
app.get('/netflix-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Netflix'";
    db.all(sql, [], (err, products) => {
        if (err) throw err;
        res.render('netflix-section', {
            user: req.session.user || null,
            products: products
        });
    });
});

app.get('/free-fire-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Free Fire'";
    db.all(sql, [], (err, products) => {
        if (err) throw err;
        res.render('free-fire-section', {
            user: req.session.user || null,
            products: products
        });
    });
});
// ... (أضف المزيد من صفحات المنتجات هنا بنفس الطريقة)


// --- صفحات أخرى ---
app.get('/my-orders', checkAuth, (req, res) => {
    const userId = req.session.user.id;
    const sql = `SELECT * FROM orders WHERE userId = ? ORDER BY purchaseDate DESC`;
    db.all(sql, [userId], (err, orders) => {
        if (err) return console.error(err.message);
        res.render('my-orders', { user: req.session.user, orders: orders });
    });
});

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


// =============================================
//                  ACTION ROUTES
// =============================================

const bcrypt = require('bcrypt'); // <-- أضف هذا السطر في أعلى ملف server.js
const saltRounds = 10; // درجة تعقيد التشفير

// ... (باقي الكود)

app.post('/register', (req, res) => {
    const { username, email, password } = req.body;

    // تشفير كلمة المرور
    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            return res.status(500).send("Error hashing password.");
        }

        // حفظ كلمة المرور المشفرة (hash) في قاعدة البيانات
        const sql = `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`;
        db.run(sql, [username, email, hash], function(err) {
            if (err) {
                return res.status(400).send("Error registering user.");
            }
            res.redirect('/login.html');
        });
    });
});


app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const sql = `SELECT * FROM users WHERE email = ?`;
    
    db.get(sql, [email], (err, user) => {
        if (err || !user) {
            return res.send('Incorrect email or password.');
        }

        // مقارنة كلمة المرور المدخلة مع المشفرة
        bcrypt.compare(password, user.password, (err, result) => {
            if (result) {
                // كلمة المرور صحيحة
                req.session.user = user;
                res.redirect('/');
            } else {
                // كلمة المرور خاطئة
                res.send('Incorrect email or password.');
            }
        });
    });
});




app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

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
            db.run(insertOrderSql, [user.id, productName, purchasePrice, purchaseDate, `Player ID: ${player_id || ''}`]);
        });

        req.session.user.balance = newBalance;
        res.json({ success: true, message: 'Purchase successful! Redirecting...' });
    } else {
        res.status(400).json({ success: false, message: 'Insufficient balance!' });
    }
});


// =============================================
//                  ADMIN ROUTES
// =============================================


app.get('/admin', checkAdmin, (req, res) => {
    const usersSql = `SELECT * FROM users`;
    const statsSql = `SELECT 
                        (SELECT COUNT(*) FROM users) as userCount, 
                        (SELECT COUNT(*) FROM orders) as orderCount,
                        (SELECT SUM(price) FROM orders WHERE status = 'Accepted') as totalRevenue
                      `;

    db.all(usersSql, [], (err, users) => {
        if (err) throw err;

        db.get(statsSql, [], (err, stats) => {
            if (err) throw err;
            
            res.render('admin', { 
                user: req.session.user,
                users: users,
                stats: stats 
            });
        });
    });
});
app.get('/admin/products', checkAdmin, (req, res) => {
    const sql = `SELECT * FROM products ORDER BY main_category, sub_category`;
    db.all(sql, [], (err, products) => {
        if (err) throw err;
        res.render('admin-products', { user: req.session.user, products: products });
    });
});

app.get('/admin/products/new', checkAdmin, (req, res) => {
    res.render('admin-add-product', { user: req.session.user });
});

app.post('/admin/products', checkAdmin, (req, res) => {
    const { name, price, image, main_category, sub_category } = req.body;
    const requires_player_id = req.body.requires_player_id ? 1 : 0;
    const sql = `INSERT INTO products (name, price, image, main_category, sub_category, requires_player_id) VALUES (?, ?, ?, ?, ?, ?)`;
    const params = [name, price, image, main_category, sub_category, requires_player_id];
    db.run(sql, params, function(err) {
        if (err) {
            console.error("DATABASE INSERT ERROR:", err.message);
            return res.send("An error occurred while adding the product.");
        }
        res.redirect('/admin/products');
    });
});

app.post('/admin/add-credit', checkAdmin, (req, res) => {
    const { userId, amount } = req.body;
    const amountToAdd = parseFloat(amount);
    const sql = `UPDATE users SET balance = balance + ? WHERE id = ?`;
    db.run(sql, [amountToAdd, userId], function(err) {
        if (err) { return console.error(err.message); }
        res.redirect('/admin');
    });
});

app.get('/admin/products/edit/:id', checkAdmin, (req, res) => {
    const productId = req.params.id;
    const sql = "SELECT * FROM products WHERE id = ?";
    
    db.get(sql, [productId], (err, product) => {
        if (err || !product) {
            return res.status(404).send('Product not found.');
        }
        res.render('admin-edit-product', { 
            user: req.session.user,
            product: product 
        });
    });
});

// مسار لعرض كل الطلبات في لوحة تحكم الأدمن
app.get('/admin/orders', checkAdmin, (req, res) => {
    const sql = `SELECT orders.*, users.username FROM orders JOIN users ON users.id = orders.userId ORDER BY purchaseDate DESC`;
    db.all(sql, [], (err, orders) => {
        if (err) throw err;
        res.render('admin-orders', { 
            user: req.session.user,
            orders: orders 
        });
    });
});

// مسار لتحديث حالة الطلب والرد
app.post('/admin/order/update/:id', checkAdmin, (req, res) => {
    const orderId = req.params.id;
    const { status, admin_reply } = req.body;

    // الخطوة 1: جلب الطلب الحالي من قاعدة البيانات لمعرفة حالته وسعره
    const findOrderSql = `SELECT * FROM orders WHERE id = ?`;
    db.get(findOrderSql, [orderId], (err, order) => {
        if (err || !order) {
            return res.send('Order not found.');
        }

        const oldStatus = order.status;
        const orderPrice = order.price;
        const userId = order.userId;

        // الخطوة 2: التحقق إذا كان الطلب يتم رفضه الآن
        if (status === 'Rejected' && oldStatus !== 'Rejected') {
            // إذا تم تغيير الحالة إلى "مرفوض" (ولم يكن مرفوضًا من قبل)
            
            db.serialize(() => {
                // أ. إعادة المبلغ إلى رصيد المستخدم
                const refundSql = `UPDATE users SET balance = balance + ? WHERE id = ?`;
                db.run(refundSql, [orderPrice, userId]);

                // ب. تحديث حالة الطلب والرد
                const updateOrderSql = `UPDATE orders SET status = ?, admin_reply = ? WHERE id = ?`;
                db.run(updateOrderSql, [status, admin_reply, orderId]);
            });
            
            console.log(`Order #${orderId} rejected. Refunded $${orderPrice} to user #${userId}.`);
            res.redirect('/admin/orders');

        } else {
            // إذا كانت الحالة أي شيء آخر، فقط قم بتحديث الطلب
            const updateOrderSql = `UPDATE orders SET status = ?, admin_reply = ? WHERE id = ?`;
            db.run(updateOrderSql, [status, admin_reply, orderId], function(err) {
                if (err) {
                    return console.error(err.message);
                }
                res.redirect('/admin/orders');
            });
        }
    });
});

app.post('/admin/products/update/:id', checkAdmin, (req, res) => {
    const productId = req.params.id;
    const { name, price, image, main_category, sub_category, sub_category_image } = req.body;
    const requires_player_id = req.body.requires_player_id ? 1 : 0;

    const sql = `UPDATE products SET 
                    name = ?, price = ?, image = ?, 
                    main_category = ?, sub_category = ?, sub_category_image = ?, 
                    requires_player_id = ? 
                 WHERE id = ?`;
    
    const params = [name, price, image, main_category, sub_category, sub_category_image, requires_player_id, productId];

    db.run(sql, params, function(err) {
        if (err) {
            return console.error(err.message);
        }
        res.redirect('/admin/products');
    });
});

app.post('/admin/products/delete/:id', checkAdmin, (req, res) => {
    const productId = req.params.id;
    const sql = "DELETE FROM products WHERE id = ?";
    
    db.run(sql, [productId], function(err) {
        if (err) {
            console.error("Delete error:", err.message);
            // في حال حدوث خطأ، أرسل رد خطأ
            return res.status(500).json({ success: false, message: 'Failed to delete product.' });
        }
        
        if (this.changes === 0) {
            // إذا لم يتم العثور على المنتج
            return res.status(404).json({ success: false, message: 'Product not found.' });
        }
        
        // في حال النجاح، أرسل رد نجاح
        res.json({ success: true, message: 'Product deleted successfully.' });
    });
});

// =============================================
//                  apps route
// =============================================




app.get('/netflix-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Netflix'";
    db.all(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('netflix-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/shahid-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Shahid'";
    db.all(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('shahid-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});
app.get('/osn-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'osn'";
    db.all(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('osn-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});
app.get('/primevideo', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'prime video'";
    db.all(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('primevideo', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});
app.get('/disney-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Disney'";
    db.all(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('disney-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});
app.get('/free-fire-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Games' AND sub_category = 'Free Fire'";
    db.all(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('free-fire-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});


app.get('/jawaker-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Games' AND sub_category = 'jawaker'";
    db.all(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('jawaker-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});


app.get('/order-details/:id', checkAuth, (req, res) => {
    const orderId = req.params.id;
    const userId = req.session.user.id; // للتأكد من أن المستخدم يرى طلباته فقط

    const sql = `SELECT * FROM orders WHERE id = ? AND userId = ?`;

    db.get(sql, [orderId, userId], (err, order) => {
        if (err) {
            return console.error(err.message);
        }
        if (!order) {
            // إذا لم يتم العثور على الطلب أو أنه لا يخص المستخدم الحالي
            return res.status(404).send('Order not found or you do not have permission to view it.');
        }
        res.render('order-details', { 
            user: req.session.user, 
            order: order 
        });
    });
});



// =============================================
//                  START SERVER
// =============================================
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});