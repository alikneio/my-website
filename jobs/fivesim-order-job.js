'use strict';

/*
|--------------------------------------------------------------------------
| 5SIM Orders Job
|--------------------------------------------------------------------------
|
| - يفحص طلبات 5SIM المعلّقة كل دقيقة.
| - يحفظ الرقم والكود عند وصول SMS.
| - يعتمد على expires_at القادم من 5SIM.
| - يستخدم created_at + 15 دقيقة فقط كخطة احتياط.
| - يلغي الطلب المنتهي عند المزود إن أمكن.
| - يرجع رصيد الزبون مرة واحدة فقط.
| - لا يلمس SMM أو الطلبات العادية.
|
*/

const JOB_INTERVAL_MS = 60_000;
const FALLBACK_EXPIRY_MINUTES = 15;
const MAX_ORDERS_PER_RUN = 100;

const MYSQL_LOCK_NAME =
  'akcell:fivesim-order-job:v1';

const FAILURE_STATUSES = new Set([
  'CANCELED',
  'CANCELLED',
  'TIMEOUT',
  'EXPIRED',
  'BANNED',
  'REFUNDED'
]);

// =====================================================
// Helpers
// =====================================================

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeStatus(value) {
  return clean(value).toUpperCase();
}

function isFailureStatus(status) {
  return FAILURE_STATUSES.has(
    normalizeStatus(status)
  );
}

