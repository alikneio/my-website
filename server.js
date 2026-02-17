console.log("🟢 Server starting...");

 // دايمًا بالبداية
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const axios = require('axios');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const shahidApi = require("./services/shahidApi");





// ثالثاً: تحديد PORT بعد تحميل dotenv
const PORT = process.env.PORT || 3000;

// بعدها استورد أي شيء بيحتاج PORT أو ENV
const { dailycardAPI, verifyPlayerId } = require('./services/dailycard');
const { v4: uuidv4 } = require('uuid');
// 🔽 عدّل هول:
const { getSmmServices, createSmmOrder, getSmmOrderStatus } = require('./services/smmgen');

// (رح نرجع لـ syncSMM بعد شوي)
const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
const sendOrderStatusTelegram = require('./utils/sendOrderStatusTelegram');
const sendTelegramMessage = require('./utils/sendTelegramNotification');
const uploadNone = multer();
const crypto = require('crypto');
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");






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
const makeSyncJob = require('./jobs/syncProviderOrders');
const syncJob = makeSyncJob(db, promisePool);



// ===============================
//  User Levels & Discounts System
// ===============================

// حساب مستوى المستخدم والخصم بناءً على total_spent
async function recalcUserLevel(userId) {
  try {
    const [[row]] = await promisePool.query(
      "SELECT total_spent FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    const spent = Number(row?.total_spent || 0);
    let level = 1;

    if (spent >= 100 && spent < 500) level = 2;
    else if (spent >= 500 && spent < 1500) level = 3;
    else if (spent >= 1500 && spent < 5000) level = 4;
    else if (spent >= 5000) level = 5;

    // ✅ نحدّث level فقط (ما نلمس discount_percent نهائياً)
    await promisePool.query(
      "UPDATE users SET level = ? WHERE id = ?",
      [level, userId]
    );

    return { level };
  } catch (err) {
    console.error("❌ recalcUserLevel error:", err.message || err);
    return null;
  }
}

// ❷ احسب الخصم الفعلي للمستخدم (VIP + Level بنفس الوقت)
function getUserEffectiveDiscount(user) {
  if (!user) return 0;

  // (A) أولوية 1: خصم يدوي VIP محفوظ في users.discount_percent
  const manual = Number(user.discount_percent || 0);
  if (Number.isFinite(manual) && manual > 0) {
    return manual;
  }

  // (B) أولوية 2: خصم حسب LEVEL
  const level = Number(user.level || 1);
  let levelDiscount = 0;

  // عدّل الأرقام حسب النظام اللي بدك ياه
  if (level === 2) levelDiscount = 2;
  else if (level === 3) levelDiscount = 4;
  else if (level === 4) levelDiscount = 6;
  else if (level >= 5) levelDiscount = 10; // مثال: لفل 5 وما فوق 8%

  return levelDiscount;
}

// ❸ دالة مساعدة لتطبيق خصم المستخدم على سعر واحد (تستعمل في /buy و غيره)
function applyUserDiscount(rawPrice, user) {
  const price = Number(rawPrice || 0);
  if (!Number.isFinite(price) || price <= 0) return 0;

  const discount = getUserEffectiveDiscount(user);
  if (!discount || discount <= 0) {
    return Number(price.toFixed(2));
  }

  const discounted = price - (price * (discount / 100));
  return Number(discounted.toFixed(2));
}

// ❹ تطبيق الخصم على List من الـ products (تُستخدم في صفحات المنتجات)
function applyUserDiscountToProducts(products, user) {
  const discRaw = getUserEffectiveDiscount(user);
  const disc = Number(discRaw);

  // دايمًا رجّع Array جديدة (ما ترجع نفس المرجع)
  if (!Array.isArray(products)) return [];

  // خصم غير صالح أو 0 → رجّع نسخة بدون تعديل
  if (!Number.isFinite(disc) || disc <= 0) {
    return products.map(p => ({ ...p }));
  }

  // clamp: ما نخلي الخصم أكتر من 100
  const safeDisc = Math.min(Math.max(disc, 0), 100);

  return products.map(p => {
    // تأكد p object
    if (!p || typeof p !== 'object') return p;

    const base = Number(
      p.price ??
      p.unit_price ??
      p.custom_price ??
      0
    );

    // إذا السعر مش صالح أو <=0 رجّع المنتج بدون ما تغيّر عليه
    if (!Number.isFinite(base) || base <= 0) {
      return { ...p };
    }

    const final = Number(((base * (100 - safeDisc)) / 100).toFixed(2));

    // رجّع object جديد مع الحفاظ على باقي الحقول مثل is_out_of_stock
    return {
      ...p,
      original_price: base,
      effective_discount: safeDisc,
      price: final
    };
  });
}






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

const checkAuthJson = (req, res, next) => {
  if (req.session?.user) return next();
  return res.status(401).json({ success: false, message: "Session expired. Please log in.", data: null });
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

app.use(async (req, res, next) => {
  // user متوفر لكل الصفحات
  res.locals.user = req.session.user || null;

  // defaults (حتى ما يطلع undefined بالـ EJS)
  res.locals.pendingBalanceRequestsCount = 0;      // للأدمن (كل الموقع)
  res.locals.pendingBalanceCount = 0;              // للمستخدم (طلباته هو)
  res.locals.unreadCount = 0;                      // إذا بدك (notifications)

  try {
    // إذا المستخدم مسجّل دخول
    if (req.session.user?.id) {
      const userId = req.session.user.id;

      // ✅ unread notifications للمستخدم + pending balance requests للمستخدم
      // (إذا ما بدك notifications شيل أول SELECT)
      const [[rowUser]] = await promisePool.query(
        `
        SELECT
          (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = FALSE) AS unreadCount,
          (SELECT COUNT(*) FROM balance_requests WHERE user_id = ? AND status = 'pending') AS pendingBalanceCount
        `,
        [userId, userId]
      );

      res.locals.unreadCount = Number(rowUser?.unreadCount || 0);
      res.locals.pendingBalanceCount = Number(rowUser?.pendingBalanceCount || 0);
    }

    // ✅ عداد الأدمن (كل الطلبات pending)
    if (req.session.user?.role === 'admin') {
      const [[rowAdmin]] = await promisePool.query(
        `SELECT COUNT(*) AS cnt FROM balance_requests WHERE status = 'pending'`
      );
      res.locals.pendingBalanceRequestsCount = Number(rowAdmin?.cnt || 0);
    }
  } catch (err) {
    console.error("❌ locals middleware error:", err);
  }

  next();
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

function getUserEffectiveDiscount(user) {
  if (!user) return 0;

  // ✅ VIP manual discount إذا موجود
  const manual = Number(user.discount_percent || 0);
  if (Number.isFinite(manual) && manual > 0) return manual;

  // ✅ غير هيك خصم حسب level
  const level = Number(user.level || 1);
  if (level === 2) return 2;
  if (level === 3) return 4;
  if (level === 4) return 6;
  if (level >= 5) return 8;

  return 0;
}




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
app.get('/transactions', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  const qStr  = (req.query.q || '').toString().trim().slice(0, 60);
  const typeQ = (req.query.type || '').toString().trim().toLowerCase();
  const page  = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 10), 100);
  const offset = (page - 1) * limit;

  try {
    // 🔎 1) اكتشف الأعمدة الموجودة بجدول transactions
    const [cols] = await promisePool.query(`SHOW COLUMNS FROM transactions`);
    const colNames = new Set(cols.map(c => c.Field));

    // user column (user_id أو userId)
    const userCol = colNames.has('user_id') ? 'user_id' : (colNames.has('userId') ? 'userId' : null);
    if (!userCol) throw new Error('transactions table missing user_id/userId column');

    // date column (حسب الموجود عندك)
    const dateCandidates = ['date', 'createdAt', 'created_at', 'time', 'timestamp'];
    const dateCol = dateCandidates.find(c => colNames.has(c));
    if (!dateCol) throw new Error('transactions table missing a date column (date/createdAt/...)');

    // 🔎 2) Filters
    const where = [`${userCol} = ?`];
    const params = [userId];

    if (typeQ && colNames.has('type') && ['debit', 'credit', 'refund'].includes(typeQ)) {
      if (typeQ === 'refund') {
        where.push(`(LOWER(type) = 'refund' OR LOWER(reason) LIKE '%refund%')`);
      } else {
        where.push(`LOWER(type) = ?`);
        params.push(typeQ);
      }
    }

    if (qStr && colNames.has('reason')) {
      where.push(`LOWER(reason) LIKE ?`);
      params.push(`%${qStr.toLowerCase()}%`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    // 🔢 3) Count
    const [countRows] = await promisePool.query(
      `SELECT COUNT(*) AS c FROM transactions ${whereSql}`,
      params
    );
    const total = Number(countRows?.[0]?.c || 0);
    const pages = Math.max(1, Math.ceil(total / limit));

    // 📄 4) List (مهم: alias للتاريخ إلى tx_date)
    const listSql = `
      SELECT
        ${colNames.has('id') ? 'id,' : ''}
        ${colNames.has('type') ? 'type,' : `'debit' AS type,`}
        ${colNames.has('amount') ? 'amount,' : '0 AS amount,'}
        ${colNames.has('reason') ? 'reason,' : "'' AS reason,"}
        ${dateCol} AS tx_date
      FROM transactions
      ${whereSql}
      ORDER BY ${dateCol} DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await promisePool.query(listSql, [...params, limit, offset]);

    return res.render('transactions', {
      user: req.session.user || null,
      transactions: rows,
      meta: { total, page, pages, limit, q: qStr, type: typeQ }
    });

  } catch (err) {
    console.error('❌ GET /transactions error:', err);
    return res.status(500).send(`<pre>${String(err?.message || err)}</pre>`);
  }
});

// ✅ My Balance page
app.get('/my-balance', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  try {
    // ✅ آخر بيانات المستخدم (رصيد/level/discount/total_spent)
    const [[userRow]] = await promisePool.query(
      `SELECT id, username, balance, level, discount_percent, total_spent
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );

    // ✅ طلبات التعبئة للمستخدم
    const [requests] = await promisePool.query(
      `SELECT id, amount, currency, proof_image, status, admin_note, created_at
       FROM balance_requests
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 200`,
      [userId]
    );

    // ✅ Stats صغيرة للواجهة
    const stats = requests.reduce((acc, r) => {
      const amt = Number(r.amount || 0);
      acc.total++;
      acc.byStatus[r.status] = (acc.byStatus[r.status] || 0) + 1;
      if (r.status === 'approved') acc.approvedSum += amt;
      if (r.status === 'pending') acc.pendingSum += amt;
      return acc;
    }, { total: 0, approvedSum: 0, pendingSum: 0, byStatus: {} });

    return res.render('my-balance', {
      user: userRow || req.session.user,
      requests,
      stats
    });

  } catch (err) {
    console.error('❌ GET /my-balance error:', err);
    return res.status(500).send('Server error');
  }
});

app.get('/admin/balance-requests', checkAdmin, async (req, res) => {
  const status = (req.query.status || '').trim(); // pending / approved / rejected

  try {
    const params = [];
    let where = '';

    if (['pending', 'approved', 'rejected'].includes(status)) {
      where = 'WHERE br.status = ?';
      params.push(status);
    }

    const [requests] = await promisePool.query(
      `
      SELECT br.*, u.username
      FROM balance_requests br
      JOIN users u ON u.id = br.user_id
      ${where}
      ORDER BY br.id DESC
      LIMIT 500
      `,
      params
    );

    res.render('admin-balance-requests', { requests, statusFilter: status });
  } catch (err) {
    console.error("GET /admin/balance-requests:", err);
    res.status(500).send("Server error");
  }
});



app.get('/test', (req, res) => {
  res.send("Test is working ✅");
});



app.post('/telegram/link', (req, res) => {
  const userId = req.session?.user?.id;
  const code = String(req.body?.code || '').trim();

  if (!userId) return res.status(401).send("❌ Please login first.");
  if (!/^\d{6}$/.test(code)) return res.status(400).send("❌ Invalid code.");

  db.query(
    "SELECT chat_id, expires_at FROM telegram_link_codes WHERE code=? LIMIT 1",
    [code],
    (err, rows) => {
      if (err) return res.status(500).send("❌ Database error.");
      if (!rows || rows.length === 0) return res.status(400).send("❌ Code not found.");

      const { chat_id, expires_at } = rows[0];
      if (Date.now() > new Date(expires_at).getTime()) {
        return res.status(400).send("❌ Code expired. Go back to the bot and /start again.");
      }

      db.query(
        "UPDATE users SET telegram_chat_id=? WHERE id=?",
        [chat_id, userId],
        (err2) => {
          if (err2) return res.status(500).send("❌ Failed to link Telegram.");

          db.query("DELETE FROM telegram_link_codes WHERE code=?", [code], () => {});
          return res.send("✅ Telegram linked successfully!");
        }
      );
    }
  );
});

app.post('/add-balance/whish/usd', upload.single('proofImage'), (req, res) => {
  const { amount } = req.body;
  const userId = req.session.user.id;
  const currency = 'USD';
  const proofImage = req.file?.filename;

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

    db.query(insertBalanceSql, [userId, amount, currency, proofImage], async (balanceErr) => {
      if (balanceErr) {
        console.error('Error saving USD balance request:', balanceErr);
        return res.status(500).send('Internal server error.');
      }

      // إرسال إشعار عبر تلغرام للأدمن (via RELAY)
      try {
        const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || '2096387191';
        const username = req.session.user?.username || userId;

        let msg =
          `📥 *New Balance Top-up Request*\n\n` +
          `👤 User: ${username}\n` +
          `💰 Amount: ${amount} ${currency}`;

        if (proofImage) {
          const imageUrl = `https://akcell.store/uploads/whish/${proofImage}`;
          msg += `\n🖼 [Proof Image](${imageUrl})`;
        }

        // ✅ Relay sender (no direct api.telegram.org)
        await sendTelegramMessage(
          adminChatId,
          msg,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: 'Markdown', timeoutMs: 15000 }
        );
      } catch (err) {
        console.error('Error sending Telegram message (via relay):', err?.message || err);
        // لا توقف العملية لو فشل التلغرام
      }

      // بعد كل شيء تمام، رجع المستخدم لصفحة الشكر
      return res.redirect('/thank-you');
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
  const proofImage = req.file?.filename; // ✅ ما يكسر إذا ما في ملف

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

    db.query(insertBalanceSql, [userId, amount, currency, proofImage], async (balanceErr) => {
      if (balanceErr) {
        console.error('Error saving LBP balance request:', balanceErr);
        return res.status(500).send('Internal server error.');
      }

      // إشعار تلغرام للأدمن (via RELAY)
      try {
        const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || '2096387191';
        const username = req.session.user?.username || userId;

        let msg =
          `📥 *New Balance Top-up Request*\n\n` +
          `👤 User: ${username}\n` +
          `💰 Amount: ${amount} ${currency}`;

        if (proofImage) {
          const imageUrl = `https://akcell.store/uploads/whish/${proofImage}`;
          msg += `\n🖼 [Proof Image](${imageUrl})`;
        }

        await sendTelegramMessage(
          adminChatId,
          msg,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: 'Markdown', timeoutMs: 15000 }
        );
      } catch (err) {
        console.error('Error sending Telegram message (LBP via relay):', err?.message || err);
        // لا نوقف العملية
      }

      // تحويل المستخدم لصفحة الشكر
      return res.redirect('/thank-you');
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



app.post("/telegram/webhook", express.json(), (req, res) => {
  console.log("📩 TG update received:", req.body?.message?.text || req.body?.callback_query?.data);
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("❌ webhook error:", e.message);
    res.sendStatus(500);
  }
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


  const q = (sql, params = []) => new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
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
  const user = req.session.user || null;

  const sql = `
    SELECT *
    FROM products
    WHERE sub_category = 'Netflix High Quality'
    ORDER BY sort_order ASC, id ASC
  `;

  db.query(sql, [], (err, products) => {
    if (err) {
      console.error('❌ Netflix HQ fetch error:', err.message || err);
      return res.status(500).send('Server error');
    }

    // ⛔ ما نغير منطق الخصم
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('netflixH-section', {
      user,
      products: finalProducts
    });
  });
});


app.get('/windows-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'Windows key'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (windows-section):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('windows-section', { user, products: finalProducts });
  });
});

app.get('/office-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'Microsoft office keys'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (office-section):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('office-section', { user, products: finalProducts });
  });
});

app.get('/roblox', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'Roblox Cards'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (roblox):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('roblox', { user, products: finalProducts });
  });
});

app.get('/cyberghost', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'Cyber Ghost'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (cyberghost):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('cyberghost', { user, products: finalProducts });
  });
});

app.get('/telegramstars', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'Telegram Stars'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (telegramstars):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('telegramstars', { user, products: finalProducts });
  });
});

app.get('/spotifyN-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'Spotify Normal Quality'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (spotifyN-section):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('spotifyN-section', { user, products: finalProducts });
  });
});

app.get('/spotifyH-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'Spotify High Quality'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (spotifyH-section):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('spotifyH-section', { user, products: finalProducts });
  });
});

app.get('/netflixL-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'Netflix Normal Quality'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (netflixL-section):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('netflixL-section', { user, products: finalProducts });
  });
});

app.get('/iptv-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE sub_category = 'IPTV'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (iptv-section):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('iptv-section', { user, products: finalProducts });
  });
});

app.get('/touch-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Communication' AND sub_category = 'Touch'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (touch-section):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('touch-section', { user, products: finalProducts });
  });
});

app.get('/alfa-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Communication' AND sub_category = 'Alfa'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (alfa-section):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('alfa-section', { user, products: finalProducts });
  });
});

app.get('/u-share', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Communication' AND sub_category = 'Alfa U-share'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Database error (u-share):", err.message || err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('u-share', { user, products: finalProducts });
  });
});



app.get('/my-orders', checkAuth, (req, res) => {
  const userId = req.session.user.id;

  const from   = (req.query.from || '').trim();
  const to     = (req.query.to   || '').trim();
  const q      = (req.query.q    || '').trim();
  const status = (req.query.status || 'all').trim();

  const params = [userId];
  let where = 'WHERE o.userId = ?';

  // فلتر التاريخ من/إلى
  if (from) {
    where += ' AND o.purchaseDate >= ?';
    params.push(from + ' 00:00:00');
  }
  if (to) {
    where += ' AND o.purchaseDate <= ?';
    params.push(to + ' 23:59:59');
  }

  // بحث بالـ ID أو الاسم
  if (q) {
    where += ' AND (o.id = ? OR o.productName LIKE ?)';
    params.push(q, `%${q}%`);
  }

  const sql = `
    SELECT
      o.id,
      o.productName,
      o.price,
      o.purchaseDate,
      o.status,
      o.order_details,
      o.provider,
      o.provider_order_id,

      so.provider_status,
      so.delivered_qty,
      so.remains_qty,
      so.quantity AS smm_quantity
    FROM orders o
    LEFT JOIN smm_orders so
      ON so.provider_order_id = o.provider_order_id
    ${where}
    ORDER BY o.id DESC
    LIMIT 300
  `;

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error('❌ /my-orders error:', err.message);
      return res.status(500).send('Server error');
    }

    // نعمل status نهائي لكل طلب
    const allOrders = rows.map(row => {
      let displayStatus = row.status || 'Waiting';

      // فقط طلبات SMM
      if (row.provider === 'smm' && row.provider_status) {
        const ps = String(row.provider_status).toLowerCase();

        if (ps === 'completed' || ps === 'completedpartial') {
          displayStatus = 'Accepted';
        } else if (ps === 'partial') {
          displayStatus = 'Partial';
        } else if (ps === 'canceled' || ps === 'cancelled' || ps === 'refunded') {
          displayStatus = 'Rejected';
        } else if (ps === 'processing' || ps === 'in progress' || ps === 'pending') {
          displayStatus = 'In progress';
        } else {
          displayStatus = 'Waiting';
        }
      }

      return {
        ...row,
        displayStatus
      };
    });

    // فلتر الحالة (بعد ما نحسب displayStatus)
    const filteredOrders =
      status === 'all'
        ? allOrders
        : allOrders.filter(o => (o.displayStatus || 'Waiting') === status);

    // المجموع
    const total = filteredOrders.reduce(
      (sum, o) => sum + (Number(o.price) || 0),
      0
    );

    res.render('my-orders', {
      user: req.session.user,
      orders: filteredOrders,
      total,
      filters: { from, to, q, status }
    });
  });
});



