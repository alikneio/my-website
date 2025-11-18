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
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');
// 🔽 عدّل هول:
const { getSmmServices, createSmmOrder } = require('./services/smmgen');
// (رح نرجع لـ syncSMM بعد شوي)
const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
const sendOrderStatusTelegram = require('./utils/sendOrderStatusTelegram');
const sendTelegramMessage = require('./utils/sendTelegramNotification');
const uploadNone = multer();
require('./telegram/saveChatId');





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

const { pool: db, promisePool, query } = require('./database');
const makeSyncSMMJob = require('./jobs/syncSMM');
const syncSMM = makeSyncSMMJob(db, promisePool);







// ... (باقي الكود مثل app.use و المسارات)

app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Important for API routes
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

// خلف Proxy (Railway/NGINX) لازم نثق بالـ proxy للـ secure cookies
app.set('trust proxy', 1);

const isProd = process.env.NODE_ENV === 'production';

// إعدادات MySQLStore
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),   // تأكد أنها رقم
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // createDatabaseTable: true,       // اختياري: ينشئ جدول الجلسات تلقائياً إذا مش موجود
  // schema: { tableName: 'sessions' } // اختياري: اسم الجدول
});

// تفعيل الجلسات باستخدام MySQLStore
app.use(session({
  name: process.env.SESSION_NAME || 'akcell_sid',
  secret: process.env.SESSION_SECRET,      // ⚠️ لازم تضيفه في .env
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24,           // يوم
    httpOnly: true,                         // يمنع الوصول من الجافاسكربت
    sameSite: 'lax',                        // جيّد لمعظم الحالات (عدّل لـ 'none' مع secure لو عندك cross-site)
    secure: isProd                          // true فقط على https (production)
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

function withTimeout(promise, ms = 4000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram timeout')), ms))
  ]);
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


const { isMaintenance, MAINT_START, MAINT_END, MAINT_TZ } = require('./utils/maintenance');

// مسارات/طلبات بنستثنيها من الصيانة (صحة، ستاتيك، أدمن اختياري)
const EXEMPT = [
  /^\/healthz$/,
  /^\/css\//, /^\/js\//, /^\/images\//, /^\/assets\//,
  /^\/favicon\.ico$/,
  // إذا بدك تسمح للأدمن يفتح دايمًا، فعّل هالسطر:
   /^\/admin/,
];

app.use((req, res, next) => {
  if (EXEMPT.some(rx => rx.test(req.path))) return next();

  if (isMaintenance()) {
    // لو طلب JSON أو XHR رجّع JSON 503
    const wantsJSON =
      req.xhr ||
      req.headers.accept?.includes('application/json') ||
      req.path.startsWith('/api');

    if (wantsJSON) {
      return res.status(503).json({
        success: false,
        message: 'Service under scheduled maintenance. Please try again later.',
        maintenance: { tz: MAINT_TZ, fromHour: MAINT_START, toHour: MAINT_END }
      });
    }

    // صفحة صيانة جميلة
    return res.status(503).render('maintenance', {
      tz: MAINT_TZ,
      fromHour: MAINT_START.toString().padStart(2, '0') + ':00',
      toHour: MAINT_END.toString().padStart(2, '0') + ':00'
    });
  }

  next();
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
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const adminChatId = '2096387191';
      const username = req.session.user.username;

      let msg = `📥 *New Balance Top-up Request*\n\n` +
                `👤 User: ${username}\n` +
                `💰 Amount: ${amount} ${currency}`;

      if (proofImage) {
        const imageUrl = `https://akcell.store/uploads/whish/${proofImage}`;
 
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
      const botToken = process.env.TELEGRAM_BOT_TOKEN;;
      const adminChatId = '2096387191';
      const username = req.session.user.username;

      let msg = `📥 *New Balance Top-up Request*\n\n` +
                `👤 User: ${username}\n` +
                `💰 Amount: ${amount} ${currency}`;

      if (proofImage) {
       const imageUrl = `https://akcell.store/uploads/whish/${proofImage}`;

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


// ====== Games: list categories ======
app.get('/games', async (req, res) => {
  const q = (sql, p = []) =>
    new Promise((ok, no) => db.query(sql, p, (e, r) => (e ? no(e) : ok(r))));

  try {
    const rows = await q(
      `
      SELECT
        c.id,
        c.label,
        c.slug,
        c.image AS image_url,
        c.sort_order,
        c.active,
        COUNT(sap.product_id) AS products_count
      FROM api_categories c
      LEFT JOIN selected_api_products sap
        ON sap.category = c.slug AND sap.active = 1
      WHERE c.active = 1 AND c.section = 'games'
      GROUP BY c.id, c.label, c.slug, c.image, c.sort_order, c.active
      ORDER BY c.sort_order ASC, c.label ASC
      `
    );

    res.render('games', {
      user: req.session.user || null,
      categories: rows.map(c => ({
        ...c,
        image_url: c.image_url || '/images/default-category.png',
      })),
    });
  } catch (err) {
    console.error('Load /games error:', err);
    res.status(500).send('Failed to load games categories');
  }
});

// ====== Games: products in a single category ======
app.get('/games/:slug', async (req, res) => {
  const { slug } = req.params;
  const q = (sql, p = []) =>
    new Promise((ok, no) => db.query(sql, p, (e, r) => (e ? no(e) : ok(r))));

  try {
    // 1) تأكيد الكاتيجوري
    const [category] = await q(
      `
      SELECT id, label, slug, image AS image_url
      FROM api_categories
      WHERE slug = ? AND active = 1 AND section = 'games'
      LIMIT 1
      `,
      [slug]
    );
    if (!category) return res.status(404).send('Category not found');

    // 2) إعدادات المنتجات المختارة
    const selected = await q(
      `SELECT * FROM selected_api_products WHERE active = 1 AND category = ?`,
      [slug]
    );
    const map = new Map(selected.map(p => [Number(p.product_id), p]));

    // 3) منتجات المزود (الكاش)
    const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
    const apiProducts = await getCachedAPIProducts();

    // 4) نجهز الداتا للعرض
    const products = apiProducts
      .filter(p => map.has(p.id))
      .map(p => {
        const c = map.get(p.id);
        const isQty = c.variable_quantity === 1;
        return {
          id: p.id,
          name: c.custom_name || p.name,
          image: c.custom_image || p.image || '/images/default-product.png',
          price: isQty ? null : Number(c.custom_price || p.price),
          variable_quantity: isQty,
          requires_player_id: (c.player_check ?? p.player_check) ? 1 : 0,
          is_out_of_stock: c.is_out_of_stock === 1,
        };
      });

    res.render('api-category-list', {
      user: req.session.user || null,
      category: {
        ...category,
        image_url: category.image_url || '/images/default-category.png',
      },
      products,
    });
  } catch (err) {
    console.error('Load /games/:slug error:', err);
    res.status(500).send('Failed to load category products');
  }
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

app.get('/giftcards', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Gift Cards'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('giftcards', { 
            user: req.session.user || null,
            products: products
        });
    });
});


// قائمة الأقسام (تظهر للزائر)
// صفحة اختيار الخدمة (Accounts / Apps)
app.get('/apps-section', async (req, res) => {
  const q = (sql, p = []) => new Promise((ok, no) => db.query(sql, p, (e, r) => e ? no(e) : ok(r)));
  try {
    const categories = await q(`
      SELECT
        c.id,
        c.label,
        c.slug,
        c.image AS image_url,
        c.sort_order,
        c.active,
        COUNT(sap.product_id) AS products_count
      FROM api_categories c
      LEFT JOIN selected_api_products sap
        ON sap.category = c.slug AND sap.active = 1
      WHERE c.active = 1 AND c.section = 'apps'
      GROUP BY c.id, c.label, c.slug, c.image, c.sort_order, c.active
      ORDER BY c.sort_order ASC, c.label ASC
    `);

    res.render('apps-section', {
      user: req.session.user || null,
      categories: categories.map(c => ({
        ...c,
        image_url: c.image_url || '/images/default-category.png'
      }))
    });
  } catch (err) {
    console.error('Load /apps-section error:', err);
    res.status(500).send('Failed to load apps categories');
  }
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

app.get('/windows-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Windows key'";
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('windows-section', {
            user: req.session.user || null,
            products: products
        });
    });
});

app.get('/office-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Microsoft office keys'";
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('office-section', {
            user: req.session.user || null,
            products: products
        });
    });
});




app.get('/cyberghost', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'Cyber Ghost'";
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('cyberghost', {
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
app.get('/iptv-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE sub_category = 'IPTV'";
    db.query(sql, [], (err, products) => {
        if (err) throw err;
        res.render('iptv-section', {
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


app.get('/u-share', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Communication' AND sub_category = 'Alfa U-share'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('u-share', { 
            user: req.session.user || null,
            products: products
        });
    });
});




// --- صفحات أخرى ---
// My Orders (with filters, totals, counters, pagination)
// === REPLACE your current /my-orders route with this ===
app.get('/my-orders', checkAuth, (req, res) => {
  const userId = req.session.user.id;

  // read filters (all optional)
  const from   = (req.query.from || '').trim();    // yyyy-mm-dd
  const to     = (req.query.to   || '').trim();    // yyyy-mm-dd
  const q      = (req.query.q    || '').trim();
  const status = (req.query.status || 'all').trim(); // all | Accepted | Waiting | Rejected

  let sql = `SELECT * FROM orders WHERE userId = ?`;
  const params = [userId];

  // add clauses ONLY when provided
  if (from) {
    sql += ` AND purchaseDate >= ?`;
    params.push(new Date(from));
  }
  if (to) {
    // include the "to" day fully
    sql += ` AND purchaseDate < DATE_ADD(?, INTERVAL 1 DAY)`;
    params.push(new Date(to));
  }
  if (status && status !== 'all') {
    sql += ` AND status = ?`;
    params.push(status);
  }
  if (q) {
    // search by numeric id OR product name
    const idCandidate = Number.isFinite(+q) ? +q : -1;
    sql += ` AND (id = ? OR productName LIKE ?)`;
    params.push(idCandidate, `%${q}%`);
  }

  sql += ` ORDER BY purchaseDate DESC`;

  db.query(sql, params, (err, orders = []) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send('Error loading orders.');
    }
    const total = orders.reduce((s, o) => s + (parseFloat(o.price) || 0), 0);

    // pass filters back to the view to keep form state
    res.render('my-orders', {
      user: req.session.user,
      orders,
      total,
      filters: { from, to, q, status }
    });
  });
});



app.get('/checkout/:id', checkAuth, (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const error = req.query.error || null;

  // إذا عندك عمود active بالجدول، استعمله. إذا ما عندك، رجّع للسطر القديم:
  const sql = "SELECT * FROM products WHERE id = ? /* AND active = 1 */";

  db.query(sql, [productId], (err, results) => {
    if (err || !results || results.length === 0) {
      return res.status(404).send('❌ Product not found.');
    }

    const product = results[0];
    product.source = 'sql';

    // (اختياري) لو عندك عمود is_out_of_stock بالجدول
    if (Object.prototype.hasOwnProperty.call(product, 'is_out_of_stock')) {
      const oos = Number(product.is_out_of_stock) === 1 || product.is_out_of_stock === true;
      if (oos) {
        return res.status(403).send('This product is currently out of stock.');
      }
    }

    // رسائل الخطأ
    let errorMessage = '';
    if (error === 'balance') {
      errorMessage = 'Insufficient balance.';
    } else if (error === 'server') {
      errorMessage = 'Server error during purchase. Please try again.';
    }

    // ملاحظات المنتج
    const notes = (product.notes && String(product.notes).trim() !== '') ? String(product.notes).trim() : null;

    // ✅ ولادة idempotency key وتمريره للواجهة
    const idemKey = uuidv4();
    req.session.idemKey = idemKey;

    return res.render('checkout', {
      user: req.session.user || null,
      product,
      error: errorMessage,
      notes,
      idemKey              // ← مهم: استعمله hidden input بالـ EJS
    });
  });
});




app.get('/api-checkout/:id', checkAuth, async (req, res) => {
  const productId = parseInt(req.params.id, 10);

  const query = (sql, params) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    // 1) جلب المنتج
    const sqlSel = "SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1";
    const results = await query(sqlSel, [productId]);
    const error = req.query.error || null;

    if (results.length === 0) {
      return res.status(404).send("❌ Product not found or not activated.");
    }

    const product = results[0];

    // ✅ منع العرض لو Out of Stock
    if (Number(product.is_out_of_stock) === 1) {
      return res.status(403).send('This product is currently out of stock.');
    }

    // 2) تجهيز الداتا
    const isQuantity = Number(product.variable_quantity) === 1;

    const unitQty = isQuantity ? Math.max(parseInt(product.unit_quantity || 1, 10) || 1, 1) : undefined;
    const minQty  = isQuantity ? parseInt(product.min_quantity || 1, 10) || 1 : undefined;
    const maxQty  = isQuantity ? parseInt(product.max_quantity || 999999, 10) || 999999 : undefined;

    const unitPriceNum = parseFloat(product.custom_price || product.unit_price || 0) || 0;

    const productData = {
      id: product.product_id,
      name: product.custom_name || 'API Product',
      image: product.custom_image || '/images/default-product.png',
      price: isQuantity ? null : unitPriceNum.toFixed(2),
      unit_price: isQuantity ? unitPriceNum : undefined,
      unit_quantity: unitQty,
      min_quantity: minQty,
      max_quantity: maxQty,
      requires_player_id: Number(product.player_check) === 1,
      requires_verification: Number(product.requires_verification) === 1,
      variable_quantity: isQuantity,
      unit_label: isQuantity ? (product.unit_label || 'units') : undefined,
    };

    // 2.1) حساب أقل كلفة لازمة للطلب (minCost) + canVerify
    const floor = Number(process.env.VERIFY_BALANCE_FLOOR || 0) || 0;
    let minCost = 0;

    if (isQuantity) {
      const uPrice = Number(product.unit_price) || 0;
      const uQty   = Math.max(1, parseInt(product.unit_quantity || 1, 10));
      const mQty   = Math.max(1, parseInt(product.min_quantity || 1, 10));
      const blocks = Math.ceil(mQty / uQty);
      minCost = parseFloat((blocks * uPrice).toFixed(2));
    } else {
      minCost = Number(product.custom_price || product.unit_price || 0) || 0;
      if (minCost === 0) {
        try {
          const list = await getCachedAPIProducts();
          const apiItem = list.find(p => Number(p.id) === Number(productId));
          if (apiItem) minCost = Number(apiItem.price) || 0;
        } catch (_) { /* ignore */ }
      }
    }
    minCost = Math.max(minCost, floor);

    const userBalance = Number(req.session.user?.balance || 0);
    const canVerify = userBalance >= minCost;

    // 3) ولادة idempotency_key وتمريره للواجهة
    const idemKey = uuidv4();
    req.session.idemKey = idemKey; // لتتبع آخر مفتاح تولّد لهالزيارة

    const viewData = {
      user: req.session.user || null,
      product: productData,
      error,
      minCost,
      canVerify,
      idemKey,                 // << مهم: يُستخدم بالـ form كـ hidden input
    };

    if (isQuantity) {
      return res.render('api-checkout-quantity', viewData);
    } else {
      return res.render('api-checkout-fixed', viewData);
    }

  } catch (error) {
    console.error("❌ Error in /api-checkout/:id:", error.stack || error.message);
    res.status(500).send("Internal Server Error");
  }
});