function parseDateUtc(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value;
  }

  const raw = clean(value);

  if (!raw) {
    return null;
  }

  /*
   * database.js عندك:
   * timezone: 'Z'
   * dateStrings: true
   *
   * لذلك تاريخ MySQL بدون timezone نعتبره UTC.
   */
  const normalized =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? `${raw.replace(' ', 'T')}Z`
      : raw;

  const date = new Date(normalized);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function toMysqlUtc(value) {
  const date = parseDateUtc(value);

  if (!date) {
    return null;
  }

  return date
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function getEffectiveExpiry(row) {
  /*
   * الأولوية دائمًا للوقت القادم من 5SIM.
   */
  const providerExpiry = parseDateUtc(
    row.expires_at
  );

  if (providerExpiry) {
    return providerExpiry;
  }

  /*
   * Fallback فقط إذا المزود لم يرسل expires_at.
   */
  const createdAt = parseDateUtc(
    row.created_at
  );

  if (!createdAt) {
    return null;
  }

  return new Date(
    createdAt.getTime() +
    FALLBACK_EXPIRY_MINUTES * 60_000
  );
}

function extractLatestSms(
  providerOrder,
  oldCode = '',
  oldText = ''
) {
  const smsList = Array.isArray(
    providerOrder?.sms
  )
    ? providerOrder.sms
    : [];

  /*
   * نبحث من آخر رسالة إلى أول رسالة.
   */
  for (
    let index = smsList.length - 1;
    index >= 0;
    index -= 1
  ) {
    const sms = smsList[index] || {};

    const code = clean(
      sms.code ||
      sms.sms_code
    );

    const text = clean(
      sms.text ||
      sms.sms_text ||
      sms.message
    );

    if (code || text) {
      return {
        code: code || clean(oldCode),
        text: text || clean(oldText)
      };
    }
  }

  return {
    code: clean(oldCode),
    text: clean(oldText)
  };
}

// =====================================================
// MySQL global lock
// يمنع تشغيل Jobين بنفس الوقت
// =====================================================

async function acquireGlobalLock(
  promisePool
) {
  const [[row]] =
    await promisePool.query(
      `
      SELECT GET_LOCK(?, 0) AS acquired
      `,
      [MYSQL_LOCK_NAME]
    );

  return Number(
    row?.acquired || 0
  ) === 1;
}

async function releaseGlobalLock(
  promisePool
) {
  try {
    await promisePool.query(
      `
      SELECT RELEASE_LOCK(?)
      `,
      [MYSQL_LOCK_NAME]
    );
  } catch (_) {
    // لا نكسر الـJob بسبب فشل تحرير القفل.
  }
}

// =====================================================
// Financial audit
// =====================================================

async function insertRefundTransaction({
  conn,
  userId,
  orderId,
  amount
}) {
  await conn.query(
    `
    INSERT INTO transactions
      (
        user_id,
        order_id,
        type,
        amount,
        reason
      )
    VALUES
      (
        ?,
        ?,
        'credit',
        ?,
        ?
      )
    `,
    [
      userId,
      orderId,
      amount,
      `Automatic 5SIM refund for order #${orderId}`
    ]
  );
}

async function insertRefundNotification({
  conn,
  userId,
  orderId,
  amount
}) {
  /*
   * إذا شكل جدول notifications عندك مختلف،
   * لا نسمح لهذا الشي بمنع الاسترجاع المالي.
   */
  try {
    await conn.query(
      `
      INSERT INTO notifications
        (
          user_id,
          message,
          type,
          created_at
        )
      VALUES
        (
          ?,
          ?,
          'order',
          NOW()
        )
      `,
      [
        userId,
        `Virtual number order #${orderId} was rejected. $${Number(
          amount
        ).toFixed(2)} was refunded to your balance.`
      ]
    );
  } catch (error) {
    console.warn(
      '⚠️ 5SIM refund notification skipped:',
      error.code ||
      error.message
    );
  }
}

// =====================================================
// SMS received
// =====================================================

async function markOrderAccepted({
  promisePool,
  row,
  providerOrder,
  providerStatus,
  phoneNumber,
  smsCode,
  smsText,
  expiresAt
}) {
  const conn =
    await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    const [[lockedOrder]] =
      await conn.query(
        `
        SELECT
          id,
          refunded,
          sms_code,
          sms_text
        FROM fivesim_orders
        WHERE id = ?
        FOR UPDATE
        `,
        [row.fivesim_id]
      );

    if (!lockedOrder) {
      await conn.rollback();
      return false;
    }

    /*
     * إذا رجعنا الرصيد سابقًا، لا نعيد فتح الطلب.
     */
    if (
      Number(
        lockedOrder.refunded || 0
      ) === 1
    ) {
      await conn.rollback();

      console.warn(
        `⚠️ 5SIM order #${row.order_id} was already refunded; late SMS ignored`
      );

      return false;
    }

    const finalSmsCode =
      clean(smsCode) ||
      clean(lockedOrder.sms_code);

    const finalSmsText =
      clean(smsText) ||
      clean(lockedOrder.sms_text);

    await conn.query(
      `
      UPDATE fivesim_orders
      SET
        phone_number = ?,
        sms_code = ?,
        sms_text = ?,
        status = 'received',
        provider_status = ?,
        expires_at = ?,
        raw_response = ?,
        updated_at = NOW()
      WHERE id = ?
      `,
      [
        phoneNumber ||
        row.phone_number ||
        null,

        finalSmsCode || null,
        finalSmsText || null,

        providerStatus || null,
        expiresAt,

        JSON.stringify(
          providerOrder || {}
        ),

        row.fivesim_id
      ]
    );

    await conn.query(
      `
      UPDATE orders
      SET
        status = 'Accepted',
        is_new = 1
      WHERE id = ?
        AND provider = 'fivesim'
      `,
      [row.order_id]
    );

    await conn.commit();

    console.log(
      `✅ 5SIM order #${row.order_id}: SMS received`
    );

    return true;

  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {
      // ignore rollback error
    }

    throw error;

  } finally {
    conn.release();
  }
}

// =====================================================
// Refund exactly once
// =====================================================