app.get('/checkout/:id', checkAuth, (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const error = req.query.error || null;

  const sql = "SELECT * FROM products WHERE id = ?";

  db.query(sql, [productId], (err, results) => {
    if (err || !results || results.length === 0) {
      return res.status(404).send('❌ Product not found.');
    }

    const user = req.session.user || null;
    const product = results[0];
    product.source = 'sql';

    // (اختياري) legacy out_of_stock column
    if (Object.prototype.hasOwnProperty.call(product, 'is_out_of_stock')) {
      const oos = Number(product.is_out_of_stock) === 1 || product.is_out_of_stock === true;
      if (oos) return res.status(403).send('This product is currently out of stock.');
    }

    // رسائل الخطأ
    let errorMessage = '';
    if (error === 'balance') errorMessage = 'Insufficient balance.';
    else if (error === 'server') errorMessage = 'Server error during purchase. Please try again.';

    // ملاحظات المنتج
    const notes = (product.notes && String(product.notes).trim() !== '') ? String(product.notes).trim() : null;

    // خصم السعر بالـ checkout
    const originalPrice = Number(product.price || 0);
    const finalPrice = applyUserDiscount(originalPrice, user);

    product.original_price = Number.isFinite(originalPrice) ? Number(originalPrice.toFixed(2)) : 0;
    product.price = finalPrice;

    // idempotency key
    const idemKey = uuidv4();
    req.session.idemKey = idemKey;

    // ===== Hybrid: stock availability =====
    const deliveryMode = (product.delivery_mode || 'manual').toString();
    product.delivery_mode = deliveryMode;

    if (deliveryMode !== 'stock') {
      return res.render('checkout', {
        user,
        product,
        error: errorMessage,
        notes,
        idemKey,
        effectiveDiscount: (user ? getUserEffectiveDiscount(user) : 0)
      });
    }

    const stockSql = `
      SELECT 1
      FROM product_stock_items
      WHERE product_id = ? AND status = 'available'
      LIMIT 1
    `;

    db.query(stockSql, [productId], (stockErr, stockRows) => {
      // إذا فشل query، نخليه false بس منضل نسمح بالشراء (رح يصير Pending)
      product.in_stock = (!stockErr && stockRows && stockRows.length > 0);

      return res.render('checkout', {
        user,
        product,
        error: errorMessage,
        notes,
        idemKey,
        effectiveDiscount: (user ? getUserEffectiveDiscount(user) : 0)
      });
    });
  });
});


