console.log("🟢 Server starting...");


require('dotenv').config({ path: './.env' });
 // دايمًا بالبداية
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const axios = require('axios');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');

// ثالثاً: تحديد PORT بعد تحميل dotenv
const PORT = process.env.PORT || 3000;


// بعدها استورد أي شيء بيحتاج PORT أو ENV
const { dailycardAPI, verifyPlayerId } = require('./services/dailycard');
const TelegramBot = require('node-telegram-bot-api');
const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
const sendOrderStatusTelegram = require('./utils/sendOrderStatusTelegram');
const sendTelegramMessage = require('./utils/sendTelegramNotification');
const uploadNone = multer();
require('./telegram/saveChatId');



console.log("🧾 ENV DUMP:", process.env);



const storage = multer.diskStorage({
  destination: './public/uploads/whish',
  filename: (req, file, cb) => {
    cb(null, `whish_${Date.now()}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });








 // تمت إضافته لأنه ضروري

// 1. تعريف التطبيق والبورت أولاً
const app = express();



// 2. إعداد محرك القوالب
app.set('view engine', 'ejs');

const db = require('./database');






// ... (باقي الكود مثل app.use و المسارات)

app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Important for API routes
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

// إعدادات MySQLStore
const sessionStore = new MySQLStore({
  host: 'nozomi.proxy.rlwy.net',
  port: 25474,
  user: 'root',
  password: 'GrYyLrtHsllLcgVUYAsDoZReIwJodGaQ',
  database: 'railway'
});

// تفعيل الجلسات باستخدام MySQLStore
app.use(session({
  key: 'akcell_sid',
  secret: 'AKCELL_SUPER_SECRET_2025', // غيرها لشي قوي خاص فيك!
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 // مدة الجلسة = يوم
  }
}));



const setTelegramChatId = require('./telegram/setTelegramChatId');
app.use('/', setTelegramChatId);



app.use((req, res, next) => {
  res.locals.user = req.session.user || null;

  // ✅ عداد الإشعارات
  if (req.session.user) {
    const userId = req.session.user.id;
    const sql = "SELECT COUNT(*) AS unreadCount FROM notifications WHERE user_id = ? AND is_read = FALSE";

    db.query(sql, [userId], (err, result) => {
      if (!err) {
        res.locals.unreadCount = result[0].unreadCount;
      } else {
        res.locals.unreadCount = 0;
      }
      next();
    });
  } else {
    res.locals.unreadCount = 0;
    next();
  }
});
function checkUser(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.redirect('/login'); // أو أي صفحة تسجيل الدخول عندك
  }
}




// Middlewares
const checkAuth = (req, res, next) => {
    if (req.session.user) next();
    else res.redirect('/login');
};

const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') next();
    else res.status(403).send('Access Denied');
};

// Middleware to refresh user data from DB on every request
app.use((req, res, next) => {
    // Check if a user is logged in
    if (req.session.user) {
        const sql = "SELECT * FROM users WHERE id = ?";
        db.query(sql, [req.session.user.id], (err, results) => {
            if (err) {
                console.error(err);
                return next(); // Continue even if there's an error
            }
            if (results.length > 0) {
                // Update the session with the latest data from the database
                req.session.user = results[0]; 
            }
            next(); // Continue to the requested route
        });
    } else {
        next(); // If no user is logged in, just continue
    }
});


// =============================================
//                  PAGE ROUTES
// =============================================

// --- الصفحة الرئيسية ---
app.get('/', (req, res) => {
  try {
    const user = req.session?.user || null;

    // التحقق من إذا تم تسجيل الدخول للتو
    const justLoggedIn = req.session?.justLoggedIn || false;
    if (req.session) req.session.justLoggedIn = false;

    // عرض التنبيه فقط إذا تم تسجيل الدخول حديثاً ولا يوجد telegram_chat_id
    const showTelegramToast = justLoggedIn && user && !user.telegram_chat_id;

    console.log("✅ Rendering home page...");
    res.render('index', { user, showTelegramToast });
  } catch (error) {
    console.error("🔥 Error rendering /:", error);
    res.status(500).send("Error rendering home page");
  }
});


app.get('/test', (req, res) => {
  res.send("Test is working ✅");
});


app.post('/add-balance/whish/usd', upload.single('proofImage'), (req, res) => {
  const { amount } = req.body;
  const userId = req.session.user.id;
  const currency = 'USD';
  const proofImage = req.file.filename;

  // إشعار داخلي في قاعدة البيانات
  const insertNotificationSql = `
    INSERT INTO notifications (user_id, message, type, created_at)
    VALUES (?, ?, 'balance_request', NOW())
  `;
  const notificationMsg = `طلب تعبئة رصيد جديد بقيمة ${amount} ${currency}`;

  db.query(insertNotificationSql, [userId, notificationMsg], (notifErr) => {
    if (notifErr) {
      console.error('Error saving notification:', notifErr);
      return res.status(500).send('Internal server error.');
    }

    // حفظ طلب التعبئة في قاعدة البيانات
    const insertBalanceSql = `
      INSERT INTO balance_requests (user_id, amount, currency, proof_image, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', NOW())
    `;

    db.query(insertBalanceSql, [userId, amount, currency, proofImage], (balanceErr) => {
      if (balanceErr) {
        console.error('Error saving USD balance request:', balanceErr);
        return res.status(500).send('Internal server error.');
      }

      // إرسال إشعار عبر تلغرام للأدمن
      const botToken = '8205085707:AAFCb4bsiwEIXDMe4pGYEruMBsK4aWSp40I';
      const adminChatId = '2096387191';
      const username = req.session.user.username;

      let msg = `📥 *New Balance Top-up Request*\n\n` +
                `👤 User: ${username}\n` +
                `💰 Amount: ${amount} ${currency}`;

      if (proofImage) {
        const imageUrl = `https://akcells.store/uploads/whish/${proofImage}`;
 
        msg += `\n🖼 [Proof Image](${imageUrl})`;
      }

      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: msg,
          parse_mode: "Markdown"
        })
      }).catch(err => {
        console.error('Error sending Telegram message:', err);
        // لا توقف العملية لو فشل التلغرام
      });

      // بعد كل شيء تمام، رجع المستخدم لصفحة الشكر
      res.redirect('/thank-you');
    });
  });
});

app.get('/thank-you', (req, res) => {
  res.render('thank-you'); // إذا اسم الملف thank-you.ejs
});


// ربط chatId بالمستخدم المسجل حالياً
app.get('/set-telegram/:chatId', (req, res) => {
  const userId = req.session.user?.id;
  const chatId = req.params.chatId;

  if (!userId) {
    return res.redirect('/login?error=not_logged_in');
  }

  db.query(
    'UPDATE users SET telegram_chat_id = ? WHERE id = ?',
    [chatId, userId],
    (err) => {
      if (err) {
        console.error("❌ Error saving chat ID:", err.message);
        return res.status(500).send('❌ حدث خطأ أثناء ربط الحساب، حاول لاحقاً.');
      }

      return res.send('✅ تم ربط حسابك بنجاح مع البوت! ستصلك الإشعارات الآن على تيليغرام.');
    }
  );
});




app.post('/add-balance/whish/lbp', upload.single('proofImage'), (req, res) => {
  const { amount } = req.body;
  const userId = req.session.user.id;
  const currency = 'LBP';
  const proofImage = req.file.filename;

  // إشعار داخلي
  const insertNotificationSql = `
    INSERT INTO notifications (user_id, message, type, created_at)
    VALUES (?, ?, 'balance_request', NOW())
  `;
  const notificationMsg = `طلب تعبئة رصيد جديد بقيمة ${amount} ${currency}`;

  db.query(insertNotificationSql, [userId, notificationMsg], (notifErr) => {
    if (notifErr) {
      console.error('Error saving notification:', notifErr);
      return res.status(500).send('Internal server error.');
    }

    // إدخال الطلب
    const insertBalanceSql = `
      INSERT INTO balance_requests (user_id, amount, currency, proof_image, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', NOW())
    `;

    db.query(insertBalanceSql, [userId, amount, currency, proofImage], (balanceErr) => {
      if (balanceErr) {
        console.error('Error saving LBP balance request:', balanceErr);
        return res.status(500).send('Internal server error.');
      }

      // إشعار تلغرام للأدمن
      const botToken = '8205085707:AAFCb4bsiwEIXDMe4pGYEruMBsK4aWSp40I';
      const adminChatId = '2096387191';
      const username = req.session.user.username;

      let msg = `📥 *New Balance Top-up Request*\n\n` +
                `👤 User: ${username}\n` +
                `💰 Amount: ${amount} ${currency}`;

      if (proofImage) {
       const imageUrl = `https://akcells.store/uploads/whish/${proofImage}`;

        msg += `\n🖼 [Proof Image](${imageUrl})`;
      }

      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: msg,
          parse_mode: "Markdown"
        })
      }).catch(err => {
        console.error('Error sending Telegram message:', err);
      });

      // تحويل المستخدم لصفحة الشكر
      res.redirect('/thank-you');
    });
  });
});


app.get('/add-balance/whish', (req, res) => {
  res.render('add-balance-menu'); // بتكون صفحة وسيطة فيها اختيار USD أو LBP
});

// صفحة تعبئة الدولار
app.get('/add-balance/whish/usd', (req, res) => {
  res.render('add-balance/whish-usd'); // لازم يكون في ملف add-balance-whish-usd.ejs
});

// صفحة تعبئة الليرة
app.get('/add-balance/whish/lbp', (req, res) => {
  res.render('add-balance/whish-lbp');
 // لازم يكون في ملف add-balance-whish-lbp.ejs
});







