// /jobs/syncSMM.js
const axios = require('axios');

module.exports = function makeSyncSMMJob(db, promisePool) {
  const API_URL =
    process.env.SMMGEN_API_URL || 'https://my.smmgen.com/api/v2';

  const API_KEY = process.env.SMMGEN_API_KEY;

  // فاصل بين كل طلب status والثاني لتخفيف 429
  const REQUEST_DELAY_MS = 1500;

  // إجمالي المحاولات: المحاولة الأولى + محاولتان إضافيتان
  const MAX_STATUS_ATTEMPTS = 3;

  if (!API_KEY) {
    console.warn(
      '⚠️ SMMGEN_API_KEY is not set, syncSMM will not work correctly.'
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isDbDisconnect(err) {
    const code = err?.code;

    return (
      code === 'PROTOCOL_CONNECTION_LOST' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR' ||
      code === 'PROTOCOL_ENQUEUE_AFTER_QUIT'
    );
  }

  // ✅ normalize status strings: trim + lowercase
  function normStatus(s) {
    return String(s || '').trim().toLowerCase();
  }

  // ✅ mapping مرن
  function mapStatuses(providerStatus) {
    const s = normStatus(providerStatus);

    // SMMGen:
    // Pending, Processing, In progress, Completed, Partial, Canceled
    if (s.includes('completed')) {
      return {
        smm: 'completed',
        local: 'Accepted',
      };
    }

    if (s.includes('partial')) {
      return {
        smm: 'partial',
        local: 'Partial',
      };
    }

    if (
      s.includes('canceled') ||
      s.includes('cancelled')
    ) {
      return {
        smm: 'canceled',
        local: 'Rejected',
      };
    }

    if (
      s.includes('processing') ||
      s.includes('in progress') ||
      s.includes('in_progress')
    ) {
      return {
        smm: 'processing',
        local: 'In progress',
      };
    }

    return {
      smm: 'pending',
      local: 'Waiting',
    };
  }

  function getProviderErrorMessage(data) {
    const providerError = data?.error;

    if (typeof providerError === 'string') {
      return providerError;
    }

    if (providerError?.message) {
      return String(providerError.message);
    }

    if (providerError) {
      try {
        return JSON.stringify(providerError);
      } catch (_) {
        return 'Unknown provider error';
      }
    }

    if (data?.message) {
      return String(data.message);
    }

    return '';
  }

  function isRateLimited(httpStatus, data) {
    const errorCode = Number(
      data?.error?.code ??
      data?.code ??
      0
    );

    const message = getProviderErrorMessage(data).toLowerCase();

    return (
      httpStatus === 429 ||
      errorCode === 429 ||
      message.includes('too many requests') ||
      message.includes('rate limit')
    );
  }

  function getRetryWaitMs(response, attempt) {
    const retryAfterHeader =
      response?.headers?.['retry-after'];

    const retryAfterSeconds =
      Number(retryAfterHeader);

    if (
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0
    ) {
      return retryAfterSeconds * 1000;
    }

    // المحاولة الأولى: 5 ثوانٍ
    // المحاولة الثانية: 10 ثوانٍ
    return attempt * 5000;
  }

  async function fetchStatus(orderId) {
    if (!API_KEY) {
      throw new Error('SMMGEN_API_KEY is missing');
    }

    if (!orderId) {
      throw new Error('provider order ID is missing');
    }

    for (
      let attempt = 1;
      attempt <= MAX_STATUS_ATTEMPTS;
      attempt += 1
    ) {
      const params = new URLSearchParams({
        key: API_KEY,
        action: 'status',
        order: String(orderId),
      });

      let response;

      try {
        response = await axios.post(
          API_URL,
          params.toString(),
          {
            timeout: 20_000,
            headers: {
              'Content-Type':
                'application/x-www-form-urlencoded',
            },

            // نفحص status يدويًا حتى نقدر نعالج 429
            validateStatus: () => true,
          }
        );
      } catch (networkErr) {
        const isTemporaryNetworkError =
          networkErr?.code === 'ECONNRESET' ||
          networkErr?.code === 'ECONNABORTED' ||
          networkErr?.code === 'ETIMEDOUT' ||
          networkErr?.code === 'EAI_AGAIN';

        if (
          isTemporaryNetworkError &&
          attempt < MAX_STATUS_ATTEMPTS
        ) {
          const waitMs = attempt * 3000;

          console.warn(
            `⏳ syncSMM: temporary connection error for provider order ${orderId}. ` +
            `Retrying in ${Math.round(waitMs / 1000)}s...`
          );

          await sleep(waitMs);
          continue;
        }

        throw networkErr;
      }

      const { status: httpStatus, data } = response;

      if (isRateLimited(httpStatus, data)) {
        if (attempt < MAX_STATUS_ATTEMPTS) {
          const waitMs = getRetryWaitMs(
            response,
            attempt
          );

          console.warn(
            `⏳ syncSMM: SMMGen rate limit for provider order ${orderId}. ` +
            `Attempt ${attempt}/${MAX_STATUS_ATTEMPTS}. ` +
            `Retrying in ${Math.round(waitMs / 1000)}s...`
          );

          await sleep(waitMs);
          continue;
        }

        const err = new Error(
          `SMMGen rate limit after ${MAX_STATUS_ATTEMPTS} attempts`
        );

        err.provider_payload = data;
        err.http_status = httpStatus;
        throw err;
      }

      if (httpStatus < 200 || httpStatus >= 300) {
        const err = new Error(
          `SMMGen HTTP error ${httpStatus}`
        );

        err.provider_payload = data;
        err.http_status = httpStatus;
        throw err;
      }

      if (!data) {
        const err = new Error(
          'Empty response from SMMGen'
        );

        err.provider_payload = data;
        throw err;
      }

      if (
        typeof data === 'object' &&
        data.error
      ) {
        const message =
          getProviderErrorMessage(data) ||
          'Unknown provider error';

        const err = new Error(message);
        err.provider_payload = data;
        throw err;
      }

      return data;
    }

    throw new Error(
      `Failed to fetch status for provider order ${orderId}`
    );
  }

  async function safeQuery(sql, params = []) {
    try {
      return await promisePool.query(sql, params);
    } catch (err) {
      if (isDbDisconnect(err)) {
        console.error(
          '❌ syncSMM: DB connection lost (retry once):',
          err.message || err
        );

        await sleep(1500);

        return await promisePool.query(
          sql,
          params
        );
      }

      throw err;
    }
  }

  async function safeGetConnection() {
    try {
      return await promisePool.getConnection();
    } catch (err) {
      if (isDbDisconnect(err)) {
        console.error(
          '❌ syncSMM: cannot get DB connection (skip order):',
          err.message || err
        );

        return null;
      }

      throw err;
    }
  }

  async function dbHealthy() {
    try {
      await promisePool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  return async function syncSmmOrders() {
    console.log('🔄 syncSMM job running...');

    if (!API_KEY) {
      console.log(
        '⏭️ syncSMM skipped: SMMGEN_API_KEY is missing'
      );
      return;
    }

    // Gate سريع: إذا DB مش جاهزة ما نفوت
    if (!(await dbHealthy())) {
      console.log(
        '⏭️ syncSMM skipped: DB not ready'
      );
      return;
    }

    // SELECT مع ORDER BY قبل LIMIT
    let rows = [];

    try {
      const [r] = await safeQuery(
        `
        SELECT
          so.*,
          o.id     AS order_id,
          o.userId AS user_id,
          o.price  AS user_price,
          o.status AS order_status
        FROM smm_orders so
        JOIN orders o
          ON o.provider_order_id = so.provider_order_id
        WHERE
          so.provider_order_id IS NOT NULL
          AND so.provider_order_id <> ''
          AND (
            so.status IN ('pending','processing','partial')
            OR (
              so.status = 'completed'
              AND so.refunded = 0
              AND so.charge > 0
            )
          )
        ORDER BY o.id DESC
        LIMIT 20
        `
      );

      rows = r || [];
    } catch (err) {
      if (isDbDisconnect(err)) {
        console.error(
          '❌ syncSMM: DB connection lost (skipping this run):',
          err.message || err
        );

        return;
      }

      console.error(
        '❌ syncSMM: top-level DB error:',
        err
      );

      return;
    }

    if (!rows.length) {
      console.log(
        '🔄 syncSMM: no pending SMM orders.'
      );
      return;
    }

    console.log(
      `📦 syncSMM: checking ${rows.length} order(s)`
    );

    /*
     * نستعمل index بدل for...of حتى نضيف فاصلًا
     * بين طلبات الـ API بدون الانتظار قبل أول طلب.
     */
    for (
      let index = 0;
      index < rows.length;
      index += 1
    ) {
      const row = rows[index];
      const providerOrderId =
        row.provider_order_id;

      // فاصل بين الطلبات لتخفيف 429
      if (index > 0) {
        await sleep(REQUEST_DELAY_MS);
      }

      // API fetch
      let statusData;

      try {
        statusData = await fetchStatus(
          providerOrderId
        );

        console.log('SMMGEN status:', {
          order: providerOrderId,
          status: statusData?.status,
          remains: statusData?.remains,
          charge: statusData?.charge,
        });
      } catch (err) {
        const msg =
          err?.provider_payload ||
          err?.response?.data ||
          err?.message ||
          err;

        console.error(
          `❌ syncSMM: error fetching status for provider_order_id=${providerOrderId}:`,
          msg
        );

        continue;
      }

      const providerStatusRaw =
        statusData?.status || '';

      const {
        smm: smmStatus,
        local: localStatus,
      } = mapStatuses(providerStatusRaw);

      const orderedQty =
        Number(row.quantity || 0);

      const remainsFromApi =
        Number(statusData?.remains);

      const remainsFromDb =
        Number(row.remains_qty);

      // remains: نختار الأصح ونضبط الحدود
      let remains = remainsFromApi;

      if (
        !Number.isFinite(remains) ||
        remains < 0
      ) {
        remains = remainsFromDb;
      }

      if (
        !Number.isFinite(remains) ||
        remains < 0
      ) {
        remains = 0;
      }

      if (
        orderedQty > 0 &&
        remains > orderedQty
      ) {
        remains = orderedQty;
      }

      const delivered = Math.max(
        0,
        Math.min(
          orderedQty,
          orderedQty - remains
        )
      );

      /*
       * بقي كما كان عندك حتى لا نغيّر
       * منطق الحساب الحالي.
       */
      const userPaid = Number(
        row.charge || row.user_price || 0
      );

      let refundAmount = 0;

      if (
        (
          smmStatus === 'partial' ||
          smmStatus === 'canceled'
        ) &&
        orderedQty > 0 &&
        userPaid > 0
      ) {
        const ratio =
          delivered / orderedQty;

        const usedAmount = +(
          userPaid * ratio
        ).toFixed(2);

        refundAmount = +(
          userPaid - usedAmount
        ).toFixed(2);

        if (refundAmount < 0.01) {
          refundAmount = 0;
        }
      }

      // Transaction
      const conn =
        await safeGetConnection();

      if (!conn) {
        continue;
      }

      try {
        await conn.beginTransaction();

        // تحديث smm_orders
        await conn.query(
          `
          UPDATE smm_orders
          SET
            status          = ?,
            provider_status = ?,
            delivered_qty   = ?,
            remains_qty     = ?,
            refund_amount   = refund_amount + ?,
            charge          = ?,
            updated_at      = NOW()
          WHERE id = ?
          `,
          [
            smmStatus,
            providerStatusRaw,
            delivered,
            remains,
            refundAmount,
            userPaid - refundAmount,
            row.id,
          ]
        );

        // تحديث orders.status
        await conn.query(
          `
          UPDATE orders
          SET status = ?
          WHERE id = ?
          `,
          [
            localStatus,
            row.order_id,
          ]
        );

        // Refund إذا لازم
        if (
          refundAmount > 0 &&
          !row.refunded
        ) {
          await conn.query(
            `
            UPDATE users
            SET balance = balance + ?
            WHERE id = ?
            `,
            [
              refundAmount,
              row.user_id,
            ]
          );

          await conn.query(
            `
            INSERT INTO transactions
              (user_id, type, amount, reason)
            VALUES
              (?, 'credit', ?, ?)
            `,
            [
              row.user_id,
              refundAmount,
              `Partial refund for SMM order #${row.id} (provider: ${providerStatusRaw})`,
            ]
          );

          await conn.query(
            `
            UPDATE smm_orders
            SET refunded = 1
            WHERE id = ?
            `,
            [row.id]
          );

          const adminMsg = `
جزء من خدمتك تم تنفيذه بشكل جزئي من المزود:
- الكمية المطلوبة: ${orderedQty}
- الكمية المنفذة: ${delivered}
- الكمية غير المنفذة / المسترجعة: ${remains}
- المبلغ المسترجع لرصيدك: $${refundAmount.toFixed(2)}
          `.trim();

          await conn.query(
            `
            UPDATE orders
            SET admin_reply = ?
            WHERE id = ?
            `,
            [
              adminMsg,
              row.order_id,
            ]
          );
        }

        await conn.commit();

        console.log(
          `✅ syncSMM: order #${row.order_id} ` +
          `provider ${providerOrderId} → ${providerStatusRaw}, ` +
          `local=${localStatus}, ` +
          `refund=$${refundAmount}`
        );
      } catch (innerErr) {
        try {
          await conn.rollback();
        } catch (_) {
          // تجاهل خطأ rollback
        }

        if (isDbDisconnect(innerErr)) {
          console.error(
            '❌ syncSMM: DB lost during transaction (will retry next run):',
            innerErr.message || innerErr
          );
        } else {
          console.error(
            '❌ syncSMM (transaction) error:',
            innerErr.message || innerErr
          );
        }
      } finally {
        try {
          conn.release();
        } catch (_) {
          // تجاهل خطأ release
        }
      }
    }

    console.log('✅ syncSMM job finished.');
  };
};