app.get('/api-checkout/:id', checkAuth, async (req, res) => {
  const productId = parseInt(req.params.id, 10);
  const error = req.query.error || null;

  const query = (sql, params) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    const user = req.session.user || null;

    // 1) جلب المنتج
    const sqlSel = "SELECT * FROM selected_api_products WHERE product_id = ? AND active = 1";
    const results = await query(sqlSel, [productId]);

    if (!results || results.length === 0) {
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

    // السعر الخام (قبل الخصم)
    const rawUnitPrice = parseFloat(product.custom_price || product.unit_price || 0) || 0;

    // ✅ الخصم الفعلي (VIP أو Level)
    const effectiveDiscount = getUserEffectiveDiscount(user);

    // ✅ تطبيق الخصم حسب نوع المنتج
    const fixedFinalPrice = !isQuantity
      ? applyUserDiscount(rawUnitPrice, user)
      : null;

    const discountedUnitPrice = isQuantity
      ? applyUserDiscount(rawUnitPrice, user)
      : undefined;

    const productData = {
      id: product.product_id,
      name: product.custom_name || 'API Product',
      image: product.custom_image || '/images/default-product.png',

      // FIXED: السعر بعد الخصم
      price: isQuantity ? null : Number(fixedFinalPrice).toFixed(2),

      // QUANTITY: unit_price بعد الخصم
      unit_price: isQuantity ? Number(discountedUnitPrice) : undefined,

      unit_quantity: unitQty,
      min_quantity: minQty,
      max_quantity: maxQty,

      requires_player_id: Number(product.player_check) === 1,
      requires_verification: Number(product.requires_verification) === 1,
      variable_quantity: isQuantity,
      unit_label: isQuantity ? (product.unit_label || 'units') : undefined,

      // (اختياري للعرض)
      original_unit_price: Number(rawUnitPrice.toFixed(2)),
      effective_discount: Number(effectiveDiscount || 0)
    };

    // 2.1) حساب أقل كلفة لازمة للطلب (minCost) + canVerify (بعد الخصم)
    const floor = Number(process.env.VERIFY_BALANCE_FLOOR || 0) || 0;
    let minCost = 0;

    if (isQuantity) {
      const uPrice = applyUserDiscount(rawUnitPrice, user); // ✅ بعد الخصم
      const uQty   = Math.max(1, parseInt(product.unit_quantity || 1, 10));
      const mQty   = Math.max(1, parseInt(product.min_quantity || 1, 10));
      const blocks = Math.ceil(mQty / uQty);
      minCost = parseFloat((blocks * uPrice).toFixed(2));
    } else {
      minCost = applyUserDiscount(rawUnitPrice, user); // ✅ بعد الخصم

      // fallback لو السعر صفر
      if (minCost === 0) {
        try {
          const list = await getCachedAPIProducts();
          const apiItem = list.find(p => Number(p.id) === Number(productId));
          if (apiItem) minCost = applyUserDiscount(Number(apiItem.price) || 0, user);
        } catch (_) { /* ignore */ }
      }
    }

    minCost = Math.max(minCost, floor);

    const userBalance = Number(req.session.user?.balance || 0);
    const canVerify = userBalance >= minCost;

    // 3) ولادة idempotency_key وتمريره للواجهة
    const idemKey = uuidv4();
    req.session.idemKey = idemKey;

    const viewData = {
      user,
      product: productData,
      error,
      minCost,
      canVerify,
      idemKey,
      effectiveDiscount
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



function makeSlug(name = '') {
  return (
    String(name)
      .normalize('NFKD')                 // يفكّك الأحرف
      .replace(/[\u0300-\u036f]/g, '')   // يشيل التشكيل
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')       // أي شي غير حرف/رقم → -
      .replace(/^-+|-+$/g, '')           // يشيل - من الأول والآخر
  ) || 'other';
}


app.get('/admin/smm/sync', checkAdmin, async (req, res) => {
  try {
    console.log('🔄 Sync SMM Services Started...');

    const services = await getSmmServices(); // من SMMGEN
    if (!Array.isArray(services)) {
      throw new Error('SMMGEN services response is not an array');
    }

    console.log(`📦 Received ${services.length} services from provider.`);

    // نجلب الكاتيجوري الموجودة
    const existingCats = await query(`
      SELECT id, name
      FROM smm_categories
    `);

    const catMap = new Map(); // name → id
    existingCats.forEach((c) => {
      catMap.set(c.name, c.id);
    });

    // ملاحظة مهمة: هلق ما منعمل UPDATE على name/rate/min/max/category_id/is_active
    const insertCatSql = `
      INSERT INTO smm_categories (name, slug, is_active, sort_order)
      VALUES (?, ?, 0, 0) 
      ON DUPLICATE KEY UPDATE
        name = VALUES(name)
    `;

    const insertServiceSql = `
      INSERT INTO smm_services
        (provider_service_id, category_id, category, name, type, rate, min_qty, max_qty, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
        -- 👇 ما منعدل شي حساس حتى ما نكسر التعديلات اليدوية
        category = VALUES(category)
    `;

    let insertedCount = 0;
    let skippedBadRate = 0;
    let skippedBadBounds = 0;
    let skippedSeparator = 0;

    await query('START TRANSACTION');

    for (const s of services) {
      const catNameRaw = s.category || 'Other';
      const catName = String(catNameRaw).trim() || 'Other';

      // 1) تأكد أن الكاتيجوري موجودة
      let catId = catMap.get(catName);
      if (!catId) {
        const slug = (typeof makeSlug === 'function')
          ? makeSlug(catName)
          : catName.toLowerCase().replace(/\s+/g, '-');

        const result = await query(insertCatSql, [catName, slug]);
        catId = result.insertId || catId;

        if (!catId) {
          const [row] = await query(
            'SELECT id FROM smm_categories WHERE slug = ? LIMIT 1',
            [slug]
          );
          if (row) catId = row.id;
        }

        if (catId) {
          catMap.set(catName, catId);
        } else {
          console.warn('⚠️ Failed to resolve category id for', catName);
          continue;
        }
      }

      // 2) فلترة بيانات الخدمة
      const providerId = Number(s.service);
      const name = String(s.name || '').trim();
      const providerCategory = String(s.category || '').trim();
      const rawRate = Number(s.rate);
      const minQty = Number(s.min);
      const maxQty = Number(s.max);
      const type = String(s.type || 'default');

      // خدمات الفاصل / العناوين
      if (!name || name.startsWith('- <') || /^-+ *<*/.test(name)) {
        skippedSeparator++;
        console.log('⏩ Skipping separator / dummy service:', providerId, name);
        continue;
      }

      if (!providerId) {
        console.log('⏩ Skipping service with invalid provider id:', s.service, name);
        continue;
      }

      const MAX_RATE = 9999999.99;
      if (!Number.isFinite(rawRate) || rawRate <= 0 || rawRate > MAX_RATE) {
        skippedBadRate++;
        console.log('⏩ Skipping service with invalid rate:', {
          providerId,
          name,
          rawRate,
        });
        continue;
      }

      if (
        !Number.isFinite(minQty) ||
        !Number.isFinite(maxQty) ||
        minQty <= 0 ||
        maxQty < minQty
      ) {
        skippedBadBounds++;
        console.log('⏩ Skipping service with invalid min/max:', {
          providerId,
          name,
          minQty,
          maxQty,
        });
        continue;
      }

      const safeRate = rawRate.toFixed(4);

      const params = [
        providerId,        // provider_service_id
        catId,             // category_id (فقط لأول مرة)
        providerCategory,  // category (نص المزود)
        name,              // name (فقط لأول مرة)
        type,              // type
        safeRate,          // rate (فقط لأول مرة)
        minQty,            // min_qty (فقط لأول مرة)
        maxQty,            // max_qty (فقط لأول مرة)
      ];

      await query(insertServiceSql, params);
      insertedCount++;
    }

    await query('COMMIT');

    console.log('✅ SMM Sync done.', {
      inserted: insertedCount,
      skippedBadRate,
      skippedBadBounds,
      skippedSeparator,
    });

    res.send(
      `✔️ Synced SMM services & categories successfully.
       Inserted/updated (new rows): ${insertedCount},
       skipped (rate): ${skippedBadRate},
       skipped (min/max): ${skippedBadBounds},
       skipped (separators): ${skippedSeparator}`
    );
  } catch (err) {
    console.error('❌ SMM Sync Error:', err);
    try {
      await query('ROLLBACK');
    } catch (e) {
      console.error('❌ Failed to rollback SMM sync transaction:', e);
    }
    res.status(500).send('Sync Error');
  }
});



// =============== SOCIAL MEDIA SERVICES (SMMGEN) ===============

app.get('/social-media', async (req, res) => {
  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    const categories = await q(
      `
      SELECT
        c.id,
        c.name,
        c.slug,
        c.sort_order,
        c.is_active,
        COUNT(s.id) AS service_count
      FROM smm_categories c
      LEFT JOIN smm_services s
        ON s.category_id = c.id
       AND s.is_active = 1
      WHERE c.is_active = 1
      GROUP BY
        c.id, c.name, c.slug, c.sort_order, c.is_active
      ORDER BY
        c.sort_order ASC,
        c.name ASC
      `
    );

    // 👈 هون التعديل المهم
    res.render('social-categories', {
      user: req.session.user || null,
      categories,
      smmCategories: categories
    });
  } catch (err) {
    console.error('❌ /social-media error:', err.message);
    res.status(500).send('Server error');
  }
});



// صفحة خدمات كاتيجوري معيّنة
app.get('/social-media/:slug', async (req, res) => {
  const { slug } = req.params;

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  try {
    // الكاتيجوري
    const [cat] = await q(
      `SELECT id, name FROM smm_categories WHERE slug = ? AND is_active = 1`,
      [slug]
    );

    if (!cat) {
      return res.status(404).send('Category not found or inactive');
    }

    // الخدمات ضمن هالكاتيجوري
    const services = await q(
      `
      SELECT *
      FROM smm_services
      WHERE category_id = ?
        AND is_active = 1
      ORDER BY rate ASC
      `,
      [cat.id]
    );

    if (!services.length) {
      return res
        .status(404)
        .send('لا توجد خدمات مفعّلة في هذه الفئة حالياً.');
    }

    res.render('social-services', {
      user: req.session.user || null,
      categoryName: cat.name,
      categorySlug: slug,
      services,
    });
  } catch (err) {
    console.error('❌ /social-media/:slug error:', err.message);
    res.status(500).send('Server error');
  }
});

const { createSmmRefill } = require("./services/smmgen"); // تأكد موجودة مع الباقي

app.post('/order-details/:id/refill.json', checkAuth, async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const userId  = req.session.user?.id;

  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' });
  if (!orderId) return res.status(400).json({ ok: false, message: 'Bad request' });

  const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
  const PENDING_LOCK_MS = 6 * 60 * 60 * 1000; // 6 ساعات (لـ "task not completed")

  try {
    // 1) Load order + ensure ownership + detect SMM via join
    const [[row]] = await promisePool.query(
      `
      SELECT
        o.id,
        o.userId,
        o.productName,
        o.provider_order_id,
        so.status AS smm_status
      FROM orders o
      LEFT JOIN smm_orders so
        ON so.provider_order_id = o.provider_order_id
      WHERE o.id = ? AND o.userId = ?
      LIMIT 1
      `,
      [orderId, userId]
    );

    if (!row) return res.status(404).json({ ok: false, message: 'Order not found' });

    // ✅ شرط: refill فقط لطلبات SMM
    if (!row.smm_status) {
      return res.status(400).json({ ok: false, message: 'Refill is available for SMM orders only' });
    }

    // ✅ لازم provider order id
    if (!row.provider_order_id) {
      return res.status(400).json({ ok: false, message: 'Missing provider order id' });
    }

    // ✅ منع خدمات NO REFILL
    const pname = String(row.productName || '').toUpperCase();
    if (pname.includes('NO REFILL')) {
      return res.status(400).json({ ok: false, message: 'This service does not support refill (NO REFILL)' });
    }

    // 2) Rate limit: once every 5 days (based on our DB logs)
    const [[last]] = await promisePool.query(
      `
      SELECT created_at, status
      FROM smm_refills
      WHERE order_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [orderId]
    );

    if (last?.created_at) {
      const lastMs = new Date(last.created_at).getTime();
      const nextAllowedMs = lastMs + FIVE_DAYS_MS;
      const nowMs = Date.now();

      if (nowMs < nextAllowedMs) {
        const remainingMs = nextAllowedMs - nowMs;

        const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
        const remainingDays  = Math.ceil(remainingHours / 24);

        return res.status(429).json({
          ok: false,
          message: `Refill already requested recently. Try again in ~${remainingDays} day(s) (${remainingHours}h).`,
          refill_next_at: new Date(nextAllowedMs).toISOString(),
          retry_after_seconds: Math.ceil(remainingMs / 1000)
        });
      }
    }

    // 3) Call provider (handle provider-specific errors nicely)
    let providerRefillId = null;

    try {
      // createSmmRefill لازم يكون متسامح:
      // يرجع { refill_id: '...' } أو true أو أي شيء يدل على النجاح
      const result = await createSmmRefill(row.provider_order_id);

      if (result && typeof result === 'object') {
        providerRefillId = result.refill_id || result.refill || result.id || null;
      }
    } catch (err) {
      const msg = String(err?.message || err || '').trim();
      const low = msg.toLowerCase();

      // ✅ مزود: في refill شغال
      if (low.includes('refill task is not completed')) {
        const nextAt = new Date(Date.now() + PENDING_LOCK_MS).toISOString();

        // خزّن محاولة (للتتبع)
        await promisePool.query(
          `
          INSERT INTO smm_refills (order_id, provider_order_id, status)
          VALUES (?, ?, 'pending_provider')
          `,
          [orderId, String(row.provider_order_id)]
        );

        return res.status(409).json({
          ok: false,
          message: 'A refill is already in progress for this order. Please try again later.',
          refill_next_at: nextAt,
          retry_after_seconds: Math.ceil(PENDING_LOCK_MS / 1000)
        });
      }

      // ✅ مزود: الخدمة لا تدعم refill فعليًا
      if (low.includes('refill is disabled')) {
        // اختياري: خزن flag لتخبي زر refill نهائياً لاحقاً
        try {
          await promisePool.query(`UPDATE orders SET refill_disabled = 1 WHERE id = ?`, [orderId]);
        } catch (_) {}

        // خزّن محاولة/حالة
        await promisePool.query(
          `
          INSERT INTO smm_refills (order_id, provider_order_id, status)
          VALUES (?, ?, 'disabled_service')
          `,
          [orderId, String(row.provider_order_id)]
        );

        return res.status(400).json({
          ok: false,
          message: 'Refill is disabled for this service.'
        });
      }

      // أي خطأ آخر من المزود
      return res.status(502).json({
        ok: false,
        message: msg || 'Provider error'
      });
    }

    // 4) Save refill request in our DB
    // إذا عندك عمود provider_refill_id ضيفه، إذا لا موجود عادي رح يفشل؟ لا—نخليه اختياري
    try {
      await promisePool.query(
        `
        INSERT INTO smm_refills (order_id, provider_order_id, status, provider_refill_id)
        VALUES (?, ?, 'requested', ?)
        `,
        [orderId, String(row.provider_order_id), providerRefillId ? String(providerRefillId) : null]
      );
    } catch (_) {
      // fallback إذا ما عندك عمود provider_refill_id
      await promisePool.query(
        `
        INSERT INTO smm_refills (order_id, provider_order_id, status)
        VALUES (?, ?, 'requested')
        `,
        [orderId, String(row.provider_order_id)]
      );
    }

    // (اختياري) append admin_reply
    await promisePool.query(
      `
      UPDATE orders
      SET admin_reply = CONCAT(IFNULL(admin_reply,''), '\n✅ Refill requested successfully')
      WHERE id = ?
      `,
      [orderId]
    );

    // ✅ next allowed time (5 days from now)
    const nextAllowedMs = Date.now() + FIVE_DAYS_MS;

    return res.json({
      ok: true,
      message: 'Refill requested successfully',
      refill_next_at: new Date(nextAllowedMs).toISOString(),
      provider_refill_id: providerRefillId ? String(providerRefillId) : undefined
    });

  } catch (e) {
    console.error('refill.json error:', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});





app.get('/social-checkout/:id', checkAuth, async (req, res) => {
  const userId = req.session.user.id;
  const serviceId = parseInt(req.params.id, 10);

  const { error, msg, min, max, link, qty } = req.query;

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  const [service] = await q(
    `SELECT s.*, c.name AS category_name
     FROM smm_services s
     LEFT JOIN smm_categories c ON c.id = s.category_id
     WHERE s.id = ? AND s.is_active = 1`,
    [serviceId]
  );

  if (!service) {
    return res.redirect('/social-media?error=service_not_found');
  }

  const [userRow] = await q(`SELECT balance FROM users WHERE id = ?`, [userId]);

  // ✅ idempotency key ثابت للمحاولة الحالية
  // إذا في key محفوظ مسبقاً، استعمله. إذا لا، ولّد واحد جديد.
  if (!req.session.checkoutIdemKey) {
    req.session.checkoutIdemKey = crypto.randomUUID();
  }
  const idemKey = String(req.session.checkoutIdemKey).slice(0, 64);

  res.render('social-checkout', {
    user: req.session.user,
    service,
    balance: userRow?.balance || 0,
    error: error || null,
    errorMessage: msg || null,
    rangeMin: min || service.min_qty,
    rangeMax: max || service.max_qty,
    formLink: link || '',
    formQty: qty || '',
    idemKey, // لازم يكون hidden input بالـ view
  });
});

// شراء خدمات السوشيال ميديا
app.post('/buy-social', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  const {
    service_id,
    serviceId,
    link,
    quantity,
    idempotency_key: bodyIdemKey,
  } = req.body;

  const serviceIdNum = parseInt(service_id || serviceId, 10);
  const qty = parseInt(quantity, 10);

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  // ✅ المصدر الوحيد: body (ممنوع fallback من السيشن هون)
  const idemKey = (bodyIdemKey || '').toString().slice(0, 64);

  let total = 0;
  let serviceName = '';
  let providerOrderId = '';
  let orderId = null;

  let refunded = false;
  const doRefund = async (reason) => {
    if (refunded) return;
    if (!(total > 0)) return;
    refunded = true;

    await q(`UPDATE users SET balance = balance + ? WHERE id = ?`, [total, userId]);
    await q(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'credit', ?, ?)`,
      [userId, total, reason]
    );
  };

  try {
    console.log('🟦 /buy-social START', { userId, serviceIdNum, link, qty, idemKey });

    // 1) تحقّق من المدخلات الأساسية (قبل idempotency insert)
    if (!serviceIdNum || !link || !quantity) {
      return res.redirect('/social-media?error=missing_fields');
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=invalid_quantity`);
    }
    if (!idemKey) {
      // ✅ ممنوع تمشي بدون key (هذا اللي كان يفتح باب التكرار)
      return res.redirect(`/social-checkout/${serviceIdNum}?error=missing_idem`);
    }

    // 2) جلب الخدمة (فقط المفعّلة)
    const [service] = await q(
      `SELECT * FROM smm_services WHERE id = ? AND is_active = 1`,
      [serviceIdNum]
    );
    if (!service) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=service_not_found`);
    }
    serviceName = service.name;

    // 3) تحقق min/max
    const minQty = Number(service.min_qty || 0);
    const maxQty = Number(service.max_qty || 0);
    if ((minQty && qty < minQty) || (maxQty && qty > maxQty)) {
      return res.redirect(
        `/social-checkout/${serviceIdNum}?error=range&min=${minQty}&max=${maxQty}`
      );
    }

    // 4) حساب السعر
    const rate = Number(service.rate || 0);
    const ratePer = Number(service.rate_per || 1000) || 1000;
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=pricing`);
    }
    const totalCents = Math.round((qty * rate * 100) / ratePer);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return res.redirect(`/social-checkout/${serviceIdNum}?error=pricing`);
    }
    total = totalCents / 100;

    // ✅ 5) Idempotency gate (مرتبط بالـ order_id)
    // حاول تسجل المفتاح. إذا موجود، جيب order_id وارجع عليه بدل ما تخصم من جديد.
    try {
      await q(
        `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
        [userId, idemKey]
      );
    } catch (e) {
      // duplicate key
      const rows = await q(
        `SELECT order_id FROM idempotency_keys WHERE user_id = ? AND idem_key = ? LIMIT 1`,
        [userId, idemKey]
      );
      const existingOrderId = rows?.[0]?.order_id;

      console.log('⏩ duplicate /buy-social detected', { userId, idemKey, existingOrderId });

      if (existingOrderId) {
        req.session.pendingOrderId = existingOrderId;
      }
      return res.redirect('/processing');
    }

    // 6) خصم رصيد المستخدم (ذري)
    const upd = await q(
      `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
      [total, userId, total]
    );
    if (!upd?.affectedRows) {
      // مهم: إذا ما خصمنا، الأفضل نمسح idempotency record حتى ما يعلّق المحاولة
      await q(
        `DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ? AND order_id IS NULL`,
        [userId, idemKey]
      );
      return res.redirect(`/social-checkout/${serviceIdNum}?error=balance`);
    }

    // 7) سجل معاملة الخصم
    await q(
      `INSERT INTO transactions (user_id, type, amount, reason)
       VALUES (?, 'debit', ?, ?)`,
      [userId, total, `Social Media Service: ${serviceName}`]
    );

    // 8) إنشاء الطلب عند مزوّد SMMGen
    try {
      providerOrderId = await createSmmOrder({
        service: service.provider_service_id,
        link,
        quantity: qty,
      });
      console.log('✅ providerOrderId from SMMGEN:', providerOrderId);
    } catch (apiErr) {
      console.error('❌ SMMGEN API error:', apiErr.message || apiErr);

      await doRefund(`Refund (SMMGEN error): ${serviceName}`);

      // مهم: حذف idempotency record لأن العملية فشلت وما في order_id
      await q(
        `DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ? AND order_id IS NULL`,
        [userId, idemKey]
      );

      return res.redirect(
        `/social-checkout/${serviceIdNum}?error=provider&msg=${encodeURIComponent(
          apiErr.message || 'Provider error'
        )}`
      );
    }

    if (!providerOrderId) {
      await doRefund(`Refund (no provider id): ${serviceName}`);

      await q(
        `DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ? AND order_id IS NULL`,
        [userId, idemKey]
      );

      return res.redirect(`/social-checkout/${serviceIdNum}?error=no_provider_id`);
    }

    // 9) حفظ الطلب في جدول orders
    const orderDetails = `Link: ${link} | Quantity: ${qty}`;
    const insertOrderSql = `
      INSERT INTO orders
        (userId, productName, price, purchaseDate, order_details, status, provider_order_id)
      VALUES
        (?, ?, ?, NOW(), ?, 'Waiting', ?)
    `;

    const insertRes = await q(insertOrderSql, [
      userId,
      serviceName,
      total,
      orderDetails,
      providerOrderId,
    ]);

    orderId = insertRes.insertId || null;

    // 10) حفظ الطلب في جدول smm_orders
    await q(
      `
      INSERT INTO smm_orders
        (user_id, smm_service_id, provider_order_id, status, quantity, charge, link)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `,
      [userId, service.id, providerOrderId, qty, total, link]
    );

    // ✅ 11) ربط idempotency record بالـ orderId (الخطوة الأهم)
    if (orderId) {
      await q(
        `UPDATE idempotency_keys SET order_id = ? WHERE user_id = ? AND idem_key = ? LIMIT 1`,
        [orderId, userId, idemKey]
      );
    }

    // 12) إشعار داخلي
    await q(
      `INSERT INTO notifications (user_id, message, created_at, is_read)
       VALUES (?, ?, NOW(), 0)`,
      [userId, `✅ تم استلام طلب خدمتك (${serviceName}) بنجاح. سيتم تنفيذها قريبًا.`]
    );

    // 13) إشعار تيليغرام (نفس كودك… ما لمست فيه شي)
    try {
      const now = new Date();

      const userRows = await q(
        'SELECT username, telegram_chat_id FROM users WHERE id = ? LIMIT 1',
        [userId]
      );
      const userRow = userRows[0] || {};
      const chatId = userRow.telegram_chat_id;

      if (chatId) {
        const userMsg = `
📥 *تم استلام طلب خدمتك بنجاح*

🧾 *الخدمة:* ${serviceName}
🔢 *الكمية:* ${qty}
💰 *السعر:* ${total}$
📌 *الحالة:* جاري التنفيذ
        `.trim();

        try {
          await sendTelegramMessage(
            chatId,
            userMsg,
            process.env.TELEGRAM_BOT_TOKEN,
            { parseMode: 'Markdown', timeoutMs: 15000 }
          );
        } catch (e) {
          console.warn('⚠️ Failed to send Telegram to user:', e.message || e);
        }
      }

      try {
        const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || '2096387191';
        const adminMsg = `
🆕 <b>طلب سوشيال ميديا جديد!</b>

👤 <b>الزبون:</b> ${userRow.username || userId}
🧾 <b>الخدمة:</b> ${serviceName}
🔢 <b>الكمية:</b> ${qty}
💰 <b>السعر:</b> ${total}$
🔗 <b>الرابط:</b> ${link}
🔢 <b>رقم الطلب عند المزود:</b> ${providerOrderId}
🕒 <b>الوقت:</b> ${now.toLocaleString()}
        `.trim();

        await sendTelegramMessage(
          adminChatId,
          adminMsg,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: 'HTML', timeoutMs: 15000 }
        );
      } catch (e) {
        console.warn('⚠️ Failed to notify admin via Telegram:', e.message || e);
      }
    } catch (e) {
      console.warn('⚠️ Telegram notification flow error (social):', e.message || e);
    }

    // ✅ 14) حفظ رقم الطلب للـ processing
    req.session.pendingOrderId = orderId;

    // ✅ مهم: امسح checkout key حتى الطلب الجاي يكون مفتاح جديد
    req.session.checkoutIdemKey = null;

    return res.redirect('/processing');

  } catch (err) {
    console.error('❌ /buy-social error:', err?.message || err);

    // ✅ إذا ما صار providerOrderId (يعني ما انبعت للمزوّد)، منعمل refund
    // إذا providerOrderId موجود، لا تعمل refund تلقائي (لأن الطلب عند المزود انعمل فعلياً)
    try {
      if (!providerOrderId) {
        await doRefund(`Refund (server error): ${serviceName || 'Social Service'}`);

        // إزالة idempotency record لأنه ما في order_id
        if (idemKey) {
          await q(
            `DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ? AND order_id IS NULL`,
            [userId, idemKey]
          );
        }
      } else {
        // إذا بدك: سجل إشعار للإدمن/لوج قوي هون لأن الطلب عند المزود انعمل
        await q(
          `INSERT INTO notifications (user_id, message, created_at, is_read)
           VALUES (?, ?, NOW(), 0)`,
          [userId, `⚠️ حصل خطأ داخلي بعد إنشاء الطلب عند المزود. رقم المزود: ${providerOrderId}. تواصل مع الدعم.`]
        );
      }
    } catch (e2) {
      console.error('❌ refund/cleanup after error failed:', e2?.message || e2);
    }

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

app.post('/admin/balance-requests/update/:id', checkAdmin, async (req, res) => {
  const requestId = Number(req.params.id);
  const newStatus = String(req.body.status || 'pending');
  const adminNote = String(req.body.admin_note || '').trim();

  if (!['pending', 'approved', 'rejected'].includes(newStatus)) {
    return res.redirect('/admin/balance-requests?error=bad_status');
  }

  const conn = await promisePool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) هات الطلب
    const [[reqRow]] = await conn.query(
      `SELECT id, user_id, amount, status FROM balance_requests WHERE id=? FOR UPDATE`,
      [requestId]
    );
    if (!reqRow) {
      await conn.rollback();
      return res.redirect('/admin/balance-requests?error=not_found');
    }

    const oldStatus = reqRow.status;

    // 2) إذا عم نحاول نوافق وهو أصلاً approved => لا تعمل شي
    if (oldStatus === 'approved' && newStatus === 'approved') {
      await conn.rollback();
      return res.redirect('/admin/balance-requests?info=already_approved');
    }

    // 3) تحديث حالة الطلب
    await conn.query(
      `UPDATE balance_requests
       SET status=?, admin_note=?, admin_id=?, decided_at=NOW()
       WHERE id=?`,
      [newStatus, adminNote, req.session.user.id, requestId]
    );

    // 4) إذا صار approved من حالة غير approved => زيد رصيد المستخدم
    if (newStatus === 'approved' && oldStatus !== 'approved') {
      const amount = Number(reqRow.amount || 0);
      if (amount > 0) {
        await conn.query(
          `UPDATE users SET balance = balance + ? WHERE id=?`,
          [amount, reqRow.user_id]
        );

        // (اختياري) سجل transaction إذا عندك جدول transactions
        // await conn.query(`INSERT INTO transactions (...) VALUES (...)`, [...]);
      }
    }

    await conn.commit();
    return res.redirect('/admin/balance-requests?success=1');

  } catch (err) {
    await conn.rollback();
    console.error("POST /admin/balance-requests/update/:id:", err);
    return res.redirect('/admin/balance-requests?error=server');
  } finally {
    conn.release();
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



// ========== ADMIN – SMM CATEGORIES ==========

/// =============== ADMIN: SMM CATEGORIES ===============

// =============== ADMIN: SMM CATEGORIES ===============
app.get('/admin/smm-categories', checkAdmin, async (req, res) => {
  const user   = req.session.user;
  const search = (req.query.search || '').trim();
  const status = req.query.status || 'all';

  const filters = { search, status };

  try {
    let where = 'WHERE 1=1';
    const params = [];

    // بحث بالاسم + السِلَغ + ID لو كان رقم
    if (search) {
      where += ' AND (name LIKE ? OR slug LIKE ?';
      const like = `%${search}%`;
      params.push(like, like);

      const asId = parseInt(search, 10);
      if (Number.isFinite(asId)) {
        where += ' OR id = ?';
        params.push(asId);
      }
      where += ')';
    }

    // فلتر حالة الكاتيجوري
    if (status === 'active') {
      where += ' AND is_active = 1';
    } else if (status === 'inactive') {
      where += ' AND is_active = 0';
    }

    const categories = await query(
      `
      SELECT id, name, slug, sort_order, is_active
      FROM smm_categories
      ${where}
      ORDER BY sort_order ASC, name ASC
      LIMIT 500
      `,
      params
    );

    const flash = req.session.adminFlash
      ? { type: 'info', message: req.session.adminFlash }
      : null;
    req.session.adminFlash = null;

    res.render('admin-smm-categories', {
      user,
      categories,
      filters,
      flash,
    });
  } catch (err) {
    console.error('❌ /admin/smm-categories error:', err.message);
    res.status(500).send('Internal server error');
  }
});

function slugifyCategory(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')   // anything not letters/numbers → -
    .replace(/^-+|-+$/g, '')       // trim dashes
    || 'category';
}


app.post('/admin/smm-categories/create', checkAdmin, async (req, res) => {
  try {
    const rawName   = (req.body.name || '').trim();
    let sortOrder   = parseInt(req.body.sort_order || '0', 10);
    if (!Number.isFinite(sortOrder)) sortOrder = 0;

    if (!rawName) {
      req.session.adminFlash = 'Category name is required.';
      return res.redirect('/admin/smm-categories');
    }

    let slug = slugifyCategory(rawName);

    await query(
      `
      INSERT INTO smm_categories (name, slug, sort_order, is_active)
      VALUES (?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        name       = VALUES(name),
        sort_order = VALUES(sort_order),
        is_active  = VALUES(is_active)
      `,
      [rawName, slug, sortOrder]
    );

    req.session.adminFlash = 'Category saved successfully.';
    return res.redirect('/admin/smm-categories');
  } catch (err) {
    console.error('❌ /admin/smm-categories/create error:', err.message);
    req.session.adminFlash = 'Error while saving category.';
    return res.redirect('/admin/smm-categories');
  }
});


app.post('/admin/smm-categories/:id/update', checkAdmin, async (req, res) => {
  const catId = parseInt(req.params.id, 10);
  if (!Number.isFinite(catId)) {
    return res.status(400).send('Bad request');
  }

  try {
    const rawName  = (req.body.name || '').trim();
    const rawSlug  = (req.body.slug || '').trim();
    let sortOrder  = parseInt(req.body.sort_order || '0', 10);
    if (!Number.isFinite(sortOrder)) sortOrder = 0;

    if (!rawName) {
      req.session.adminFlash = 'Name cannot be empty.';
      return res.redirect('/admin/smm-categories');
    }

    const slug = rawSlug || slugifyCategory(rawName);

    await query(
      `
      UPDATE smm_categories
      SET name = ?, slug = ?, sort_order = ?
      WHERE id = ?
      LIMIT 1
      `,
      [rawName, slug, sortOrder, catId]
    );

    req.session.adminFlash = 'Category updated.';
    return res.redirect('/admin/smm-categories');
  } catch (err) {
    console.error('❌ /admin/smm-categories/:id/update error:', err.message);
    req.session.adminFlash = 'Update error.';
    return res.redirect('/admin/smm-categories');
  }
});


// UPDATE SMM CATEGORY (name / slug / sort)
app.post('/admin/smm-categories/:id/edit', checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).send('Bad request');
  }

  const { name, slug, sort_order } = req.body;
  const cleanName = (name || '').trim();
  if (!cleanName) {
    req.session.adminFlash = 'Name is required.';
    return res.redirect('/admin/smm-categories');
  }

  const cleanSlug =
    (slug || cleanName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 190) || 'category';

  const sort = parseInt(sort_order || '0', 10) || 0;

  db.query(
    `
    UPDATE smm_categories
    SET name = ?, slug = ?, sort_order = ?
    WHERE id = ? LIMIT 1
    `,
    [cleanName, cleanSlug, sort, id],
    (err) => {
      if (err) {
        console.error('❌ update smm_category:', err.message);
        req.session.adminFlash = 'Failed to update category.';
      } else {
        req.session.adminFlash = 'Category updated.';
      }
      return res.redirect('/admin/smm-categories');
    }
  );
});


app.post('/admin/smm-categories/:id/toggle', checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).send('Bad request');
  }

  db.query(
    'SELECT is_active FROM smm_categories WHERE id = ? LIMIT 1',
    [id],
    (err, rows) => {
      if (err) {
        console.error('❌ toggle smm_category (select):', err.message);
        return res.status(500).send('DB error');
      }
      if (!rows.length) {
        return res.status(404).send('Not found');
      }

      const newStatus = rows[0].is_active ? 0 : 1;

      db.query(
        'UPDATE smm_categories SET is_active = ? WHERE id = ? LIMIT 1',
        [newStatus, id],
        (err2) => {
          if (err2) {
            console.error('❌ toggle smm_category (update):', err2.message);
            return res.status(500).send('DB error');
          }

          req.session.adminFlash = 'Category status updated.';
          return res.redirect('/admin/smm-categories');
        }
      );
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

app.post('/admin/smm-services/:id/update-category', checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  let { category_id } = req.body;

  if (!Number.isFinite(id)) {
    return res.status(400).send('Bad request');
  }

  if (!category_id || category_id === 'none') {
    category_id = null;
  }

  db.query(
    'UPDATE smm_services SET category_id = ? WHERE id = ?',
    [category_id, id],
    (err) => {
      if (err) {
        console.error('❌ update smm_service category:', err.message);
        return res.status(500).send('DB error');
      }

      const qs = new URLSearchParams({
        q: req.query.q || '',
        category_id: req.query.category_id || 'all',
        status: req.query.status || 'all',
      }).toString();

      res.redirect('/admin/smm-services' + (qs ? `?${qs}` : ''));
    }
  );
});



// Admin: SMM Services list
// =============== ADMIN: SMM SERVICES ===============
app.get('/admin/smm-services', checkAdmin, async (req, res) => {
  const search        = (req.query.search || '').trim();
  const categoryId    = req.query.category_id || 'all';
  const status        = req.query.status || 'all';
  const providerCat   = (req.query.provider_cat || '').trim();
  const onlyUncat     = req.query.only_uncategorized === '1';

  const filters = {
    search,
    category_id: categoryId,
    status,
    provider_cat: providerCat,
    only_uncategorized: onlyUncat ? '1' : '0',
  };

  try {
    const params = [];
    let where = 'WHERE 1=1';

    // البحث
    if (search) {
      where += ' AND (s.name LIKE ? OR s.provider_service_id LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like);
    }

    // فلتر الكاتيجوري بالموقع
    if (categoryId !== 'all') {
      where += ' AND s.category_id = ?';
      params.push(categoryId);
    }

    // فلتر الحالة
    if (status === 'active') {
      where += ' AND s.is_active = 1';
    } else if (status === 'inactive') {
      where += ' AND s.is_active = 0';
    }

    // فلتر "فقط بدون كاتيجوري بالموقع"
    if (onlyUncat) {
      where += ' AND (s.category_id IS NULL OR s.category_id = 0)';
    }

    // فلتر provider category (من عمود s.category)
    if (providerCat) {
      where += ' AND s.category = ?';
      params.push(providerCat);
    }

    const services = await query(
      `
      SELECT
        s.*,
        c.name AS category_name,
        s.category AS provider_category
      FROM smm_services s
      LEFT JOIN smm_categories c
        ON s.category_id = c.id
      ${where}
      ORDER BY s.id DESC
      LIMIT 200
      `,
      params
    );

    // كاتيجوري الموقع
    const categories = await query(
      `
      SELECT id, name
      FROM smm_categories
      WHERE is_active = 1
      ORDER BY sort_order, name
      `
    );

    // لستة provider categories مميزة (من عمود category في smm_services)
    const providerCats = await query(
      `
      SELECT DISTINCT category AS provider_category
      FROM smm_services
      WHERE category IS NOT NULL AND category <> ''
      ORDER BY provider_category ASC
      `
    );

    res.render('admin-smm-services', {
      user: req.session.user,
      services,
      categories,
      providerCats,
      filters,
    });
  } catch (err) {
    console.error('❌ /admin/smm-services error:', err);
    res.status(500).send('Server error');
  }
});

// تفعيل / تعطيل سريع
app.get('/admin/smm-services/:id/toggle', checkAdmin, (req, res) => {
  const serviceId = req.params.id;

  db.query(
    `SELECT is_active FROM smm_services WHERE id = ?`,
    [serviceId],
    (err, rows) => {
      if (err) {
        console.error('❌ Toggle error:', err.message);
        return res.status(500).send('Server error');
      }

      if (!rows.length) {
        return res.status(404).send('Service not found');
      }

      const newStatus = rows[0].is_active ? 0 : 1;

      db.query(
        `UPDATE smm_services SET is_active = ? WHERE id = ?`,
        [newStatus, serviceId],
        err2 => {
          if (err2) {
            console.error('❌ Update error:', err2.message);
            return res.status(500).send('Server error');
          }

          return res.redirect('/admin/smm-services');
        }
      );
    }
  );
});

app.post('/admin/smm-services/bulk-assign', checkAdmin, async (req, res) => {
  const categoryId = Number(req.body.bulk_category_id || 0);
  const selected   = (req.body.selected_ids || '').trim(); // "1,2,3"

  if (!categoryId || !selected) {
    // ما في شي مختار → رجع بس
    return res.redirect('/admin/smm-services');
  }

  let ids = selected.split(',')
    .map(id => Number(id.trim()))
    .filter(id => Number.isInteger(id) && id > 0);

  if (!ids.length) {
    return res.redirect('/admin/smm-services');
  }

  try {
    // mysql2 بيفهم IN (?) مع Array
    await query(
      `UPDATE smm_services
       SET category_id = ?
       WHERE id IN (?)`,
      [categoryId, ids]
    );
  } catch (err) {
    console.error('❌ bulk-assign error:', err);
  }

  res.redirect('/admin/smm-services');
});


// دالة مشتركة لتفعيل/تعطيل خدمة SMM
function toggleSmmService(req, res) {
  const serviceId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serviceId)) {
    return res.status(400).send('Bad request');
  }

  db.query(
    'SELECT is_active FROM smm_services WHERE id = ?',
    [serviceId],
    (err, rows) => {
      if (err) {
        console.error('❌ Toggle error (select):', err.message);
        return res.status(500).send('Server error');
      }

      if (!rows.length) {
        return res.status(404).send('Service not found');
      }

      const newStatus = rows[0].is_active ? 0 : 1;

      db.query(
        'UPDATE smm_services SET is_active = ? WHERE id = ?',
        [newStatus, serviceId],
        (err2) => {
          if (err2) {
            console.error('❌ Toggle error (update):', err2.message);
            return res.status(500).send('Server error');
          }

          return res.redirect('/admin/smm-services');
        }
      );
    }
  );
}

app.get('/admin/smm-services/:id/toggle', checkAdmin, toggleSmmService);
app.post('/admin/smm-services/:id/toggle', checkAdmin, toggleSmmService);

// ====== ADMIN: EDIT SINGLE SMM SERVICE ======

app.get('/admin/smm-services/:id/edit', checkAdmin, (req, res) => {
  const serviceId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serviceId)) {
    return res.status(400).send('Bad request');
  }

  const sqlService = 'SELECT * FROM smm_services WHERE id = ? LIMIT 1';
  const sqlCats = `
    SELECT id, name
    FROM smm_categories
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC
  `;

  db.query(sqlService, [serviceId], (err, rows) => {
    if (err) {
      console.error('❌ admin smm edit service:', err.message);
      return res.status(500).send('DB error');
    }
    if (!rows.length) {
      return res.status(404).send('Service not found');
    }
    const service = rows[0];

    db.query(sqlCats, (err2, catRows) => {
      if (err2) {
        console.error('❌ admin smm edit categories:', err2.message);
        return res.status(500).send('DB error');
      }

      res.render('admin-smm-service-edit', {
        user: req.session.user,
        service,
        categories: catRows,
        message: req.query.msg || null,
      });
    });
  });
});


app.post('/admin/smm-services/:id/save', checkAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).send('Bad request');
  }

  const { name, rate, min_qty, max_qty, category_id, is_active } = req.body;

  const catId = category_id && category_id !== '' ? Number(category_id) : null;
  const numericRate = Number(rate || 0);
  const minQ = parseInt(min_qty || '0', 10) || 0;
  const maxQ = parseInt(max_qty || '0', 10) || 0;
  const activeFlag = is_active === '1' || is_active === 'on' ? 1 : 0;

  db.query(
    `
    UPDATE smm_services
    SET
      name       = ?,
      rate       = ?,
      min_qty    = ?,
      max_qty    = ?,
      category_id = ?,
      is_active  = ?
    WHERE id = ?
    `,
    [name.trim(), numericRate, minQ, maxQ, catId, activeFlag, id],
    (err) => {
      if (err) {
        console.error('❌ update smm_service:', err.message);
        return res.redirect('/admin/smm-services?msg=error');
      }
      res.redirect('/admin/smm-services?msg=updated');
    }
  );
});

app.post('/admin/smm-services/:id/edit', checkAdmin, (req, res) => {
  const serviceId = parseInt(req.params.id, 10);
  if (!Number.isFinite(serviceId)) {
    return res.status(400).send('Bad request');
  }

  const {
    name,
    category_id,
    rate,
    rate_per,
    min_qty,
    max_qty,
    is_active,
    average_time,
    notes,

    // ✅ badges
    badge_best_price,
    badge_fast_start,
    badge_refill,
    badge_no_refill,
    badge_low_quality,     // 👈 الجديد
  } = req.body;

  const catId = category_id && category_id !== 'none'
    ? parseInt(category_id, 10)
    : null;

  const numericRate    = Number(rate || 0);
  const numericRatePer = Number(rate_per || 1000) || 1000;
  const minQ           = parseInt(min_qty || '0', 10) || 0;
  const maxQ           = parseInt(max_qty || '0', 10) || 0;
  const activeFlag     = is_active === '1' ? 1 : 0;
  const avgTime        = (average_time || '').trim();
  const cleanNotes     = (notes || '').trim();
  const cleanName      = (name || '').trim();

  // flags
  const bestPriceFlag = badge_best_price ? 1 : 0;
  const fastStartFlag = badge_fast_start ? 1 : 0;
  const refillFlag    = badge_refill ? 1 : 0;
  const noRefillFlag  = badge_no_refill ? 1 : 0;
  const lowQualityFlag= badge_low_quality ? 1 : 0;   // 👈 الجديد

  if (!cleanName || !Number.isFinite(numericRate) || numericRate <= 0) {
    return res.redirect(`/admin/smm-services/${serviceId}/edit?msg=invalid`);
  }

  const sql = `
    UPDATE smm_services
    SET name             = ?,
        category_id      = ?,
        rate             = ?,
        rate_per         = ?,
        min_qty          = ?,
        max_qty          = ?,
        average_time     = ?,
        notes            = ?,
        is_active        = ?,
        badge_best_price = ?,
        badge_fast_start = ?,
        badge_refill     = ?,
        badge_no_refill  = ?,
        badge_low_quality= ?      -- 👈 الجديد
    WHERE id = ?
    LIMIT 1
  `;

  db.query(
    sql,
    [
      cleanName,
      catId,
      numericRate,
      numericRatePer,
      minQ,
      maxQ,
      avgTime,
      cleanNotes,
      activeFlag,
      bestPriceFlag,
      fastStartFlag,
      refillFlag,
      noRefillFlag,
      lowQualityFlag,
      serviceId,
    ],
    err => {
      if (err) {
        console.error('❌ update smm service:', err.message);
        return res.status(500).send('DB error');
      }

      return res.redirect(`/admin/smm-services/${serviceId}/edit?msg=updated`);
    }
  );
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

app.get('/api/out-of-stock', async (req, res) => {
  try {
    const sql = `
      /* 1) API products */
      SELECT CAST(product_id AS CHAR) AS id
      FROM selected_api_products
      WHERE is_out_of_stock = 1

      UNION

      /* 2) Normal products (exclude anything that exists as API product) */
      SELECT CAST(p.id AS CHAR) AS id
      FROM products p
      LEFT JOIN selected_api_products sap
        ON sap.product_id = p.id
      WHERE sap.product_id IS NULL
        AND p.is_out_of_stock = 1
    `;

    db.query(sql, [], (err, rows) => {
      if (err) {
        console.error('❌ OOS API error:', err);
        return res.json([]);
      }
      res.json(rows.map(r => String(r.id)));
    });

  } catch (e) {
    console.error('❌ OOS API fatal error:', e);
    res.json([]);
  }
});


// شراء منتج كمي (نسبي) بدقة سنت 100%
// شراء منتج كمي بدقة سنت 100% + حماية من الخصم المزدوج
// شراء منتج كمي بدقة سنت (Round) + حماية من الخصم المزدوج
app.post('/buy-quantity-product', checkAuth, async (req, res) => {
  const userId = req.session.user?.id;
  if (!userId) return res.redirect('/login?error=session');

  const rawIdemKey = (req.body.idempotency_key || req.session.idemKey || '').toString().slice(0, 64);
  const { productId, quantity, player_id } = req.body;

  const query = (sql, params) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  async function refundProviderOrder(providerOrderId) {
    if (!providerOrderId) return;
    try {
      await dailycardAPI.post('/api-keys/orders/cancel/', { id: providerOrderId });
    } catch (e) {
      console.warn('⚠️ Provider cancel/refund failed (ignored):', e?.message || e);
    }
  }

  try {
    // 0) Idempotency gate
    if (rawIdemKey) {
      try {
        await query(
          `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
          [userId, rawIdemKey]
        );
      } catch (e) {
        // نفس request انبعت قبل -> خليه يروح على processing
        return res.redirect('/processing');
      }
    }

    // ✅ 0.5) Fresh user from DB (بنخليها مثل ما هي حتى ما نخرب منطقك)
    let sessionUser = null;
    try {
      const [[freshUser]] = await promisePool.query(
        'SELECT * FROM users WHERE id = ? LIMIT 1',
        [userId]
      );
      sessionUser = freshUser || req.session.user || null;
      if (freshUser) req.session.user = freshUser;
    } catch (_) {
      sessionUser = req.session.user || null;
    }

    // 1) Fetch product (variable qty)
    const [product] = await query(
      `SELECT * FROM selected_api_products
       WHERE product_id = ? AND active = 1 AND variable_quantity = 1
       LIMIT 1`,
      [productId]
    );
    if (!product) return res.redirect(`/api-checkout/${productId}?error=notfound`);

    if (Number(product.is_out_of_stock) === 1) {
      return res.redirect(`/api-checkout/${productId}?error=out_of_stock`);
    }

    // 2) Validate qty
    const qty = parseInt(quantity, 10);

    const unitQty = Math.max(1, parseInt(product.unit_quantity ?? 1, 10));
    const rawUnitPrice = Number(product.custom_price || product.unit_price || 0) || 0;

    const min = Number.isFinite(parseInt(product.min_quantity, 10)) ? parseInt(product.min_quantity, 10) : 1;
    const max = Number.isFinite(parseInt(product.max_quantity, 10)) ? parseInt(product.max_quantity, 10) : 999999;

    if (!Number.isFinite(qty) || qty < min || qty > max) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_quantity`);
    }
    if (!Number.isFinite(unitQty) || unitQty <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=invalid_unit_qty`);
    }

    // 3) Player ID requirements
    const requiresPlayerId = Number(product.player_check) === 1;
    if (requiresPlayerId && (!player_id || player_id.trim() === '')) {
      return res.redirect(`/api-checkout/${productId}?error=missing_player`);
    }

    if (Number(product.requires_verification) === 1) {
      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        return res.redirect(
          `/api-checkout/${productId}?error=verify&msg=${encodeURIComponent(verifyRes.message || 'Verification failed')}`
        );
      }
    }

    // 4) Base pricing (NO DISCOUNT)
    const baseTotalCents = Math.round((qty * rawUnitPrice * 100) / unitQty);
    if (!Number.isFinite(baseTotalCents) || baseTotalCents <= 0) {
      return res.redirect(`/api-checkout/${productId}?error=pricing`);
    }
    const baseTotal = baseTotalCents / 100;

    // ✅ 5) Final total = base total (NO DISCOUNT)
    const finalTotal = baseTotal;

    // 7) Call provider FIRST
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
      return res.redirect(`/api-checkout/${productId}?error=network`);
    }

    if (!providerOrderId) {
      return res.redirect(`/api-checkout/${productId}?error=order_failed`);
    }

    // 8) Transaction
    const conn = await promisePool.getConnection();
    let insertId = null;

    try {
      await conn.beginTransaction();

      // ✅ خصم ذري من الرصيد (NO DISCOUNT)
      const [updRes] = await conn.query(
        `UPDATE users
            SET balance = balance - ?
          WHERE id = ? AND balance >= ?`,
        [finalTotal, userId, finalTotal]
      );

      if (!updRes?.affectedRows) {
        await conn.rollback();
        await refundProviderOrder(providerOrderId);
        return res.redirect(`/api-checkout/${productId}?error=balance`);
      }

      await conn.query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'debit', ?, ?)`,
        [userId, finalTotal, `Purchase: ${product.custom_name || `API Product ${productId}`}`]
      );

      const orderDetails = player_id
        ? `User ID: ${player_id}, Quantity: ${qty}`
        : `Quantity: ${qty}`;

      const [orderRes] = await conn.query(
        `INSERT INTO orders
          (userId, productName, price, purchaseDate, order_details, status, provider_order_id, provider, source${rawIdemKey ? ', client_token' : ''})
         VALUES
          (?, ?, ?, NOW(), ?, 'Waiting', ?, 'dailycard', 'api'${rawIdemKey ? ', ?' : ''})`,
        rawIdemKey
          ? [userId, product.custom_name || `API Product ${productId}`, finalTotal, orderDetails, providerOrderId, rawIdemKey]
          : [userId, product.custom_name || `API Product ${productId}`, finalTotal, orderDetails, providerOrderId]
      );

      insertId = orderRes.insertId;

      await conn.query(
        `INSERT INTO notifications (user_id, message, created_at, is_read)
         VALUES (?, ?, NOW(), 0)`,
        [userId, `✅ تم استلام طلبك (${product.custom_name || `API Product ${productId}`}) بنجاح. سيتم معالجته قريبًا.`]
      );

      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      await refundProviderOrder(providerOrderId);
      console.error('❌ buy-quantity tx error:', e);
      return res.redirect(`/api-checkout/${productId}?error=server`);
    } finally {
      conn.release();
    }

    // 10) Refresh session after commit
    try {
      const [[freshUserAfter]] = await promisePool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
      if (freshUserAfter) req.session.user = freshUserAfter;
    } catch (_) {}

    // 11) Telegram (after commit) - NO DISCOUNT
    try {
      const [urows] = await promisePool.query(
        'SELECT username, telegram_chat_id FROM users WHERE id = ?',
        [userId]
      );
      const urow = urows[0];

      const productName = product.custom_name || `API Product ${productId}`;

      if (urow?.telegram_chat_id) {
        const userHtmlMsg =
          `📥 <b>تم استلام طلبك بنجاح</b>\n\n` +
          `🛍️ <b>المنتج:</b> ${productName}\n` +
          `🔢 <b>الكمية:</b> ${qty}\n` +
          `💰 <b>السعر:</b> ${Number(finalTotal).toFixed(2)}$\n` +
          `📌 <b>الحالة:</b> جاري المعالجة`;

        await sendTelegramMessage(
          urow.telegram_chat_id,
          userHtmlMsg,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: 'HTML', timeoutMs: 15000 }
        );
      }

      const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || '2096387191';
      if (adminChatId) {
        const adminHtmlMsg =
          `🆕 <b>طلب جديد (API Quantity)!</b>\n` +
          `👤 <b>الزبون:</b> ${urow?.username || userId}\n` +
          `🎁 <b>المنتج:</b> ${productName}\n` +
          `📦 <b>الكمية:</b> ${qty}\n` +
          `💰 <b>السعر:</b> ${Number(finalTotal).toFixed(2)}$\n` +
          `🕓 <b>الوقت:</b> ${new Date().toLocaleString('en-US', { hour12: false })}`;

        await sendTelegramMessage(
          adminChatId,
          adminHtmlMsg,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: 'HTML', timeoutMs: 15000 }
        );
      }
    } catch (e) {
      console.warn('⚠️ Telegram error (buy-quantity):', e.message || e);
    }

    req.session.pendingOrderId = insertId;
    return res.redirect('/processing');

  } catch (err) {
    console.error('❌ Quantity Order Error:', err?.response?.data || err.message || err);
    return res.redirect(`/api-checkout/${productId}?error=server`);
  }
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
  const userId = req.session.user.id;

  db.query(
    "SELECT telegram_chat_id FROM users WHERE id=? LIMIT 1",
    [userId],
    (err, rows) => {
      if (err) {
        console.error("❌ profile telegram fetch:", err.message);
        return res.render('profile', { user: req.session.user, telegramLinked: false });
      }

      const telegramLinked = !!rows?.[0]?.telegram_chat_id;

      // إذا بتحب، حدّث session كمان
      req.session.user.telegram_chat_id = rows?.[0]?.telegram_chat_id || null;

      res.render('profile', {
        user: req.session.user,
        telegramLinked
      });
    }
  );
});

app.post('/profile/link-telegram', checkAuth, (req, res) => {
  const userId = req.session.user.id;
  const code = String(req.body.code || '').trim();

  if (!/^\d{6}$/.test(code)) {
    return res.redirect('/profile?tg=invalid_code');
  }

  db.query(
    "SELECT chat_id, expires_at FROM telegram_link_codes WHERE code=? LIMIT 1",
    [code],
    (err, rows) => {
      if (err) {
        console.error("❌ tg code lookup:", err.message);
        return res.redirect('/profile?tg=db_error');
      }

      if (!rows || rows.length === 0) {
        return res.redirect('/profile?tg=code_not_found');
      }

      const { chat_id, expires_at } = rows[0];
      if (Date.now() > new Date(expires_at).getTime()) {
        return res.redirect('/profile?tg=expired');
      }

      db.query(
        "UPDATE users SET telegram_chat_id=? WHERE id=?",
        [chat_id, userId],
        (err2) => {
          if (err2) {
            console.error("❌ tg link update:", err2.message);
            return res.redirect('/profile?tg=link_failed');
          }

          // احذف الكود بعد الاستعمال
          db.query("DELETE FROM telegram_link_codes WHERE code=?", [code], () => {});
          req.session.user.telegram_chat_id = chat_id;

          return res.redirect('/profile?tg=linked');
        }
      );
    }
  );
});


app.post('/profile/unlink-telegram', checkAuth, (req, res) => {
  const userId = req.session.user.id;

  db.query(
    "UPDATE users SET telegram_chat_id=NULL WHERE id=?",
    [userId],
    (err) => {
      if (err) {
        console.error("❌ tg unlink:", err.message);
        return res.redirect('/profile?tg=unlink_failed');
      }

      req.session.user.telegram_chat_id = null;
      res.redirect('/profile?tg=unlinked');
    }
  );
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

  const sessionUser = req.session.user;
  if (!sessionUser?.id) {
    return res.status(401).json({ success: false, message: 'Session expired. Please log in.' });
  }

  const idemKey = (bodyIdemKey || req.session.idemKey || '').toString().slice(0, 64).trim();

  // Helper to store & return idempotent response
  async function storeIdempotencyResponse(conn, userId, key, payload) {
    if (!key) return;
    const json = JSON.stringify(payload);

    await conn.query(
      `INSERT INTO idempotency_keys (user_id, idem_key, response_json)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE response_json = VALUES(response_json)`,
      [userId, key, json]
    );
  }

  // Helper: if existing response for idemKey exists, return it
  async function returnExistingIdempotentResponse(userId, key) {
    if (!key) return false;

    try {
      const [[row]] = await promisePool.query(
        `SELECT response_json
           FROM idempotency_keys
          WHERE user_id = ? AND idem_key = ?
          LIMIT 1`,
        [userId, key]
      );

      if (row?.response_json) {
        try {
          const payload = JSON.parse(row.response_json);
          return res.json(payload);
        } catch (_) {}
      }
    } catch (_) {}

    return false;
  }

  try {
    // ✅ 0) إذا نفس الطلب تكرر ومعه response مخزنة -> رجّعها فورًا
    const alreadyReturned = await returnExistingIdempotentResponse(sessionUser.id, idemKey);
    if (alreadyReturned) return;

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    // ✅ 0.5) Fresh user from DB
    let freshUser = null;
    try {
      const [[u]] = await promisePool.query(
        'SELECT * FROM users WHERE id = ? LIMIT 1',
        [sessionUser.id]
      );
      freshUser = u || sessionUser;
      if (u) req.session.user = u;
    } catch (_) {
      freshUser = sessionUser;
    }

    // 1) Fetch product
    const [product] = await q(
      'SELECT * FROM products WHERE id = ? AND active = 1 LIMIT 1',
      [productId]
    );
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const deliveryMode = (product.delivery_mode || 'manual').toString().toLowerCase().trim();
    const isStock = deliveryMode === 'stock';

    // 2) Base price
    const basePrice = Number(product.price || 0);
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return res.status(400).json({ success: false, message: 'Pricing error' });
    }

    // 3) Discount + final price
    const effectiveDiscountPercent = (typeof getUserEffectiveDiscount === 'function')
      ? Number(getUserEffectiveDiscount(freshUser) || 0)
      : Number(freshUser.discount_percent || 0) || 0;

    const purchasePrice = applyUserDiscount(basePrice, freshUser);
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      return res.status(400).json({ success: false, message: 'Pricing error' });
    }

    // 4) Order details
    const now = new Date();
    const pId = (playerId && playerId.trim() !== '') ? playerId.trim() : null;

    const conn = await promisePool.getConnection();

    try {
      await conn.beginTransaction();

      // ✅ 5) Idempotency gate INSIDE transaction:
      if (idemKey) {
        try {
          await conn.query(
            `INSERT INTO idempotency_keys (user_id, idem_key, response_json)
             VALUES (?, ?, NULL)`,
            [freshUser.id, idemKey]
          );
        } catch (e) {
          const [[row]] = await conn.query(
            `SELECT response_json
               FROM idempotency_keys
              WHERE user_id = ? AND idem_key = ?
              LIMIT 1`,
            [freshUser.id, idemKey]
          );

          if (row?.response_json) {
            try {
              const payload = JSON.parse(row.response_json);
              await conn.commit();
              return res.json(payload);
            } catch (_) {}
          }

          await conn.rollback();
          return res.status(409).json({
            success: false,
            message: 'Request already in progress. Please wait a moment and refresh.'
          });
        }
      }

      // ===== ✅ STOCK (LOCKED) =====
      let stockItem = null;

      if (isStock) {
        // عمود المخزن عندنا اسمه delivery_text
        const [[item]] = await conn.query(
          `SELECT id, delivery_text
             FROM product_stock_items
            WHERE product_id = ? AND status = 'available'
            ORDER BY id ASC
            LIMIT 1
            FOR UPDATE`,
          [productId]
        );
        stockItem = item || null;
      }

      const shouldAutoDeliver = isStock && !!stockItem;

      // order_details
      const orderDetailsParts = [];
      if (pId) orderDetailsParts.push(`Player ID: ${pId}`);
      if (isStock && !stockItem) {
        orderDetailsParts.push('Auto-delivery: Out of stock — will be processed manually.');
      }
      const orderDetails = orderDetailsParts.length ? orderDetailsParts.join(' | ') : null;

      const initialStatus = shouldAutoDeliver ? 'Accepted' : 'Waiting';

      // ✅ 6) Deduct balance atomically
      const [updRes] = await conn.query(
        `UPDATE users
            SET balance = balance - ?
          WHERE id = ? AND balance >= ?`,
        [purchasePrice, freshUser.id, purchasePrice]
      );

      if (!updRes?.affectedRows) {
        const failPayload = { success: false, message: 'Insufficient balance' };
        await storeIdempotencyResponse(conn, freshUser.id, idemKey, failPayload);
        await conn.rollback();
        return res.status(400).json(failPayload);
      }

      // ✅ 7) Insert order
      // (نفس جدولك بدون أعمدة جديدة)
      const adminReplyAuto = shouldAutoDeliver ? (stockItem.delivery_text || '') : null;

      const [orderResult] = await conn.query(
        `INSERT INTO orders (userId, productName, price, purchaseDate, order_details, status, admin_reply)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [freshUser.id, product.name, purchasePrice, now, orderDetails, initialStatus, adminReplyAuto]
      );
      const orderId = orderResult.insertId;

      // ✅ 8) إذا auto-delivery: علّم item sold + اربط order_id
      if (shouldAutoDeliver) {
        await conn.query(
          `UPDATE product_stock_items
              SET status='sold', sold_at=NOW(), order_id=?
            WHERE id=?`,
          [orderId, stockItem.id]
        );
      }

      // ✅ 9) Notification (user)
      const notifMsg = shouldAutoDeliver
        ? `✅ تم تسليم طلبك (${product.name}) تلقائياً. ادخل على Order Details لرؤية البيانات.`
        : `✅ تم استلام طلبك (${product.name}) بنجاح. سيتم معالجته قريبًا.`;

      await conn.query(
        `INSERT INTO notifications (user_id, message, created_at, is_read)
         VALUES (?, ?, NOW(), 0)`,
        [freshUser.id, notifMsg]
      );

      // ✅ 10) idempotency response payload
      const successPayload = shouldAutoDeliver
        ? { success: true, redirectUrl: `/order-details/${orderId}` }
        : { success: true, redirectUrl: '/processing' };

      await storeIdempotencyResponse(conn, freshUser.id, idemKey, successPayload);

      await conn.commit();

      // ✅ After commit side-effects
      try {
        const [[freshAfter]] = await promisePool.query(
          'SELECT * FROM users WHERE id = ? LIMIT 1',
          [freshUser.id]
        );
        if (freshAfter) req.session.user = freshAfter;
      } catch (sessErr) {
        console.error('⚠️ Failed to refresh session user (buy):', sessErr.message || sessErr);
      }

      req.session.pendingOrderId = orderId;

      // ✅ Telegram (after commit)
      try {
        const [rows] = await promisePool.query(
          'SELECT telegram_chat_id, username FROM users WHERE id = ?',
          [freshUser.id]
        );
        const chatId = rows[0]?.telegram_chat_id;
        const username = rows[0]?.username || freshUser.username;

        if (chatId) {
          const userStatus = shouldAutoDeliver ? 'تم التسليم تلقائياً' : 'جاري المعالجة (Waiting)';
          const msg = `
📥 *طلبك تم تسجيله بنجاح*

🛍️ *المنتج:* ${product.name}
💰 *السعر بعد الخصم:* ${purchasePrice}$
📉 *الخصم الفعلي:* ${effectiveDiscountPercent}%
📌 *الحالة:* ${userStatus}
🧾 *رقم الطلب:* ${orderId}
          `.trim();

          await sendTelegramMessage(
            chatId,
            msg,
            process.env.TELEGRAM_BOT_TOKEN,
            { parseMode: "Markdown", timeoutMs: 15000 }
          );
        }

        const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || '2096387191';
        const adminStatus = shouldAutoDeliver
          ? '✅ Delivered automatically (stock)'
          : (isStock ? '⏳ Pending manual (no stock)' : '⏳ Pending manual');

        const adminMsg = `
🆕 <b>طلب جديد!</b>

👤 <b>الزبون:</b> ${username}
🛍️ <b>المنتج:</b> ${product.name}
💰 <b>السعر بعد الخصم:</b> ${purchasePrice}$
📉 <b>الخصم الفعلي:</b> ${effectiveDiscountPercent}%
📋 <b>التفاصيل:</b> ${orderDetails || 'لا يوجد'}
📌 <b>الحالة:</b> ${adminStatus}
🧾 <b>Order ID:</b> ${orderId}
🕒 <b>الوقت:</b> ${now.toLocaleString()}
        `.trim();

        await sendTelegramMessage(
          adminChatId,
          adminMsg,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: "HTML", timeoutMs: 15000 }
        );

      } catch (e) {
        console.warn('⚠️ Telegram notification flow error:', e.message || e);
      }

      return res.json(successPayload);

    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      console.error('Transaction failed:', e?.message || e);
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