app.get("/admin/smm/sync", checkAdmin, async (req, res) => {
  try {
    console.log("🔄 Sync SMM Services Started...");

    const services = await getSmmServices();
    console.log(`📦 Received ${services.length} services.`);

    const insertSql = `
      INSERT INTO smm_services
        (provider_service_id, name, category, type, rate, min_qty, max_qty, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name      = VALUES(name),
        category  = VALUES(category),
        type      = VALUES(type),
        rate      = VALUES(rate),
        min_qty   = VALUES(min_qty),
        max_qty   = VALUES(max_qty),
        is_active = VALUES(is_active)
    `;

    for (const s of services) {
      const params = [
        s.service,                 // provider_service_id
        s.name,                    // name
        s.category || "Other",     // category
        s.type || "default",       // type
        s.rate,                    // rate
        s.min,                     // min_qty
        s.max,                     // max_qty
        1                          // is_active
      ];

      db.query(insertSql, params);
    }

    res.send("✔️ Synced with SMM Provider");
  } catch (err) {
    console.error("❌ SMM Sync Error:", err);
    res.status(500).send("Sync Error");
  }
});


// =============== SOCIAL MEDIA SERVICES (SMMGEN) ===============

app.get('/social-media', (req, res) => {
  const sql = `
    SELECT
      c.id,
      c.name,
      c.slug,
      c.is_active,
      COUNT(s.id) AS services_count
    FROM smm_categories c
    LEFT JOIN smm_services s
      ON s.smm_category_id = c.id
     AND s.is_active = 1
    WHERE c.is_active = 1
    GROUP BY c.id, c.name, c.slug, c.is_active
    HAVING services_count > 0
    ORDER BY c.sort_order ASC, c.name ASC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error('❌ /social-media error:', err.message);
      return res.status(500).send('Server error');
    }

    res.render('social-categories', {
      user: req.session.user || null,
      categories: rows
    });
  });
});

app.get('/social-media/:slug', (req, res) => {
  const { slug } = req.params;

  const sql = `
    SELECT
      c.id            AS cat_id,
      c.name          AS cat_name,
      c.slug          AS cat_slug,
      c.is_active     AS cat_active,
      s.*
    FROM smm_categories c
    LEFT JOIN smm_services s
      ON s.smm_category_id = c.id
     AND s.is_active = 1
    WHERE c.slug = ?
    ORDER BY s.name ASC
  `;

  db.query(sql, [slug], (err, rows) => {
    if (err) {
      console.error('❌ /social-media/:slug error:', err.message);
      return res.status(500).send('Server error');
    }

    if (!rows.length) {
      return res.status(404).send('Category not found or has no services.');
    }

    const cat = rows[0];

    // فلتر الخدمات لو في صفوف بدون خدمة (بسبب LEFT JOIN)
    const services = rows.filter(r => r.id); // s.id

    if (!services.length) {
      return res.status(404).send('Category not found or has no services.');
    }

    res.render('social-services', {
      user: req.session.user || null,
      categoryName: cat.cat_name,
      categorySlug: cat.cat_slug,
      services
    });
  });
});




// لستة الخدمات ضمن كاتيجوري واحد
app.get('/social-media/:slug', async (req, res) => {
  const q = (sql, p = []) =>
    new Promise((ok, no) => db.query(sql, p, (e, r) => e ? no(e) : ok(r)));

  const { slug } = req.params;

  try {
    const rows = await q(
      `SELECT * FROM smm_services WHERE is_active = 1 ORDER BY name ASC`
    );

    // فلترة بالـ JS حسب slugify(category)
    const services = rows.filter(s => slugify(s.category || '') === slug);

    if (!services.length) {
      return res.status(404).send('Category not found or has no services.');
    }

    const categoryName = services[0].category;

    res.render('social-services', {
      user: req.session.user || null,
      categoryName,
      categorySlug: slug,
      services
    });
  } catch (e) {
    console.error('❌ /social-media/:slug error:', e.message);
    res.status(500).send('Server error loading social services.');
  }
});



app.get('/social-checkout/:id', checkAuth, (req, res) => {
  const serviceId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serviceId)) {
    return res.status(400).send('Invalid service ID');
  }

  const sql = `SELECT * FROM smm_services WHERE id = ? AND is_active = 1`;
  db.query(sql, [serviceId], (err, rows) => {
    if (err || !rows.length) {
      console.error('❌ social-checkout error:', err?.message);
      return res.status(404).send('Service not found.');
    }

    const service = rows[0];

    // 🔑 نولّد مفتاح عدم التكرار ونخزّنه بالسيشن
    const idemKey = uuidv4();
    req.session.idemKey = idemKey;

    res.render('social-checkout', {
      user: req.session.user,
      service,
      idemKey         // 👈 هيدا اللي كان ناقص
    });
  });
});


app.post('/buy-social', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  // من الـ form ممكن يجي الاسم service_id أو serviceId حسب الـ EJS
  const {
    service_id,
    serviceId,
    link,
    quantity,
    idempotency_key: rawIdemKey,
  } = req.body;

  const serviceIdNum = parseInt(service_id || serviceId, 10);
  const qty = parseInt(quantity, 10);

  const idemKey = (rawIdemKey || req.session.idemKey || '')
    .toString()
    .slice(0, 64);

  const query = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    // 0) Idempotency
    if (idemKey) {
      try {
        await query(
          `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
          [userId, idemKey]
        );
      } catch (e) {
        // المفتاح مستعمل سابقًا → لا خصم جديد ولا طلب جديد
        req.session.pendingOrderId = req.session.pendingOrderId || null;
        return res.redirect('/processing');
      }
    }

    // 1) تحقق أساسي من المدخلات
    if (!serviceIdNum || !link || !quantity) {
      return res.redirect('/social-media?error=missing_fields');
    }

    if (!Number.isFinite(qty) || qty <= 0) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=invalid_quantity`);
    }

    // 2) جلب الخدمة من DB
    const [service] = await query(
      `SELECT * FROM smm_services WHERE id = ? AND is_active = 1`,
      [serviceIdNum]
    );

    if (!service) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=service_not_found`);
    }

    // 3) تحقق من min / max
    const minQty = Number(service.min_qty || 0);
    const maxQty = Number(service.max_qty || 0);

    if ((minQty && qty < minQty) || (maxQty && qty > maxQty)) {
      return res.redirect(
        `/social-checkout/${serviceIdNum}?error=range&min=${minQty}&max=${maxQty}`
      );
    }

    // 4) السعر (rate per 1000)
    const rate = Number(service.rate || 0); // مثال: 0.90 لكل 1000
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=pricing`);
    }

    // totalCents = round(qty * rate * 100 / 1000)
    const totalCents = Math.round((qty * rate * 100) / 1000);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=pricing`);
    }
    const total = totalCents / 100; // DECIMAL(10,2)

    // 5) خصم ذري من الرصيد
    const upd = await query(
      `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
      [total, userId, total]
    );
    if (!upd?.affectedRows) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=balance`);
    }

    // 6) تسجيل معاملة الخصم
    await query(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'debit', ?, ?)`,
      [userId, total, `Social Media Service: ${service.name}`]
    );

    // 7) إنشاء الطلب عند المزود SMMGEN
    let providerOrderId = null;
    try {
      providerOrderId = await createSmmOrder({
        service: service.provider_service_id, // من جدول smm_services
        link,
        quantity: qty,
      });
    } catch (apiErr) {
      console.error('❌ SMMGEN API error:', apiErr.message || apiErr);

      // Refund
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [
        total,
        userId,
      ]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund (SMMGEN error): ${service.name}`]
      );

      return res.redirect(
        `/social-checkout/${serviceIdNum}?error=provider&msg=${encodeURIComponent(
          apiErr.message || 'Provider error'
        )}`
      );
    }

    if (!providerOrderId) {
      // Refund إذا ما رجع ID
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [
        total,
        userId,
      ]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund (no provider id): ${service.name}`]
      );
      return res.redirect(`/social-checkout/${serviceIdNum}?error=no_provider_id`);
    }

    // 8) حفظ الطلب في جدول orders (العام)
    const orderDetails = `Link: ${link} | Quantity: ${qty}`;

    const insertOrderSql = `
      INSERT INTO orders
        (userId, productName, price, purchaseDate, order_details, status,
         provider_order_id, provider, source${idemKey ? ', client_token' : ''})
      VALUES
        (?, ?, ?, NOW(), ?, 'Waiting', ?, 'smmgen', 'smm'${idemKey ? ', ?' : ''})
    `;

    const insertParams = [
      userId,
      service.name,
      total,
      orderDetails,
      providerOrderId,
    ];
    if (idemKey) insertParams.push(idemKey);

    const insertRes = await query(insertOrderSql, insertParams);
    const orderId = insertRes.insertId || insertRes?.[0]?.insertId || null;

    // 9) حفظ في جدول smm_orders (اختياري لكنه مفيد للـ sync)
    await query(
      `
      INSERT INTO smm_orders
        (user_id, smm_service_id, provider_order_id, status, quantity, charge, link)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `,
      [userId, service.id, providerOrderId, qty, total, link]
    );

    // 10) إشعار داخلي
    await query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [
        userId,
        `✅ تم استلام طلب خدمتك (${service.name}) بنجاح. سيتم تنفيذها قريبًا.`,
      ]
    );

    // 11) تيليغرام
    const [userRow] = await query(
      `SELECT username, telegram_chat_id FROM users WHERE id = ?`,
      [userId]
    );

    if (userRow?.telegram_chat_id) {
      await sendTelegramMessage(
        userRow.telegram_chat_id,
        `📥 <b>تم استلام طلب خدمتك للسوشيال ميديا</b>\n\n🛍️ <b>الخدمة:</b> ${
          service.name
        }\n🔗 <b>الرابط:</b> ${link}\n🔢 <b>الكمية:</b> ${qty}\n💰 <b>السعر:</b> ${total}$\n📌 <b>الحالة:</b> جاري المعالجة`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 طلب Social Media جديد!\n👤 الزبون: ${
          userRow?.username
        }\n🛍️ الخدمة: ${service.name}\n🔢 الكمية: ${qty}\n💰 السعر: ${total}$\n🔗 الرابط: ${link}\n🕓 الوقت: ${new Date().toLocaleString(
          'en-US',
          { hour12: false }
        )}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // 12) تجربة موحدة
    req.session.pendingOrderId = orderId;
    return res.redirect('/processing');
  } catch (err) {
    console.error('❌ /buy-social error:', err?.response?.data || err.message || err);
    return res.redirect(`/social-checkout/${serviceIdNum}?error=server`);
  }
});



// =============================================
//                  ACTION ROUTES
// =============================================

const bcrypt = require('bcrypt'); // <-- أضف هذا السطر في أعلى ملف server.js
const saltRounds = 10; // درجة تعقيد التشفير



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
    await promisePool.query(`
      UPDATE balance_requests
      SET status = ?, admin_note = ?
      WHERE id = ?
    `, [status, admin_note || null, requestId]);

    // جلب معلومات الطلب كاملة
    const [rows] = await promisePool.query(`
      SELECT br.amount, br.currency, br.user_id, u.telegram_chat_id
      FROM balance_requests br
      JOIN users u ON br.user_id = u.id
      WHERE br.id = ?
    `, [requestId]);

    if (reqRows.length === 0) return res.redirect('/admin/balance-requests');

    const { amount, currency, telegram_chat_id: chatId } = reqRows[0];
    if (!chatId) return res.redirect('/admin/balance-requests');

    const botToken = process.env.TELEGRAM_BOT_TOKEN;;
    
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

app.get('/admin/dev/sync-smm', checkAdmin, async (req, res) => {
  try {
    await syncSMM();
    res.send("✅ SMM Services Synced Successfully");
  } catch (err) {
    res.status(500).send("❌ Sync Failed");
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

// =============== ADMIN - SMM SERVICES ===============
const adminQ = (sql, params = []) =>
  new Promise((ok, no) => db.query(sql, params, (e, r) => (e ? no(e) : ok(r))));

// لستة الخدمات مع فلترة بسيطة
app.get('/admin/smm-services', checkAdmin, (req, res) => {
  const { q, category_id, status } = req.query;

  const params = [];
  let sql = `
    SELECT
      s.*,
      c.name AS smm_category_name
    FROM smm_services s
    LEFT JOIN smm_categories c
      ON c.id = s.smm_category_id
    WHERE 1=1
  `;

  if (category_id && category_id !== 'all') {
    sql += ' AND s.smm_category_id = ?';
    params.push(parseInt(category_id, 10) || 0);
  }

  if (status === 'active') {
    sql += ' AND s.is_active = 1';
  } else if (status === 'disabled') {
    sql += ' AND s.is_active = 0';
  }

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    sql += ' AND (s.name LIKE ? OR s.category LIKE ? OR s.provider_service_id = ?)';
    params.push(term, term, q.trim());
  }

  sql += ' ORDER BY s.id DESC LIMIT 200'; // حد 200 عشان الأداء

  db.query(sql, params, (err, services) => {
    if (err) {
      console.error('❌ /admin/smm-services error:', err.message);
      return res.status(500).send('DB error');
    }

    db.query(
      'SELECT id, name FROM smm_categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC',
      (err2, categories) => {
        if (err2) {
          console.error('❌ load smm_categories in admin:', err2.message);
          return res.status(500).send('DB error');
        }

        res.render('admin-smm-services', {
          user: req.session.user,
          services,
          categories,
          filters: {
            q: q || '',
            category_id: category_id || 'all',
            status: status || 'all'
          }
        });
      }
    );
  });
});
// ADMIN – SMM CATEGORIES
app.get('/admin/smm-categories', checkAdmin, (req, res) => {
  db.query(
    'SELECT * FROM smm_categories ORDER BY sort_order ASC, name ASC',
    (err, rows) => {
      if (err) {
        console.error('❌ /admin/smm-categories error:', err.message);
        return res.status(500).send('DB error');
      }
      res.render('admin-smm-categories', {
        user: req.session.user,
        categories: rows
      });
    }
  );
});

app.post('/admin/smm-categories/create', checkAdmin, (req, res) => {
  const { name, sort_order } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/admin/smm-categories?error=name');
  }

  const slug = slugify(name, { lower: true, strict: true }).slice(0, 190);
  const sort = parseInt(sort_order || '0', 10) || 0;

  db.query(
    'INSERT INTO smm_categories (name, slug, sort_order) VALUES (?, ?, ?)',
    [name.trim(), slug, sort],
    err => {
      if (err) {
        console.error('❌ create smm_category:', err.message);
      }
      res.redirect('/admin/smm-categories');
    }
  );
});


app.post('/admin/smm-categories/:id/update', checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, sort_order } = req.body;
  if (!Number.isFinite(id)) return res.redirect('/admin/smm-categories');

  const slug = slugify(name || '', { lower: true, strict: true }).slice(0, 190);
  const sort = parseInt(sort_order || '0', 10) || 0;

  db.query(
    'UPDATE smm_categories SET name = ?, slug = ?, sort_order = ? WHERE id = ?',
    [name.trim(), slug, sort, id],
    err => {
      if (err) {
        console.error('❌ update smm_category:', err.message);
      }
      res.redirect('/admin/smm-categories');
    }
  );
});

app.post('/admin/smm-categories/:id/toggle', checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect('/admin/smm-categories');

  db.query(
    'UPDATE smm_categories SET is_active = 1 - is_active WHERE id = ?',
    [id],
    err => {
      if (err) {
        console.error('❌ toggle smm_category:', err.message);
      }
      res.redirect('/admin/smm-categories');
    }
  );
});



// bulk enable/disable لكل الخدمات ضمن كاتيجوري معيّنة
app.post('/admin/smm-services/bulk-category', checkAdmin, (req, res) => {
  const { category, action } = req.body;

  if (!category || !['enable', 'disable'].includes(action)) {
    req.session.flash = { type: 'danger', msg: 'Invalid bulk action.' };
    return res.redirect('/admin/smm-services');
  }

  const isActive = action === 'enable' ? 1 : 0;

  db.query(
    'UPDATE smm_services SET is_active = ? WHERE category = ?',
    [isActive, category],
    (err, result) => {
      if (err) {
        console.error('Admin SMM bulk-category error:', err.message);
        req.session.flash = { type: 'danger', msg: 'Bulk update failed.' };
        return res.redirect('/admin/smm-services');
      }

      req.session.flash = {
        type: 'success',
        msg: `Category "${category}" updated (${result.affectedRows} services).`
      };
      res.redirect('/admin/smm-services?cat=' + encodeURIComponent(category));
    }
  );
});


// فورم تعديل خدمة
app.get('/admin/smm-services/:id/edit', checkAdmin, async (req, res) => {
  try {
    const [service] = await adminQ(
      `SELECT * FROM smm_services WHERE id = ?`,
      [req.params.id]
    );
    if (!service) return res.status(404).send('Service not found');

    res.render('admin-smm-service-form', {
      user: req.session.user || null,
      service,
      flash: req.session.flash || null
    });
    req.session.flash = null;
  } catch (e) {
    console.error('Admin SMM edit form error:', e);
    res.status(500).send('Failed to load edit form');
  }
});

// حفظ التعديل
app.post('/admin/smm-services/:id/edit', checkAdmin, async (req, res) => {
  try {
    const {
      name,
      category,
      type,
      rate,
      min_qty,
      max_qty,
      description,
      is_active
    } = req.body;

    await adminQ(
      `
        UPDATE smm_services
        SET
          name = ?,
          category = ?,
          type = ?,
          rate = ?,
          min_qty = ?,
          max_qty = ?,
          description = ?,
          is_active = ?
        WHERE id = ?
      `,
      [
        name || '',
        category || '',
        type || null,
        Number(rate) || 0,
        Number(min_qty) || 0,
        Number(max_qty) || 0,
        description || null,
        is_active ? 1 : 0,
        req.params.id
      ]
    );

    req.session.flash = { type: 'success', msg: 'Service updated successfully.' };
    res.redirect('/admin/smm-services');
  } catch (e) {
    console.error('Admin SMM update error:', e);
    req.session.flash = { type: 'danger', msg: 'Failed to update service.' };
    res.redirect(`/admin/smm-services/${req.params.id}/edit`);
  }
});

// تحديث خدمة واحدة (اسم / ريت / مين / ماكس / كاتيجوري)
app.post('/admin/smm-services/:id/update', checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.redirect('/admin/smm-services');

  const {
    name,
    rate,
    min_qty,
    max_qty,
    smm_category_id
  } = req.body;

  const catId = smm_category_id && smm_category_id !== 'null'
    ? parseInt(smm_category_id, 10)
    : null;

  const sql = `
    UPDATE smm_services
    SET
      name = ?,
      rate = ?,
      min_qty = ?,
      max_qty = ?,
      smm_category_id = ?
    WHERE id = ?
  `;

  db.query(
    sql,
    [
      name || '',
      Number(rate || 0),
      parseInt(min_qty || '0', 10) || 0,
      parseInt(max_qty || '0', 10) || 0,
      catId,
      id
    ],
    err => {
      if (err) {
        console.error('❌ update smm_service:', err.message);
      }
      res.redirect('/admin/smm-services');
    }
  );
});


// تفعيل / تعطيل سريع
app.post('/admin/smm-services/:id/toggle', checkAdmin, async (req, res) => {
  try {
    await adminQ(
      `UPDATE smm_services
       SET is_active = IF(is_active = 1, 0, 1)
       WHERE id = ?`,
      [req.params.id]
    );
    res.redirect('/admin/smm-services');
  } catch (e) {
    console.error('Admin SMM toggle error:', e);
    res.status(500).send('Toggle failed');
  }
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


// ✅ تحقّق اللاعب: مسموح فقط إذا الرصيد ≥ أقل كلفة للطلب
app.post('/verify-player', checkAuth, async (req, res) => {
  const { player_id, product_id } = req.body;
  const userId = req.session.user?.id;

  if (!player_id || !product_id) {
    return res.status(400).json({ success: false, message: "Missing player_id or product_id" });
  }

  try {
    // جِب المستخدم + رصيده
    const [userRow] = await promisePool.query(
      "SELECT balance FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    const userBalance = parseFloat(userRow?.[0]?.balance || 0);

    // جِب إعدادات المنتج المختار (لو موجودة)
    const [selRows] = await promisePool.query(
      "SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1 LIMIT 1",
      [product_id]
    );
    const sel = selRows?.[0];

    // لو ما في تخصيص، استعن بالكاش تبع المزود
    let apiPrice = 0, productType = 'package';
    if (!sel) {
      const list = await getCachedAPIProducts();
      const p = list.find(x => Number(x.id) === Number(product_id));
      if (p) {
        apiPrice = parseFloat(p.price || 0) || 0;
        productType = p.product_type || 'package';
      }
    }

    // احسب أقل كلفة لازمة للطلب
    let minCost = 0;

    if (sel && Number(sel.variable_quantity) === 1) {
      // كمية متغيرة
      const unitPrice = Number(sel.unit_price) || 0;
      const unitQty   = Math.max(1, parseInt(sel.unit_quantity || 1, 10));
      const minQty    = Math.max(1, parseInt(sel.min_quantity || 1, 10));
      const blocks    = Math.ceil(minQty / unitQty);
      minCost = parseFloat((blocks * unitPrice).toFixed(2));
    } else if (sel) {
      // سعر ثابت
      minCost = Number(sel.custom_price || sel.unit_price || apiPrice || 0) || 0;
    } else {
      // ما عندي تخصيص؟ خُد سعر المزود (ثابت)
      minCost = apiPrice;
    }

    // خيار إضافي: أرضية دنيا من .env لو بدك (افتراضي 0)
    const floor = Number(process.env.VERIFY_BALANCE_FLOOR || 0) || 0;
    minCost = Math.max(minCost, floor);

    if (userBalance < minCost) {
      return res.status(403).json({
        success: false,
        reason: 'balance',
        message: `You need at least $${minCost.toFixed(2)} to verify this ID.`
      });
    }

    // ✅ مسموح… كمّل التحقق من المزود
    const result = await verifyPlayerId(product_id, player_id);
    if (result.success === true || result.success === "true") {
      return res.json({
        success: true,
        message: "Player ID is valid.",
        player_name: result.player_name || ""
      });
    } else {
      return res.json({
        success: false,
        message: result.message || "Invalid Player ID."
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


// GET /search/json?q=...
app.get('/search/json', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    const like = `%${q}%`;

    // 1) SQL products
    const sqlProducts = await query(
      `SELECT 
         id,
         name,
         price,
         image,
         main_category AS category,
         sub_category AS subcategory
       FROM products
       WHERE name LIKE ? OR sub_category LIKE ? OR main_category LIKE ?
       LIMIT 100`,
      [like, like, like]
    );

    // 2) API (selected_api_products الفعّالة)
    const apiCustom = await query(
      `SELECT 
         product_id AS id,
         COALESCE(custom_name, NULL) AS custom_name,
         custom_price, custom_image, category,
         variable_quantity, unit_price
       FROM selected_api_products
       WHERE active = 1
         AND (custom_name LIKE ? OR category LIKE ?)
       LIMIT 100`,
      [like, like]
    );

    // تطبيع + روابط
    const results = [
      ...sqlProducts.map(p => ({
        id: p.id,
        title: p.name,
        price: p.price,
        image: p.image || '/images/default-product.png',
        category: p.category,
        subcategory: p.subcategory,
        source: 'sql',
        href: `/checkout/${p.id}`
      })),
      ...apiCustom.map(p => ({
        id: p.id,
        title: p.custom_name || `API Product #${p.id}`,
        price: p.custom_price || p.unit_price || null,
        image: p.custom_image || '/images/default-product.png',
        category: p.category,
        subcategory: null,
        source: 'api',
        href: `/api-checkout/${p.id}`
      })),
    ];

    // ترتيب: الأقرب للاسم أولاً
    const needle = q.toLowerCase();
    results.sort((a, b) => {
      const ai = (a.title||'').toLowerCase().indexOf(needle);
      const bi = (b.title||'').toLowerCase().indexOf(needle);
      return (ai === -1 ? 1e9 : ai) - (bi === -1 ? 1e9 : bi);
    });

    res.json(results.slice(0, 60));
  } catch (e) {
    console.error('❌ /search/json error:', e);
    res.json([]);
  }
});

