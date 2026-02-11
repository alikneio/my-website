// /jobs/syncSMM.js
const axios = require('axios');

module.exports = function makeSyncSMMJob(db, promisePool) {
  const API_URL = 'https://smmgen.com/api/v2';
  const API_KEY = process.env.SMMGEN_API_KEY;

  if (!API_KEY) {
    console.warn('⚠️ SMMGEN_API_KEY is not set, syncSMM will not work correctly.');
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

  function mapStatuses(providerStatus) {
    const s = (providerStatus || '').toLowerCase();

    // قيم SMMGen المتوقعة: Pending, Processing, In progress, Completed, Partial, Canceled
    if (s === 'completed') return { smm: 'completed', local: 'Accepted' };
    if (s === 'partial')   return { smm: 'partial',   local: 'Partial' };
    if (s === 'canceled')  return { smm: 'canceled',  local: 'Rejected' };
    if (s === 'processing' || s === 'in progress') {
      return { smm: 'processing', local: 'In progress' };
    }
    // pending / undefined
    return { smm: 'pending', local: 'Waiting' };
  }

  async function fetchStatus(orderId) {
    const params = new URLSearchParams({
      key: API_KEY || '',
      action: 'status',
      order: orderId,
    });

    // Timeout مهم حتى ما يعلق الـ job
    const { data } = await axios.post(API_URL, params, { timeout: 20_000 });
    return data;
  }

  async function safeQuery(sql, params) {
    try {
      return await promisePool.query(sql, params);
    } catch (err) {
      // Retry مرة واحدة إذا انقطع الاتصال
      if (isDbDisconnect(err)) {
        console.error('❌ syncSMM: DB connection lost (retry once):', err.message || err);
        await new Promise((r) => setTimeout(r, 1500));
        return await promisePool.query(sql, params);
      }
      throw err;
    }
  }

  async function safeGetConnection() {
    try {
      return await promisePool.getConnection();
    } catch (err) {
      if (isDbDisconnect(err)) {
        console.error('❌ syncSMM: cannot get DB connection (skip run):', err.message || err);
        return null;
      }
      throw err;
    }
  }

  return async function syncSmmOrders() {
    console.log('🔄 syncSMM job running...');

    // 1) أول SELECT كان سبب الكراش لأنه برا try/catch
    let rows = [];
    try {
      const [r] = await safeQuery(`
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
            OR (so.status = 'completed' AND so.refunded = 0 AND so.charge > 0)
          )
        LIMIT 100
      `);
      rows = r || [];
    } catch (err) {
      if (isDbDisconnect(err)) {
        console.error('❌ syncSMM: DB connection lost (skipping this run):', err.message || err);
        return;
      }
      console.error('❌ syncSMM: top-level DB error:', err);
      return;
    }

    if (!rows.length) {
      console.log('🔄 syncSMM: no pending SMM orders.');
      return;
    }

    for (const row of rows) {
      const providerOrderId = row.provider_order_id;

      // 2) API fetch (إذا فشل ما لازم يوقع الـ job)
      let statusData;
      try {
        statusData = await fetchStatus(providerOrderId);
        console.log('SMMGEN status response:', statusData);
      } catch (err) {
        // Axios errors
        const msg = err?.response?.data || err?.message || err;
        console.error(`❌ syncSMM: error fetching status for provider_order_id=${providerOrderId}:`, msg);
        continue;
      }

      const providerStatusRaw = statusData?.status || '';
      const { smm: smmStatus, local: localStatus } = mapStatuses(providerStatusRaw);

      const orderedQty     = Number(row.quantity || 0);
      const remainsFromApi = Number(statusData?.remains || 0);
      const remainsFromDb  = Number(row.remains_qty || 0);

      // remains: نختار الأحدث/الأصح، ونضبط الحدود
      let remains = remainsFromApi;
      if (!Number.isFinite(remains) || remains < 0) remains = remainsFromDb;
      if (!Number.isFinite(remains) || remains < 0) remains = 0;
      if (orderedQty > 0 && remains > orderedQty) remains = orderedQty;

      const delivered = Math.max(0, Math.min(orderedQty, orderedQty - remains));

      const userPaid = Number(row.charge || row.user_price || 0);
      let refundAmount = 0;

      if ((smmStatus === 'partial' || smmStatus === 'canceled') && orderedQty > 0 && userPaid > 0) {
        const ratio = delivered / orderedQty;
        const usedAmount = +(userPaid * ratio).toFixed(2);
        refundAmount = +(userPaid - usedAmount).toFixed(2);
        if (refundAmount < 0.01) refundAmount = 0;
      }

      // 3) Transaction: لازم تكون آمنة وتضمن release
      const conn = await safeGetConnection();
      if (!conn) {
        // DB واقعة / ما قدرنا ناخد connection
        // نتركها للدورة الجاية بدل ما نوقع السيرفر
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
          `UPDATE orders SET status = ? WHERE id = ?`,
          [localStatus, row.order_id]
        );

        // Refund إذا لازم
        if (refundAmount > 0 && !row.refunded) {
          await conn.query(
            `UPDATE users SET balance = balance + ? WHERE id = ?`,
            [refundAmount, row.user_id]
          );

          await conn.query(
            `
            INSERT INTO transactions (user_id, type, amount, reason)
            VALUES (?, 'credit', ?, ?)
            `,
            [
              row.user_id,
              refundAmount,
              `Partial refund for SMM order #${row.id} (provider: ${providerStatusRaw})`,
            ]
          );

          await conn.query(
            `UPDATE smm_orders SET refunded = 1 WHERE id = ?`,
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
            `UPDATE orders SET admin_reply = ? WHERE id = ?`,
            [adminMsg, row.order_id]
          );
        }

        await conn.commit();

        console.log(
          `✅ syncSMM: order #${row.order_id} provider ${providerOrderId} → ${providerStatusRaw}, local=${localStatus}, refund=$${refundAmount}`
        );
      } catch (innerErr) {
        // إذا DB قطعت خلال الترانزاكشن، rollback إذا ممكن
        if (isDbDisconnect(innerErr)) {
          console.error('❌ syncSMM: DB lost during transaction (will retry next run):', innerErr.message || innerErr);
        } else {
          console.error('❌ syncSMM (transaction) error:', innerErr.message || innerErr);
        }

        try {
          await conn.rollback();
        } catch (_) {
          // تجاهل
        }
      } finally {
        try {
          conn.release();
        } catch (_) {
          // تجاهل
        }
      }
    }
  };
};