app.get('/checkout/shahid/:type', checkAuth, async (req, res) => {
  const typeParam = String(req.params.type || '').trim(); // e.g. shahid-1-month
  const error = req.query.error || null;

  const user = req.session.user || null;

  // رسائل الخطأ
  let errorMessage = '';
  if (error === 'balance') errorMessage = 'Insufficient balance.';
  else if (error === 'server') errorMessage = 'Server error during purchase. Please try again.';
  else if (error === 'notfound') errorMessage = 'Package not found.';

  // ✅ 0) Load saved profile (auto-fill)
  let savedProfile = null;
  try {
    const [[p]] = await promisePool.query(
      `SELECT phone, first_name, last_name, country_code
       FROM user_shahid_profiles
       WHERE user_id = ?
       LIMIT 1`,
      [user?.id]
    );
    savedProfile = p || null;
  } catch (e) {
    console.error("⚠️ load user_shahid_profiles failed:", e?.message || e);
    savedProfile = null;
  }

  // 1) Fetch API types (to get title/months)
  let apiTypes = [];
  try {
    const resp = await shahidApi.getTypes();
    apiTypes = Array.isArray(resp?.data) ? resp.data : [];
  } catch (e) {
    console.error("❌ Shahid getTypes error:", e?.response?.data || e.message);
    apiTypes = [];
  }

  const apiTypeObj = apiTypes.find(t => String(t.type) === typeParam) || null;
  if (!apiTypeObj) {
    return res.redirect('/shahid-section?error=notfound');
  }

  // 2) Fetch your local config (image + sell prices + enabled)
  const cfgSql = `SELECT * FROM shahid_api_products WHERE type = ? AND is_enabled = 1 LIMIT 1`;
  db.query(cfgSql, [typeParam], (err, rows) => {
    if (err) {
      console.error("DB error shahid_api_products:", err);
      return res.status(500).send("Server error");
    }
    const cfg = rows?.[0] || null;
    if (!cfg) {
      return res.redirect('/shahid-section?error=notfound');
    }

    // 3) Build a "product-like" object for checkout
    const product = {
      id: null,
      source: 'shahid_api',
      type: typeParam,

      name: cfg.custom_title || apiTypeObj.title || 'Shahid Package',
      image: cfg.image || '/images/shahid.png',

      notes: `Shahid API Package • ${apiTypeObj.months} month(s)`,

      delivery_mode: 'manual',
      in_stock: true,

      sell_price_shared: cfg.sell_price_shared,
      sell_price_full: cfg.sell_price_full
    };

    // 4) Shared/Full selection (via query ?full=1)
    const isFullQuery = String(req.query.full || '0') === '1';
    const basePrice = isFullQuery
      ? Number(cfg.sell_price_full || 0)
      : Number(cfg.sell_price_shared || 0);

    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return res.redirect('/shahid-section?error=server');
    }

    // discount
    const finalPrice = applyUserDiscount(basePrice, user);

    product.original_price = Number(basePrice.toFixed(2));
    product.price = Number(finalPrice.toFixed(2));

    // idempotency
    const idemKey = uuidv4();
    req.session.idemKey = idemKey;

    const notes = (product.notes && String(product.notes).trim() !== '') ? String(product.notes).trim() : null;

    return res.render('checkout-shahid', {
      user,
      product,
      error: errorMessage,
      notes,
      idemKey,
      effectiveDiscount: (user ? getUserEffectiveDiscount(user) : 0),

      shahid: {
        type: typeParam,
        apiTitle: apiTypeObj.title,
        months: apiTypeObj.months,
        apiPrice: apiTypeObj.price || null,
        isFull: isFullQuery ? 1 : 0,
        sellShared: cfg.sell_price_shared,
        sellFull: cfg.sell_price_full
      },

      // ✅ auto-fill
      savedProfile
    });
  });
});