// ✅ يرجّع IDs المنتجات المقفولة من جدول products
app.get('/api/out-of-stock', (req, res) => {
  const sql = `
    SELECT CAST(id AS CHAR) AS id FROM products WHERE is_out_of_stock = 1
    UNION
    SELECT CAST(product_id AS CHAR) AS id FROM selected_api_products WHERE is_out_of_stock = 1
  `;
  db.query(sql, [], (err, rows) => {
    if (err) { console.error('❌ OOS API error:', err); return res.json([]); }
    res.json(rows.map(r => String(r.id)));
  });
});


// شراء منتج كمي (نسبي) بدقة سنت 100%
// شراء منتج كمي بدقة سنت 100% + حماية من الخصم المزدوج
// شراء منتج كمي بدقة سنت (Round) + حماية من الخصم المزدوج
app.post('/buy-quantity-product', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  // ✅ Fallback للمفتاح من السيشن لو ما وصل من الواجهة
  const rawIdemKey = req.body.idempotency_key || req.session.idemKey || '';
  const { productId, quantity, player_id } = req.body;

  const query = (sql, params) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    // 0) Idempotency (اختياري لكن مفضّل)
    if (rawIdemKey) {
      try {
        await query(
          `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
          [userId, String(rawIdemKey).slice(0, 64)]
        );
      } catch (e) {
        // مفتاح مستخدم قبل → اعتبر الطلب مكرّر
        req.session.pendingOrderId = req.session.pendingOrderId || null;
        return res.redirect('/processing');
      }
    }

    // 1) جلب المنتج المتغيّر
    const [product] = await query(
      `SELECT * FROM selected_api_products
        WHERE product_id = ? AND active = 1 AND variable_quantity = 1`,
      [productId]
    );
    if (!product) return res.redirect(`/api-checkout/${productId}?error=notfound`);

    // 2) Out of stock
    if (Number(product.is_out_of_stock) === 1) {
      return res.redirect(`/api-checkout/${productId}?error=out_of_stock`);
    }

    // 3) تحقق ومدى
    const qty = parseInt(quantity, 10);
    const unitQty = Math.max(1, parseInt(product.unit_quantity ?? 1, 10));
    const unitPrice = Number(product.unit_price) || 0; // يفضّل DECIMAL(10,4) في DB

    const min = Number.isFinite(parseInt(product.min_quantity, 10)) ? parseInt(product.min_quantity, 10) : 1;
    const max = Number.isFinite(parseInt(product.max_quantity, 10)) ? parseInt(product.max_quantity, 10) : 999999;

    if (!Number.isFinite(qty) || qty < min || qty > max) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_quantity`);
    }
    if (!Number.isFinite(unitQty) || unitQty <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_unit_qty`);
    }

    // 4) إلزام Player ID لو طالب (حتى لو ما في تحقق خارجي)
    const requiresPlayerId = Number(product.player_check) === 1;
    if (requiresPlayerId && (!player_id || player_id.trim() === '')) {
      return res.redirect(`/api-checkout/${productId}?error=missing_player`);
    }

    // 4.1) تحقق خارجي لو مطلوب فقط
    if (Number(product.requires_verification) === 1) {
      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.redirect(
          `/api-checkout/${productId}?error=verify&msg=${encodeURIComponent(verifyRes.message || 'Verification failed')}`
        );
      }
    }

    // 5) التسعير الدقيق — أقرب سنت (Math.round)
    const totalCents = Math.round((qty * unitPrice * 100) / unitQty);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=pricing`);
    }
    const total = totalCents / 100; // يُخزَّن DECIMAL(10,2)

    // 6) خصم ذري يمنع السباق/التكرار
    const upd = await query(
      `UPDATE users
         SET balance = balance - ?
       WHERE id = ? AND balance >= ?`,
      [total, userId, total]
    );
    if (!upd?.affectedRows) {
      return res.redirect(`/api-checkout/${productId}?error=balance`);
    }

    // 7) سجل معاملة الخصم
    await query(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'debit', ?, ?)`,
      [userId, total, `Purchase: ${product.custom_name || `API Product ${productId}`}`]
    );

    // 8) إرسال الطلب للمزوّد
    const orderBody = {
      product: parseInt(productId, 10),
      quantity: qty,
      ...(player_id ? { account_id: player_id } : {})
    };

    let providerOrderId = null;
    try {
      const { data: result } = await dailycardAPI.post('/api-keys/orders/create/', orderBody);
      providerOrderId = result?.id || result?.data?.id || result?.order_id || null;
    } catch (e) {
      // فشل الشبكة/المزوّد → Refund
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `API Product ${productId}`} (provider error)`]
      );
      return res.redirect(`/api-checkout/${productId}?error=network`);
    }

    if (!providerOrderId) {
      // فشل بدون ID → Refund
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `API Product ${productId}`}`]
      );
      return res.redirect(`/api-checkout/${productId}?error=order_failed`);
    }

    // 9) حفظ الطلب داخليًا
    const orderStatus = 'Waiting';
    const orderDetails = player_id ? `User ID: ${player_id}, Quantity: ${qty}` : `Quantity: ${qty}`;

    const insertSql = `
      INSERT INTO orders
        (userId, productName, price, purchaseDate, order_details, status, provider_order_id, provider, source${rawIdemKey ? ', client_token' : ''})
      VALUES
        (?, ?, ?, NOW(), ?, ?, ?, 'dailycard', 'api'${rawIdemKey ? ', ?' : ''})
    `;
    const insertParams = [
      userId,
      product.custom_name || `API Product ${productId}`,
      total,
      orderDetails,
      orderStatus,
      providerOrderId
    ];
    if (rawIdemKey) insertParams.push(String(rawIdemKey).slice(0, 64));

    const insertResult = await query(insertSql, insertParams);
    const insertId = insertResult.insertId || insertResult[0]?.insertId;

    // 10) إشعارات داخلية
    await query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [userId, `✅ تم استلام طلبك (${product.custom_name || `API Product ${productId}`}) بنجاح. سيتم معالجته قريبًا.`]
    );

    // 11) تيليغرام
    const [userRow] = await query(
      'SELECT username, telegram_chat_id FROM users WHERE id = ?',
      [userId]
    );
    if (userRow?.telegram_chat_id) {
      await sendTelegramMessage(
        userRow.telegram_chat_id,
        `📥 <b>تم استلام طلبك بنجاح</b>\n\n🛍️ <b>المنتج:</b> ${product.custom_name || `API Product ${productId}`}\n🔢 <b>الكمية:</b> ${qty}\n💰 <b>السعر:</b> ${total}$\n📌 <b>الحالة:</b> جاري المعالجة`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }
    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 طلب جديد!\n👤 الزبون: ${userRow?.username}\n🎁 المنتج: ${product.custom_name || `API Product ${productId}`}\n📦 الكمية: ${qty}\n💰 السعر: ${total}$\n🕓 الوقت: ${new Date().toLocaleString('en-US', { hour12: false })}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // 12) تجربة موحّدة
    req.session.pendingOrderId = insertId;
    // (اختياري) امسح المفتاح من السيشن بعد الاستخدام
    // delete req.session.idemKey;

    return res.redirect('/processing');

  } catch (err) {
    console.error('❌ Quantity Order Error:', err?.response?.data || err.message || err);
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





app.post('/buy', checkAuth, uploadNone.none(), async (req, res) => {
  const { productId, playerId, idempotency_key: bodyIdemKey } = req.body;
  const user = req.session.user;
  if (!user?.id) return res.status(401).json({ success: false, message: 'Session expired. Please log in.' });

  // ✅ Idempotency: من الـ body أو من السيشن (fallback)
  const idemKey = (bodyIdemKey || req.session.idemKey || '').toString().slice(0, 64);

  // helper (وحدة استعلام بالبرومس)
  const q = (sql, params = []) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  try {
    // 0) Idempotency gate (اختياري لكنه مفضّل)
    if (idemKey) {
      try {
        await q(`INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`, [user.id, idemKey]);
        // إذا نجح الإدراج → أول طلب، كمّل طبيعي
      } catch (e) {
        // مفتاح مكرر → اعتبر الطلب مكرر: لا خصم، لا إدخال Order
        return res.json({ success: true, redirectUrl: '/processing' });
      }
    }

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    // 1) جلب المنتج
    const productSql = 'SELECT * FROM products WHERE id = ? AND active = 1';
    const result = await q(productSql, [productId]);
    if (!result?.length) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const product = result[0];

    // 2) السعر
    const purchasePrice = Number(product.price || 0);
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      return res.status(400).json({ success: false, message: 'Pricing error' });
    }

    // 3) تحقق رصيد سريع (دليل مبكر فقط؛ الخصم الحقيقي بالترانزاكشن كما هو)
    if (user.balance < purchasePrice) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // 4) قيم جاهزة
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

    // ✅ النسخة المعتمدة على Pool + Transaction (منطقك نفسه)
    const conn = await promisePool.getConnection();
    try {
      await conn.beginTransaction();

      // خصم الرصيد (تبقي منطقك كما هو)
      await conn.query(updateUserSql, [newBalance, user.id]);

      // إدخال الطلب
      const [orderResult] = await conn.query(insertOrderSql, [
        user.id,
        product.name,
        purchasePrice,
        now,
        orderDetails
      ]);
      const orderId = orderResult.insertId;

      // إشعار داخلي
      await conn.query(notifSql, [user.id, notifMsg]);

      // إنهاء المعاملة
      await conn.commit();

      // 🔔 إشعارات تيليغرام بعد الـ COMMIT (منطقك كما هو)
      try {
        const [rows] = await promisePool.query(
          'SELECT telegram_chat_id FROM users WHERE id = ?',
          [user.id]
        );
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
          } catch (e) {
            console.warn('⚠️ Failed to send Telegram to user:', e.message);
          }
        } else {
          console.log("ℹ️ No valid telegram_chat_id found, or user hasn't messaged bot yet.");
        }

        // إشعار تيليغرام للإدمن
        try {
          const adminChatId = '2096387191'; // ← عدّل إذا لزم
          const adminMsg = `