// --- صفحات الفئات الرئيسية (ثابتة) ---


app.get('/login', (req, res) => {
  res.render('login', { query: req.query });
});


app.get('/accounts', (req, res) => {
    res.render('accounts', { user: req.session.user || null });
});
app.get('/games', (req, res) => {
    res.render('games', { user: req.session.user || null });
});
app.get('/communication', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Communication'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('communication', { 
            user: req.session.user || null,
            products: products
        });
    });
});

app.get('/apps-section', (req, res) => {
    res.render('apps-section', { user: req.session.user || null });
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.status(500).send("Could not log out.");
    }
    res.redirect('/'); // أو أي صفحة تسجيل دخول عندك
  });
});

app.get('/processing', checkAuth, (req, res) => {
  res.render('order-processing'); // تأكد أن الملف اسمه order-processing.ejs وموجود بـ views/
});


// --- صفحات المنتجات (ديناميكية) ---
app.get('/netflixH-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Netflix High Quality'";
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('netflixH-section', {
            user: req.session.user || null,
            products: products
        });
    });
});

app.get('/spotifyN-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Spotify Normal Quality'";
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('spotifyN-section', {
            user: req.session.user || null,
            products: products
        });
    });
});

app.get('/spotifyH-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Spotify High Quality'";
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('spotifyH-section', {
            user: req.session.user || null,
            products: products
        });
    });
});



app.get('/netflixL-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Netflix Normal Quality'";
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('netflixH-section', {
            user: req.session.user || null,
            products: products
        });
    });
});




app.get('/touch-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Communication' AND sub_category = 'Touch'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('touch-section', { 
            user: req.session.user || null,
            products: products
        });
    });
});

app.get('/alfa-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Communication' AND sub_category = 'Alfa'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('alfa-section', { 
            user: req.session.user || null,
            products: products
        });
    });
});





// --- صفحات أخرى ---
app.get('/my-orders', checkAuth, (req, res) => {
    const userId = req.session.user.id;
    const sql = `SELECT * FROM orders WHERE userId = ? ORDER BY purchaseDate DESC`;
    db.query(sql, [userId], (err, orders) => {
        if (err) return console.error(err.message);
        res.render('my-orders', { user: req.session.user, orders: orders });
    });
});


app.get('/checkout/:id', checkAuth, (req, res) => {
  const productId = parseInt(req.params.id);
  const error = req.query.error || null;

  const sql = "SELECT * FROM products WHERE id = ?";
  db.query(sql, [productId], (err, results) => {
    if (err || results.length === 0) {
      return res.status(404).send('❌ Product not found.');
    }

    const product = results[0];
    product.source = 'sql';

    let errorMessage = '';
    if (error === 'balance') {
      errorMessage = 'Insufficient balance.';
    } else if (error === 'server') {
      errorMessage = 'Server error during purchase. Please try again.';
    }

    const notes = product.notes && product.notes.trim() !== '' ? product.notes.trim() : null;

    res.render('checkout', {
      user: req.session.user,
      product,
      error: errorMessage,
      notes
    });
  });
});





app.get('/api-checkout/:id', checkAuth, async (req, res) => {
  const productId = parseInt(req.params.id);

  const query = (sql, params) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });

  try {
    // 1. جلب المنتج من جدول selected_api_products
    const sql = "SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1";
    const results = await query(sql, [productId]);
    const error = req.query.error || null;


    if (results.length === 0) {
      return res.status(404).send("❌ Product not found or not activated.");
    }

    const product = results[0];

    // 2. تجهيز بيانات المنتج بناءً على نوعه
    const isQuantity = product.variable_quantity === 1;

    const productData = {
      id: product.product_id,
      name: product.custom_name || 'API Product',
      image: product.custom_image || '/images/default-product.png',
      price: isQuantity
        ? null // سيتم حساب السعر لاحقًا حسب الكمية
        : parseFloat(product.custom_price || product.unit_price || 0).toFixed(2),
      unit_price: isQuantity
        ? parseFloat(product.custom_price || product.unit_price || 0)
        : undefined,
      unit_quantity: isQuantity ? parseInt(product.unit_quantity || 1) : undefined,
      min_quantity: isQuantity ? parseInt(product.min_quantity || 1) : undefined,
      max_quantity: isQuantity ? parseInt(product.max_quantity || 999999) : undefined,
      requires_player_id: product.player_check === 1,
       requires_verification: product.requires_verification === 1,
      variable_quantity: isQuantity,
      unit_label: isQuantity ? product.unit_label || 'units' : undefined,
    };

    // 3. التوجيه حسب النوع
    if (isQuantity) {
      return res.render('api-checkout-quantity', {
  user: req.session.user || null,
  product: productData,
  error // ✅ تمرير الخطأ إلى EJS
});

    } else {
      return res.render('api-checkout-fixed', {
        user: req.session.user || null,
        product: productData
      });
    }

  } catch (error) {
    console.error("❌ Error in /api-checkout/:id:", error.stack || error.message);
    res.status(500).send("Internal Server Error");
  }
});



app.get('/category/:name', async (req, res) => {
  const categoryName = req.params.name.toLowerCase();

  const query = (sql, params) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });

  try {
    const products = await query(
      "SELECT * FROM selected_api_products WHERE category = ? AND active = 1",
      [categoryName]
    );

    res.render('category-products', {
      products
    });
  } catch (err) {
    console.error("❌ Error loading category:", err.message);
    res.status(500).send("Server Error");
  }
});





// =============================================
//                  ACTION ROUTES
// =============================================

const bcrypt = require('bcrypt'); // <-- أضف هذا السطر في أعلى ملف server.js
const saltRounds = 10; // درجة تعقيد التشفير



app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/register', (req, res) => {
  const error = req.session.error;
  delete req.session.error;
  res.render('register', { error });
});






app.post('/register', (req, res) => {
  const { username, email, password, phone } = req.body;

  // تحقق من كلمة المرور
  const isPasswordValid =
    password.length >= 8 && /[A-Z]/.test(password) && /\d/.test(password);

  if (!isPasswordValid) {
    req.session.error = "❌ كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير ورقم.";
    return res.redirect('/register');
  }

  // تحقق من التكرار
  const checkSql = `SELECT * FROM users WHERE username = ? OR email = ?`;
  db.query(checkSql, [username, email], (err, results) => {
    if (err) {
      console.error("🔴 DB Error:", err);
      req.session.error = "⚠️ حصل خطأ في الخادم.";
      return res.redirect('/register');
    }

    if (results.length > 0) {
      req.session.error = "⚠️ اسم المستخدم أو البريد الإلكتروني مستخدم مسبقاً.";
      return res.redirect('/register');
    }

    // تشفير وحفظ
    bcrypt.hash(password, saltRounds, (err, hash) => {
      if (err) {
        console.error("🔴 Hash Error:", err);
        req.session.error = "⚠️ خطأ في التشفير.";
        return res.redirect('/register');
      }

      const insertSql = `INSERT INTO users (username, email, password, phone) VALUES (?, ?, ?, ?)`;
      db.query(insertSql, [username, email, hash, phone], (err, result) => {
        if (err) {
          console.error("🔴 Insert Error:", err);
          req.session.error = "❌ لم يتم إنشاء الحساب. حاول لاحقاً.";
          return res.redirect('/register');
        }

        // نجاح
        req.session.success = "✅ تم إنشاء الحساب بنجاح! سجل دخولك الآن.";
        return res.redirect('/login');
      });
    });
  });
});


app.get('/notifications', checkUser, (req, res) => {
  const userId = req.session.user.id;

  const sql = "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC";
  db.query(sql, [userId], (err, notifications) => {
    if (err) return res.status(500).send("Error loading notifications.");

    // ✅ علّمهم كمقروءين
    const markRead = "UPDATE notifications SET is_read = TRUE WHERE user_id = ?";
    db.query(markRead, [userId], () => {});

    res.render('notifications', {
      notifications,
      unreadCount: 0 // نرسل صفر لأننا علمناهم كمقروءين
    });
  });
});

app.get('/notifications/count', (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.json({ count: 0 });

  const sql = "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = FALSE";
  db.query(sql, [userId], (err, result) => {
    if (err) {
      console.error("❌ Notification Count Error:", err);
      return res.json({ count: 0 });
    }
    res.json({ count: result[0].count });
  });
});


app.get('/admin/balance-requests', checkAdmin, (req, res) => {
  const sql = `
    SELECT balance_requests.*, users.username 
    FROM balance_requests 
    JOIN users ON users.id = balance_requests.user_id 
    ORDER BY created_at DESC
  `;

  db.query(sql, [], (err, requests) => {
    if (err) {
      console.error("❌ DB Error:", err.message);
      return res.status(500).send("Failed to load balance requests.");
    }

    res.render('admin-balance-requests', {
      user: req.session.user,
      requests
    });
  });
});



const fetch = require('node-fetch');