app.post('/buy-shahid', checkAuth, uploadNone.none(), async (req, res) => {
  const {
    shahidType,
    isFull,
    customerPhone,
    customerFirstName,
    customerLastName,
    countryCode,
    idempotency_key: bodyIdemKey
  } = req.body;

  const sessionUser = req.session.user;
  if (!sessionUser?.id) {
    return res.status(401).json({ success: false, message: 'Session expired. Please log in.' });
  }

  const idemKey = (bodyIdemKey || req.session.idemKey || '').toString().slice(0, 64).trim();

  async function storeIdempotencyResponse(conn, userId, key, payload) {
    if (!key) return;
    const json = JSON.stringify(payload);
    await conn.query(
      `INSERT INTO idempotency_keys (user_id, idem_key, response_json)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE response_json = VALUES(response_json)`,
      [userId, key, json]
    );
  }

  async function returnExistingIdempotentResponse(userId, key) {
    if (!key) return false;
    try {
      const [[row]] = await promisePool.query(
        `SELECT response_json FROM idempotency_keys WHERE user_id = ? AND idem_key = ? LIMIT 1`,
        [userId, key]
      );
      if (row?.response_json) {
        try { return res.json(JSON.parse(row.response_json)); } catch (_) {}
      }
    } catch (_) {}
    return false;
  }

  function mapTypeToApiValue(t) {
    const s = String(t || "").toLowerCase();
    if (s.includes("1-month")) return "1-month";
    if (s.includes("3-month")) return "3-month";
    if (s.includes("1-year") || s.includes("12")) return "1-year";
    return t;
  }

  try {
    const alreadyReturned = await returnExistingIdempotentResponse(sessionUser.id, idemKey);
    if (alreadyReturned) return;

    const typeParam = String(shahidType || '').trim();
    const fullFlag = String(isFull) === 'true' || String(isFull) === '1';

    const phone = String(customerPhone || '').trim();
    const fn = String(customerFirstName || '').trim();
    const ln = String(customerLastName || '').trim();
    const cc = String(countryCode || 'lb').trim() || 'lb';

    if (!typeParam) return res.status(400).json({ success: false, message: 'Missing package type.' });
    if (!phone || phone.replace(/\D/g, '').length < 10) return res.status(400).json({ success: false, message: 'Invalid phone.' });
    if (!fn || !ln) return res.status(400).json({ success: false, message: 'Missing first/last name.' });

    // ✅ Fresh user
    let freshUser = null;
    try {
      const [[u]] = await promisePool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [sessionUser.id]);
      freshUser = u || sessionUser;
      if (u) req.session.user = u;
    } catch (_) {
      freshUser = sessionUser;
    }

    // ✅ Load pricing/config
    const [[cfg]] = await promisePool.query(
      `SELECT * FROM shahid_api_products WHERE type = ? AND is_enabled = 1 LIMIT 1`,
      [typeParam]
    );
    if (!cfg) return res.status(404).json({ success: false, message: 'Package not found or disabled.' });

    const basePrice = fullFlag ? Number(cfg.sell_price_full || 0) : Number(cfg.sell_price_shared || 0);
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return res.status(400).json({ success: false, message: 'Pricing error' });
    }

    const effectiveDiscountPercent = (typeof getUserEffectiveDiscount === 'function')
      ? Number(getUserEffectiveDiscount(freshUser) || 0)
      : Number(freshUser.discount_percent || 0) || 0;

    const purchasePrice = applyUserDiscount(basePrice, freshUser);
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      return res.status(400).json({ success: false, message: 'Pricing error' });
    }

    const now = new Date();
    const conn = await promisePool.getConnection();
    let orderId = null;

    // keep some values for telegram after commit
    const productName = (cfg.custom_title && String(cfg.custom_title).trim() !== '')
      ? String(cfg.custom_title).trim()
      : `Shahid (${typeParam})`;

    const orderDetails = [
      `Provider: Shahid API`,
      `Type: ${typeParam}`,
      `Account: ${fullFlag ? 'Full' : 'Shared'}`,
      `Phone: ${phone}`,
      `Name: ${fn} ${ln}`,
      `Country: ${cc}`
    ].join(' | ');

    try {
      await conn.beginTransaction();

      // ✅ Idempotency gate inside TX
      if (idemKey) {
        try {
          await conn.query(
            `INSERT INTO idempotency_keys (user_id, idem_key, response_json) VALUES (?, ?, NULL)`,
            [freshUser.id, idemKey]
          );
        } catch (e) {
          const [[row]] = await conn.query(
            `SELECT response_json FROM idempotency_keys WHERE user_id = ? AND idem_key = ? LIMIT 1`,
            [freshUser.id, idemKey]
          );
          if (row?.response_json) {
            try {
              const payload = JSON.parse(row.response_json);
              await conn.commit();
              return res.json(payload);
            } catch (_) {}
          }
          await conn.rollback();
          return res.status(409).json({ success: false, message: 'Request already in progress. Please wait and refresh.' });
        }
      }

      // ✅ Deduct balance
      const [updRes] = await conn.query(
        `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
        [purchasePrice, freshUser.id, purchasePrice]
      );
      if (!updRes?.affectedRows) {
        const failPayload = { success: false, message: 'Insufficient balance' };
        await storeIdempotencyResponse(conn, freshUser.id, idemKey, failPayload);
        await conn.rollback();
        return res.status(400).json(failPayload);
      }

      // ✅ Save/Update Shahid profile (auto-fill next time)
      await conn.query(
        `INSERT INTO user_shahid_profiles (user_id, phone, first_name, last_name, country_code)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           phone = VALUES(phone),
           first_name = VALUES(first_name),
           last_name = VALUES(last_name),
           country_code = VALUES(country_code)`,
        [freshUser.id, phone, fn, ln, cc]
      );

      // ✅ Insert order (status Waiting)
      const [orderResult] = await conn.query(
        `INSERT INTO orders (userId, productName, price, purchaseDate, order_details, status, admin_reply)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [freshUser.id, productName, purchasePrice, now, orderDetails, 'Waiting', null]
      );
      orderId = orderResult.insertId;

      await conn.query(
        `INSERT INTO notifications (user_id, message, created_at, is_read)
         VALUES (?, ?, NOW(), 0)`,
        [freshUser.id, `✅ تم تسجيل طلب شاهد بنجاح. رقم الطلب: ${orderId}`]
      );

      const successPayload = { success: true, redirectUrl: `/order-details/${orderId}` };
      await storeIdempotencyResponse(conn, freshUser.id, idemKey, successPayload);

      await conn.commit();

      // ✅ refresh session user
      try {
        const [[freshAfter]] = await promisePool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [freshUser.id]);
        if (freshAfter) req.session.user = freshAfter;
      } catch (_) {}

      // ===========================
      // ✅ Telegram AFTER COMMIT (like your /buy)
      // ===========================
      try {
        // user chat id + username
        const [rows] = await promisePool.query(
          'SELECT telegram_chat_id, username FROM users WHERE id = ?',
          [freshUser.id]
        );
        const chatId = rows?.[0]?.telegram_chat_id;
        const username = rows?.[0]?.username || freshUser.username || `User#${freshUser.id}`;

        // message to user (order registered)
        if (chatId) {
          const msg = `
📥 *طلب شاهد تم تسجيله بنجاح*

🛍️ *الباقة:* ${productName}
💰 *السعر بعد الخصم:* ${purchasePrice}$
📉 *الخصم الفعلي:* ${effectiveDiscountPercent}%
📌 *الحالة:* جاري المعالجة (Waiting)
🧾 *رقم الطلب:* ${orderId}
          `.trim();

          await sendTelegramMessage(
            chatId,
            msg,
            process.env.TELEGRAM_BOT_TOKEN,
            { parseMode: "Markdown", timeoutMs: 15000 }
          );
        }

        // message to admin
        const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || '2096387191';
        const adminMsg = `
🆕 <b>طلب شاهد جديد!</b>

👤 <b>الزبون:</b> ${username}
🛍️ <b>الباقة:</b> ${productName}
💰 <b>السعر بعد الخصم:</b> ${purchasePrice}$
📉 <b>الخصم الفعلي:</b> ${effectiveDiscountPercent}%
📋 <b>التفاصيل:</b> ${orderDetails}
📌 <b>الحالة:</b> ⏳ Waiting
🧾 <b>Order ID:</b> ${orderId}
🕒 <b>الوقت:</b> ${now.toLocaleString()}
        `.trim();

        await sendTelegramMessage(
          adminChatId,
          adminMsg,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: "HTML", timeoutMs: 15000 }
        );

      } catch (e) {
        console.warn('⚠️ Telegram notification flow error (buy-shahid):', e?.message || e);
      }

      // ✅ THEN: call external API (after commit)
      let apiResp = null;
      try {
        apiResp = await shahidApi.buy({
          type: mapTypeToApiValue(typeParam),
          customerPhone: phone,
          isFull: fullFlag,
          customerFirstName: fn,
          customerLastName: ln,
          countryCode: cc
        });
      } catch (e) {
        const payload = e?.response?.data || { error: e.message };
        console.error("❌ Shahid buy failed:", payload);

        // refund + keep order waiting
        try {
          await promisePool.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [purchasePrice, freshUser.id]);
          await promisePool.query(
            `UPDATE orders SET status = ?, admin_reply = ? WHERE id = ? LIMIT 1`,
            ['Waiting', `Shahid API failed. Refunded.\n${JSON.stringify(payload)}`, orderId]
          );

          // notify user in-app
          await promisePool.query(
            `INSERT INTO notifications (user_id, message, created_at, is_read)
             VALUES (?, ?, NOW(), 0)`,
            [freshUser.id, `⚠️ فشل تنفيذ اشتراك شاهد وتمت إعادة الرصيد. (Order #${orderId})`]
          );

        } catch (refundErr) {
          console.error("Refund/update failed:", refundErr);
        }

        // optional: Telegram to admin about failure
        try {
          const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || '2096387191';
          const failMsg = `
⚠️ <b>Shahid API Failed</b>

🧾 <b>Order ID:</b> ${orderId}
🛍️ <b>Package:</b> ${productName}
💰 <b>Refunded:</b> ${purchasePrice}$
📋 <b>Error:</b> ${escapeHtml(JSON.stringify(payload))}
          `.trim();

          await sendTelegramMessage(
            adminChatId,
            failMsg,
            process.env.TELEGRAM_BOT_TOKEN,
            { parseMode: "HTML", timeoutMs: 15000 }
          );
        } catch (_) {}

        return res.json({ success: true, redirectUrl: `/order-details/${orderId}` });
      }

      // ✅ Update order with credentials/status
      try {
        const d = apiResp?.data || null;
        const status = String(d?.status || '').toLowerCase() || 'active';

        const adminReply = [
          `✅ Shahid Delivered`,
          `Email: ${d?.email || '-'}`,
          `Password: ${d?.password || '-'}`,
          `Expiry: ${d?.expiryDate || '-'}`,
          `Subscription ID: ${d?.id || '-'}`,
          `Status: ${d?.status || '-'}`
        ].join('\n');

        await promisePool.query(
          `UPDATE orders SET status = ?, admin_reply = ? WHERE id = ? LIMIT 1`,
          [status === 'active' ? 'Accepted' : 'Waiting', adminReply, orderId]
        );

        await promisePool.query(
          `INSERT INTO notifications (user_id, message, created_at, is_read)
           VALUES (?, ?, NOW(), 0)`,
          [freshUser.id, `✅ تم تنفيذ اشتراك شاهد. ادخل على Order Details لرؤية البيانات. (Order #${orderId})`]
        );

        // ✅ Telegram: delivered to user (optional)
        try {
          const [rows] = await promisePool.query(
            'SELECT telegram_chat_id FROM users WHERE id = ?',
            [freshUser.id]
          );
          const chatId = rows?.[0]?.telegram_chat_id;
          if (chatId) {
            const deliveredMsg = `
✅ *تم تنفيذ اشتراك شاهد بنجاح*

🧾 *Order ID:* ${orderId}
📧 *Email:* ${d?.email || '-'}
🔐 *Password:* ${d?.password || '-'}
📆 *Expiry:* ${d?.expiryDate || '-'}
            `.trim();

            await sendTelegramMessage(
              chatId,
              deliveredMsg,
              process.env.TELEGRAM_BOT_TOKEN,
              { parseMode: "Markdown", timeoutMs: 15000 }
            );
          }
        } catch (_) {}

      } catch (uErr) {
        console.error("Update order after API success failed:", uErr);
      }

      return res.json({ success: true, redirectUrl: `/order-details/${orderId}` });

    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      console.error('Transaction failed (buy-shahid):', e?.message || e);
      return res.status(500).json({ success: false, message: 'Transaction failed' });
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('❌ Shahid Buy Error:', err?.response?.data || err.message || err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }

  // tiny helper for admin HTML messages (avoid breaking HTML)
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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
  const sql = `
    SELECT
      p.*,
      (
        SELECT COUNT(*)
        FROM product_stock_items psi
        WHERE psi.product_id = p.id
          AND psi.status = 'available'
      ) AS stock_count
    FROM products p
    ORDER BY p.main_category, p.sub_category, p.sort_order ASC, p.id ASC
  `;

  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("❌ Error fetching products:", err.message || err);
      return res.status(500).send("Server error");
    }

    // ضمان قيم افتراضية حتى لو في منتجات قديمة
    const normalized = (products || []).map(p => {
      const delivery_mode = (p.delivery_mode || 'manual').toString().toLowerCase();
      return {
        ...p,
        delivery_mode,
        stock_count: (p.stock_count !== null && p.stock_count !== undefined)
          ? Number(p.stock_count)
          : null
      };
    });

    res.render('admin-products', { user: req.session.user, products: normalized });
  });
});