async function refundOrderOnce({
  promisePool,
  row,
  providerStatus,
  providerPayload
}) {
  const conn =
    await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    /*
     * نقفل سجل 5SIM أولًا.
     */
    const [[fiveOrder]] =
      await conn.query(
        `
        SELECT
          id,
          order_id,
          user_id,
          customer_price,
          sms_code,
          sms_text,
          refunded,
          refund_amount
        FROM fivesim_orders
        WHERE id = ?
        FOR UPDATE
        `,
        [row.fivesim_id]
      );

    if (!fiveOrder) {
      await conn.rollback();
      return false;
    }

    /*
     * منع Refund مكرر.
     */
    if (
      Number(
        fiveOrder.refunded || 0
      ) === 1
    ) {
      await conn.rollback();
      return false;
    }

    /*
     * إذا الكود وصل، ممنوع الاسترجاع.
     */
    if (
      clean(fiveOrder.sms_code) ||
      clean(fiveOrder.sms_text)
    ) {
      await conn.rollback();
      return false;
    }

    /*
     * نقفل الطلب الرئيسي.
     */
    const [[localOrder]] =
      await conn.query(
        `
        SELECT
          id,
          userId,
          price,
          status,
          provider
        FROM orders
        WHERE id = ?
          AND provider = 'fivesim'
        FOR UPDATE
        `,
        [fiveOrder.order_id]
      );

    if (!localOrder) {
      await conn.rollback();
      return false;
    }

    /*
     * نقفل المستخدم قبل تعديل الرصيد.
     */
    const [[user]] =
      await conn.query(
        `
        SELECT
          id,
          balance,
          total_spent
        FROM users
        WHERE id = ?
        FOR UPDATE
        `,
        [fiveOrder.user_id]
      );

    if (!user) {
      await conn.rollback();
      return false;
    }

    /*
     * نرجع سعر البيع للزبون،
     * وليس تكلفة المزود.
     */
    const refundAmount = Number(
      fiveOrder.customer_price ||
      localOrder.price ||
      0
    );

    if (
      !Number.isFinite(refundAmount) ||
      refundAmount <= 0
    ) {
      throw new Error(
        `Invalid refund amount for order #${fiveOrder.order_id}`
      );
    }

    /*
     * نعلّم الطلب Refunded أولًا داخل نفس Transaction.
     * شرط refunded=0 حماية إضافية.
     */
    const [markResult] =
      await conn.query(
        `
        UPDATE fivesim_orders
        SET
          status = 'failed',
          provider_status = ?,
          refunded = 1,
          refund_amount = ?,
          raw_response = ?,
          updated_at = NOW()
        WHERE id = ?
          AND refunded = 0
          AND COALESCE(sms_code, '') = ''
          AND COALESCE(sms_text, '') = ''
        `,
        [
          providerStatus ||
          'EXPIRED',

          refundAmount,

          JSON.stringify(
            providerPayload || {}
          ),

          fiveOrder.id
        ]
      );

    if (
      markResult.affectedRows !== 1
    ) {
      await conn.rollback();
      return false;
    }

    /*
     * إعادة الرصيد.
     */
    await conn.query(
      `
      UPDATE users
      SET
        balance = balance + ?,
        total_spent = GREATEST(
          0,
          COALESCE(total_spent, 0) - ?
        )
      WHERE id = ?
      `,
      [
        refundAmount,
        refundAmount,
        fiveOrder.user_id
      ]
    );

    /*
     * تحديث الطلب الرئيسي.
     */
    await conn.query(
      `
      UPDATE orders
      SET
        status = 'Rejected',
        is_new = 1
      WHERE id = ?
        AND provider = 'fivesim'
      `,
      [fiveOrder.order_id]
    );

    /*
     * تسجيل حركة مالية.
     */
    await insertRefundTransaction({
      conn,
      userId:
        fiveOrder.user_id,
      orderId:
        fiveOrder.order_id,
      amount:
        refundAmount
    });

    /*
     * إشعار اختياري.
     */
    await insertRefundNotification({
      conn,
      userId:
        fiveOrder.user_id,
      orderId:
        fiveOrder.order_id,
      amount:
        refundAmount
    });

    await conn.commit();

    console.log(
      `✅ 5SIM order #${fiveOrder.order_id}: refunded $${refundAmount.toFixed(2)}`
    );

    return true;

  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {
      // ignore rollback error
    }

    throw error;

  } finally {
    conn.release();
  }
}

// =====================================================
// Process one pending order
// =====================================================