🆕 <b>طلب جديد!</b>

👤 <b>الزبون:</b> ${user.username}
🛍️ <b>المنتج:</b> ${product.name}
💰 <b>السعر:</b> ${purchasePrice}$
📋 <b>التفاصيل:</b> ${orderDetails || 'لا يوجد'}
🕒 <b>الوقت:</b> ${now.toLocaleString()}
          `.trim();

          await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: adminChatId,
            text: adminMsg,
            parse_mode: 'HTML'
          });
          console.log('📢 Admin notified via Telegram');
        } catch (e) {
          console.warn('⚠️ Failed to notify admin via Telegram:', e.message);
        }
      } catch (e) {
        console.warn('⚠️ Telegram notification flow error:', e.message);
      }

      // تحديث الرصيد في السيشن
      req.session.user.balance = newBalance;

      // (اختياري) مسح المفتاح من السيشن بعد الاستخدام
      // delete req.session.idemKey;

      // نجاح
      return res.json({ success: true, redirectUrl: '/processing' });

    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      console.error('Transaction failed:', e);
      return res.status(500).json({ success: false, message: 'Transaction failed' });
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('❌ SQL Product Order Error:', err?.response?.data || err.message || err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
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
    // ✅ استقبال القيم من الفورم
    const { name, price, main_category, sub_category, image } = req.body;
    const is_out_of_stock = req.body.is_out_of_stock ? 1 : 0; // ✅ Checkbox

    const sql = `
        UPDATE products 
        SET name = ?, price = ?, main_category = ?, sub_category = ?, image = ?, is_out_of_stock = ?
        WHERE id = ?
    `;

    // ✅ تمرير القيم بالترتيب الصحيح
    db.query(sql, [name, price, main_category, sub_category, image, is_out_of_stock, productId], (err, result) => {
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
    notes
  } = req.body;

  // قيم من الشيك بوكسات
  const requires_player_id = (req.body.requires_player_id === '1' || req.body.requires_player_id === 'on') ? 1 : 0;
  const is_out_of_stock   = (req.body.is_out_of_stock   === '1' || req.body.is_out_of_stock   === 'on') ? 1 : 0;

  const sql = `
    UPDATE products
    SET name = ?, price = ?, image = ?, main_category = ?, sub_category = ?, 
        sub_category_image = ?, requires_player_id = ?, player_id_label = ?, notes = ?,
        is_out_of_stock = ?
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
    notes || null,
    is_out_of_stock,
    productId
  ];

  db.query(sql, values, (err) => {
    if (err) {
      console.error("❌ Error updating product:", err);
      return res.status(500).send("Database error during update.");
    }
    res.redirect('/admin/products');
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
  const { status: rawStatus, admin_reply } = req.body;

  // توحيد القيمة (احتياط)
  const status = (rawStatus || '').trim().toLowerCase() === 'accepted' ? 'Accepted'
              : (rawStatus || '').trim().toLowerCase() === 'rejected' ? 'Rejected'
              : rawStatus;

  const findOrderSql = `SELECT * FROM orders WHERE id = ?`;

  db.query(findOrderSql, [orderId], (err, results) => {
    if (err || results.length === 0) {
      return res.status(404).send('Order not found.');
    }

    const order = results[0];
    const oldStatus = order.status;
    const orderPrice = parseFloat(order.price);
    const userId = order.userId;

    if (status === 'Rejected' && oldStatus !== 'Rejected') {
      (async () => {
        const conn = await promisePool.getConnection();
        try {
          await conn.beginTransaction();

          await conn.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [orderPrice, userId]);

          await conn.query(
            `INSERT INTO transactions (user_id, type, amount, reason)
             VALUES (?, 'credit', ?, ?)`,
            [userId, orderPrice, `Refund for rejected order #${orderId}`]
          );

          const notifMsg = `❌ تم رفض طلبك (${order.productName})، وتم استرجاع المبلغ (${order.price}$) إلى رصيدك.`;
          await conn.query(
            `INSERT INTO notifications (user_id, message, created_at, is_read)
             VALUES (?, ?, NOW(), 0)`,
            [userId, notifMsg]
          );

          await conn.query(
            `UPDATE orders SET status = ?, admin_reply = ? WHERE id = ?`,
            [status, admin_reply, orderId]
          );

          // ✅ أهم شي: كمِّت وردّ فورًا — ما تنطر تيليغرام
          await conn.commit();
          console.log(`✅ Order #${orderId} rejected and refunded.`);
          res.redirect('/admin/orders');

          // 🔔 بعد الرد: بلّغ تيليغرام بخلفية وبـ timeout (ما مننتظر)
          withTimeout(sendOrderStatusTelegram(orderId, status, admin_reply))
            .catch(tgErr => console.error("⚠️ Telegram (rejected) error:", tgErr.message));

        } catch (txErr) {
          console.error("❌ Error during reject/refund:", txErr);
          try { await conn.rollback(); } catch (_) {}
          return res.status(500).send("Error updating request");
        } finally {
          conn.release();
        }
      })();

    } else {
      db.query(
        `UPDATE orders SET status = ?, admin_reply = ? WHERE id = ?`,
        [status, admin_reply, orderId],
        (err) => {
          if (err) {
            console.error(err.message);
            return res.status(500).send("DB error while updating order.");
          }

          console.log(`✅ Order #${orderId} updated to ${status}`);
          // ✅ ردّ فوري
          res.redirect('/admin/orders');

          // 🔔 بلّغ تيليغرام بخلفية وبـ timeout
          withTimeout(sendOrderStatusTelegram(orderId, status, admin_reply))
            .then(() => console.log(`📨 Telegram queued for order #${orderId}`))
            .catch(tgErr => console.error("⚠️ Telegram (update) error:", tgErr.message));
        }
      );
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

    const page  = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    // 🔎 جديد: خذ نص البحث (لو موجود)
    const qRaw = (req.query.q || '').trim();
    const q = qRaw.toLowerCase();

    const apiProducts = await getCachedAPIProducts();

    const customSql = "SELECT * FROM selected_api_products";
    const customProducts = await query(customSql);
    const customProductMap = new Map(customProducts.map(p => [parseInt(p.product_id), p]));

    const displayProducts = apiProducts.map(apiProduct => {
      const customData = customProductMap.get(apiProduct.id) || {};
      return {
        ...apiProduct,
        is_selected: !!customData.active,
        custom_price: customData.custom_price,
        custom_image: customData.custom_image
      };
    });

    // 🔎 جديد: فلترة على الكل قبل التقطيع
    const filtered = q
      ? displayProducts.filter(p =>
          (p.name || '').toLowerCase().includes(q) ||
          String(p.id).includes(q)
        )
      : displayProducts;

    // التقطيع بعد الفلترة
    const totalProducts = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalProducts / limit));
    const paginatedProducts = filtered.slice(offset, offset + limit);

    res.render('admin-api-products', {
      user: req.session.user,
      products: paginatedProducts,
      currentPage: page,
      totalPages,
      q: qRaw,              // 🔎 جديد: مرّر نص البحث للواجهة
    });

  } catch (error) {
    console.error("API Error in /admin/api-products:", error.stack || error.message);
    res.status(500).send("❌ Error loading API products.");
  }
});