app.post('/admin/products/reorder', checkAdmin, async (req, res) => {
  const { productId, direction } = req.body; // up | down

  if (!productId || !['up', 'down'].includes(direction)) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  const conn = await promisePool.getConnection();
  try {
    await conn.beginTransaction();

    const [[p]] = await conn.query(
      `SELECT id, main_category, sub_category, sort_order
       FROM products
       WHERE id = ?
       LIMIT 1`,
      [productId]
    );

    if (!p) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const cmp = direction === 'up' ? '<' : '>';
    const ord = direction === 'up' ? 'DESC' : 'ASC';

    const [[neighbor]] = await conn.query(
      `SELECT id, sort_order
       FROM products
       WHERE main_category = ? AND sub_category = ?
         AND (
           sort_order ${cmp} ?
           OR (sort_order = ? AND id ${cmp} ?)
         )
       ORDER BY sort_order ${ord}, id ${ord}
       LIMIT 1`,
      [p.main_category, p.sub_category, p.sort_order, p.sort_order, p.id]
    );

    if (!neighbor) {
      await conn.rollback();
      return res.json({ success: true, message: 'Already at edge' });
    }

    await conn.query(`UPDATE products SET sort_order = ? WHERE id = ?`, [neighbor.sort_order, p.id]);
    await conn.query(`UPDATE products SET sort_order = ? WHERE id = ?`, [p.sort_order, neighbor.id]);

    await conn.commit();
    return res.json({ success: true });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('❌ reorder error:', err.message || err);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});




app.post('/admin/products/update/:id', checkAdmin, (req, res) => {
  const productId = req.params.id;

  const { name, price, main_category, sub_category, image } = req.body;
  const is_out_of_stock = req.body.is_out_of_stock ? 1 : 0;
  const sort_order = Number(req.body.sort_order || 0);

  const sql = `
    UPDATE products
    SET name = ?,
        price = ?,
        main_category = ?,
        sub_category = ?,
        image = ?,
        is_out_of_stock = ?,
        sort_order = ?
    WHERE id = ?
  `;

  db.query(
    sql,
    [name, price, main_category, sub_category, image, is_out_of_stock, sort_order, productId],
    (err) => {
      if (err) {
        console.error("❌ Error updating product:", err.message || err);
        return res.status(500).send("Error updating product.");
      }
      res.redirect('/admin/products');
    }
  );
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
  const {
    username,
    email,
    phone,
    role,
    level,
    discount_percent,
    total_spent
  } = req.body;

  const lvl   = parseInt(level || 1, 10);
  const disc  = parseFloat(discount_percent || 0);
  const spent = parseFloat(total_spent || 0);

  const sql = `
    UPDATE users
    SET username = ?,
        email = ?,
        phone = ?,
        role = ?,
        level = ?,
        discount_percent = ?,
        total_spent = ?
    WHERE id = ?
  `;

  db.query(sql, [username, email, phone, role, lvl, disc, spent, req.params.id], (err) => {
    if (err) {
      console.error("❌ Error updating user:", err.message);
      return res.status(500).send("❌ Error updating user.");
    }
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
  const {
    name,
    price,
    image,
    main_category,
    sub_category,
    sub_category_image,
    player_id_label,
    notes,
    description,
    delivery_mode
  } = req.body;

  // ✅ checkboxes
  const requires_player_id =
    (req.body.requires_player_id === '1' || req.body.requires_player_id === 'on') ? 1 : 0;

  const is_out_of_stock =
    (req.body.is_out_of_stock === '1' || req.body.is_out_of_stock === 'on') ? 1 : 0;

  const active = (req.body.active === '0') ? 0 : 1; // افتراضي شغّال
  const sort_order = Number(req.body.sort_order || 0);

  // ✅ Delivery mode sanitize
  const dm = (delivery_mode || 'manual').toString().toLowerCase().trim();
  const safeDeliveryMode = (dm === 'stock' || dm === 'manual') ? dm : 'manual';

  // ✅ validation بسيط
  if (!name || !price || !main_category || !sub_category) {
    return res.status(400).send("Missing required fields");
  }

  // ✅ تنظيف القيم (منع تخزين سترينغ فاضي)
  const cleanName = name.trim();
  const cleanMainCat = main_category.trim();
  const cleanSubCat = sub_category.trim();

  const cleanPrice = Number(price);
  if (!Number.isFinite(cleanPrice) || cleanPrice < 0) {
    return res.status(400).send("Invalid price");
  }

  const cleanImage = image?.trim() ? image.trim() : null;
  const cleanSubImage = sub_category_image?.trim() ? sub_category_image.trim() : null;
  const cleanPlayerLabel = player_id_label?.trim() ? player_id_label.trim() : null;
  const cleanNotes = notes?.trim() ? notes.trim() : null;
  const cleanDescription = description?.trim() ? description.trim() : null;

  // ✅ ملاحظة منطقية:
  // إذا المنتج Stock، ما في داعي تخليه Out of Stock بالcheckbox
  // (المخزون هو اللي بيقرر) بس منخليها مثل ما هي لتوافق نظامك الحالي.
  // إذا بدك نجبرها 0 وقت stock، قلّي وبعملها.

  const sql = `
    INSERT INTO products
    (
      name,
      price,
      image,
      main_category,
      sub_category,
      sub_category_image,
      requires_player_id,
      player_id_label,
      notes,
      description,
      is_out_of_stock,
      active,
      sort_order,
      delivery_mode
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    cleanName,
    cleanPrice,
    cleanImage,
    cleanMainCat,
    cleanSubCat,
    cleanSubImage,
    requires_player_id,
    cleanPlayerLabel,
    cleanNotes,
    cleanDescription,
    is_out_of_stock,
    active,
    sort_order,
    safeDeliveryMode
  ];

  db.query(sql, params, (err, result) => {
    if (err) {
      console.error("❌ DATABASE INSERT ERROR:", err?.message || err);
      return res.status(500).send("Error adding product");
    }

    // ✅ إذا المنتج Stock: الأفضل تروح مباشرة على صفحة المخزون لتضيف حسابات
    if (safeDeliveryMode === 'stock') {
      return res.redirect(`/admin/products/${result.insertId}/stock`);
    }

    // ✅ غير هيك رجوع للمنتجات
    return res.redirect('/admin/products');
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
    notes,
    description,
    delivery_mode
  } = req.body;

  // ✅ Sanitize delivery mode
  const dm = (delivery_mode || 'manual').toString().toLowerCase().trim();
  const safeDeliveryMode = (dm === 'stock' || dm === 'manual') ? dm : 'manual';

  // ✅ قيم من الشيك بوكسات
  const requires_player_id =
    (req.body.requires_player_id === '1' || req.body.requires_player_id === 'on') ? 1 : 0;

  const is_out_of_stock =
    (req.body.is_out_of_stock === '1' || req.body.is_out_of_stock === 'on') ? 1 : 0;

  // ✅ Price normalize (اختياري بس مفيد)
  const normalizedPrice = Number(price);
  const safePrice = Number.isFinite(normalizedPrice) ? normalizedPrice : 0;

  const sql = `
    UPDATE products
    SET
      name = ?,
      price = ?,
      image = ?,
      main_category = ?,
      sub_category = ?,
      sub_category_image = ?,
      requires_player_id = ?,
      player_id_label = ?,
      notes = ?,
      description = ?,
      is_out_of_stock = ?,
      delivery_mode = ?
    WHERE id = ?
    LIMIT 1
  `;

  const values = [
    (name || '').trim(),
    safePrice,
    (image || '').trim() || null,
    (main_category || '').trim() || null,
    (sub_category || '').trim() || null,
    (sub_category_image || '').trim() || null,
    requires_player_id,
    (player_id_label || '').trim() || null,
    notes?.trim() ? notes.trim() : null,
    description?.trim() ? description.trim() : null,
    is_out_of_stock,
    safeDeliveryMode,
    productId
  ];

  db.query(sql, values, (err) => {
    if (err) {
      console.error("❌ Error updating product:", err?.message || err);
      return res.status(500).send("Database error during update.");
    }

    res.redirect('/admin/products');
  });
});


// ✅ Stock Manager Page
app.get('/admin/products/:id/stock', checkAdmin, (req, res) => {
  const productId = Number(req.params.id);

  const sqlProduct = `
    SELECT p.*,
      (
        SELECT COUNT(*)
        FROM product_stock_items psi
        WHERE psi.product_id = p.id AND psi.status = 'available'
      ) AS stock_count
    FROM products p
    WHERE p.id = ?
    LIMIT 1
  `;

  db.query(sqlProduct, [productId], (err, rows) => {
    if (err || !rows || !rows.length) {
      console.error('❌ Stock page product error:', err?.message || err);
      return res.status(404).send('Product not found');
    }

    const product = rows[0];
    product.delivery_mode = (product.delivery_mode || 'manual').toString().toLowerCase();

    const stockCount = Number(product.stock_count || 0);

    const sqlItems = `
      SELECT id, delivery_text, status, created_at
      FROM product_stock_items
      WHERE product_id = ? AND status = 'available'
      ORDER BY id DESC
      LIMIT 200
    `;

    db.query(sqlItems, [productId], (e2, stockItems) => {
      if (e2) {
        console.error('❌ Stock items error:', e2?.message || e2);
        stockItems = [];
      }

      res.render('admin-product-stock', {
        user: req.session.user,
        product,
        stockCount,
        stockItems
      });
    });
  });
});


// ✅ Add stock items (bulk)
app.post('/admin/products/:id/stock/add', checkAdmin, (req, res) => {
  const productId = Number(req.params.id);
  const raw = (req.body.items || '').toString();

  const lines = raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!lines.length) {
    return res.redirect(`/admin/products/${productId}/stock`);
  }

  const values = lines.map(t => [productId, t, 'available']);

  const sql = `
    INSERT INTO product_stock_items (product_id, delivery_text, status)
    VALUES ?
  `;

  db.query(sql, [values], (err) => {
    if (err) {
      console.error('❌ Add stock error:', err?.message || err);
    }
    res.redirect(`/admin/products/${productId}/stock`);
  });
});


// ✅ Delete one stock item
app.post('/admin/products/:id/stock/delete/:stockId', checkAdmin, (req, res) => {
  const productId = Number(req.params.id);
  const stockId = Number(req.params.stockId);

  const sql = `
    DELETE FROM product_stock_items
    WHERE id = ? AND product_id = ? AND status = 'available'
    LIMIT 1
  `;

  db.query(sql, [stockId, productId], (err) => {
    if (err) {
      console.error('❌ Delete stock item error:', err?.message || err);
    }
    res.redirect(`/admin/products/${productId}/stock`);
  });
});


// ✅ Clear all available stock items (optional but useful)
app.post('/admin/products/:id/stock/clear', checkAdmin, (req, res) => {
  const productId = Number(req.params.id);

  const sql = `
    DELETE FROM product_stock_items
    WHERE product_id = ? AND status = 'available'
  `;

  db.query(sql, [productId], (err) => {
    if (err) {
      console.error('❌ Clear stock error:', err?.message || err);
    }
    res.redirect(`/admin/products/${productId}/stock`);
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
app.post('/admin/order/update/:id', checkAdmin, async (req, res) => {
  const orderId = req.params.id;
  const { status: rawStatus, admin_reply } = req.body;

  // توحيد الحالة
  const normalized = (rawStatus || '').trim().toLowerCase();
  const status =
    normalized === 'accepted' ? 'Accepted' :
    normalized === 'rejected' ? 'Rejected' :
    rawStatus;

  let conn;
  try {
    conn = await promisePool.getConnection();
    await conn.beginTransaction();

    // 🔒 اقفل الطلب بالـ transaction (FOR UPDATE) لمنع سباق
    const [[order]] = await conn.query(
      `SELECT * FROM orders WHERE id = ? FOR UPDATE`,
      [orderId]
    );

    if (!order) {
      await conn.rollback();
      return res.status(404).send('Order not found.');
    }

    const oldStatus = order.status;
    const orderPrice = Number(order.price || 0);
    const userId = order.userId;

    if (!Number.isFinite(orderPrice) || orderPrice < 0) {
      await conn.rollback();
      return res.status(400).send('Invalid order price.');
    }

    // ✅ إذا ما في تغيير فعلي بالحالة: بس حدّث الرد الإداري وخلص
    // (وبيمنع تكرار refund/total_spent)
    if ((status || '').trim() === (oldStatus || '').trim()) {
      await conn.query(
        `UPDATE orders SET admin_reply = ? WHERE id = ?`,
        [admin_reply, orderId]
      );

      await conn.commit();
      res.redirect('/admin/orders');

      // تيليغرام بالخلفية
      withTimeout(sendOrderStatusTelegram(orderId, status, admin_reply))
        .catch(tgErr => console.error("⚠️ Telegram (no-status-change) error:", tgErr.message));
      return;
    }

    // =========================================================
    // 1) REJECTED: Refund balance + transaction + notification
    //    (فقط إذا كان oldStatus مش Rejected)
    // =========================================================
    if (status === 'Rejected') {
      // Refund
      await conn.query(
        `UPDATE users SET balance = balance + ? WHERE id = ?`,
        [orderPrice, userId]
      );

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

      await conn.commit();

      console.log(`✅ Order #${orderId} rejected and refunded.`);
      res.redirect('/admin/orders');

      withTimeout(sendOrderStatusTelegram(orderId, status, admin_reply))
        .catch(tgErr => console.error("⚠️ Telegram (rejected) error:", tgErr.message));

      return;
    }

    // =========================================================
    // 2) ACCEPTED: زِد total_spent مرة واحدة فقط عند الانتقال لأول مرة لـ Accepted
    // =========================================================
    if (status === 'Accepted') {
      // حدّث الطلب أولاً
      await conn.query(
        `UPDATE orders SET status = ?, admin_reply = ? WHERE id = ?`,
        [status, admin_reply, orderId]
      );

      // ✅ إذا عم ننتقل لأول مرة لـ Accepted (oldStatus != Accepted)
      // زِد total_spent
      if (oldStatus !== 'Accepted') {
        await conn.query(
          `UPDATE users SET total_spent = total_spent + ? WHERE id = ?`,
          [orderPrice, userId]
        );
      }

      await conn.commit();

      // بعد الـ commit: level recalculation (مش داخل transaction)
      try {
        await recalcUserLevel(userId);
      } catch (lvlErr) {
        console.error('⚠️ recalcUserLevel error (admin accept):', lvlErr.message || lvlErr);
      }

      console.log(`✅ Order #${orderId} updated to Accepted.`);
      res.redirect('/admin/orders');

      withTimeout(sendOrderStatusTelegram(orderId, status, admin_reply))
        .catch(tgErr => console.error("⚠️ Telegram (accepted) error:", tgErr.message));

      return;
    }

    // =========================================================
    // 3) باقي الحالات: بس تحديث status + admin_reply
    // =========================================================
    await conn.query(
      `UPDATE orders SET status = ?, admin_reply = ? WHERE id = ?`,
      [status, admin_reply, orderId]
    );

    await conn.commit();

    console.log(`✅ Order #${orderId} updated to ${status}`);
    res.redirect('/admin/orders');

    withTimeout(sendOrderStatusTelegram(orderId, status, admin_reply))
      .catch(tgErr => console.error("⚠️ Telegram (update) error:", tgErr.message));

  } catch (e) {
    console.error('❌ admin/order/update failed:', e);
    try { if (conn) await conn.rollback(); } catch (_) {}
    return res.status(500).send("Error updating request");
  } finally {
    try { if (conn) conn.release(); } catch (_) {}
  }
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
    const query = (sql, params = []) =>
      new Promise((resolve, reject) => {
        db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
      });

    // Params
    const limit = 20;

    // 🔎 Search
    const qRaw = (req.query.q || '').trim();
    const q = qRaw.toLowerCase();

    // Page (initial)
    let page = parseInt(req.query.page, 10) || 1;
    if (page < 1) page = 1;

    // 1) Get API products
    const apiProducts = await getCachedAPIProducts();

    // 2) Get only needed columns from custom table (lighter than SELECT *)
    const customSql = `
      SELECT product_id, active, custom_price, custom_image
      FROM selected_api_products
    `;
    const customProducts = await query(customSql);

    const customProductMap = new Map(
      customProducts.map(p => [parseInt(p.product_id, 10), p])
    );

    // 3) Merge API + custom
    const displayProducts = apiProducts.map(apiProduct => {
      const customData = customProductMap.get(Number(apiProduct.id)) || {};
      return {
        ...apiProduct,
        is_selected: !!customData.active,
        custom_price: customData.custom_price ?? null,
        custom_image: customData.custom_image ?? null
      };
    });

    // 4) Filter before pagination
    const filtered = q
      ? displayProducts.filter(p => {
          const name = (p.name || '').toLowerCase();
          return name.includes(q) || String(p.id).includes(q);
        })
      : displayProducts;

    // 5) Compute pages after filtering + clamp page
    const totalProducts = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalProducts / limit));

    if (page > totalPages) page = totalPages;

    const offset = (page - 1) * limit;
    const paginatedProducts = filtered.slice(offset, offset + limit);

    // 6) Render
    res.render('admin-api-products', {
      user: req.session.user,
      products: paginatedProducts,
      currentPage: page,
      totalPages,
      q: qRaw
    });

  } catch (error) {
    console.error("API Error in /admin/api-products:", error.stack || error.message);
    res.status(500).send("❌ Error loading API products.");
  }
});

// مسار لإضافة أو إزالة منتج من الـ API
app.post('/admin/api-products/toggle', checkAdmin, (req, res) => {
  const { productId, isActive } = req.body;

  const on = (isActive === true || isActive === 'true' || isActive === 1 || isActive === '1');

  if (on) {
    const sql = `
      INSERT INTO selected_api_products (product_id, active)
      VALUES (?, TRUE)
      ON DUPLICATE KEY UPDATE active = TRUE
    `;
    db.query(sql, [productId], (err) => {
      if (err) {
        console.error("❌ Toggle activate error:", err);
        return res.json({ success: false, error: err.code || 'DB_ERROR' });
      }
      res.json({ success: true, status: 'activated' });
    });
  } else {
    const sql = `UPDATE selected_api_products SET active = FALSE WHERE product_id = ?`;
    db.query(sql, [productId], (err) => {
      if (err) {
        console.error("❌ Toggle deactivate error:", err);
        return res.json({ success: false, error: err.code || 'DB_ERROR' });
      }
      res.json({ success: true, status: 'deactivated' });
    });
  }
});

