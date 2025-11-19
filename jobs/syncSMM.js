// /jobs/syncSMM.js
const axios = require('axios');

module.exports = function makeSyncSMMJob(db, promisePool) {
  const API_URL = 'https://smmgen.com/api/v2';
  const API_KEY = process.env.SMMGEN_API_KEY;

  if (!API_KEY) {
    console.warn('⚠️ SMMGEN_API_KEY is not set, syncSMM will not work correctly.');
  }

  function mapStatuses(providerStatus) {
    const s = (providerStatus || '').toLowerCase();

    // قيم SMMGen المتوقعة: Pending, Processing, In progress, Completed, Partial, Canceled
    if (s === 'completed') {
      return { smm: 'completed', local: 'Accepted' };
    }
    if (s === 'partial') {
      return { smm: 'partial', local: 'Partial' };
    }
    if (s === 'canceled') {
      return { smm: 'canceled', local: 'Rejected' };
    }
    if (s === 'processing' || s === 'in progress') {
      return { smm: 'processing', local: 'In progress' };
    }
    // pending / undefined
    return { smm: 'pending', local: 'Waiting' };
  }

  async function fetchStatus(orderId) {
    const params = new URLSearchParams({
      key: API_KEY,
      action: 'status',
      order: orderId,
    });

    const { data } = await axios.post(API_URL, params);
    // مثال: {status:'Completed', charge:'0.05', remains:'0', ...}
    return data;
  }

  return async function syncSmmOrders() {
    console.log('🔄 syncSMM job running...');

    // نجيب الطلبات اللي ما خلصت او اللي ممكن تحتاج ريفند
    const [rows] = await promisePool.query(`
      SELECT
        so.*,
        o.id       AS order_id,
        o.userId   AS user_id,
        o.price    AS user_price,
        o.status   AS order_status
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

    if (!rows.length) {
      console.log('🔄 syncSMM: no pending SMM orders.');
      return;
    }

    for (const row of rows) {
      const providerOrderId = row.provider_order_id;

      try {
        const statusData = await fetchStatus(providerOrderId);
        const providerStatusRaw = statusData.status || '';
        const { smm: smmStatus, local: localStatus } = mapStatuses(providerStatusRaw);

        const orderedQty   = Number(row.quantity || 0);
        const remains      = Number(statusData.remains || 0);
        const providerCharge = Number(statusData.charge || 0); // المبلغ اللي خصم من رصيدك بالمزوّد
        const userPaid     = Number(row.charge || row.user_price || 0); // السعر اللي دفعه الزبون بالموقع

        const delivered = Math.max(
          0,
          Math.min(orderedQty, orderedQty - remains)
        );

        let refundAmount = 0;

        // نحسب ريفند فقط لو Partial أو Canceled وكان في فرق فعلي
        if ((smmStatus === 'partial' || smmStatus === 'canceled') && orderedQty > 0 && userPaid > 0) {
          const ratio = delivered / orderedQty;
          const usedAmount = +(userPaid * ratio).toFixed(2);
          refundAmount = +(userPaid - usedAmount).toFixed(2);

          if (refundAmount < 0.01) {
            refundAmount = 0; // فرق سنتات صغير → طنّشه
          }
        }

        // نستخدم connection خاص للـ transaction
        const conn = await promisePool.getConnection();
        try {
          await conn.beginTransaction();

          // ✅ تحديث smm_orders دائماً (حتى لو ما في ريفند)
          await conn.query(
            `
            UPDATE smm_orders
            SET
              status          = ?,
              provider_status = ?,
              delivered_qty   = ?,
              remains_qty     = ?,
              refund_amount   = refund_amount + ?,
              charge          = ?,        -- ممكن نحدّثها لتساوي المبلغ المستخدم فعلياً
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

          // ✅ تحديث orders.status
          await conn.query(
            `UPDATE orders SET status = ? WHERE id = ?`,
            [localStatus, row.order_id]
          );

          // ✅ لو في ريفند و لسا ما عملناه قبل
          if (refundAmount > 0 && !row.refunded) {
            // 1) رجوع المبلغ للزبون
            await conn.query(
              `UPDATE users SET balance = balance + ? WHERE id = ?`,
              [refundAmount, row.user_id]
            );

            // 2) تسجيل حركة مالية
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

            // 3) مارك انو هالطلب رجعنا ريفندو
            await conn.query(
              `UPDATE smm_orders SET refunded = 1 WHERE id = ?`,
              [row.id]
            );

            // 4) (اختياري) admin_reply في جدول orders
            const adminMsg = `
جزء من خدمتك تم تنفيذه بشكل جزئي من المزود:
- الكمية المطلوبة: ${orderedQty}
- الكمية المنفذة: ${delivered}
- الكمية غير المنفذة / المسترجعة: ${remains}
- المبلغ المسترجع لرصيدك: $${refundAmount.toFixed(2)}
            `.trim();

            // غيّر اسم العمود حسب عندك (admin_reply أو adminReply)
            await conn.query(
              `UPDATE orders SET admin_reply = ? WHERE id = ?`,
              [adminMsg, row.order_id]
            );
          }

          await conn.commit();
          conn.release();
          console.log(
            `✅ syncSMM: order #${row.order_id} provider ${providerOrderId} → ${providerStatusRaw}, local status = ${localStatus}, refund = $${refundAmount}`
          );
        } catch (innerErr) {
          await conn.rollback();
          conn.release();
          console.error('❌ syncSMM (transaction) error:', innerErr.message || innerErr);
        }
      } catch (err) {
        console.error(
          `❌ syncSMM: error fetching status for provider_order_id=${providerOrderId}:`,
          err.response?.data || err.message || err
        );
      }
    }
  };
};