app.post('/admin/balance-requests/update/:id', async (req, res) => {
  const requestId = req.params.id;
  const { status, admin_note } = req.body;

  try {
    // تحديث الطلب
    await db.promise().query(`
      UPDATE balance_requests
      SET status = ?, admin_note = ?
      WHERE id = ?
    `, [status, admin_note || null, requestId]);

    // جلب معلومات الطلب كاملة
    const [reqRows] = await db.promise().query(`
      SELECT br.amount, br.currency, br.user_id, u.telegram_chat_id
      FROM balance_requests br
      JOIN users u ON br.user_id = u.id
      WHERE br.id = ?
    `, [requestId]);

    if (reqRows.length === 0) return res.redirect('/admin/balance-requests');

    const { amount, currency, telegram_chat_id: chatId } = reqRows[0];
    if (!chatId) return res.redirect('/admin/balance-requests');

    const botToken = '8205085707:AAFCb4bsiwEIXDMe4pGYEruMBsK4aWSp40I';
    
    const msg = status === 'approved'
      ? `✅ *تمت الموافقة على طلب تعبئة الرصيد الخاص بك*\n\n💰 القيمة: ${amount} ${currency}\n📌 الحالة: تم القبول.`
      : `❌ *تم رفض طلب تعبئة الرصيد الخاص بك*\n\n💰 القيمة: ${amount} ${currency}\n📌 السبب: ${admin_note || 'لم يتم تحديد السبب.'}`;

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: "Markdown"
      })
    });

    res.redirect('/admin/balance-requests');
  } catch (err) {
    console.error('❌ Error updating request or sending Telegram:', err);
    res.status(500).send('Error updating request');
  }
});


app.get('/admin/balance-requests', checkAdmin, (req, res) => {
  const sql = `
    SELECT balance_requests.*, users.username 
    FROM balance_requests 
    JOIN users ON users.id = balance_requests.user_id 
    ORDER BY created_at DESC
  `;

  db.query(sql, [], (err, requests) => {
    if (err) {
      console.error("❌ DB Error:", err.message);
      return res.status(500).send("Failed to load balance requests.");
    }

    res.render('admin-balance-requests', {
      user: req.session.user,
      requests
    });
  });
});






app.get('/free-fire-section', async (req, res) => {
  try {
    const query = (sql, params) =>
      new Promise((resolve, reject) => {
        db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
      });

    const selectedSql = "SELECT * FROM selected_api_products WHERE active = 1 AND category = 'freefire'";
    const selectedProducts = await query(selectedSql);
    const selectedMap = new Map(selectedProducts.map(p => [parseInt(p.product_id), p]));
    const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');


     const apiProducts = await getCachedAPIProducts();

    const finalProducts = apiProducts
      .filter(p => selectedMap.has(p.id))
      .map(p => {
        const custom = selectedMap.get(p.id);
        return {
          id: p.id,
          name: custom.custom_name || p.name,
          image: custom.custom_image || p.image || '/images/default-product.png',
          price: custom.custom_price ? parseFloat(custom.custom_price) : parseFloat(p.price),
          variable_quantity: custom.variable_quantity === 1,
          requires_player_id: p.player_check ? 1 : 0
        };
      });

    res.render('free-fire-section', {
      user: req.session.user,
      products: finalProducts
    });

  } catch (error) {
    console.error("❌ Error loading Free Fire section:", error.message);
    res.status(500).send("Error loading Free Fire products.");
  }
});


// هذا المسار رح يستخدم من خلال AJAX (fetch)


app.post('/verify-player', checkAuth, async (req, res) => {
  const { player_id, product_id } = req.body;

  try {
    const result = await verifyPlayerId(product_id, player_id);

    console.log("🔽 API Raw Response:", result); // تأكيد بالكونسول

    if (result.success === true || result.success === "true") {
      return res.json({
        success: true,
        message: "Player ID is valid.",
        player_name: result.player_name || ""
      });
    } else {
      return res.json({
        success: false,
        message: "Invalid Player ID."
      });
    }

  } catch (error) {
    console.error("Verification Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to verify player ID."
    });
  }
});