async function processPendingOrder({
  promisePool,
  getFiveSimOrder,
  cancelFiveSimOrder,
  row
}) {
  let providerOrder = null;

  let providerStatus =
    normalizeStatus(
      row.provider_status ||
      row.status ||
      'PENDING'
    );

  let providerCheckFailed = false;

  /*
   * جلب الحالة الحالية من 5SIM.
   */
  try {
    providerOrder =
      await getFiveSimOrder(
        row.provider_order_id
      );

    providerStatus =
      normalizeStatus(
        providerOrder?.status ||
        providerStatus
      );

  } catch (error) {
    providerCheckFailed = true;

    console.warn(
      `⚠️ 5SIM status check failed for order #${row.order_id}:`,
      error.providerPayload ||
      error.message ||
      error
    );
  }

  const {
    code: smsCode,
    text: smsText
  } = extractLatestSms(
    providerOrder,
    row.sms_code,
    row.sms_text
  );

  const phoneNumber =
    clean(
      providerOrder?.phone ||
      row.phone_number
    );

  const expiresAt =
    toMysqlUtc(
      providerOrder?.expires ||
      providerOrder?.expires_at ||
      providerOrder?.expire ||
      row.expires_at
    );

  /*
   * وصول SMS له الأولوية المطلقة.
   */
  if (smsCode || smsText) {
    await markOrderAccepted({
      promisePool,
      row,
      providerOrder,
      providerStatus,
      phoneNumber,
      smsCode,
      smsText,
      expiresAt
    });

    return;
  }

  const effectiveExpiry =
    getEffectiveExpiry({
      ...row,

      expires_at:
        expiresAt ||
        row.expires_at
    });

  const expiredByTime =
    Boolean(
      effectiveExpiry &&
      Date.now() >=
        effectiveExpiry.getTime()
    );

  const terminalFailure =
    isFailureStatus(
      providerStatus
    );

  /*
   * الطلب ما زال شغال.
   */
  if (
    !terminalFailure &&
    !expiredByTime
  ) {
    /*
     * تحديث البيانات المحلية فقط.
     */
    if (providerOrder) {
      await promisePool.query(
        `
        UPDATE fivesim_orders
        SET
          phone_number = ?,
          provider_status = ?,
          expires_at = ?,
          raw_response = ?,
          updated_at = NOW()
        WHERE id = ?
          AND refunded = 0
        `,
        [
          phoneNumber || null,
          providerStatus || 'PENDING',
          expiresAt,

          JSON.stringify(
            providerOrder
          ),

          row.fivesim_id
        ]
      );
    }

    return;
  }

  /*
   * إذا API المزود وقع مؤقتًا،
   * لا نرجع الرصيد إلا بعد انتهاء الوقت المحفوظ فعليًا.
   */
  if (
    providerCheckFailed &&
    !expiredByTime
  ) {
    return;
  }

  /*
   * إذا انتهى الوقت لكن المزود لم يرجع Failure،
   * نحاول إلغاء الطلب.
   */
  if (
    expiredByTime &&
    !terminalFailure
  ) {
    try {
      const cancelResult =
        await cancelFiveSimOrder(
          row.provider_order_id
        );

      providerOrder =
        cancelResult ||
        providerOrder;

      providerStatus =
        normalizeStatus(
          cancelResult?.status ||
          'CANCELED'
        );

    } catch (error) {
      console.warn(
        `⚠️ 5SIM cancel failed for order #${row.order_id}:`,
        error.providerPayload ||
        error.message ||
        error
      );

      /*
       * بما أن الوقت انتهى فعلًا،
       * ما منحبس رصيد الزبون بسبب فشل Endpoint الإلغاء.
       */
      if (
        !providerStatus ||
        providerStatus === 'PENDING'
      ) {
        providerStatus = 'EXPIRED';
      }
    }
  }

  await refundOrderOnce({
    promisePool,
    row,

    providerStatus:
      providerStatus ||
      (
        expiredByTime
          ? 'EXPIRED'
          : 'CANCELED'
      ),

    providerPayload:
      providerOrder || {
        status:
          providerStatus ||
          (
            expiredByTime
              ? 'EXPIRED'
              : 'CANCELED'
          ),

        effective_expiry:
          effectiveExpiry
            ? effectiveExpiry.toISOString()
            : null
      }
  });
}

// =====================================================
// Run job once
// =====================================================