// مسار لإضافة أو إزالة منتج من الـ API
app.post('/admin/api-products/toggle', checkAdmin, (req, res) => {
  const { productId, isActive } = req.body;

  // تأكيد البوليان
  const on = (isActive === true || isActive === 'true' || isActive === 1 || isActive === '1');

  if (on) {
    const sql = `
      INSERT INTO selected_api_products (product_id, active)
      VALUES (?, TRUE)
      ON DUPLICATE KEY UPDATE active = TRUE
    `;
    db.query(sql, [productId], (err) => {
      if (err) return res.json({ success: false });
      res.json({ success: true, status: 'activated' });
    });
  } else {
    // ❌ لا تحذف! ✅ عطّل فقط
    const sql = `UPDATE selected_api_products SET active = FALSE WHERE product_id = ?`;
    db.query(sql, [productId], (err) => {
      if (err) return res.json({ success: false });
      res.json({ success: true, status: 'deactivated' });
    });
  }
});


// مسار لعرض صفحة تعديل منتج API معين
// GET: Edit API Product (with dynamic categories list)
app.get('/admin/api-products/edit/:id', checkAdmin, async (req, res) => {
  const productId = Number(req.params.id);

  try {
    const apiProducts = await getCachedAPIProducts();
    const selectedProduct = apiProducts.find(p => p.id === productId);
    if (!selectedProduct) return res.status(404).send("❌ Product not found in API");

    // 1) customization للمنتج
    db.query(
      "SELECT * FROM selected_api_products WHERE product_id = ? LIMIT 1",
      [productId],
      (err, rows) => {
        if (err) {
          console.error("❌ DB Error (custom):", err);
          return res.status(500).send("❌ Database Error");
        }
        const custom = rows?.[0] || {};

        // 2) جلب التصنيفات الفعّالة (الترتيب على sort_order)
        const catsSql = `
          SELECT slug, label
          FROM api_categories
          WHERE active = 1
          ORDER BY (sort_order IS NULL), sort_order ASC, label ASC
        `;
        db.query(catsSql, (err2, categories) => {
          if (err2) {
            console.error("❌ DB Error (categories):", err2);
            return res.status(500).send("❌ Database Error");
          }

          // 3) عرض الصفحة
          res.render('admin-edit-api-product', {
            product: selectedProduct,
            custom,
            categories,          // <<< مهم
            user: req.session.user
          });
        });
      }
    );
  } catch (e) {
    console.error("❌ Error in /admin/api-products/edit:", e);
    res.status(500).send("❌ Internal Server Error");
  }
});


// ✅ EDIT API PRODUCT (FULL REPLACEMENT)
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

  // Flags
  const variableQtyFlag       = (variable_quantity === '1' || variable_quantity === 'on') ? 1 : 0;
  const player_check          = (req.body.player_check === '1' || req.body.player_check === 'on') ? 1 : 0;
  const requires_verification = (req.body.requires_verification === '1' || req.body.requires_verification === 'on') ? 1 : 0;
  const is_out_of_stock       = (req.body.is_out_of_stock === '1' || req.body.is_out_of_stock === 'on') ? 1 : 0;

  // Values
  const priceToSave    = custom_price ? parseFloat(custom_price) : null;
  const imageToSave    = custom_image || null;
  const nameToSave     = custom_name || null;
  const labelToSave    = unit_label || 'units';
 const categoryToSave = category ? slugify(category) : null;


  const unitPriceToSave    = variableQtyFlag ? (parseFloat(unit_price) || null)    : null;
  const unitQuantityToSave = variableQtyFlag ? (parseFloat(unit_quantity) || null) : null;
  const minQtyToSave       = variableQtyFlag ? (parseInt(min_quantity) || null)    : null;
  const maxQtyToSave       = variableQtyFlag ? (parseInt(max_quantity) || null)    : null;

  const sql = `
    INSERT INTO selected_api_products (
      product_id, custom_price, custom_image, custom_name, category, active,
      variable_quantity, unit_price, unit_quantity, min_quantity, max_quantity,
      player_check, unit_label, requires_verification, is_out_of_stock
    )
    VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      custom_price          = VALUES(custom_price),
      custom_image          = VALUES(custom_image),
      custom_name           = VALUES(custom_name),
      category              = VALUES(category),
      active                = TRUE,
      variable_quantity     = VALUES(variable_quantity),
      unit_price            = VALUES(unit_price),
      unit_quantity         = VALUES(unit_quantity),
      min_quantity          = VALUES(min_quantity),
      max_quantity          = VALUES(max_quantity),
      player_check          = VALUES(player_check),
      unit_label            = VALUES(unit_label),
      requires_verification = VALUES(requires_verification),
      is_out_of_stock       = VALUES(is_out_of_stock)
  `;

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
    requires_verification,
    is_out_of_stock
  ];

  db.query(sql, params, (err) => {
    if (err) {
      console.error("❌ Error saving custom API product:", err);
      return res.status(500).send("❌ Error saving changes.");
    }
    res.redirect('/admin/api-products');
  });
});