app.post('/admin/api-products/sync', checkAdmin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const rid = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();

  try {
    // ✅ Lock using app.locals (no global var needed)
    if (app.locals.__apiProductsSyncLock) {
      return res.status(429).json({
        success: false,
        message: 'Sync already running. Please wait a moment.',
        rid
      });
    }
    app.locals.__apiProductsSyncLock = true;

    // ✅ Load provider function safely
    let getCachedAPIProducts;
    try {
      ({ getCachedAPIProducts } = require('./utils/getCachedAPIProducts'));
    } catch (e) {
      console.error(`❌ [${rid}] require getCachedAPIProducts failed:`, e);
      return res.status(500).json({
        success: false,
        message: 'Server misconfiguration: getCachedAPIProducts not found.',
        rid
      });
    }

    // ✅ Force refresh toggle
    const forceQ = String(req.query.force || '').toLowerCase();
    const forceH = String(req.headers['x-force-refresh'] || '').toLowerCase();
    const forceRefresh = (forceQ === '1' || forceQ === 'true' || forceH === '1' || forceH === 'true');

    // ✅ Timeout wrapper
    const TIMEOUT_MS = 20000;
    const withTimeout = (p, ms) =>
      Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Sync timeout after ${ms}ms`)), ms))
      ]);

    // ✅ Run
    let list;
    let usedForce = false;

    try {
      if (forceRefresh) {
        usedForce = true;
        // may be ignored if function doesn't accept args
        list = await withTimeout(getCachedAPIProducts({ forceRefresh: true, force: true }), TIMEOUT_MS);
      } else {
        list = await withTimeout(getCachedAPIProducts(), TIMEOUT_MS);
      }
    } catch (e1) {
      // fallback no-args
      list = await withTimeout(getCachedAPIProducts(), TIMEOUT_MS);
    }

    if (!Array.isArray(list)) {
      return res.status(500).json({
        success: false,
        message: 'Invalid provider response (expected array).',
        type: typeof list,
        rid
      });
    }

    const tookMs = Date.now() - startedAt;
    const sample = list[0] || null;

    return res.status(200).json({
      success: true,
      message: `Sync done. Products loaded: ${list.length}`,
      total: list.length,
      usedForce,
      tookMs,
      rid,
      sampleKeys: sample ? Object.keys(sample).slice(0, 25) : []
    });

  } catch (err) {
    console.error(`❌ [${rid}] Sync route unexpected error:`, err);
    return res.status(500).json({
      success: false,
      message: 'Server error during sync.',
      detail: err.message,
      rid
    });
  } finally {
    // ✅ Always release lock
    app.locals.__apiProductsSyncLock = false;
  }
});


app.get('/admin/dev/find-product/:id', checkAdmin, async (req, res) => {
  // ✅ منع كاش المتصفح لهاي الصفحة (Dev only)
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');

    // ✅ دعم force refresh للتجربة (إذا الدالة ما بتدعمه رح تتجاهله غالبًا)
    const force = String(req.query.force || '').toLowerCase();
    const forceRefresh = (force === '1' || force === 'true' || force === 'yes');

    let list;
    try {
      list = await getCachedAPIProducts({ forceRefresh: true });
      // إذا forceRefresh=false وما بدك تجبره، استخدم الشرط التالي بدل السطر فوق:
      // list = await getCachedAPIProducts(forceRefresh ? { forceRefresh: true } : undefined);
    } catch (e) {
      // fallback إذا الدالة ما بتقبل args
      list = await getCachedAPIProducts();
    }

    if (!Array.isArray(list)) {
      return res.status(500).json({
        found: false,
        error: 'getCachedAPIProducts did not return an array',
        type: typeof list
      });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ found: false, error: 'Invalid product id' });
    }

    const p = list.find(x => Number(x?.id) === id);
    if (!p) return res.json({ found: false, product: null });

    // ✅ Helpers
    const asStr = (v) => String(v ?? '').trim();
    const toNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const normBool = (v) => {
      const s = String(v ?? '').toLowerCase().trim();
      // only treat these as TRUE
      if (s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on') return true;
      if (s === '0' || s === 'false' || s === 'no' || s === 'n' || s === 'off' || s === '') return false;
      // fallback: numbers
      const n = Number(s);
      if (Number.isFinite(n)) return n === 1;
      // otherwise: unknown -> false (safer)
      return false;
    };

    // ✅ Important fields (raw + type)
    const debug = {
      id: p.id,
      name: p.name,

      is_out_of_stock: p.is_out_of_stock,
      is_out_of_stock_type: typeof p.is_out_of_stock,

      active: p.active,
      active_type: typeof p.active,

      status: p.status,
      status_type: typeof p.status,

      stock: p.stock,
      stock_type: typeof p.stock,

      max_quantity: p.max_quantity,
      max_quantity_type: typeof p.max_quantity,

      variable_quantity: p.variable_quantity,
      variable_quantity_type: typeof p.variable_quantity,

      price: p.price,
      price_type: typeof p.price
    };

    // ✅ Normalized values to catch "0" truthy problems
    const normalized = {
      is_out_of_stock_bool: normBool(p.is_out_of_stock),
      active_bool: normBool(p.active),
      variable_quantity_bool: normBool(p.variable_quantity),

      stock_num: toNum(p.stock),
      max_quantity_num: toNum(p.max_quantity),
      price_num: toNum(p.price),

      status_str: asStr(p.status).toLowerCase()
    };

    // ✅ Hypotheses: why it might be considered OOS (you can adjust rules)
    const matches = {
      by_is_out_of_stock_flag: normalized.is_out_of_stock_bool === true,

      // common patterns
      by_status_contains_oos:
        normalized.status_str.includes('out') && normalized.status_str.includes('stock'),

      by_stock_zero:
        normalized.stock_num !== null && normalized.stock_num <= 0,

      by_max_quantity_zero:
        normalized.max_quantity_num !== null && normalized.max_quantity_num <= 0
    };

    // ✅ A safe, trimmed product view (avoid accidental leaking of secrets)
    // add/remove fields حسب اللي بتحتاجه
    const safeProduct = {
      id: p.id,
      name: p.name,
      price: p.price,
      product_type: p.product_type,
      variable_quantity: p.variable_quantity,
      unit_label: p.unit_label,
      image: p.image,

      is_out_of_stock: p.is_out_of_stock,
      active: p.active,
      status: p.status,
      stock: p.stock,
      max_quantity: p.max_quantity
    };

    // ✅ Optionally allow returning the full product only if explicitly requested
    const includeFull = String(req.query.full || '').toLowerCase();
    const full = (includeFull === '1' || includeFull === 'true' || includeFull === 'yes');

    return res.json({
      found: true,
      debug,
      normalized,
      matches,
      product: full ? p : safeProduct
    });

  } catch (e) {
    console.error('❌ /admin/dev/find-product error:', e);
    return res.status(500).json({ found: false, error: e.message || 'Server error' });
  }
});

app.get('/admin/api-products/sync-ping', checkAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, time: new Date().toISOString() });
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
// ✅ EDIT API PRODUCT (SAFE VERSION - prevents NULL unit_price)
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

  // Helpers
  const toFloat = (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };

  const toInt = (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  };

  // Base values
  const priceToSave = toFloat(custom_price); // DECIMAL(10,2) nullable
  const imageToSave = (custom_image && String(custom_image).trim() !== '') ? String(custom_image).trim() : null;
  const nameToSave  = (custom_name && String(custom_name).trim() !== '') ? String(custom_name).trim() : null;

  const categoryToSave = category ? slugify(category) : null;
  const labelToSave    = (unit_label && String(unit_label).trim() !== '') ? String(unit_label).trim() : 'units';

  // Quantity-related values
  const unitPriceInput = toFloat(unit_price);      // DECIMAL(10,4) not null in DB
  const unitQtyInput   = toFloat(unit_quantity);   // nullable
  const minQtyInput    = toInt(min_quantity);
  const maxQtyInput    = toInt(max_quantity);

  // ✅ Critical: never send NULL for unit_price
  const unitPriceToSave = (variableQtyFlag === 1)
    ? (unitPriceInput ?? priceToSave ?? 0)
    : (priceToSave ?? 0);

  // Optional fields: use sane defaults
  const unitQuantityToSave = (variableQtyFlag === 1) ? (unitQtyInput ?? 1) : 1;
  const minQtyToSave       = (variableQtyFlag === 1) ? (minQtyInput ?? 1) : 1;
  const maxQtyToSave       = (variableQtyFlag === 1) ? (maxQtyInput ?? 9999) : 9999;

  const sql = `
    INSERT INTO selected_api_products (
      product_id, custom_price, custom_image, custom_name, category, active,
      is_out_of_stock, variable_quantity,
      unit_price, unit_quantity, min_quantity, max_quantity,
      player_check, unit_label, requires_verification
    )
    VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      custom_price          = VALUES(custom_price),
      custom_image          = VALUES(custom_image),
      custom_name           = VALUES(custom_name),
      category              = VALUES(category),
      active                = TRUE,
      is_out_of_stock       = VALUES(is_out_of_stock),
      variable_quantity     = VALUES(variable_quantity),
      unit_price            = VALUES(unit_price),
      unit_quantity         = VALUES(unit_quantity),
      min_quantity          = VALUES(min_quantity),
      max_quantity          = VALUES(max_quantity),
      player_check          = VALUES(player_check),
      unit_label            = VALUES(unit_label),
      requires_verification = VALUES(requires_verification)
  `;

  const params = [
    productId,
    priceToSave,
    imageToSave,
    nameToSave,
    categoryToSave,
    is_out_of_stock,
    variableQtyFlag,
    unitPriceToSave,
    unitQuantityToSave,
    minQtyToSave,
    maxQtyToSave,
    player_check,
    labelToSave,
    requires_verification
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
  if (!userId) {
    return res.status(401).json({ success: false, message: "Session expired. Please log in." });
  }

  const idempotency_key = (req.body.idempotency_key || req.session.idemKey || '')
    .toString()
    .slice(0, 64)
    .trim();

  const { productId, player_id } = req.body;
  if (!productId) return res.status(400).json({ success: false, message: "Missing product ID." });

  const query = (sql, params) =>
    new Promise((resolve, reject) => {
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  async function getIdemPayload() {
    if (!idempotency_key) return null;
    const rows = await query(
      `SELECT response_json FROM idempotency_keys WHERE user_id = ? AND idem_key = ? LIMIT 1`,
      [userId, idempotency_key]
    );
    const raw = rows?.[0]?.response_json;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  async function upsertIdemLock() {
    if (!idempotency_key) return { locked: false };
    try {
      await query(
        `INSERT INTO idempotency_keys (user_id, idem_key, response_json) VALUES (?, ?, NULL)`,
        [userId, idempotency_key]
      );
      return { locked: true };
    } catch (e) {
      const existing = await getIdemPayload();
      if (existing) return { locked: false, payload: existing };
      return { locked: false, inProgress: true };
    }
  }

  async function saveIdemPayload(payload) {
    if (!idempotency_key) return;
    await query(
      `UPDATE idempotency_keys
          SET response_json = ?
        WHERE user_id = ? AND idem_key = ?`,
      [JSON.stringify(payload), userId, idempotency_key]
    );
  }

  async function refundProviderOrder(providerOrderId) {
    if (!providerOrderId) return;
    try {
      await dailycardAPI.post('/api-keys/orders/cancel/', { id: providerOrderId });
    } catch (e) {
      console.warn("⚠️ Provider refund/cancel failed (ignored):", e?.message || e);
    }
  }

  try {
    // ✅ 0) لو فيه payload محفوظة لنفس المفتاح رجّعها فوراً
    const existingPayload = await getIdemPayload();
    if (existingPayload) return res.json(existingPayload);

    // ✅ 1) Idempotency lock
    const lock = await upsertIdemLock();
    if (lock?.payload) return res.json(lock.payload);
    if (lock?.inProgress) {
      return res.status(409).json({
        success: false,
        message: "Request already in progress. Please wait a moment and refresh."
      });
    }

    // ✅ 0.5) Fresh user
    let sessionUser = null;
    try {
      const [[freshUser]] = await promisePool.query(
        "SELECT * FROM users WHERE id = ? LIMIT 1",
        [userId]
      );
      sessionUser = freshUser || req.session.user || null;
      if (freshUser) req.session.user = freshUser;
    } catch (_) {
      sessionUser = req.session.user || null;
    }

    // ✅ 1) Fetch product
    const [product] = await query(
      `SELECT * FROM selected_api_products
       WHERE product_id = ?
         AND active = 1
         AND (variable_quantity IS NULL OR variable_quantity = 0)
       LIMIT 1`,
      [productId]
    );
    if (!product) {
      const payload = { success: false, message: "Product not found." };
      await saveIdemPayload(payload);
      return res.status(404).json(payload);
    }

    if (Number(product.is_out_of_stock) === 1) {
      const payload = { success: false, message: "Product is out of stock." };
      await saveIdemPayload(payload);
      return res.status(400).json(payload);
    }

    // ✅ 2) Base price (NO DISCOUNT)
    const rawPrice = Number(product.custom_price || product.unit_price || 0) || 0;
    const basePrice = Math.round(rawPrice * 100) / 100;

    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      const payload = { success: false, message: "Pricing error." };
      await saveIdemPayload(payload);
      return res.status(400).json(payload);
    }

    // ✅ 3) Final price = Base price (NO DISCOUNT)
    const finalPrice = basePrice;

    // ✅ 4) Player requirements
    const requiresPlayerId = Number(product.player_check) === 1;
    if (requiresPlayerId && (!player_id || player_id.trim() === "")) {
      const payload = { success: false, message: "Missing player ID." };
      await saveIdemPayload(payload);
      return res.status(400).json(payload);
    }

    if (Number(product.requires_verification) === 1) {
      const verifyRes = await verifyPlayerId(productId, player_id);
      if (!verifyRes.success) {
        const payload = { success: false, message: verifyRes.message || "Player verification failed." };
        await saveIdemPayload(payload);
        return res.status(400).json(payload);
      }
    }

    // ✅ 5) Create provider order FIRST
    const orderBody = {
      product: parseInt(productId, 10),
      ...(player_id ? { account_id: player_id } : {})
    };

    let providerOrderId = null;
    try {
      const { data: result } = await dailycardAPI.post("/api-keys/orders/create/", orderBody);
      providerOrderId = result?.id || result?.data?.id || result?.order_id || null;
    } catch (e) {
      const payload = { success: false, message: "Provider error. Please try again." };
      await saveIdemPayload(payload);
      return res.status(502).json(payload);
    }

    if (!providerOrderId) {
      const payload = { success: false, message: "Order failed at provider." };
      await saveIdemPayload(payload);
      return res.status(500).json(payload);
    }

    // ✅ 6) DB Transaction
    const conn = await promisePool.getConnection();
    let insertId = null;

    try {
      await conn.beginTransaction();

      // ✅ خصم ذري من الرصيد (NO DISCOUNT)
      const [updRes] = await conn.query(
        `UPDATE users
            SET balance = balance - ?
          WHERE id = ? AND balance >= ?`,
        [finalPrice, userId, finalPrice]
      );

      if (!updRes?.affectedRows) {
        await conn.rollback();
        await refundProviderOrder(providerOrderId);

        const payload = { success: false, message: "Insufficient balance." };
        await saveIdemPayload(payload);
        return res.status(400).json(payload);
      }

      await conn.query(
        `INSERT INTO transactions (user_id, type, amount, reason)
         VALUES (?, 'debit', ?, ?)`,
        [userId, finalPrice, `Purchase: ${product.custom_name || product.name || `API Product ${productId}`}`]
      );

      const orderDetails = requiresPlayerId ? `User ID: ${player_id}` : '';
      const [orderRes] = await conn.query(
        `INSERT INTO orders
          (userId, productName, price, purchaseDate, order_details, status, provider_order_id, provider, source${idempotency_key ? ', client_token' : ''})
         VALUES
          (?, ?, ?, NOW(), ?, 'Waiting', ?, 'dailycard', 'api'${idempotency_key ? ', ?' : ''})`,
        idempotency_key
          ? [userId, product.custom_name || product.name || `API Product ${productId}`, finalPrice, orderDetails, providerOrderId, idempotency_key]
          : [userId, product.custom_name || product.name || `API Product ${productId}`, finalPrice, orderDetails, providerOrderId]
      );

      insertId = orderRes.insertId;

      await conn.query(
        `INSERT INTO notifications (user_id, message, created_at, is_read)
         VALUES (?, ?, NOW(), 0)`,
        [userId, `✅ Your order for (${product.custom_name || product.name || `API Product ${productId}`}) was received and is being processed.`]
      );

      await conn.commit();

    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      await refundProviderOrder(providerOrderId);

      console.error("❌ buy-fixed tx error:", e);
      return res.status(500).json({ success: false, message: "Transaction failed." });
    } finally {
      conn.release();
    }

    // ✅ Post-commit
    try {
      const [[freshUserAfter]] = await promisePool.query("SELECT * FROM users WHERE id = ?", [userId]);
      if (freshUserAfter) req.session.user = freshUserAfter;
    } catch (_) {}

    // ✅ Telegram messages (NO DISCOUNT)
    try {
      const [urows] = await promisePool.query("SELECT username, telegram_chat_id FROM users WHERE id = ?", [userId]);
      const urow = urows[0];

      if (urow?.telegram_chat_id) {
        await sendTelegramMessage(
          urow.telegram_chat_id,
          `📥 <b>Your order has been received</b>\n\n🛍️ <b>Product:</b> ${product.custom_name || product.name || `API Product ${productId}`}\n💰 <b>Price:</b> ${finalPrice.toFixed(2)}$\n📌 <b>Status:</b> Processing`,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: 'HTML', timeoutMs: 15000 }
        );
      }

      if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
        await sendTelegramMessage(
          process.env.ADMIN_TELEGRAM_CHAT_ID,
          `🆕 New Fixed Product Order!\n👤 User: ${urow?.username}\n🎁 Product: ${product.custom_name || product.name || `API Product ${productId}`}\n💰 Price: ${finalPrice.toFixed(2)}$\n🕓 Time: ${new Date().toLocaleString('en-US', { hour12: false })}`,
          process.env.TELEGRAM_BOT_TOKEN,
          { parseMode: 'HTML', timeoutMs: 15000 }
        );
      }
    } catch (e) {
      console.warn("⚠️ Telegram error (buy-fixed):", e.message || e);
    }

    req.session.pendingOrderId = insertId;

    const okPayload = { success: true, redirectUrl: "/processing" };
    await saveIdemPayload(okPayload);
    return res.json(okPayload);

  } catch (err) {
    const rawErr = err?.response?.data || err.message || err;
    console.error("❌ Fixed Order Error:", rawErr);
    return res.status(500).json({ success: false, message: "Server error. Please try again later." });
  }
});


app.post('/admin/levels/reset', checkAdmin, async (req, res) => {
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    // ✅ Lock آخر reset record لتفادي race condition
    const [[last]] = await conn.query(`
      SELECT created_at
      FROM level_resets
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `);

    // ✅ منع كبستين خلال 24 ساعة
    if (last?.created_at) {
      const lastTime = new Date(last.created_at).getTime();
      const hours = (Date.now() - lastTime) / (1000 * 60 * 60);

      if (hours < 24) {
        await conn.rollback();
        // بدل ما تبعت نص 409 (بيبين "مش شغال") رجّعك مع رسالة
        return res.redirect('/admin/users?reset=too_soon');
      }
    }

    // ✅ سجل مين عمل reset (ولو ما في session ما بيوقع)
    const adminId = req?.session?.user?.id ?? null;

    await conn.query(
      `INSERT INTO level_resets (admin_user_id) VALUES (?)`,
      [adminId]
    );

    // ✅ Reset لكل المستخدمين (بدون ما نلمس balance)
    await conn.query(`
      UPDATE users
      SET total_spent = 0,
          level = 0,
          discount_percent = 0
    `);

    await conn.commit();

    // ✅ Redirect لصفحة موجودة (بدّلها إذا بدك)
    return res.redirect('/admin/users?reset=ok');

  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('❌ Reset levels error:', e);
    return res.status(500).send('Reset failed');
  } finally {
    conn.release();
  }
});




// =============================================
//                  apps route
// =============================================




app.get('/netflix-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Netflix'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('netflix-section', {
      user,
      products: finalProducts
    });
  });
});

// Shahid API endpoints (separated from MySQL products)
app.get("/api/shahid/types", checkAuthJson, async (req, res) => {
  try {
    return res.json(await shahidApi.getTypes());
  } catch (e) {
    const status = e?.response?.status || 500;
    const payload = e?.response?.data || { error: e.message };

    console.error("Shahid types FAIL status=", status);
    console.error("Shahid types FAIL payload=", payload);
    console.error("Shahid types FAIL baseURL=", process.env.SHAHID_BASE_URL);

    return res.status(status).json({
      success: false,
      message: "Shahid API error",
      data: payload
    });
  }
});


app.post("/api/shahid/buy", checkAuthJson, async (req, res) => {
  try {
    return res.json(await shahidApi.buy(req.body));
  } catch (e) {
    const status = e?.response?.status || 500;
    return res.status(status).json(e?.response?.data || { success: false, message: "Shahid API error", data: null });
  }
});

app.get("/api/shahid/subscription/:id", checkAuthJson, async (req, res) => {
  try {
    return res.json(await shahidApi.getById(req.params.id));
  } catch (e) {
    const status = e?.response?.status || 500;
    return res.status(status).json(e?.response?.data || { success: false, message: "Shahid API error", data: null });
  }
});


app.get('/shahid-section', async (req, res) => {
  const user = req.session.user || null;

  // 1) Fetch types from Shahid API
  let types = [];
  try {
    const resp = await shahidApi.getTypes(); // { success, message, data: [...] }
    types = Array.isArray(resp?.data) ? resp.data : [];
  } catch (e) {
    console.error("❌ Shahid API types error:", e?.response?.data || e.message);
    types = [];
  }

  // 2) Fetch your local pricing + images + ordering overrides
  db.query(
    "SELECT * FROM shahid_api_products WHERE is_enabled = 1 ORDER BY sort_order ASC, id ASC",
    [],
    (err, rows) => {
      if (err) {
        console.error("❌ DB error shahid_api_products:", err);
        return res.status(500).send("Server error");
      }

      const configRows = rows || [];

      // Map configs by type for fast merge
      const cfgMap = new Map(configRows.map(r => [String(r.type), r]));

      // 3) Merge: only show types that you configured locally (for image + sell price)
      const shahidCards = (types || [])
        .map(t => {
          const key = String(t.type);
          const cfg = cfgMap.get(key);
          if (!cfg) return null; // not configured -> hide

          return {
            type: t.type,            // e.g. "shahid-1-month"
            months: t.months,        // from API
            api_title: t.title,      // from API (optional)
            api_price: t.price,      // from API (reference)

            // Your store display fields
            title: cfg.custom_title || t.title,
            image: cfg.image || "/images/shahid.png",
            sell_price_full: cfg.sell_price_full,
            sell_price_shared: cfg.sell_price_shared,
            sort_order: cfg.sort_order || 0,
          };
        })
        .filter(Boolean);

      // Optional: log for debugging
      console.log("✅ /shahid-section types:", types.length, "configs:", configRows.length, "cards:", shahidCards.length);

      // 4) Render the new EJS that uses shahidCards
      return res.render('shahid-section', {
        user,
        shahidCards
      });
    }
  );
});


app.get('/osn-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'osn'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('osn-section', { user, products: finalProducts });
  });
});

app.get('/primevideo', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'prime video'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('primevideo', { user, products: finalProducts });
  });
});

app.get('/Adobe_Creativity_Cloud', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Adobe Creativity Cloud'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('Adobe_Creativity_Cloud', { user, products: finalProducts });
  });
});

app.get('/disney-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Disney'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('disney-section', { user, products: finalProducts });
  });
});

app.get('/disneyhigh-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Disney High'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('disneyhigh-section', { user, products: finalProducts });
  });
});

app.get('/youtube-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Youtube premuim'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('youtube-section', { user, products: finalProducts });
  });
});

app.get('/gemini', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Gemini Pro'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('gemini', { user, products: finalProducts });
  });
});

app.get('/watchit', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Watch It'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('watchit', { user, products: finalProducts });
  });
});


app.get('/starzplay', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Starzplay'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('starzplay', { user, products: finalProducts });
  });
});

app.get('/grammarly', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Grammarly'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('grammarly', { user, products: finalProducts });
  });
});

app.get('/hbo', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'HBO Max'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('hbo', { user, products: finalProducts });
  });
});

app.get('/perplexity', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Perplexity AI'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('perplexity', { user, products: finalProducts });
  });
});

app.get('/crunchyroll-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Crunchy Roll'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('crunchyroll-section', { user, products: finalProducts });
  });
});

app.get('/Claude', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Claude'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('Claude', { user, products: finalProducts });
  });
});


app.get('/capcut-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'CapCut'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('capcut-section', { user, products: finalProducts });
  });
});

app.get('/canva-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Canva'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('canva-section', { user, products: finalProducts });
  });
});

app.get('/appletv', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Apple Tv+'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('appletv', { user, products: finalProducts });
  });
});

app.get('/autodesk', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'AUTODESK'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('autodesk', { user, products: finalProducts });
  });
});

app.get('/tod', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'TOD'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('tod', { user, products: finalProducts });
  });
});

app.get('/chatgpt-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Chatgpt'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('chatgpt-section', { user, products: finalProducts });
  });
});

app.get('/anghami-section', (req, res) => {
  const sql = `
    SELECT * FROM products
    WHERE main_category = 'Accounts' AND sub_category = 'Anghami'
    ORDER BY sort_order ASC, id ASC
  `;
  db.query(sql, [], (err, products) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send("Server error");
    }
    const user = req.session.user || null;
    const finalProducts = applyUserDiscountToProducts(products, user);

    res.render('anghami-section', { user, products: finalProducts });
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



app.get('/order-details/:id', checkAuth, (req, res) => {
  const orderId = Number(req.params.id);
  const userId = req.session.user.id;

  const sql = `
    SELECT
      o.*,
      so.status          AS smm_status,
      so.quantity        AS smm_quantity,
      so.delivered_qty   AS smm_delivered_qty,
      so.remains_qty     AS smm_remains_qty,
      so.refund_amount   AS smm_refund_amount,
      so.provider_status AS smm_provider_status
    FROM orders o
    LEFT JOIN smm_orders so
      ON so.provider_order_id = o.provider_order_id
    WHERE o.id = ? AND o.userId = ?
    LIMIT 1
  `;

  db.query(sql, [orderId, userId], (err, rows) => {
    if (err || rows.length === 0) {
      console.error('order-details error:', err?.message || err);
      return res.status(404).send("❌ Order not found or access denied.");
    }

    const row = rows[0];

    res.render('order-details', {
      order: {
        id: row.id,
        productName: row.productName,
        price: row.price,
        purchaseDate: row.purchaseDate,
        status: row.status,
        order_details: row.order_details || '',
        admin_reply: row.admin_reply || '',
        provider_order_id: row.provider_order_id || null,

        // معلومات الـ SMM (بتكون null للطلبات العادية)
        smm_status: row.smm_status || null,
        smm_quantity: row.smm_quantity || null,
        smm_delivered_qty: row.smm_delivered_qty || null,
        smm_remains_qty: row.smm_remains_qty || null,
        smm_refund_amount: row.smm_refund_amount || null,
        smm_provider_status: row.smm_provider_status || null,
      }
    });
  });
});


// JSON status for polling من صفحة Order Details (UPDATED: includes delivery summary)
// JSON status for polling from Order Details
app.get('/order-details/:id/status.json', checkAuth, (req, res) => {
  const orderId = Number(req.params.id);
  const userId  = req.session.user?.id;

  if (!userId || !orderId) {
    return res.json({ ok: false });
  }

  const sql = `
    SELECT
      o.*,

      -- ===== SMM fields =====
      so.status          AS smm_status,
      so.quantity        AS smm_quantity,
      so.delivered_qty   AS smm_delivered_qty,
      so.remains_qty     AS smm_remains_qty,
      so.refund_amount   AS smm_refund_amount,
      so.provider_status AS smm_provider_status,

      -- ===== Delivery (safe preview only) =====
      od.created_at      AS delivery_created_at,
      od.delivery_text   AS delivery_text

    FROM orders o

    LEFT JOIN smm_orders so
      ON so.provider_order_id = o.provider_order_id

    LEFT JOIN order_deliveries od
      ON od.order_id = o.id

    WHERE o.id = ? AND o.userId = ?
    LIMIT 1
  `;

  db.query(sql, [orderId, userId], (err, rows) => {
    if (err || !rows || !rows.length) {
      console.error('order-details status.json error:', err?.message || err);
      return res.json({ ok: false });
    }

    const row = rows[0];

    // ======================================================
    // ==================== SMM BLOCK =======================
    // ======================================================
    let smmBlock = null;

    // ✅ SMM فقط إذا في سجل بـ smm_orders
    if (row.smm_status) {
      const orderedQty   = Number(row.smm_quantity || 0);
      const hasDelivered = row.smm_delivered_qty !== null && row.smm_delivered_qty !== undefined;
      const remainsDB    = Number(row.smm_remains_qty || 0);

      let deliveredQty, remainsQty;

      if (hasDelivered) {
        deliveredQty = Number(row.smm_delivered_qty || 0);
        remainsQty   = remainsDB || Math.max(0, orderedQty - deliveredQty);
      } else {
        remainsQty   = remainsDB;
        deliveredQty = Math.max(0, orderedQty - remainsQty);
      }

      if (deliveredQty < 0) deliveredQty = 0;
      if (deliveredQty > orderedQty) deliveredQty = orderedQty;
      if (remainsQty   < 0) remainsQty   = 0;

      smmBlock = {
        ordered: orderedQty,
        delivered: deliveredQty,
        remains: remainsQty,
        provider_status: row.smm_provider_status || row.smm_status || ''
      };
    }

    // ======================================================
    // ================= DELIVERY PREVIEW ===================
    // ======================================================
    const hasDelivery =
      !!(row.delivery_text && String(row.delivery_text).trim() !== '');

    let preview = '';
    if (hasDelivery) {
      const t = String(row.delivery_text).trim();
      preview = (t.length <= 10)
        ? 'Delivered'
        : `${t.slice(0, 3)}***${t.slice(-3)}`;
    }

    // ======================================================
    // ============== MANUAL / STOCK CHECK ==================
    // ======================================================
    let pendingManual = false;

    if (
      Object.prototype.hasOwnProperty.call(row, 'fulfillment_mode') ||
      Object.prototype.hasOwnProperty.call(row, 'stock_fallback')
    ) {
      pendingManual =
        (String(row.fulfillment_mode || '').toLowerCase() === 'stock') &&
        (Number(row.stock_fallback || 0) === 1);
    } else {
      const det = String(row.order_details || '').toLowerCase();
      pendingManual =
        det.includes('out of stock') ||
        det.includes('auto-delivery unavailable');
    }

    // ======================================================
    // ============== ADMIN REPLY LOGIC =====================
    // ======================================================
    const rawAdminReply = (row.admin_reply || '').toString();

    // إذا في delivery → نخفي admin_reply الحقيقي
    const adminReplyForClient = hasDelivery ? '' : rawAdminReply;

    // display_reply = نقطة عرض واحدة للواجهة
    const displayReply = hasDelivery
      ? (preview || 'Delivered')
      : (rawAdminReply.trim() ? rawAdminReply : '');

    // ======================================================
    // ==================== RESPONSE ========================
    // ======================================================
    return res.json({
      ok: true,
      status: row.status,

      // legacy (للواجهات القديمة)
      admin_reply: adminReplyForClient,

      // ✅ الجديد (الواجهة تعتمد عليه)
      display_reply: displayReply,

      // SMM (null للطلبات العادية)
      smm: smmBlock,

      // helpers
      delivery_preview: preview,
      delivery: {
        has_delivery: hasDelivery,
        preview,
        pending_manual: pendingManual
      }
    });
  });
});



app.get('/order-details/:id/delivery.json', checkAuth, async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const userId = req.session.user?.id;

  if (!userId) return res.status(401).json({ ok: false });
  if (!orderId) return res.status(400).json({ ok: false });

  try {
    const [[order]] = await promisePool.query(
      `SELECT id
         FROM orders
        WHERE id = ? AND userId = ?
        LIMIT 1`,
      [orderId, userId]
    );
    if (!order) return res.status(404).json({ ok: false });

    const [[del]] = await promisePool.query(
      `SELECT delivery_text
         FROM order_deliveries
        WHERE order_id = ?
        LIMIT 1`,
      [orderId]
    );

    if (!del?.delivery_text) {
      return res.status(404).json({ ok: false, message: 'No delivery yet' });
    }

    return res.json({ ok: true, delivery: del.delivery_text });

  } catch (e) {
    console.error('delivery.json error:', e);
    return res.status(500).json({ ok: false });
  }
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

app.get("/admin/shahid-api", checkAdmin, async (req, res) => {
  // 1) Types from API
  let types = [];
  try {
    const resp = await shahidApi.getTypes();
    types = Array.isArray(resp?.data) ? resp.data : [];
  } catch (e) {
    console.error("Admin Shahid types error:", e?.response?.data || e.message);
    types = [];
  }

  // 2) Existing configs from DB
  db.query("SELECT * FROM shahid_api_products ORDER BY sort_order ASC, id ASC", [], (err, rows) => {
    if (err) {
      console.error("DB error shahid_api_products:", err);
      return res.status(500).send("Server error");
    }

    const cfgMap = new Map((rows || []).map(r => [String(r.type), r]));

    // 3) Merge (نعرض كل types حتى لو ما عنده config بعد)
    const items = (types || []).map(t => {
      const cfg = cfgMap.get(String(t.type)) || {};
      return {
        type: t.type,
        api_title: t.title,
        months: t.months,
        api_full: t.price?.full ?? null,
        api_shared: t.price?.user ?? null,

        id: cfg.id || null,
        custom_title: cfg.custom_title || "",
        image: cfg.image || "",
        sell_price_full: cfg.sell_price_full ?? "",
        sell_price_shared: cfg.sell_price_shared ?? "",
        sort_order: cfg.sort_order ?? 0,
        is_enabled: (cfg.is_enabled ?? 0) ? 1 : 0
      };
    });

    return res.render("admin-shahid-api", {
      user: req.session.user || null,
      items
    });
  });
});

app.post("/admin/shahid-api/save", checkAdmin, (req, res) => {
  // نتوقع fields arrays
  const types = [].concat(req.body.type || []);
  const enabled = [].concat(req.body.is_enabled || []);
  const titles = [].concat(req.body.custom_title || []);
  const images = [].concat(req.body.image || []);
  const fullPrices = [].concat(req.body.sell_price_full || []);
  const sharedPrices = [].concat(req.body.sell_price_shared || []);
  const orders = [].concat(req.body.sort_order || []);

  if (!types.length) {
    return res.redirect("/admin/shahid-api");
  }

  let pending = types.length;
  let hadError = false;

  types.forEach((type, i) => {
    const row = {
      type: String(type),
      is_enabled: enabled[i] === "1" ? 1 : 0,
      custom_title: (titles[i] || "").trim(),
      image: (images[i] || "").trim(),
      sell_price_full: fullPrices[i] !== "" ? Number(fullPrices[i]) : null,
      sell_price_shared: sharedPrices[i] !== "" ? Number(sharedPrices[i]) : null,
      sort_order: orders[i] !== "" ? Number(orders[i]) : 0
    };

    const sql = `
      INSERT INTO shahid_api_products
        (type, custom_title, image, sell_price_full, sell_price_shared, sort_order, is_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        custom_title = VALUES(custom_title),
        image = VALUES(image),
        sell_price_full = VALUES(sell_price_full),
        sell_price_shared = VALUES(sell_price_shared),
        sort_order = VALUES(sort_order),
        is_enabled = VALUES(is_enabled)
    `;

    db.query(sql, [
      row.type,
      row.custom_title || null,
      row.image || null,
      row.sell_price_full,
      row.sell_price_shared,
      row.sort_order,
      row.is_enabled
    ], (err) => {
      if (err) {
        hadError = true;
        console.error("Save shahid_api_products error:", err);
      }
      pending--;
      if (pending === 0) {
        return res.redirect("/admin/shahid-api" + (hadError ? "?saved=0" : "?saved=1"));
      }
    });
  });
});



app.post('/admin/api-products/reset', checkAdmin, async (req, res) => {
  try {
    const id = Number(req.body.productId);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid productId' });
    }

    // عدّل الأعمدة حسب جدولك الفعلي (احذف اللي مش موجود عندك)
    await q(`
      UPDATE selected_api_products
      SET active = 0,
          custom_price = NULL,
          custom_image = NULL,
          custom_name = NULL,
          category = NULL
      WHERE product_id = ?
    `, [id]);

    return res.json({ success: true, message: `Local settings reset for product ${id}` });
  } catch (e) {
    console.error('❌ reset api product error:', e);
    return res.status(500).json({ success: false, message: e.message || 'Reset failed' });
  }
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

  const asBool = (v) => Number(v) === 1;
  const asNum  = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  try {
    const [category] = await q(
      `SELECT id, label, slug, image AS image_url
       FROM api_categories
       WHERE slug = ? AND active = 1 AND section = 'apps'
       LIMIT 1`,
      [slug]
    );
    if (!category) return res.status(404).send('Category not found');

    // ✅ خفّف الأعمدة + تأكد من القيم
    const selected = await q(
      `SELECT
         product_id, custom_price, custom_image, custom_name, category, active,
         is_out_of_stock, variable_quantity, unit_label, player_check
       FROM selected_api_products
       WHERE active = 1 AND category = ?`,
      [slug]
    );

    const map = new Map(selected.map(p => [Number(p.product_id), p]));

    const { getCachedAPIProducts } = require('./utils/getCachedAPIProducts');
    const apiProducts = await getCachedAPIProducts();

    const products = apiProducts
      .filter(p => map.has(Number(p.id)))
      .map(p => {
        const c = map.get(Number(p.id));

        const isQty = asBool(c.variable_quantity);

        // ✅ price: fixed -> custom_price (حتى لو 0) وإلا API price
        const price = isQty ? null : asNum((c.custom_price ?? p.price), 0);

        // ✅ flags normalized
        const outOfStock = asBool(c.is_out_of_stock);

        // ✅ DEBUG (احذفها بعد ما تتأكد)
        console.log('DEBUG OOS', { id: p.id, db: c.is_out_of_stock, outOfStock });

        return {
          id: Number(p.id),
          name: c.custom_name ?? p.name,
          image: c.custom_image ?? p.image ?? '/images/default-product.png',
          price,
          variable_quantity: isQty,
          unit_label: c.unit_label ?? 'units',
          requires_player_id: asBool(c.player_check ?? p.player_check) ? 1 : 0,
          is_out_of_stock: outOfStock
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


const bot = require('./telegram/bot');


// =============================================
//                  START SERVER
// =============================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);

  // ---- DB health gate ----
  const dbHealthy = async () => {
    try {
      await promisePool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  };

  // =========================================================
  // syncSMM safe runner (no crash, no overlap, + backoff)
  // =========================================================
  let syncSmmRunning = false;
  let smmBackoffMs = 0;

  const runSyncSMM = async () => {
    if (syncSmmRunning) return;

    if (smmBackoffMs > 0) {
      console.log(`⏳ syncSMM backoff ${Math.round(smmBackoffMs / 1000)}s`);
      return;
    }

    if (typeof isMaintenance === 'function' && isMaintenance()) return;

    if (!(await dbHealthy())) {
      console.log('⏭️ syncSMM skipped: DB not ready');
      smmBackoffMs = 30_000;
      setTimeout(() => { smmBackoffMs = 0; }, smmBackoffMs);
      return;
    }

    syncSmmRunning = true;
    try {
      await syncSMM();
      smmBackoffMs = 0;
    } catch (e) {
      console.error('❌ syncSMM run error:', e?.message || e);
      smmBackoffMs = smmBackoffMs ? Math.min(smmBackoffMs * 2, 10 * 60 * 1000) : 30_000;
      setTimeout(() => { smmBackoffMs = 0; }, smmBackoffMs);
    } finally {
      syncSmmRunning = false;
    }
  };

  // =========================================================
  // syncProviderOrders safe runner (syncJob) + backoff
  // =========================================================
  let providerRunning = false;
  let providerBackoffMs = 0;

  const runSyncProvider = async () => {
    if (providerRunning) return;

    if (providerBackoffMs > 0) {
      console.log(`⏳ syncProviderOrders backoff ${Math.round(providerBackoffMs / 1000)}s`);
      return;
    }

    if (typeof isMaintenance === 'function' && isMaintenance()) return;

    if (!(await dbHealthy())) {
      console.log('⏭️ syncProviderOrders skipped: DB not ready');
      providerBackoffMs = 30_000;
      setTimeout(() => { providerBackoffMs = 0; }, providerBackoffMs);
      return;
    }

    providerRunning = true;
    try {
      await syncJob(); // ✅ نفس الدالة اللي عندك
      providerBackoffMs = 0;
    } catch (e) {
      console.error('❌ syncProviderOrders error:', e?.message || e);
      providerBackoffMs = providerBackoffMs ? Math.min(providerBackoffMs * 2, 10 * 60 * 1000) : 30_000;
      setTimeout(() => { providerBackoffMs = 0; }, providerBackoffMs);
    } finally {
      providerRunning = false;
    }
  };

  // ✅ تشغيل أولي
  runSyncSMM();
  runSyncProvider();

  // ✅ خفّف الضغط: كل 3 دقائق (بدل 50 ثانية)
  setInterval(runSyncSMM, 3 * 60 * 1000);
  setInterval(runSyncProvider, 3 * 60 * 1000);

 

  // =========================
  // ✅ Telegram Webhook setup (DISABLED on Railway)
  // =========================
  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) {
    console.log("⚠️ PUBLIC_URL missing -> Telegram webhook setup skipped");
  } else {
    const webhookUrl = `${publicUrl}/telegram/webhook`;
    console.log("ℹ️ Webhook URL should be:", webhookUrl);
    console.log("ℹ️ Webhook setup skipped on Railway due to Telegram outbound timeouts.");
  }
});