async function runFiveSimOrderJob({
  promisePool,
  getFiveSimOrder,
  cancelFiveSimOrder
}) {
  let lockAcquired = false;

  try {
    lockAcquired =
      await acquireGlobalLock(
        promisePool
      );

    /*
     * Job ثاني شغال على Instance أخرى.
     */
    if (!lockAcquired) {
      return;
    }

    const [rows] =
      await promisePool.query(
        `
        SELECT
          fvo.id AS fivesim_id,
          fvo.order_id,
          fvo.user_id,
          fvo.provider_order_id,
          fvo.phone_number,
          fvo.sms_code,
          fvo.sms_text,
          fvo.status,
          fvo.provider_status,
          fvo.expires_at,
          fvo.created_at,
          fvo.refunded,
          fvo.customer_price,

          o.status AS order_status

        FROM fivesim_orders fvo

        INNER JOIN orders o
          ON o.id = fvo.order_id
         AND o.provider = 'fivesim'

        WHERE fvo.refunded = 0

          AND COALESCE(
            fvo.sms_code,
            ''
          ) = ''

          AND COALESCE(
            fvo.sms_text,
            ''
          ) = ''

          AND fvo.provider_order_id
              IS NOT NULL

          AND o.status <> 'Accepted'

        ORDER BY
          fvo.created_at ASC

        LIMIT ?
        `,
        [MAX_ORDERS_PER_RUN]
      );

    for (const row of rows) {
      try {
        await processPendingOrder({
          promisePool,
          getFiveSimOrder,
          cancelFiveSimOrder,
          row
        });

      } catch (error) {
        /*
         * خطأ طلب واحد لا يوقف بقية الطلبات.
         */
        console.error(
          '❌ 5SIM job failed for one order:',
          {
            orderId:
              row.order_id,

            providerOrderId:
              row.provider_order_id,

            code:
              error.code,

            message:
              error.message ||
              error
          }
        );
      }
    }

  } catch (error) {
    console.error(
      '❌ 5SIM job run failed:',
      {
        code:
          error.code,

        message:
          error.message ||
          error
      }
    );

  } finally {
    if (lockAcquired) {
      await releaseGlobalLock(
        promisePool
      );
    }
  }
}

// =====================================================
// Start recurring job
// =====================================================

function startFiveSimOrderJob({
  promisePool,
  getFiveSimOrder,
  cancelFiveSimOrder
}) {
  if (!promisePool) {
    throw new Error(
      'startFiveSimOrderJob: promisePool is required'
    );
  }

  if (
    typeof getFiveSimOrder !==
    'function'
  ) {
    throw new Error(
      'startFiveSimOrderJob: getFiveSimOrder is required'
    );
  }

  if (
    typeof cancelFiveSimOrder !==
    'function'
  ) {
    throw new Error(
      'startFiveSimOrderJob: cancelFiveSimOrder is required'
    );
  }

  /*
   * حماية من تشغيل interval مرتين
   * داخل نفس Node process.
   */
  if (
    global.__FIVESIM_ORDER_JOB_INTERVAL__
  ) {
    return global
      .__FIVESIM_ORDER_JOB_INTERVAL__;
  }

  const runner = () => {
    runFiveSimOrderJob({
      promisePool,
      getFiveSimOrder,
      cancelFiveSimOrder
    }).catch((error) => {
      console.error(
        '❌ Unhandled 5SIM job error:',
        error.message ||
        error
      );
    });
  };

  /*
   * تشغيل أول مرة بعد إقلاع السيرفر.
   */
  const initialTimer =
    setTimeout(
      runner,
      8_000
    );

  if (
    typeof initialTimer.unref ===
    'function'
  ) {
    initialTimer.unref();
  }

  /*
   * تشغيل دوري كل دقيقة.
   */
  global.__FIVESIM_ORDER_JOB_INTERVAL__ =
    setInterval(
      runner,
      JOB_INTERVAL_MS
    );

  if (
    typeof global
      .__FIVESIM_ORDER_JOB_INTERVAL__
      .unref === 'function'
  ) {
    global
      .__FIVESIM_ORDER_JOB_INTERVAL__
      .unref();
  }

  console.log(
    `✅ 5SIM job started — every ${
      JOB_INTERVAL_MS / 1000
    }s`
  );

  return global
    .__FIVESIM_ORDER_JOB_INTERVAL__;
}

module.exports = {
  startFiveSimOrderJob,
  runFiveSimOrderJob
};