app.post('/buy-fixed-product', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.status(401).json({ success: false, message: "Session expired. Please log in." });

  // ✅ Idempotency key: من الـ body أو من السيشن (fallback)
  const idempotency_key = req.body.idempotency_key || req.session.idemKey || '';

  const { productId, player_id } = req.body;
  if (!productId) return res.status(400).json({ success: false, message: "Missing product ID." });

  const query = (sql, params) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });

  try {
    // 0) Idempotency (اختياري لكن مفضّل)
    if (idempotency_key) {
      try {
        await query(
          `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
          [userId, String(idempotency_key).slice(0, 64)]
        );
      } catch (e) {
        // مفتاح مستخدم قبل → اعتبره مكرر بدون خصم جديد
        return res.json({ success: true, redirectUrl: "/processing" });
      }
    }

    // 1) المنتج الثابت (variable_quantity = 0 أو NULL)
    const [product] = await query(
      `SELECT * FROM selected_api_products
        WHERE product_id = ?
          AND active = 1
          AND (variable_quantity IS NULL OR variable_quantity = 0)`,
      [productId]
    );
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // 2) Out of stock
    if (Number(product.is_out_of_stock) === 1) {
      return res.status(400).json({ success: false, message: "Product is out of stock." });
    }

    // 3) السعر (دائمًا قرب للسنتات)
    const rawPrice = Number(product.custom_price || product.unit_price || 0) || 0;
    const priceCents = Math.round(rawPrice * 100);           // سنتات
    const price = priceCents / 100;                           // دولار (DECIMAL(10,2) بالـ DB)
    if (price <= 0) {
      return res.status(400).json({ success: false, message: "Pricing error." });
    }

    // 4) Player ID — إلزام إذا product.player_check = 1
    const requiresPlayerId = Number(product.player_check) === 1;
    if (requiresPlayerId && (!player_id || player_id.trim() === "")) {
      return res.status(400).json({ success: false, message: "Missing player ID." });
    }

    // 4.1) تحقق خارجي إذا مطلوب فقط
    if (Number(product.requires_verification) === 1) {
      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.status(400).json({ success: false, message: verifyRes.message || "Player verification failed." });
      }
    }

    // 5) خصم ذري (يمنع الخصم المزدوج والسباق)
    const upd = await query(
      `UPDATE users
         SET balance = balance - ?
       WHERE id = ? AND balance >= ?`,
      [price, userId, price]
    );
    if (!upd?.affectedRows) {
      return res.status(400).json({ success: false, message: "Insufficient balance." });
    }

    // 6) سجل معاملة الخصم
    await query(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'debit', ?, ?)`,
      [userId, price, `Purchase: ${product.custom_name || product.name || `API Product ${productId}`}`]
    );

    // 7) طلب المزود
    const orderBody = {
      product: parseInt(productId, 10),
      ...(player_id ? { account_id: player_id } : {})
    };

    let providerOrderId = null;
    try {
      const { data: result } = await dailycardAPI.post('/api-keys/orders/create/', orderBody);
      providerOrderId = result?.id || result?.data?.id || result?.order_id || null;
    } catch (e) {
      // فشل شبكة/مزود → Refund فوري
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [price, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, price, `Refund: ${product.custom_name || product.name || `API Product ${productId}`} (provider error)`]
      );
      return res.status(502).json({ success: false, message: "Provider error. Refund issued." });
    }

    if (!providerOrderId) {
      // فشل بدون ID واضح → Refund
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [price, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, price, `Refund: ${product.custom_name || product.name || `API Product ${productId}`}`]
      );
      return res.status(500).json({ success: false, message: "Order failed. Refund issued." });
    }

    // 8) حفظ الطلب داخليًا (+ client_token لو موجود)
    const orderDetails = requiresPlayerId ? `User ID: ${player_id}` : '';
    const insertSql = `
      INSERT INTO orders
        (userId, productName, price, purchaseDate, order_details, status, provider_order_id, provider, source${idempotency_key ? ', client_token' : ''})
      VALUES
        (?, ?, ?, NOW(), ?, 'Waiting', ?, 'dailycard', 'api'${idempotency_key ? ', ?' : ''})
    `;
    const insertParams = [
      userId,
      product.custom_name || product.name || `API Product ${productId}`,
      price,
      orderDetails,
      providerOrderId
    ];
    if (idempotency_key) insertParams.push(String(idempotency_key).slice(0, 64));

    const insertResult = await query(insertSql, insertParams);
    const insertId = insertResult.insertId || insertResult?.[0]?.insertId;

    // 9) إشعارات داخلية
    await query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [userId, `✅ Your order for (${product.custom_name || product.name || `API Product ${productId}`}) was received and is being processed.`]
    );

    // 10) تيليغرام
    const [userRow] = await query(`SELECT username, telegram_chat_id FROM users WHERE id = ?`, [userId]);
    if (userRow?.telegram_chat_id) {
      await sendTelegramMessage(
        userRow.telegram_chat_id,
        `📥 <b>Your order has been received</b>\n\n🛍️ <b>Product:</b> ${product.custom_name || product.name || `API Product ${productId}`}\n💰 <b>Price:</b> ${price.toFixed(2)}$\n📌 <b>Status:</b> Processing`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }
    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 New Order!\n👤 User: ${userRow?.username}\n🎁 Product: ${product.custom_name || product.name || `API Product ${productId}`}\n💰 Price: ${price.toFixed(2)}$\n🕓 Time: ${new Date().toLocaleString('en-US', { hour12: false })}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // 11) النهاية
    req.session.pendingOrderId = insertId;
    return res.json({ success: true, redirectUrl: "/processing" });

  } catch (err) {
    const rawErr = err?.response?.data || err.message || err;
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

app.get('/Adobe_Creativity_Cloud', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Adobe Creativity Cloud'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('Adobe_Creativity_Cloud', { 
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

app.get('/disneyhigh-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Disney High'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('disneyhigh-section', { 
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

app.get('/gemini', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Gemini Pro'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('gemini', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/starzplay', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Starzplay'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('starzplay', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/grammarly', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Grammarly'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('grammarly', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/perplexity', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Perplexity AI'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('perplexity', { 
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

app.get('/autodesk', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'AUTODESK'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('autodesk', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/tod', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'TOD'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('tod', { 
            user: req.session.user || null,
            products: products  // تأكد من تمرير المنتجات
        });
    });
});

app.get('/chatgpt-section', (req, res) => {
    const sql = "SELECT * FROM products WHERE main_category = 'Accounts' AND sub_category = 'Chatgpt'";
    db.query(sql, [], (err, products) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).send("Server error");
        }
        res.render('chatgpt-section', { 
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


// 🔄 بدّل الراوت الحالي بهيدا — موحَّد مع بقية النظام
app.post('/bigolive-section', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  // مفتاح عدم التكرار من الواجهة أو من السيشن
  const rawIdemKey = req.body.idempotency_key || req.session.idemKey || '';
  const { productId, quantity, player_id } = req.body;

  const query = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    // 0) Idempotency
    if (rawIdemKey) {
      try {
        await query(
          `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
          [userId, String(rawIdemKey).slice(0, 64)]
        );
      } catch (e) {
        // مكرر → لا خصم ولا طلب جديد
        req.session.pendingOrderId = req.session.pendingOrderId || null;
        return res.redirect('/processing');
      }
    }

    // 1) إعدادات المنتج
    const [product] = await query(
      `SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1`,
      [productId]
    );
    if (!product) return res.redirect(`/api-checkout/${productId}?error=notfound`);

    // منع الشراء لو Out of Stock
    if (Number(product.is_out_of_stock) === 1) {
      return res.redirect(`/api-checkout/${productId}?error=out_of_stock`);
    }

    // 2) أرقام وضوابط الكمية
    const qty       = parseInt(quantity, 10);
    const unitQty   = Math.max(1, parseInt(product.unit_quantity ?? 1, 10));
    const unitPrice = Number(product.unit_price) || 0;
    const minQty    = Math.max(1, parseInt(product.min_quantity ?? 1, 10));
    const maxQty    = Math.max(minQty, parseInt(product.max_quantity ?? 999999, 10));

    if (!Number.isFinite(qty) || qty < minQty || qty > maxQty || unitQty <= 0 || unitPrice <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_quantity`);
    }

    // 2.1) Player ID مطلوب إذا player_check=1 حتى لو ما في Verify خارجي
    const requiresPlayerId = Number(product.player_check) === 1;
    if (requiresPlayerId && (!player_id || player_id.trim() === '')) {
      return res.redirect(`/api-checkout/${productId}?error=missing_player`);
    }

    // 3) التحقق الخارجي (إن لزم)
    if (Number(product.requires_verification) === 1) {
      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.redirect(`/api-checkout/${productId}?error=verify&msg=${encodeURIComponent(verifyRes.message || 'Verification failed')}`);
      }
    }

    // 4) التسعير الدقيق بالسنتات (موحّد مع باقي المسارات)
    // totalCents = round(qty * unitPrice * 100 / unitQty)
    const totalCents = Math.round((qty * unitPrice * 100) / unitQty);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=pricing`);
    }
    const total = totalCents / 100;

    // 5) خصم ذري يمنع السباق/التكرار
    const upd = await query(
      `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
      [total, userId, total]
    );
    if (!upd?.affectedRows) {
      return res.redirect(`/api-checkout/${productId}?error=balance`);
    }

    // 6) تسجيل معاملة الخصم
    await query(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'debit', ?, ?)`,
      [userId, total, `Purchase: ${product.custom_name || `BIGO Product ${productId}`}`]
    );

    // 7) إنشاء الطلب عند المزوّد
    const orderBody = {
      product: Number(productId),
      quantity: qty,
      ...(player_id ? { account_id: player_id } : {})
    };

    let providerOrderId = null;
    try {
      const { data: result } = await dailycardAPI.post('/api-keys/orders/create/', orderBody);
      providerOrderId = result?.id || result?.data?.id || result?.order_id || null;
    } catch (e) {
      // فشل شبكة/مزود → Refund فوري
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `BIGO Product ${productId}`} (provider error)`]
      );
      return res.redirect(`/api-checkout/${productId}?error=network`);
    }

    if (!providerOrderId) {
      // فشل بدون ID → Refund
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `BIGO Product ${productId}`}`]
      );
      return res.redirect(`/api-checkout/${productId}?error=order_failed`);
    }

    // 8) حفظ الطلب داخليًا (+ client_token لو موجود)
    const orderDetails = player_id
      ? `User ID: ${player_id}, Quantity: ${qty}`
      : `Quantity: ${qty}`;

    const insertSql = `
      INSERT INTO orders
        (userId, productName, price, purchaseDate, order_details, status, provider_order_id, provider, source${rawIdemKey ? ', client_token' : ''})
      VALUES
        (?, ?, ?, NOW(), ?, 'Waiting', ?, 'dailycard', 'api'${rawIdemKey ? ', ?' : ''})
    `;
    const insertParams = [
      userId,
      product.custom_name || `BIGO Product ${productId}`,
      total,
      orderDetails,
      providerOrderId
    ];
    if (rawIdemKey) insertParams.push(String(rawIdemKey).slice(0, 64));

    const insertRes = await query(insertSql, insertParams);
    const orderId = insertRes?.insertId ?? insertRes?.[0]?.insertId ?? null;

    // 9) إشعارات داخلية + تيليغرام
    await query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [userId, `✅ تم استلام طلبك (${product.custom_name || `BIGO Product ${productId}`}) بنجاح. سيتم معالجته قريبًا.`]
    );

    const [userRow] = await query(
      `SELECT username, telegram_chat_id FROM users WHERE id = ?`,
      [userId]
    );

    if (userRow?.telegram_chat_id) {
      await sendTelegramMessage(
        userRow.telegram_chat_id,
        `📥 <b>تم استلام طلبك</b>\n\n🛍️ <b>المنتج:</b> ${product.custom_name || `BIGO Product ${productId}`}\n🔢 <b>الكمية:</b> ${qty}\n💰 <b>السعر:</b> ${total}$\n📌 <b>الحالة:</b> جاري المعالجة`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }
    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 طلب BIGO جديد!\n👤 الزبون: ${userRow?.username}\n🎁 المنتج: ${product.custom_name || `BIGO Product ${productId}`}\n📦 الكمية: ${qty}\n💰 السعر:${total}$\n🕓 الوقت: ${new Date().toLocaleString('en-US', { hour12: false })}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // 10) تجربة موحّدة
    req.session.pendingOrderId = orderId;
    return res.redirect('/processing');

  } catch (err) {
    console.error('❌ BIGO Order Error:', err?.response?.data || err.message || err);
    return res.redirect(`/api-checkout/${productId}?error=server`);
  }
});



app.post('/likee-section', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  // مفتاح عدم التكرار من الواجهة أو من السيشن
  const rawIdemKey = req.body.idempotency_key || req.session.idemKey || '';
  const { productId, quantity, player_id } = req.body;

  const query = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    // 0) Idempotency
    if (rawIdemKey) {
      try {
        await query(
          `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
          [userId, String(rawIdemKey).slice(0, 64)]
        );
      } catch (e) {
        // مكرر → لا خصم ولا طلب جديد
        req.session.pendingOrderId = req.session.pendingOrderId || null;
        return res.redirect('/processing');
      }
    }

    // 1) جلب المنتج المفعّل
    const [product] = await query(
      `SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1`,
      [productId]
    );
    if (!product) return res.redirect(`/api-checkout/${productId}?error=notfound`);

    // 2) Out of Stock
    if (Number(product.is_out_of_stock) === 1) {
      return res.redirect(`/api-checkout/${productId}?error=out_of_stock`);
    }

    // 3) أرقام وضوابط الكمية
    const qty       = parseInt(quantity, 10);
    const unitQty   = Math.max(1, parseInt(product.unit_quantity ?? 1, 10));
    const unitPrice = Number(product.unit_price) || 0;
    const minQty    = Math.max(1, parseInt(product.min_quantity ?? 1, 10));
    const maxQty    = Math.max(minQty, parseInt(product.max_quantity ?? 999999, 10));

    if (!Number.isFinite(qty) || qty < minQty || qty > maxQty || unitQty <= 0 || unitPrice <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_quantity`);
    }

    // 3.1) Player ID مطلوب إذا player_check=1 حتى لو ما في Verify خارجي
    const requiresPlayerId = Number(product.player_check) === 1;
    if (requiresPlayerId && (!player_id || player_id.trim() === "")) {
      return res.redirect(`/api-checkout/${productId}?error=missing_player`);
    }

    // 3.2) تحقق خارجي إذا مطلوب
    if (Number(product.requires_verification) === 1) {
      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.redirect(`/api-checkout/${productId}?error=verify&msg=${encodeURIComponent(verifyRes.message || "Verification failed")}`);
      }
    }

    // 4) التسعير الدقيق بالسنتات (موحّد مع باقي المسارات)
    // totalCents = round(qty * unitPrice * 100 / unitQty)
    const totalCents = Math.round((qty * unitPrice * 100) / unitQty);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=pricing`);
    }
    const total = totalCents / 100;

    // 5) خصم ذري يمنع السباق/التكرار
    const upd = await query(
      `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
      [total, userId, total]
    );
    if (!upd?.affectedRows) {
      return res.redirect(`/api-checkout/${productId}?error=balance`);
    }

    // 6) تسجيل معاملة الخصم
    await query(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'debit', ?, ?)`,
      [userId, total, `Purchase: ${product.custom_name || `Likee Product ${productId}`}`]
    );

    // 7) إنشاء الطلب عند المزوّد
    const orderBody = {
      product: Number(productId),
      quantity: qty,
      ...(player_id ? { account_id: player_id } : {})
    };

    let providerOrderId = null;
    try {
      const { data: result } = await dailycardAPI.post('/api-keys/orders/create/', orderBody);
      providerOrderId = result?.id || result?.data?.id || result?.order_id || null;
    } catch (e) {
      // فشل شبكة/مزود → Refund فوري
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `Likee Product ${productId}`} (provider error)`]
      );
      return res.redirect(`/api-checkout/${productId}?error=network`);
    }

    if (!providerOrderId) {
      // فشل بدون ID → Refund
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `Likee Product ${productId}`}`]
      );
      return res.redirect(`/api-checkout/${productId}?error=order_failed`);
    }

    // 8) حفظ الطلب داخليًا (+ client_token لو موجود)
    const orderDetails = player_id
      ? `User ID: ${player_id}, Quantity: ${qty}`
      : `Quantity: ${qty}`;

    const insertSql = `
      INSERT INTO orders
        (userId, productName, price, purchaseDate, order_details, status, provider_order_id, provider, source${rawIdemKey ? ', client_token' : ''})
      VALUES
        (?, ?, ?, NOW(), ?, 'Waiting', ?, 'dailycard', 'api'${rawIdemKey ? ', ?' : ''})
    `;
    const insertParams = [
      userId,
      product.custom_name || `Likee Product ${productId}`,
      total,
      orderDetails,
      providerOrderId
    ];
    if (rawIdemKey) insertParams.push(String(rawIdemKey).slice(0, 64));

    const insertRes = await query(insertSql, insertParams);
    const orderId = insertRes?.insertId ?? insertRes?.[0]?.insertId ?? null;

    // 9) إشعارات داخلية + تيليغرام
    await query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [userId, `✅ تم استلام طلبك (${product.custom_name || `Likee Product ${productId}`}) بنجاح. سيتم معالجته قريبًا.`]
    );

    const [userRow] = await query(
      `SELECT username, telegram_chat_id FROM users WHERE id = ?`,
      [userId]
    );

    if (userRow?.telegram_chat_id) {
      await sendTelegramMessage(
        userRow.telegram_chat_id,
        `📥 <b>تم استلام طلبك</b>\n\n🛍️ <b>المنتج:</b> ${product.custom_name || `Likee Product ${productId}`}\n🔢 <b>الكمية:</b> ${qty}\n💰 <b>السعر:</b> ${total}$\n📌 <b>الحالة:</b> جاري المعالجة`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }
    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 طلب Likee جديد!\n👤 الزبون: ${userRow?.username}\n🎁 المنتج: ${product.custom_name || `Likee Product ${productId}`}\n📦 الكمية: ${qty}\n💰 السعر: ${total}$\n🕓 الوقت: ${new Date().toLocaleString('en-US', { hour12: false })}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // 10) تجربة موحّدة
    req.session.pendingOrderId = orderId;
    return res.redirect('/processing');

  } catch (error) {
    console.error("❌ Likee Order Error:", error?.response?.data || error.message || error);
    return res.redirect(`/api-checkout/${productId}?error=server`);
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




app.post('/soulchill-section', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  // مفتاح عدم التكرار من الواجهة أو من السيشن
  const rawIdemKey = req.body.idempotency_key || req.session.idemKey || '';
  const { productId, quantity, player_id } = req.body;

  const query = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    // 0) Idempotency
    if (rawIdemKey) {
      try {
        await query(
          `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
          [userId, String(rawIdemKey).slice(0, 64)]
        );
      } catch (e) {
        // مكرر → لا خصم ولا طلب جديد
        req.session.pendingOrderId = req.session.pendingOrderId || null;
        return res.redirect('/processing');
      }
    }

    // 1) إعدادات المنتج (لازم يكون مفعّل)
    const [product] = await query(
      `SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1`,
      [productId]
    );
    if (!product) return res.redirect(`/api-checkout/${productId}?error=notfound`);

    // منع الشراء إذا Out of Stock
    if (Number(product.is_out_of_stock) === 1) {
      return res.redirect(`/api-checkout/${productId}?error=out_of_stock`);
    }

    // 2) أرقام وضوابط الكمية
    const qty       = parseInt(quantity, 10);
    const unitQty   = Math.max(1, parseInt(product.unit_quantity ?? 1, 10));
    const unitPrice = Number(product.unit_price) || 0;
    const minQty    = Math.max(1, parseInt(product.min_quantity ?? 1, 10));
    const maxQty    = Math.max(minQty, parseInt(product.max_quantity ?? 999999, 10));

    if (!Number.isFinite(qty) || qty < minQty || qty > maxQty || unitQty <= 0 || unitPrice <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_quantity`);
    }

    // 2.1) Player ID مطلوب إذا player_check=1 حتى لو ما في Verify خارجي
    const requiresPlayerId = Number(product.player_check) === 1;
    if (requiresPlayerId && (!player_id || player_id.trim() === "")) {
      return res.redirect(`/api-checkout/${productId}?error=missing_player`);
    }

    // 2.2) التحقق الخارجي إذا مطلوب
    if (Number(product.requires_verification) === 1) {
      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.redirect(
          `/api-checkout/${productId}?error=verify&msg=${encodeURIComponent(verifyRes.message || "Verification failed")}`
        );
      }
    }

    // 3) التسعير الدقيق بالسنتات (موحّد مع باقي المسارات)
    // totalCents = round(qty * unitPrice * 100 / unitQty)
    const totalCents = Math.round((qty * unitPrice * 100) / unitQty);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=pricing`);
    }
    const total = totalCents / 100;

    // 4) خصم ذري يمنع السباق/التكرار
    const upd = await query(
      `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
      [total, userId, total]
    );
    if (!upd?.affectedRows) {
      return res.redirect(`/api-checkout/${productId}?error=balance`);
    }

    // 5) تسجيل معاملة الخصم
    await query(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'debit', ?, ?)`,
      [userId, total, `Purchase: ${product.custom_name || `Soulchill Product ${productId}`}`]
    );

    // 6) الطلب عند المزوّد (المسار الرسمي)
    const orderBody = {
      product: Number(productId),
      quantity: qty,
      ...(player_id ? { account_id: player_id } : {})
    };

    let providerOrderId = null;
    try {
      const { data: result } = await dailycardAPI.post('/api-keys/orders/create/', orderBody);
      providerOrderId = result?.id || result?.data?.id || result?.order_id || null;
    } catch (e) {
      // فشل شبكة/مزود → Refund فوري
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `Soulchill Product ${productId}`} (provider error)`]
      );
      return res.redirect(`/api-checkout/${productId}?error=network`);
    }

    if (!providerOrderId) {
      // فشل بدون ID → Refund
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `Soulchill Product ${productId}`}`]
      );
      return res.redirect(`/api-checkout/${productId}?error=order_failed`);
    }

    // 7) حفظ الطلب داخليًا (+ client_token لو موجود)
    const orderDetails = player_id
      ? `User ID: ${player_id}, Quantity: ${qty}`
      : `Quantity: ${qty}`;

    const insertSql = `
      INSERT INTO orders
        (userId, productName, price, purchaseDate, order_details, status, provider_order_id, provider, source${rawIdemKey ? ', client_token' : ''})
      VALUES
        (?, ?, ?, NOW(), ?, 'Waiting', ?, 'dailycard', 'api'${rawIdemKey ? ', ?' : ''})
    `;
    const insertParams = [
      userId,
      product.custom_name || `Soulchill Product ${productId}`,
      total,
      orderDetails,
      providerOrderId
    ];
    if (rawIdemKey) insertParams.push(String(rawIdemKey).slice(0, 64));

    const insertRes = await query(insertSql, insertParams);
    const orderId = insertRes?.insertId ?? insertRes?.[0]?.insertId ?? null;

    // 8) إشعارات
    await query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [userId, `✅ تم استلام طلبك (${product.custom_name || `Soulchill Product ${productId}`}) بنجاح. سيتم معالجته قريبًا.`]
    );

    const [userRow] = await query(
      `SELECT username, telegram_chat_id FROM users WHERE id = ?`,
      [userId]
    );

    if (userRow?.telegram_chat_id) {
      await sendTelegramMessage(
        userRow.telegram_chat_id,
        `📥 <b>تم استلام طلبك</b>\n\n🛍️ <b>المنتج:</b> ${product.custom_name || `Soulchill Product ${productId}`}\n🔢 <b>الكمية:</b> ${qty}\n💰 <b>السعر:</b> ${total}$\n📌 <b>الحالة:</b> جاري المعالجة`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }
    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 طلب Soulchill جديد!\n👤 الزبون: ${userRow?.username}\n🎁 المنتج: ${product.custom_name || `Soulchill Product ${productId}`}\n📦 الكمية: ${qty}\n💰 السعر: ${total}$\n🕓 الوقت: ${new Date().toLocaleString('en-US', { hour12: false })}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // 9) تجربة موحّدة
    req.session.pendingOrderId = orderId;
    return res.redirect('/processing');

  } catch (error) {
    console.error("❌ Soulchill Order Error:", error?.response?.data || error.message || error);
    return res.redirect(`/api-checkout/${productId}?error=server`);
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



app.post('/hiyachat-section', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  // مفتاح عدم التكرار من الواجهة أو السيشن
  const rawIdemKey = req.body.idempotency_key || req.session.idemKey || '';
  const { productId, quantity, player_id } = req.body;

  const query = (sql, params=[]) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
    );

  try {
    // 0) Idempotency
    if (rawIdemKey) {
      try {
        await query(
          `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
          [userId, String(rawIdemKey).slice(0, 64)]
        );
      } catch (e) {
        // مكرر → لا خصم ولا طلب جديد
        req.session.pendingOrderId = req.session.pendingOrderId || null;
        return res.redirect('/processing');
      }
    }

    // 1) المنتج مفعّل
    const [product] = await query(
      `SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1`,
      [productId]
    );
    if (!product) return res.redirect(`/api-checkout/${productId}?error=notfound`);

    // 2) Out of Stock
    if (Number(product.is_out_of_stock) === 1) {
      return res.redirect(`/api-checkout/${productId}?error=out_of_stock`);
    }

    // 3) تحقق ومدى الكمية
    const qty       = parseInt(quantity, 10);
    const unitQty   = Math.max(1, parseInt(product.unit_quantity ?? 1, 10));
    const unitPrice = Number(product.unit_price) || 0;
    const minQty    = Math.max(1, parseInt(product.min_quantity ?? 1, 10));
    const maxQty    = Math.max(minQty, parseInt(product.max_quantity ?? 999999, 10));
    if (!Number.isFinite(qty) || qty < minQty || qty > maxQty) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_quantity`);
    }

    // 3.1) Player ID مطلوب إذا player_check=1 حتى لو ما في Verify خارجي
    const requiresPlayerId = Number(product.player_check) === 1;
    if (requiresPlayerId && (!player_id || player_id.trim() === "")) {
      return res.redirect(`/api-checkout/${productId}?error=missing_player`);
    }

    // 3.2) التحقق الخارجي إذا مطلوب
    if (Number(product.requires_verification) === 1) {
      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.redirect(`/api-checkout/${productId}?error=verify&msg=${encodeURIComponent(verifyRes.message || "Verification failed")}`);
      }
    }

    // 4) التسعير الدقيق بالسنتات (موحّد مع راوت الكمية)
    // بدلاً من ceil(blocks) نعتمد التقريب للسنتات:
    // totalCents = round(qty * unitPrice * 100 / unitQty)
    const totalCents = Math.round((qty * unitPrice * 100) / unitQty);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=pricing`);
    }
    const total = totalCents / 100;

    // 5) خصم ذري يمنع السباق/التكرار
    const upd = await query(
      `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
      [total, userId, total]
    );
    if (!upd?.affectedRows) {
      return res.redirect(`/api-checkout/${productId}?error=balance`);
    }

    // 6) تسجيل الخصم
    await query(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'debit', ?, ?)`,
      [userId, total, `Purchase: ${product.custom_name || `Hiyachat Product ${productId}`}`]
    );

    // 7) إنشاء الطلب عند المزوّد
    const orderBody = {
      product: Number(productId),
      quantity: qty,
      ...(player_id ? { account_id: player_id } : {})
    };

    let providerOrderId = null;
    try {
      const { data: result } = await dailycardAPI.post('/api-keys/orders/create/', orderBody);
      providerOrderId = result?.id || result?.data?.id || result?.order_id || null;
    } catch (e) {
      // فشل شبكة/مزود → Refund فوري
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `Hiyachat Product ${productId}`} (provider error)`]
      );
      return res.redirect(`/api-checkout/${productId}?error=network`);
    }

    if (!providerOrderId) {
      // فشل بدون ID → Refund
      await query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
      await query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'credit', ?, ?)`,
        [userId, total, `Refund: ${product.custom_name || `Hiyachat Product ${productId}`}`]
      );
      return res.redirect(`/api-checkout/${productId}?error=order_failed`);
    }

    // 8) حفظ الطلب داخليًا (+ client_token لو موجود)
    const orderDetails = player_id
      ? `User ID: ${player_id}, Quantity: ${qty}`
      : `Quantity: ${qty}`;

    const insertSql = `
      INSERT INTO orders
        (userId, productName, price, purchaseDate, order_details, status, provider_order_id, provider, source${rawIdemKey ? ', client_token' : ''})
      VALUES
        (?, ?, ?, NOW(), ?, 'Waiting', ?, 'dailycard', 'api'${rawIdemKey ? ', ?' : ''})
    `;
    const insertParams = [
      userId,
      product.custom_name || `Hiyachat Product ${productId}`,
      total,
      orderDetails,
      providerOrderId
    ];
    if (rawIdemKey) insertParams.push(String(rawIdemKey).slice(0, 64));

    const insertRes = await query(insertSql, insertParams);
    const orderId = insertRes?.insertId ?? insertRes?.[0]?.insertId ?? null;

    // 9) إشعارات
    await query(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [userId, `✅ تم استلام طلبك (${product.custom_name || `Hiyachat Product ${productId}`}) بنجاح. سيتم معالجته قريبًا.`]
    );

    // تيليغرام
    const [userRow] = await query(`SELECT username, telegram_chat_id FROM users WHERE id = ?`, [userId]);
    if (userRow?.telegram_chat_id) {
      await sendTelegramMessage(
        userRow.telegram_chat_id,
        `📥 <b>تم استلام طلبك</b>\n\n🛍️ <b>المنتج:</b> ${product.custom_name || `Hiyachat Product ${productId}`}\n🔢 <b>الكمية:</b> ${qty}\n💰 <b>السعر:</b> ${total}$\n📌 <b>الحالة:</b> جاري المعالجة`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }
    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        process.env.ADMIN_TELEGRAM_CHAT_ID,
        `🆕 طلب Hiyachat جديد!\n👤 الزبون: ${userRow?.username}\n🎁 المنتج: ${product.custom_name || `Hiyachat Product ${productId}`}\n📦 الكمية: ${qty}\n💰 السعر: ${total}$\n🕓 الوقت: ${new Date().toLocaleString('en-US', { hour12: false })}`,
        process.env.TELEGRAM_BOT_TOKEN
      );
    }

    // 10) تجربة موحّدة
    req.session.pendingOrderId = orderId;
    return res.redirect('/processing');

  } catch (error) {
    console.error("❌ Hiyachat Order Error:", error?.response?.data || error.message || error);
    return res.redirect(`/api-checkout/${productId}?error=server`);
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


// Lightweight JSON status for live updates
// كان بدون checkAuth و بدون تقييد المستخدم
app.get('/order-details/:id', checkAuth, (req, res) => {
  const orderId = Number(req.params.id);
  const userId = req.session.user.id;

  const sql = "SELECT * FROM orders WHERE id = ? AND userId = ?";
  db.query(sql, [orderId, userId], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).send("❌ Order not found or access denied.");
    const order = rows[0];
    res.render('order-details', {
      order: {
        id: order.id,
        productName: order.productName,
        price: order.price,
        purchaseDate: order.purchaseDate,
        status: order.status,
        order_details: order.order_details || null,
        admin_reply: order.admin_reply || null,
        provider_order_id: order.provider_order_id || null
      }
    });
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


// =================== API CATEGORIES (Admin) ===================
function slugify(str = '') {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^\u0600-\u06FF\w\s-]/g, '') // يسمح بالعربي والأحرف/الأرقام والفراغ والـ -
    .replace(/\s+/g, '-')                   // فراغات -> -
    .replace(/-+/g, '-');                   // دمج - المتتالية
}

const q = (sql, params = []) =>
  new Promise((resolve, reject) => db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

// لائحة الفئات
app.get('/admin/api-categories', checkAdmin, async (req, res) => {
  try {
    const rows = await q(`
      SELECT c.*, COUNT(sap.product_id) AS products_count
      FROM api_categories c
      LEFT JOIN selected_api_products sap ON sap.category = c.slug
      GROUP BY c.id
      ORDER BY c.sort_order ASC, c.label ASC
    `);
    res.render('admin-api-categories', { user: req.session.user || null, categories: rows, flash: req.session.flash || null });
    req.session.flash = null;
  } catch (e) {
    console.error('List api_categories error:', e);
    res.status(500).send('Failed to load categories');
  }
});

// فورم إضافة
app.get('/admin/api-categories/new', checkAdmin, (req, res) => {
  res.render('admin-api-category-form', {
    user: req.session.user || null,
    mode: 'create',
     cat: { label: '', slug: '', image: '', sort_order: 0, active: 1, section: 'games' }
  });
});

// حفظ الإضافة
app.post('/admin/api-categories/new', checkAdmin, async (req, res) => {
  try {
    const { label, slug, image, sort_order, active, section } = req.body;
    const s = slug ? slugify(slug) : slugify(label);
     const allowed = ['apps', 'games'];
     const sec = allowed.includes(String(section)) ? section : 'games';
    if (!label || !s) {
      req.session.flash = { type: 'danger', msg: 'Label/Slug مطلوبين.' };
      return res.redirect('/admin/api-categories/new');
    }
     await q(
     `INSERT INTO api_categories (label, slug, section, image, sort_order, active)
      VALUES (?, ?, ?, ?, ?, ?)`,
     [label, s, sec, image || null, parseInt(sort_order || 0), active ? 1 : 0]
   );
    req.session.flash = { type: 'success', msg: 'تم إنشاء الفئة بنجاح.' };
    res.redirect('/admin/api-categories');
  } catch (e) {
    console.error('Create api_category error:', e);
    req.session.flash = { type: 'danger', msg: e.code === 'ER_DUP_ENTRY' ? 'Slug مستخدم من قبل.' : 'فشل إنشاء الفئة.' };
    res.redirect('/admin/api-categories/new');
  }
});

// فورم تعديل
app.get('/admin/api-categories/:id/edit', checkAdmin, async (req, res) => {
  try {
    const [cat] = await q(`SELECT * FROM api_categories WHERE id = ?`, [req.params.id]);
    if (!cat) return res.status(404).send('Category not found');
    res.render('admin-api-category-form', {
      user: req.session.user || null,
      mode: 'edit',
      cat
    });
  } catch (e) {
    console.error('Edit form api_category error:', e);
    res.status(500).send('Failed to load form');
  }
});

// حفظ التعديل
app.post('/admin/api-categories/:id/edit', checkAdmin, async (req, res) => {
  try {
    const { label, slug, image, sort_order, active, section } = req.body;
    const s = slug ? slugify(slug) : slugify(label);
    const allowed = ['apps', 'games'];
    const sec = allowed.includes(String(section)) ? section : 'games';
    await q(
      `UPDATE api_categories
       SET label = ?, slug = ?, section = ?, image = ?, sort_order = ?, active = ?
       WHERE id = ?`,
      [label, s, sec, image || null, parseInt(sort_order || 0), active ? 1 : 0, req.params.id]
    );
    req.session.flash = { type: 'success', msg: 'تم تحديث الفئة.' };
    res.redirect('/admin/api-categories');
  } catch (e) {
    console.error('Update api_category error:', e);
    req.session.flash = { type: 'danger', msg: e.code === 'ER_DUP_ENTRY' ? 'Slug مستخدم من قبل.' : 'فشل التحديث.' };
    res.redirect(`/admin/api-categories/${req.params.id}/edit`);
  }
});

// تفعيل/تعطيل سريع
app.post('/admin/api-categories/:id/toggle', checkAdmin, async (req, res) => {
  try {
    await q(`UPDATE api_categories SET active = IF(active=1,0,1) WHERE id = ?`, [req.params.id]);
    res.redirect('/admin/api-categories');
  } catch (e) {
    console.error('Toggle api_category error:', e);
    res.status(500).send('Toggle failed');
  }
});

// حذف (يمنع الحذف إذا عليها منتجات)
app.post('/admin/api-categories/:id/delete', checkAdmin, async (req, res) => {
  try {
    const [cat] = await q(`SELECT * FROM api_categories WHERE id = ?`, [req.params.id]);
    if (!cat) {
      req.session.flash = { type: 'warning', msg: 'الفئة غير موجودة.' };
      return res.redirect('/admin/api-categories');
    }
    const [{ cnt }] = await q(`SELECT COUNT(*) AS cnt FROM selected_api_products WHERE category = ?`, [cat.slug]);
    if (cnt > 0) {
      req.session.flash = { type: 'warning', msg: 'لا يمكن الحذف لأن هناك منتجات مرتبطة. عطّلها بدلًا من ذلك.' };
      return res.redirect('/admin/api-categories');
    }
    await q(`DELETE FROM api_categories WHERE id = ?`, [req.params.id]);
    req.session.flash = { type: 'success', msg: 'تم الحذف.' };
    res.redirect('/admin/api-categories');
  } catch (e) {
    console.error('Delete api_category error:', e);
    req.session.flash = { type: 'danger', msg: 'فشل الحذف.' };
    res.redirect('/admin/api-categories');
  }
});


// صفحة قائمة منتجات كاتيجوري واحدة (ديناميكي)
app.get('/apps/:slug', async (req, res) => {
  const { slug } = req.params;
  const q = (sql, p = []) => new Promise((ok, no) => db.query(sql, p, (e, r) => e ? no(e) : ok(r)));

  try {
    const [category] = await q(
      `SELECT id, label, slug, image AS image_url
       FROM api_categories
       WHERE slug = ? AND active = 1 AND section = 'apps'
       LIMIT 1`, [slug]
    );
    if (!category) return res.status(404).send('Category not found');

    const selected = await q(
      `SELECT * FROM selected_api_products WHERE active = 1 AND category = ?`,
      [slug]
    );
    const map = new Map(selected.map(p => [Number(p.product_id), p]));

    const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
    const apiProducts = await getCachedAPIProducts();

    const products = apiProducts
      .filter(p => map.has(p.id))
      .map(p => {
        const c = map.get(p.id);
        const isQty = c.variable_quantity === 1;
        return {
          id: p.id,
          name: c.custom_name || p.name,
          image: c.custom_image || p.image || '/images/default-product.png',
          price: isQty ? null : Number(c.custom_price || p.price),
          variable_quantity: isQty,
          requires_player_id: (c.player_check ?? p.player_check) ? 1 : 0,
          is_out_of_stock: c.is_out_of_stock === 1
        };
      });

    res.render('api-category-list', {
      user: req.session.user || null,
      category: { ...category, image_url: category.image_url || '/images/default-category.png' },
      products
    });
  } catch (err) {
    console.error('Load /apps/:slug error:', err);
    res.status(500).send('Failed to load category products');
  }
});

// Flush API cache
app.get('/admin/dev/flush-api-cache', checkAdmin, async (req, res) => {
  try {
    // لو عندك كاش داخلي بالذاكرة
    if (global.__apiProductsCache) global.__apiProductsCache = null;

    // ولو بتستخدم ملف/خانة كاش… امسحه هنا لو موجود
    res.send({ ok: true, flushed: true });
  } catch (e) {
    res.status(500).send({ ok: false, error: e.message });
  }
});

app.get('/admin/dev/list-quantity', checkAdmin, async (req, res) => {
  try {
    // احصل على نسخة "طازة" من دون كاش
    const products = await getCachedAPIProducts(/* fresh = */ true);
    const list = (products || [])
      .filter(p => (p.product_type === 'quantity'))
      .map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        category_id: p.parent_id || null,
        player_check: !!p.player_check
      }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/dev/find-product/:id', checkAdmin, async (req, res) => {
  try {
    const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
    const list = await getCachedAPIProducts();
    const id = Number(req.params.id);
    const product = list.find(p => p.id === id);
    res.json({ found: !!product, product: product || null });
  } catch (e) {
    res.status(500).json({ found: false, error: e.message });
  }
});


const makeSyncJob = require('./jobs/syncProviderOrders');
const syncJob = makeSyncJob(db, promisePool);

setInterval(() => {
  if (isMaintenance()) {
    // ما نعمل sync خلال الصيانة لتوفير موارد
    return;
  }
  syncJob().catch(() => {});
}, 2 * 60 * 1000);

app.get('/admin/dev/sync-now', checkAdmin, async (req, res) => {
  if (isMaintenance()) {
    return res.status(503).send('⛔ Maintenance window — try after it ends.');
  }
  try {
    await syncJob();
    res.send('✅ Sync done');
  } catch (e) {
    res.status(500).send('❌ Sync error: ' + e.message);
  }
});




// =============================================
//                  START SERVER
// =============================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);

syncSMM();
setInterval(syncSMM, 12 * 60 * 60 * 1000);

   console.log("🔑 API KEY:", process.env.DAILYCARD_API_KEY ? "Loaded" : "Missing");
console.log("🔐 API SECRET:", process.env.DAILYCARD_API_SECRET ? "Loaded" : "Missing");

console.log("✅ Test route registered at /test");
});