app.post('/buy-quantity-product', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  const { productId, quantity, player_id } = req.body;

  const query = (sql, params) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });

  try {
    // جلب بيانات المنتج
    const [product] = await query(
      "SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1 AND variable_quantity = 1",
      [productId]
    );
    if (!product) return res.redirect(`/api-checkout/${productId}?error=notfound`);

    const qty = parseInt(quantity);
    const min = parseInt(product.min_quantity);
    const max = parseInt(product.max_quantity);
    const unitQty = parseInt(product.unit_quantity);
    const unitPrice = parseFloat(product.unit_price);

    if (isNaN(qty) || qty < min || qty > max) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_quantity`);
    }

    // التحقق من الحساب إذا لزم
    if (product.requires_verification) {
      if (!player_id || player_id.trim() === "") {
        return res.redirect(`/api-checkout/${productId}?error=missing_player`);
      }

      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.redirect(`/api-checkout/${productId}?error=verify&msg=${encodeURIComponent(verifyRes.message || "Verification failed")}`);
      }
    }

    const total = parseFloat(((qty / unitQty) * unitPrice).toFixed(2));

    // جلب المستخدم
    const [user] = await query("SELECT balance, username, telegram_chat_id FROM users WHERE id = ?", [userId]);
    const balance = parseFloat(user?.balance || 0);
    if (balance < total) {
      return res.redirect(`/api-checkout/${productId}?error=balance`);
    }

    // خصم الرصيد
    await query("UPDATE users SET balance = balance - ? WHERE id = ?", [total, userId]);

    // تسجيل معاملة الخصم
    await query(`
      INSERT INTO transactions (user_id, type, amount, reason)
      VALUES (?, 'debit', ?, ?)
    `, [userId, total, `Purchase: ${product.custom_name || `API Product ${productId}`}`]);

    // إرسال الطلب إلى DailyCard
    const orderBody = {
      product: parseInt(productId),
      quantity: qty,
      ...(player_id ? { account_id: player_id } : {})
    };

    const { data: result } = await dailycardAPI.post('/api-keys/orders/create/', orderBody);
    const orderId = result?.id || result?.data?.id;

    if (!orderId) {
      await query("UPDATE users SET balance = balance + ? WHERE id = ?", [total, userId]);
      await query(`
        INSERT INTO transactions (user_id, type, amount, reason)
        VALUES (?, 'credit', ?, ?)
      `, [userId, total, `Refund: ${product.custom_name || `API Product ${productId}`}`]);

      const msg = JSON.stringify(result.message || '');
      if (msg.includes("Insufficient balance")) {
        return res.redirect(`/api-checkout/${productId}?error=balance`);
      }

      return res.redirect(`/api-checkout/${productId}?error=order_failed`);
    }

    const orderStatus = 'Waiting';
    const orderDetails = player_id
      ? `User ID: ${player_id}, Quantity: ${qty}`
      : `Quantity: ${qty}`;

    const insertSql = `
      INSERT INTO orders (userId, productName, price, purchaseDate, order_details, status)
      VALUES (?, ?, ?, NOW(), ?, ?)
    `;
    const insertResult = await query(insertSql, [
      userId,
      product.custom_name || `API Product ${productId}`,
      total,
      orderDetails,
      orderStatus
    ]);
    const insertId = insertResult.insertId || insertResult[0]?.insertId;

    // إشعار داخل النظام
    await query(`
      INSERT INTO notifications (user_id, message, created_at, is_read)
      VALUES (?, ?, NOW(), 0)
    `, [
      userId,
      `✅ تم استلام طلبك (${product.custom_name || `API Product ${productId}`}) بنجاح. سيتم معالجته قريبًا.`
    ]);

    // إشعار تيليغرام للمستخدم
    if (user.telegram_chat_id) {
      await sendTelegramMessage(
        user.telegram_chat_id,
        `📥 <b>تم استلام طلبك بنجاح</b>\n\n🛍️ <b>المنتج:</b> ${product.custom_name || `API Product ${productId}`}\n🔢 <b>الكمية:</b> ${qty}\n💰 <b>السعر:</b> ${total}$\n📌 <b>الحالة:</b> جاري المعالجة`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // إشعار تيليغرام للإدارة
    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 طلب جديد!\n👤 الزبون: ${user.username}\n🎁 المنتج: ${product.custom_name || `API Product ${productId}`}\n📦 الكمية: ${qty}\n💰 السعر: ${total}$\n🕓 الوقت: ${new Date().toLocaleString('en-US', { hour12: false })}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // حفظ رقم الطلب في السيشن
    req.session.pendingOrderId = insertId;
    return res.redirect(`/processing`);

  } catch (err) {
    const rawError = err.response?.data || err.message || err;
    console.error("❌ Quantity Order Error:", rawError);

    const errStr = String(rawError).toLowerCase();
    if (errStr.includes("verify")) {
      return res.redirect(`/api-checkout/${productId}?error=verify`);
    }
    if (errStr.includes("network") || errStr.includes("axios")) {
      return res.redirect(`/api-checkout/${productId}?error=network`);
    }

    return res.redirect(`/api-checkout/${productId}?error=server`);
  }
});




app.get('/transactions', checkUser, (req, res) => {
  const userId = req.session.user.id;

  const sql = `
    SELECT t.*, o.productName 
    FROM transactions t
    LEFT JOIN orders o ON t.order_id = o.id
    WHERE t.user_id = ?
    ORDER BY t.date DESC
  `;

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("❌ Failed to fetch transactions:", err);
      return res.status(500).send("حدث خطأ في تحميل سجل المعاملات.");
    }

    res.render('transactions', {
      user: req.session.user,
      transactions: results
    });
  });
});










app.post('/login', async (req, res) => {
  const { login_identifier, password, captcha } = req.body;

  // Initialize loginAttempts if not set
  if (!req.session.loginAttempts) req.session.loginAttempts = 0;

  // If attempts ≥ 3, require reCAPTCHA validation
  if (req.session.loginAttempts >= 3) {
    if (!captcha) {
      return res.status(403).json({
        success: false,
        message: "Please verify reCAPTCHA.",
        showCaptcha: true
      });
    }

    try {
      const verifyRes = await axios.post(
        `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${captcha}`
      );

      if (!verifyRes.data.success) {
        return res.status(403).json({
          success: false,
          message: "reCAPTCHA verification failed.",
          showCaptcha: true
        });
      }
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: "Error verifying reCAPTCHA.",
        showCaptcha: true
      });
    }
  }

  // Attempt to find user and check password
  const sql = `SELECT * FROM users WHERE email = ? OR username = ?`;
  db.query(sql, [login_identifier, login_identifier], (err, results) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error.' });
    }

    if (results.length > 0) {
      const user = results[0];
      bcrypt.compare(password, user.password, (err, isMatch) => {
        if (isMatch) {
          req.session.user = user;
          req.session.justLoggedIn = true;
          req.session.loginAttempts = 0;

          return res.json({ success: true, redirectUrl: '/' });
        } else {
          req.session.loginAttempts += 1;
          return res.status(401).json({
            success: false,
            message: '❌ Incorrect email or password.',
            showCaptcha: req.session.loginAttempts >= 3
          });
        }
      });
    } else {
      req.session.loginAttempts += 1;
      return res.status(401).json({
        success: false,
        message: '❌ Incorrect email or password.',
        showCaptcha: req.session.loginAttempts >= 3
      });
    }
  });
});


app.get('/profile', checkAuth, (req, res) => {
    // نحن نستخدم بيانات المستخدم المخزنة في الـ session
    res.render('profile', { user: req.session.user });
});

// مسار لتحديث اسم المستخدم
app.post('/profile/update-username', checkAuth, (req, res) => {
    const newUsername = req.body.newUsername;
    const userId = req.session.user.id;
    const sql = `UPDATE users SET username = ? WHERE id = ?`;

    db.query(sql, [newUsername, userId], function(err) {
        if (err) {
            return console.error(err.message);
        }
        // مهم جدًا: تحديث الاسم في الـ session أيضًا
        req.session.user.username = newUsername;
        res.redirect('/profile');
    });
});

// مسار لتحديث الإيميل
app.post('/profile/update-email', checkAuth, (req, res) => {
    const newEmail = req.body.newEmail;
    const userId = req.session.user.id;
    const sql = `UPDATE users SET email = ? WHERE id = ?`;

    db.query(sql, [newEmail, userId], function(err) {
        if (err) {
            return console.error(err.message);
        }
        // مهم جدًا: تحديث الإيميل في الـ session أيضًا
        req.session.user.email = newEmail;
        res.redirect('/profile');
    });
});






app.post('/buy', checkAuth, uploadNone.none(), (req, res) => {

  const { productId, playerId } = req.body;
  const user = req.session.user;

  if (!productId) {
    return res.status(400).json({ success: false, message: 'Invalid product ID' });
  }

  const productSql = 'SELECT * FROM products WHERE id = ?';
  db.query(productSql, [productId], (err, result) => {
    if (err || result.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const product = result[0];
    const purchasePrice = parseFloat(product.price);

    if (user.balance < purchasePrice) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    const newBalance = user.balance - purchasePrice;
    const now = new Date();
    const orderDetails = playerId && playerId.trim() !== '' ? playerId.trim() : null;

    const updateUserSql = 'UPDATE users SET balance = ? WHERE id = ?';
    const insertOrderSql = `
      INSERT INTO orders (userId, productName, price, purchaseDate, order_details, status)
      VALUES (?, ?, ?, ?, ?, 'Waiting')
    `;
    const notifSql = `
      INSERT INTO notifications (user_id, message, created_at, is_read)
      VALUES (?, ?, NOW(), 0)
    `;
    const notifMsg = `✅ تم استلام طلبك (${product.name}) بنجاح. سيتم معالجته قريبًا.`;

    db.beginTransaction(err => {
      if (err) {
        console.error('Transaction error:', err);
        return res.status(500).json({ success: false, message: 'Transaction failed' });
      }

      db.query(updateUserSql, [newBalance, user.id], err => {
        if (err) {
          return db.rollback(() => {
            console.error('Balance update failed:', err);
            res.status(500).json({ success: false, message: 'Balance update failed' });
          });
        }

        db.query(insertOrderSql, [user.id, product.name, purchasePrice, now, orderDetails], (err, result) => {
          if (err) {
            return db.rollback(() => {
              console.error('Order insertion failed:', err);
              res.status(500).json({ success: false, message: 'Order insertion failed' });
            });
          }

          const orderId = result.insertId;

          // إشعار داخلي
          db.query(notifSql, [user.id, notifMsg], (err) => {
            if (err) console.error('⚠️ Failed to save notification:', err);
          });

          // إشعار تيليغرام للزبون
          db.query("SELECT telegram_chat_id FROM users WHERE id = ?", [user.id], async (err, rows) => {
            if (err) {
              console.error("❌ Error fetching chat_id from DB:", err.message);
              return;
            }

            const chatId = rows[0]?.telegram_chat_id;

            if (chatId) {
              const msg = `
📥 *تم استلام طلبك بنجاح*

🛍️ *المنتج:* ${product.name}
💰 *السعر:* ${purchasePrice}$
📌 *الحالة:* جاري المعالجة
              `.trim();

              try {
                await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  chat_id: chatId,
                  text: msg,
                  parse_mode: 'Markdown'
                });
               // console.log("✅ Telegram message sent to user:", chatId);
              } catch (e) {
                console.warn("⚠️ Failed to send Telegram to user:", e.message);
              }
            } else {
              console.log("ℹ️ No valid telegram_chat_id found, or user hasn't messaged bot yet.");
            }

            // إشعار تيليغرام للإدمن
            try {
              const adminChatId = '2096387191'; // ← غيّره إذا لزم
              const adminMsg = `
🆕 <b>طلب جديد!</b>

👤 <b>الزبون:</b> ${user.username}
🛍️ <b>المنتج:</b> ${product.name}
💰 <b>السعر:</b> ${purchasePrice}$
📋 <b>التفاصيل:</b> ${orderDetails || 'لا يوجد'}
🕒 <b>الوقت:</b> ${now.toLocaleString()}

افتح لوحة الإدارة لمتابعة الطلب 👨‍💻
              `.trim();

              await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: adminChatId,
                text: adminMsg,
                parse_mode: 'HTML'
              });
              console.log("📢 Admin notified via Telegram");
            } catch (e) {
              console.warn("⚠️ Failed to notify admin via Telegram:", e.message);
            }

            // إنهاء المعاملة
            db.commit(err => {
              if (err) {
                return db.rollback(() => {
                  console.error('Commit failed:', err);
                  res.status(500).json({ success: false, message: 'Commit failed' });
                });
              }

              // تحديث الرصيد في السيشن
              req.session.user.balance = newBalance;

              // توجيه المستخدم لصفحة المعالجة
              return res.json({ success: true });

            });
          });
        });
      });
    });
  });
});





app.get('/order/:id', checkAuth, (req, res) => {
  const orderId = parseInt(req.params.id);
  const userId = req.session.user.id;

  const sql = "SELECT * FROM orders WHERE id = ? AND userId = ?";
  db.query(sql, [orderId, userId], (err, results) => {
    if (err || results.length === 0) {
      return res.status(404).send("❌ Order not found or access denied.");
    }

    const order = results[0];
    res.render('order-details', { order });
  });
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

    // 1. جلب قائمة المستخدمين
    db.query(usersSql, (err, users) => {
        if (err) throw err;

        // 2. جلب الإحصائيات
        db.query(statsSql, (err, results) => {
            if (err) throw err;
            
            const stats = results[0]; // النتيجة تأتي كمصفوفة
            
            // 3. عرض الصفحة مع كل البيانات
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
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('admin-products', { user: req.session.user, products: products });
    });
});


app.post('/admin/products/update/:id', checkAdmin, (req, res) => {
 const productId = req.params.id;
 // ✅ تم إضافة 'image' لاستقبال قيمة الصورة
// ✅ تم تصحيح أسماء الأعمدة لتطابق قاعدة البيانات
 const { name, price, main_category, sub_category, image } = req.body;

 const sql = `
 UPDATE products 
SET name = ?, price = ?, main_category = ?, sub_category = ?, image = ? 
 WHERE id = ?
`;

 // ✅ تم تمرير القيم بالترتيب الصحيح
 db.query(sql, [name, price, main_category, sub_category, image, productId], (err, result) => {
 if (err) {
 console.error("❌ Error updating product:", err.message);
 return res.status(500).send("Error updating product.");
 }

res.redirect('/admin/products');
});
});


app.get('/admin/new-orders-count', async (req, res) => {
  const sql = "SELECT COUNT(*) AS count FROM orders WHERE is_new = 1";
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ count: results[0].count });
  });
});




app.post('/admin/users/add', checkAdmin, async (req, res) => {
  const { username, email, password, phone, role } = req.body;
  const hash = await bcrypt.hash(password, 10);

  const sql = `INSERT INTO users (username, email, password, phone, role) VALUES (?, ?, ?, ?, ?)`;
  db.query(sql, [username, email, hash, phone, role], err => {
    if (err) return res.status(500).send("Error creating user.");
    res.redirect('/admin/users');
  });
});


app.get('/admin/users', checkAdmin, async (req, res) => {
  const sql = "SELECT * FROM users ORDER BY createdAt DESC";
  db.query(sql, [], (err, users) => {
    if (err) {
      console.error("❌ DB Error:", err.message); // أضف هذا السطر
      return res.status(500).send("Error loading users.");
    }
    res.render('admin-users', {
      user: req.session.user,  // ← هذا يجب أن يكون موجود
      users
    });
  });
});
// يعرض نموذج إضافة مستخدم
app.get('/admin/users/add', checkAdmin, (req, res) => {
  res.render('admin-add-user', { user: req.session.user });
});



app.get('/admin/users/edit/:id', checkAdmin, (req, res) => {
  const sql = "SELECT * FROM users WHERE id = ?";
  db.query(sql, [req.params.id], (err, results) => {
    if (err || results.length === 0) return res.status(404).send("User not found.");
    res.render('admin-edit-user', {
      user: req.session.user,
      editUser: results[0]
    });
  });
});

app.post('/admin/users/edit/:id', checkAdmin, (req, res) => {
  const { username, email, phone, role } = req.body;
  const sql = "UPDATE users SET username = ?, email = ?, phone = ?, role = ? WHERE id = ?";

  db.query(sql, [username, email, phone, role, req.params.id], (err) => {
    if (err) return res.status(500).send("❌ Error updating user.");
    res.redirect('/admin/users');
  });
});

app.post('/admin/users/delete/:id', checkAdmin, (req, res) => {
  const userId = req.params.id;
  const sql = "DELETE FROM users WHERE id = ?";
  db.query(sql, [userId], (err, result) => {
    if (err) {
      console.error("❌ Error deleting user:", err.message);
      return res.status(500).send("Failed to delete user.");
    }
    res.redirect('/admin/users');
  });
});



app.get('/admin/users/reset-password/:id', checkAdmin, (req, res) => {
  const sql = "SELECT id, username FROM users WHERE id = ?";
  db.query(sql, [req.params.id], (err, results) => {
    if (err || results.length === 0) return res.status(404).send("User not found.");
    
    const user = results[0];
    res.render('admin-reset-password', { user: req.session.user, targetUser: user });
  });
});



// الراوت المسؤول عن حفظ الباسورد
app.post('/admin/users/reset-password/:id', checkAdmin, async (req, res) => {
  const userId = req.params.id; // ✅ هذا المفتاح هو اللي يخليك تعدل لأي مستخدم
  const { newPassword } = req.body;

  const bcrypt = require('bcrypt');
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  const sql = "UPDATE users SET password = ? WHERE id = ?";
  db.query(sql, [hashedPassword, userId], (err) => {
    if (err) {
      console.error("❌ Error resetting password:", err.message);
      return res.status(500).send("Failed to reset password.");
    }

    console.log("✅ Password updated for user ID:", userId); // ← تأكيد في الكونسول
    res.redirect('/admin/users');
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
    db.query(sql, params, function(err) {
        if (err) {
            console.error("DATABASE INSERT ERROR:", err.message);
            return res.send("An error occurred while adding the product.");
        }
        res.redirect('/admin/products');
    });
});

app.post('/admin/update-balance', checkAdmin, (req, res) => {
    const { userId, amount, operation } = req.body;
    const parsedAmount = parseFloat(amount);

    if (!userId || isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).send("❌ Invalid input");
    }

    const sqlSelect = `SELECT balance FROM users WHERE id = ?`;
    db.query(sqlSelect, [userId], (err, results) => {
        if (err) return res.status(500).send("❌ DB error");

        const currentBalance = parseFloat(results[0]?.balance || 0);

        let updatedBalance = currentBalance;
        let message = '';

        if (operation === 'add') {
            updatedBalance += parsedAmount;
            message = ` ✅ Your balance has been charged with an amount of ${parsedAmount.toFixed(2)}$  Successfully`;
        } else if (operation === 'deduct') {
            if (parsedAmount > currentBalance) {
                return res.status(400).send("❌ Insufficient balance for deduction");
            }
            updatedBalance -= parsedAmount;
            message = `⚠️ An amount has been deducted ${parsedAmount.toFixed(2)}$ from your balance`;
        } else {
            return res.status(400).send("❌ Unknown operation");
        }

        const sqlUpdate = `UPDATE users SET balance = ? WHERE id = ?`;
        db.query(sqlUpdate, [updatedBalance, userId], (err2) => {
            if (err2) return res.status(500).send("❌ Failed to update balance");

            // ✅ إضافة إشعار بعد تحديث الرصيد
            const notifySql = `INSERT INTO notifications (user_id, message) VALUES (?, ?)`;
            db.query(notifySql, [userId, message], (err3) => {
                if (err3) {
                    console.error("❌ Notification insert failed:", err3.message);
                    // من الأفضل ما توقف الصفحة لو فشل الإشعار
                }
                return res.redirect('/admin');
            });
        });
    });
});



app.get('/admin/products/edit/:id', checkAdmin, (req, res) => {
  const productId = req.params.id;
  const sql = "SELECT * FROM products WHERE id = ?";

  db.query(sql, [productId], (err, result) => {
    if (err || !result || result.length === 0) {
      return res.status(404).send('❌ Product not found.');
    }

    const product = result[0];

    res.render('admin-edit-product', {
      user: req.session.user,
      product
    });
  });
});



app.post('/admin/products/edit/:id', checkAdmin, (req, res) => {
  const productId = req.params.id;
  const {
    name,
    price,
    image,
    main_category,
    sub_category,
    sub_category_image,
    player_id_label,
    notes // ← الحقل الجديد
  } = req.body;

  const requires_player_id = req.body.requires_player_id ? 1 : 0;

  const sql = `
    UPDATE products
    SET name = ?, price = ?, image = ?, main_category = ?, sub_category = ?, 
        sub_category_image = ?, requires_player_id = ?, player_id_label = ?, notes = ?
    WHERE id = ?
  `;

  const values = [
    name,
    price,
    image,
    main_category,
    sub_category,
    sub_category_image,
    requires_player_id,
    player_id_label,
    notes, // ← أضفناها ضمن القيم
    productId
  ];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error("❌ Error updating product:", err);
      return res.status(500).send("Database error during update.");
    }

    res.redirect('/admin/products'); // الرجوع بعد الحفظ
  });
});



// مسار لعرض كل الطلبات في لوحة تحكم الأدمن
app.get('/admin/orders', checkAdmin, (req, res) => {
    const sql = `SELECT orders.*, users.username FROM orders JOIN users ON users.id = orders.userId ORDER BY purchaseDate DESC`;
    db.query(sql, [], (err, orders) => {
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

  const findOrderSql = `SELECT * FROM orders WHERE id = ?`;

  db.query(findOrderSql, [orderId], (err, results) => {
    if (err || results.length === 0) {
      return res.send('Order not found.');
    }

    const order = results[0];
    const oldStatus = order.status;
    const orderPrice = parseFloat(order.price);
    const userId = order.userId;

    if (status === 'Rejected' && oldStatus !== 'Rejected') {
      db.beginTransaction(err => {
        if (err) throw err;

        db.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [orderPrice, userId], (err) => {
          if (err) return db.rollback(() => { throw err; });

          db.query(`
            INSERT INTO transactions (user_id, type, amount, reason)
            VALUES (?, 'credit', ?, ?)
          `, [userId, orderPrice, `Refund for rejected order #${orderId}`], (err) => {
            if (err) return db.rollback(() => { throw err; });

            const notifMsg = `❌ تم رفض طلبك (${order.productName})، وتم استرجاع المبلغ (${order.price}$) إلى رصيدك.`;
            db.query(`
              INSERT INTO notifications (user_id, message, created_at, is_read)
              VALUES (?, ?, NOW(), 0)
            `, [userId, notifMsg], (err) => {
              if (err) console.warn("⚠️ Failed to insert internal notification:", err);

              db.query(`UPDATE orders SET status = ?, admin_reply = ? WHERE id = ?`,
                [status, admin_reply, orderId], (err) => {
                  if (err) return db.rollback(() => { throw err; });

                  sendOrderStatusTelegram(orderId, status, admin_reply)
                    .then(() => {
                      db.commit(err => {
                        if (err) return db.rollback(() => { throw err; });
                        console.log(`✅ Order #${orderId} rejected and refunded.`);
                        res.redirect('/admin/orders');
                      });
                    })
                    .catch(err => {
                      console.error("❌ Telegram Error:", err);
                      db.rollback(() => {
                        res.status(500).send("Error sending Telegram notification.");
                      });
                    });
                });
            });
          });
        });
      });

    } else {
      db.query(`UPDATE orders SET status = ?, admin_reply = ? WHERE id = ?`, [status, admin_reply, orderId], (err) => {
        if (err) return console.error(err.message);

        sendOrderStatusTelegram(orderId, status, admin_reply)
          .then(() => {
            console.log(`✅ Order #${orderId} updated to ${status}`);
            res.redirect('/admin/orders');
          })
          .catch(err => {
            console.error("❌ Telegram Error:", err);
            res.redirect('/admin/orders');
          });
      });
    }
  });
});



app.post('/admin/products/delete/:id', checkAdmin, (req, res) => {
    const productId = req.params.id;
    const sql = "DELETE FROM products WHERE id = ?";
    
    db.query(sql, [productId], function(err) {
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


// مسار لعرض صفحة التحكم بمنتجات الـ API
app.get('/admin/api-products', checkAdmin, async (req, res) => {
  try {
    const query = (sql, params) => new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const apiProducts = await getCachedAPIProducts();

    // ب. جلب التعديلات المحفوظة من قاعدة البيانات
    const customSql = "SELECT * FROM selected_api_products";
    const customProducts = await query(customSql);
    const customProductMap = new Map(customProducts.map(p => [parseInt(p.product_id), p]));

    

    const displayProducts = apiProducts.map(apiProduct => {
      const customData = customProductMap.get(apiProduct.id) || {};
      return {
        ...apiProduct,
        is_selected: customData.active || false,
        custom_price: customData.custom_price,
        custom_image: customData.custom_image
      };
    });

    // د. تطبيق التصفية حسب الصفحة
    const totalProducts = displayProducts.length;
    const totalPages = Math.ceil(totalProducts / limit);
    const paginatedProducts = displayProducts.slice(offset, offset + limit);

    res.render('admin-api-products', {
      user: req.session.user,
      products: paginatedProducts,
      currentPage: page,
      totalPages
    });

  } catch (error) {
    console.error("API Error in /admin/api-products:", error.stack || error.message);
    res.status(500).send("❌ Error loading API products.");
  }
});

// مسار لإضافة أو إزالة منتج من الـ API
app.post('/admin/api-products/toggle', checkAdmin, (req, res) => {
    const { productId, isActive } = req.body;
    
    // تم تصحيح الشرط هنا من 'true' إلى true (boolean)
    if (isActive) { 
        // إذا كان المنتج يُضاف الآن
        const sql = "INSERT INTO selected_api_products (product_id, active) VALUES (?, TRUE) ON DUPLICATE KEY UPDATE active = TRUE";
        db.query(sql, [productId], (err, result) => {
            if (err) {
                console.error(err);
                return res.json({ success: false });
            }
            res.json({ success: true, status: 'activated' });
        });
    } else {
        // إذا كان المنتج يُزال الآن
        const sql = "DELETE FROM selected_api_products WHERE product_id = ?";
        db.query(sql, [productId], (err, result) => {
            if (err) {
                console.error(err);
                return res.json({ success: false });
            }
            res.json({ success: true, status: 'deactivated' });
        });
    }
});


// مسار لعرض صفحة تعديل منتج API معين
app.get('/admin/api-products/edit/:id', checkAdmin, async (req, res) => {
  const productId = parseInt(req.params.id);

  try {
    // 1. جلب جميع المنتجات من الكاش
    const apiProducts = await getCachedAPIProducts();

    // 2. إيجاد المنتج المطلوب من الكاش باستخدام ID
    const selectedProduct = apiProducts.find(p => p.id === productId);

    if (!selectedProduct) {
      return res.status(404).send("❌ Product not found in API");
    }

    // 3. جلب التخصيصات الموجودة (customizations) من قاعدة البيانات
    const query = "SELECT * FROM selected_api_products WHERE product_id = ?";
    db.query(query, [productId], (err, rows) => {
      if (err) {
        console.error("❌ DB Error:", err);
        return res.status(500).send("❌ Database Error");
      }

      // 4. تخصيص المنتج في حال وجد، أو قيم فارغة بشكل افتراضي
      const custom = rows[0] || {};

      // 5. عرض صفحة التعديل مع بيانات المنتج والتعديلات
      res.render('admin-edit-api-product', {
        product: selectedProduct,
        custom,
        user: req.session.user
      });
    });

  } catch (error) {
    console.error("❌ Error in /admin/api-products/edit:", error.stack || error.message);
    res.status(500).send("❌ Internal Server Error");
  }
});


app.post('/admin/api-products/edit/:id', checkAdmin, (req, res) => {
  const productId = req.params.id;
  const {
    custom_price,
    custom_image,
    custom_name,
    category,
    variable_quantity,
    unit_price,
    unit_quantity,
    min_quantity,
    max_quantity,
    unit_label
  } = req.body;

  // ✅ تحضير القيم المدخلة
  const priceToSave = custom_price ? parseFloat(custom_price) : null;
  const imageToSave = custom_image || null;
  const nameToSave = custom_name || null;
  const categoryToSave = category || null;
  const labelToSave = unit_label || 'units';

  const variableQtyFlag = variable_quantity === '1' || variable_quantity === 'on' ? 1 : 0;
  const player_check = req.body.player_check === '1' || req.body.player_check === 'on' ? 1 : 0;
  const requiresVerification = req.body.requires_verification === '1' || req.body.requires_verification === 'on' ? 1 : 0;

  const unitPriceToSave = variableQtyFlag ? parseFloat(unit_price) || null : null;
  const unitQuantityToSave = variableQtyFlag ? parseFloat(unit_quantity) || null : null;
  const minQtyToSave = variableQtyFlag ? parseInt(min_quantity) || null : null;
  const maxQtyToSave = variableQtyFlag ? parseInt(max_quantity) || null : null;

  // ✅ جملة الإدخال والتحديث
  const sql = `
    INSERT INTO selected_api_products (
      product_id, custom_price, custom_image, custom_name, category, active,
      variable_quantity, unit_price, unit_quantity, min_quantity, max_quantity,
      player_check, unit_label, requires_verification
    )
    VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      custom_price = VALUES(custom_price),
      custom_image = VALUES(custom_image),
      custom_name = VALUES(custom_name),
      category = VALUES(category),
      active = TRUE,
      variable_quantity = VALUES(variable_quantity),
      unit_price = VALUES(unit_price),
      unit_quantity = VALUES(unit_quantity),
      min_quantity = VALUES(min_quantity),
      max_quantity = VALUES(max_quantity),
      player_check = VALUES(player_check),
      unit_label = VALUES(unit_label),
      requires_verification = VALUES(requires_verification)
  `;

  // ✅ القيم المطلوبة للإدخال
  const params = [
    productId,
    priceToSave,
    imageToSave,
    nameToSave,
    categoryToSave,
    variableQtyFlag,
    unitPriceToSave,
    unitQuantityToSave,
    minQtyToSave,
    maxQtyToSave,
    player_check,
    labelToSave,
    requiresVerification
  ];

  // ✅ تنفيذ الاستعلام
  db.query(sql, params, (err, result) => {
    if (err) {
      console.error("❌ Error saving custom product data:", err);
      return res.send("❌ Error saving changes.");
    }
    res.redirect('/admin/api-products');
  });
});




app.post('/buy-fixed-product', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.status(401).json({ success: false, message: "Session expired. Please log in." });

  const { productId, player_id } = req.body;
  if (!productId) return res.status(400).json({ success: false, message: "Missing product ID." });

  const query = (sql, params) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });

  try {
    const [product] = await query(`
      SELECT * FROM selected_api_products 
      WHERE product_id = ? 
      AND active = 1 
      AND (variable_quantity IS NULL OR variable_quantity = 0)
    `, [productId]);

    if (!product) return res.status(404).json({ success: false, message: "Product not found." });

    const price = parseFloat(product.custom_price || product.unit_price || 0).toFixed(2);
    const [user] = await query("SELECT username, balance, telegram_chat_id FROM users WHERE id = ?", [userId]);
    const balance = parseFloat(user?.balance || 0);

    if (balance < price) {
      return res.status(400).json({ success: false, message: "Insufficient balance." });
    }

    if (product.requires_verification) {
      if (!player_id || player_id.trim() === "") {
        return res.status(400).json({ success: false, message: "Missing player ID." });
      }

      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.status(400).json({ success: false, message: verifyRes.message || "Player verification failed." });
      }
    }

    await query("UPDATE users SET balance = balance - ? WHERE id = ?", [price, userId]);

    await query(`
      INSERT INTO transactions (user_id, type, amount, reason)
      VALUES (?, 'debit', ?, ?)
    `, [userId, price, `Purchase: ${product.custom_name || `API Product ${productId}`}`]);

    const orderBody = {
      product: parseInt(productId),
      ...(player_id ? { account_id: player_id } : {})
    };

    const { data: result } = await dailycardAPI.post('/api-keys/orders/create/', orderBody);
    const orderIdFromAPI = result?.id || result?.data?.id;

    if (!orderIdFromAPI) {
      await query("UPDATE users SET balance = balance + ? WHERE id = ?", [price, userId]);
      await query(`
        INSERT INTO transactions (user_id, type, amount, reason)
        VALUES (?, 'credit', ?, ?)
      `, [userId, price, `Refund: ${product.custom_name || `API Product ${productId}`}`]);

      return res.status(500).json({ success: false, message: "Order failed, refund issued." });
    }

    const orderDetails = player_id ? `User ID: ${player_id}` : '';
    const insertResult = await query(`
      INSERT INTO orders (userId, productName, price, purchaseDate, order_details, status)
      VALUES (?, ?, ?, NOW(), ?, 'Waiting')
    `, [userId, product.custom_name || `API Product ${productId}`, price, orderDetails]);

    const insertId = insertResult.insertId || insertResult[0]?.insertId;

    await query(`
      INSERT INTO notifications (user_id, message, created_at, is_read)
      VALUES (?, ?, NOW(), 0)
    `, [userId, `✅ Your order for (${product.custom_name || product.name}) was received and is being processed.`]);

    if (user.telegram_chat_id) {
      await sendTelegramMessage(
        user.telegram_chat_id,
        `📥 <b>Your order has been received</b>\n\n🛍️ <b>Product:</b> ${product.custom_name || product.name}\n💰 <b>Price:</b> ${price}$\n📌 <b>Status:</b> Processing`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 New Order!\n👤 User: ${user.username}\n🎁 Product: ${product.custom_name || product.name}\n💰 Price: ${price}$\n🕓 Time: ${new Date().toLocaleString('en-US', { hour12: false })}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    req.session.pendingOrderId = insertId;
    return res.json({ success: true, redirectUrl: "/processing" });

  } catch (err) {
    const rawErr = err.response?.data || err.message || err;
    console.error("❌ Fixed Order Error:", rawErr);
    return res.status(500).json({ success: false, message: "Server error. Please try again later." });
  }
});







// =============================================
//                  apps route
// =============================================




app.get('/netflix-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Netflix'";
    db.query(sql, [], (err, products) => {
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
    db.query(sql, [], (err, products) => {
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
    db.query(sql, [], (err, products) => {
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
    db.query(sql, [], (err, products) => {
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
    db.query(sql, [], (err, products) => {
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
app.get('/youtube-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Youtube premuim'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('youtube-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/crunchyroll-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Crunchy Roll'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('crunchyroll-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/capcut-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'CapCut'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('capcut-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});




app.get('/canva-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Canva'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('canva-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});


app.get('/anghami-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Anghami'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('anghami-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/touch-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Touch'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('touch-section', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

// ✅ هذا هو الراوت المصحح لشراء BIGO:
app.post('/bigolive-section', async (req, res) => {
  const { productId, quantity, player_id } = req.body;
  const user = req.session.user;

  if (!user) return res.redirect('/login');

  const parsedQty = parseInt(quantity);
  if (!parsedQty || parsedQty <= 0) {
    return res.send({ success: false, message: "Invalid quantity." });
  }

  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

  try {
    // 1. جلب إعدادات المنتج من قاعدة البيانات
    const [custom] = await query("SELECT * FROM selected_api_products WHERE product_id = ?", [productId]);
    if (!custom) return res.send({ success: false, message: "Product not found." });

    const unitQty = custom.unit_quantity || 100000;
    const unitPrice = parseFloat(custom.unit_price || 0.2);
    const minQty = custom.min_quantity || 100000;
    const maxQty = custom.max_quantity || 1000000;

    // 2. تحقق من الكمية ضمن الحدود
    if (parsedQty < minQty || parsedQty > maxQty) {
      return res.send({ success: false, message: `Quantity must be between ${minQty} and ${maxQty}` });
    }

    // 3. حساب السعر الإجمالي
    const blocks = parsedQty / unitQty;
    const totalPrice = parseFloat((blocks * unitPrice).toFixed(2));

    // 4. تحقق من رصيد المستخدم
    const [userData] = await query("SELECT * FROM users WHERE id = ?", [user.id]);
    if (!userData || userData.balance < totalPrice) {
      return res.send({ success: false, message: "Insufficient balance." });
    }

    // 5. تنفيذ الطلب مع DailyCard
    const apiRes = await dailycardAPI.post('/api-keys/place-order', {
      product_id: productId,
      identifier: player_id,
      quantity: parsedQty
    });

    // 6. خصم الرصيد
    await query("UPDATE users SET balance = balance - ? WHERE id = ?", [totalPrice, user.id]);

    // 7. حفظ الطلب
    await query(
      "INSERT INTO orders (user_id, product_name, price, player_id, quantity, source) VALUES (?, ?, ?, ?, ?, 'api')",
      [user.id, custom.custom_name || "BIGO Product", totalPrice, player_id, parsedQty]
    );

    return res.send({ success: true, message: "✅ Order placed successfully!" });

  } catch (error) {
    console.error("❌ Error in /bigolive-section:", error.response?.data || error.message);
    return res.send({ success: false, message: "Failed to process the order with the provider." });
  }
});


app.get('/bigolive-section', async (req, res) => {
  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

  try {
    const selectedSql = "SELECT * FROM selected_api_products WHERE active = 1 AND category = 'bigo'";
    const selectedProducts = await query(selectedSql);
    const selectedMap = new Map(selectedProducts.map(p => [parseInt(p.product_id), p]));

   const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');


    const apiProducts = await getCachedAPIProducts();


    const finalProducts = apiProducts
      .filter(p => selectedMap.has(p.id))
      .map(p => {
        const custom = selectedMap.get(p.id);
        return {
          id: p.id,
          name: custom.custom_name || p.name,
          image: custom.custom_image || p.image || '/images/default-product.png',
          price: custom.custom_price ? parseFloat(custom.custom_price) : parseFloat(p.price),
          variable_quantity: custom.variable_quantity === 1,
          requires_player_id: p.player_check ? 1 : 0
        };
      });

    res.render('bigolive-section', {
      user: req.session.user,
      products: finalProducts
    });

  } catch (error) {
    console.error("❌ Error in /bigolive-section:", error.response?.data || error.message);
    res.status(500).send("Failed to load BIGO section.");
  }
});



app.post('/likee-section', async (req, res) => {
  const { productId, quantity, player_id } = req.body;
  const user = req.session.user;

  if (!user) return res.redirect('/login');

  const parsedQty = parseInt(quantity);
  if (!parsedQty || parsedQty <= 0) {
    return res.send({ success: false, message: "Invalid quantity." });
  }

  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

  try {
    // 1. جلب إعدادات المنتج من قاعدة البيانات
    const [custom] = await query("SELECT * FROM selected_api_products WHERE product_id = ?", [productId]);
    if (!custom) return res.send({ success: false, message: "Product not found." });

    const unitQty = custom.unit_quantity || 100000;
    const unitPrice = parseFloat(custom.unit_price || 0.2);
    const minQty = custom.min_quantity || 100000;
    const maxQty = custom.max_quantity || 1000000;

    // 2. تحقق من الكمية ضمن الحدود
    if (parsedQty < minQty || parsedQty > maxQty) {
      return res.send({ success: false, message: `Quantity must be between ${minQty} and ${maxQty}` });
    }

    // 3. حساب السعر الإجمالي
    const blocks = parsedQty / unitQty;
    const totalPrice = parseFloat((blocks * unitPrice).toFixed(2));

    // 4. تحقق من رصيد المستخدم
    const [userData] = await query("SELECT * FROM users WHERE id = ?", [user.id]);
    if (!userData || userData.balance < totalPrice) {
      return res.send({ success: false, message: "Insufficient balance." });
    }

    // 5. تنفيذ الطلب مع DailyCard
    const apiRes = await dailycardAPI.post('/api-keys/place-order', {
      product_id: productId,
      identifier: player_id,
      quantity: parsedQty
    });

    // 6. خصم الرصيد
    await query("UPDATE users SET balance = balance - ? WHERE id = ?", [totalPrice, user.id]);

    // 7. حفظ الطلب
    await query(
      "INSERT INTO orders (user_id, product_name, price, player_id, quantity, source) VALUES (?, ?, ?, ?, ?, 'api')",
      [user.id, custom.custom_name || "Likee Product", totalPrice, player_id, parsedQty]
    );

    return res.send({ success: true, message: "✅ Order placed successfully!" });

  } catch (error) {
    console.error("❌ Error in /likee-section:", error.response?.data || error.message);
    return res.send({ success: false, message: "Failed to process the order with the provider." });
  }
});

app.get('/likee-section', async (req, res) => {
  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

  try {
    const selectedSql = "SELECT * FROM selected_api_products WHERE active = 1 AND category = 'Likee Live'";
    const selectedProducts = await query(selectedSql);
    const selectedMap = new Map(selectedProducts.map(p => [parseInt(p.product_id), p]));

   const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');


    const apiProducts = await getCachedAPIProducts();


    const finalProducts = apiProducts
      .filter(p => selectedMap.has(p.id))
      .map(p => {
        const custom = selectedMap.get(p.id);
        return {
          id: p.id,
          name: custom.custom_name || p.name,
          image: custom.custom_image || p.image || '/images/default-product.png',
          price: custom.custom_price ? parseFloat(custom.custom_price) : parseFloat(p.price),
          variable_quantity: custom.variable_quantity === 1,
          requires_player_id: p.player_check ? 1 : 0
        };
      });

    res.render('likee-section', {
      user: req.session.user,
      products: finalProducts
    });

  } catch (error) {
    console.error("❌ Error in /likee-section:", error.response?.data || error.message);
    res.status(500).send("Failed to load Likee section.");
  }
});




app.post('/soulchill-section', async (req, res) => {
  const { productId, quantity, player_id } = req.body;
  const user = req.session.user;

  if (!user) return res.redirect('/login');

  const parsedQty = parseInt(quantity);
  if (!parsedQty || parsedQty <= 0) {
    return res.send({ success: false, message: "Invalid quantity." });
  }

  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

  try {
    // 1. جلب إعدادات المنتج من قاعدة البيانات
    const [custom] = await query("SELECT * FROM selected_api_products WHERE product_id = ?", [productId]);
    if (!custom) return res.send({ success: false, message: "Product not found." });

    const unitQty = custom.unit_quantity || 100000;
    const unitPrice = parseFloat(custom.unit_price || 0.2);
    const minQty = custom.min_quantity || 100000;
    const maxQty = custom.max_quantity || 1000000;

    // 2. تحقق من الكمية ضمن الحدود
    if (parsedQty < minQty || parsedQty > maxQty) {
      return res.send({ success: false, message: `Quantity must be between ${minQty} and ${maxQty}` });
    }

    // 3. حساب السعر الإجمالي
    const blocks = parsedQty / unitQty;
    const totalPrice = parseFloat((blocks * unitPrice).toFixed(2));

    // 4. تحقق من رصيد المستخدم
    const [userData] = await query("SELECT * FROM users WHERE id = ?", [user.id]);
    if (!userData || userData.balance < totalPrice) {
      return res.send({ success: false, message: "Insufficient balance." });
    }

    // 5. تنفيذ الطلب مع DailyCard
    const apiRes = await dailycardAPI.post('/api-keys/place-order', {
      product_id: productId,
      identifier: player_id,
      quantity: parsedQty
    });

    // 6. خصم الرصيد
    await query("UPDATE users SET balance = balance - ? WHERE id = ?", [totalPrice, user.id]);

    // 7. حفظ الطلب
    await query(
      "INSERT INTO orders (user_id, product_name, price, player_id, quantity, source) VALUES (?, ?, ?, ?, ?, 'api')",
      [user.id, custom.custom_name || "BIGO Product", totalPrice, player_id, parsedQty]
    );

    return res.send({ success: true, message: "✅ Order placed successfully!" });

  } catch (error) {
    console.error("❌ Error in /soulchill-section:", error.response?.data || error.message);
    return res.send({ success: false, message: "Failed to process the order with the provider." });
  }
});


app.get('/soulchill-section', async (req, res) => {
  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

  try {
    const selectedSql = "SELECT * FROM selected_api_products WHERE active = 1 AND category = 'soulchill'";
    const selectedProducts = await query(selectedSql);
    const selectedMap = new Map(selectedProducts.map(p => [parseInt(p.product_id), p]));

   const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');


    const apiProducts = await getCachedAPIProducts();


    const finalProducts = apiProducts
      .filter(p => selectedMap.has(p.id))
      .map(p => {
        const custom = selectedMap.get(p.id);
        return {
          id: p.id,
          name: custom.custom_name || p.name,
          image: custom.custom_image || p.image || '/images/default-product.png',
          price: custom.custom_price ? parseFloat(custom.custom_price) : parseFloat(p.price),
          variable_quantity: custom.variable_quantity === 1,
          requires_player_id: p.player_check ? 1 : 0
        };
      });

    res.render('soulchill-section', {
      user: req.session.user,
      products: finalProducts
    });

  } catch (error) {
    console.error("❌ Error in /soulchill-section:", error.response?.data || error.message);
    res.status(500).send("Failed to load Soul Chill section.");
  }
});



app.post('/hiyachat-section', async (req, res) => {
  const { productId, quantity, player_id } = req.body;
  const user = req.session.user;

  if (!user) return res.redirect('/login');

  const parsedQty = parseInt(quantity);
  if (!parsedQty || parsedQty <= 0) {
    return res.send({ success: false, message: "Invalid quantity." });
  }

  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

  try {
    // 1. جلب إعدادات المنتج من قاعدة البيانات
    const [custom] = await query("SELECT * FROM selected_api_products WHERE product_id = ?", [productId]);
    if (!custom) return res.send({ success: false, message: "Product not found." });

    const unitQty = custom.unit_quantity || 100000;
    const unitPrice = parseFloat(custom.unit_price || 0.2);
    const minQty = custom.min_quantity || 100000;
    const maxQty = custom.max_quantity || 1000000;

    // 2. تحقق من الكمية ضمن الحدود
    if (parsedQty < minQty || parsedQty > maxQty) {
      return res.send({ success: false, message: `Quantity must be between ${minQty} and ${maxQty}` });
    }

    // 3. حساب السعر الإجمالي
    const blocks = parsedQty / unitQty;
    const totalPrice = parseFloat((blocks * unitPrice).toFixed(2));

    // 4. تحقق من رصيد المستخدم
    const [userData] = await query("SELECT * FROM users WHERE id = ?", [user.id]);
    if (!userData || userData.balance < totalPrice) {
      return res.send({ success: false, message: "Insufficient balance." });
    }

    // 5. تنفيذ الطلب مع DailyCard
    const apiRes = await dailycardAPI.post('/api-keys/place-order', {
      product_id: productId,
      identifier: player_id,
      quantity: parsedQty
    });

    // 6. خصم الرصيد
    await query("UPDATE users SET balance = balance - ? WHERE id = ?", [totalPrice, user.id]);

    // 7. حفظ الطلب
    await query(
      "INSERT INTO orders (user_id, product_name, price, player_id, quantity, source) VALUES (?, ?, ?, ?, ?, 'api')",
      [user.id, custom.custom_name || "BIGO Product", totalPrice, player_id, parsedQty]
    );

    return res.send({ success: true, message: "✅ Order placed successfully!" });

  } catch (error) {
    console.error("❌ Error in /hiyachat-section:", error.response?.data || error.message);
    return res.send({ success: false, message: "Failed to process the order with the provider." });
  }
});



app.get('/hiyachat-section', async (req, res) => {
  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

  try {
    const selectedSql = "SELECT * FROM selected_api_products WHERE active = 1 AND category = 'hiyachat'";
    const selectedProducts = await query(selectedSql);
    const selectedMap = new Map(selectedProducts.map(p => [parseInt(p.product_id), p]));

   const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');


    const apiProducts = await getCachedAPIProducts();


    const finalProducts = apiProducts
      .filter(p => selectedMap.has(p.id))
      .map(p => {
        const custom = selectedMap.get(p.id);
        return {
          id: p.id,
          name: custom.custom_name || p.name,
          image: custom.custom_image || p.image || '/images/default-product.png',
          price: custom.custom_price ? parseFloat(custom.custom_price) : parseFloat(p.price),
          variable_quantity: custom.variable_quantity === 1,
          requires_player_id: p.player_check ? 1 : 0
        };
      });

    res.render('hiyachat-section', {
      user: req.session.user,
      products: finalProducts
    });

  } catch (error) {
    console.error("❌ Error in /hiyachat-section:", error.response?.data || error.message);
    res.status(500).send("Failed to load hiyachat section.");
  }
});



app.get('/jawaker-section', async (req, res) => {
    try {
        const query = (sql, params) => new Promise((resolve, reject) => {
            db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
        });

        // 1. جلب المنتجات المفعلة لفئة pubg فقط
        const customProductsQuery = "SELECT * FROM selected_api_products WHERE active = 1 AND category = 'jawaker'";
        const customProducts = await query(customProductsQuery);

        if (customProducts.length === 0) {
            return res.render('jawaker-section', { user: req.session.user || null, products: [] });
        }

        const customProductMap = new Map(
            customProducts.map(p => [parseInt(p.product_id), p])
        );

        // 2. جلب منتجات DailyCard API
        const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
        const apiProducts = await getCachedAPIProducts();

        // 3. دمج المنتجات
        const finalProducts = apiProducts
            .filter(apiProduct => customProductMap.has(apiProduct.id))
            .map(apiProduct => {
                const customData = customProductMap.get(apiProduct.id);
                return {
                    id: apiProduct.id,
                    name: customData.custom_name || apiProduct.name,
                    price: customData.custom_price !== null ? parseFloat(customData.custom_price) : parseFloat(apiProduct.price),
                    image: customData.custom_image || apiProduct.image || '/images/default-product.png',
                    requires_player_id: apiProduct.player_check ? 1 : 0,
                    source: 'api'
                };
            });

        res.render('jawaker-section', {
            user: req.session.user || null,
            products: finalProducts
        });

    } catch (error) {
        console.error("❌ Error loading jawaker section:", error.message);
        res.render('jawaker-section', {
            user: req.session.user || null,
            products: []
        });
    }
});
app.get('/pubg-section', async (req, res) => {
    try {
        const query = (sql, params) => new Promise((resolve, reject) => {
            db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
        });

        // 1. جلب المنتجات المفعلة لفئة pubg فقط
        const customProductsQuery = "SELECT * FROM selected_api_products WHERE active = 1 AND category = 'pubg'";
        const customProducts = await query(customProductsQuery);

        if (customProducts.length === 0) {
            return res.render('pubg-section', { user: req.session.user || null, products: [] });
        }

        const customProductMap = new Map(
            customProducts.map(p => [parseInt(p.product_id), p])
        );

        // 2. جلب منتجات DailyCard API
        const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
        const apiProducts = await getCachedAPIProducts();

        // 3. دمج المنتجات
        const finalProducts = apiProducts
            .filter(apiProduct => customProductMap.has(apiProduct.id))
            .map(apiProduct => {
                const customData = customProductMap.get(apiProduct.id);
                return {
                    id: apiProduct.id,
                    name: customData.custom_name || apiProduct.name,
                    price: customData.custom_price !== null ? parseFloat(customData.custom_price) : parseFloat(apiProduct.price),
                    image: customData.custom_image || apiProduct.image || '/images/default-product.png',
                    requires_player_id: apiProduct.player_check ? 1 : 0,
                    source: 'api'
                };
            });

        res.render('pubg-section', {
            user: req.session.user || null,
            products: finalProducts
        });

    } catch (error) {
        console.error("❌ Error loading PUBG section:", error.message);
        res.render('pubg-section', {
            user: req.session.user || null,
            products: []
        });
    }
});


app.get('/order-details/:id', (req, res) => {
  const orderId = req.params.id;

  const sql = "SELECT * FROM orders WHERE id = ?";
  db.query(sql, [orderId], (err, rows) => {
    if (err || rows.length === 0) {
      return res.send("❌ Order not found.");
    }

    const order = rows[0];

    const orderData = {
      id: order.id,
      productName: order.productName,
      price: order.price,
      purchaseDate: order.purchaseDate,
      status: order.status,
      order_details: order.order_details || null,
      admin_reply: order.admin_reply || null
    };

    res.render('order-details', { order: orderData });
  });
});


app.get('/order-status/:orderId', (req, res) => {
  const orderId = req.params.orderId;
  res.redirect(`/order-details/${orderId}`);
});

app.get('/db-test', (req, res) => {
  const sql = "SELECT 1";
  db.query(sql, (err, result) => {
    if (err) return res.send("❌ DB FAILED: " + err.message);
    res.send("✅ DB OK!");
  });
});
app.get("/", (req, res) => {
  res.send("✅ الموقع شغال!");
});


// =============================================
//                  START SERVER
// =============================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);



   console.log("🔑 API KEY:", process.env.DAILYCARD_API_KEY ? "Loaded" : "Missing");
console.log("🔐 API SECRET:", process.env.DAILYCARD_API_SECRET ? "Loaded" : "Missing");

console.log("✅ Test route registered at /test");
});

