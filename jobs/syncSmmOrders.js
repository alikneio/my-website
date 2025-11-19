// jobs/syncSmmOrders.js
const { getSmmOrderStatus } = require('../services/smmgen');

function makeSyncSmmOrdersJob(db) {
  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  // نحول حالة المزود لحالة داخلية
  function mapProviderStatus(st) {
    const s = String(st || '').toLowerCase();

    if (s === 'completed') return { smm: 'completed', order: 'Accepted' };
    if (s === 'partial')   return { smm: 'partial',   order: 'Accepted' };
    if (s === 'canceled')  return { smm: 'canceled',  order: 'Rejected' };

    // pending / processing / in progress ...
    return { smm: 'processing', order: 'Waiting' };
  }

  return async function syncSmmOrders() {
    try {
      // نجيب الطلبات اللي بعدها مش مخلّصة عندنا
      const rows = await q(
        `SELECT so.id,
                so.provider_order_id,
                so.status,
                o.id   AS order_id,
                o.admin_reply
         FROM smm_orders so
         JOIN orders o
           ON o.provider_order_id = so.provider_order_id
         WHERE so.status IN ('pending','processing')
         ORDER BY so.id DESC
         LIMIT 50`
      );

      if (!rows.length) return;

      for (const row of rows) {
        const providerId = row.provider_order_id;
        if (!providerId) continue;

        let statusData;
        try {
          statusData = await getSmmOrderStatus(providerId);
        } catch (e) {
          console.error('❌ SMMGEN status error:', e.message || e);
          continue;
        }

        // مثال رد SMMGen: { status: 'Completed', remains: 0, ... }
        const map = mapProviderStatus(statusData.status);
        if (!map) continue;

        if (map.smm === row.status) {
          // ما تغيّر شي
          continue;
        }

        console.log('🔁 update smm_order', {
          providerId,
          from: row.status,
          to: map.smm,
        });

        // 1) تحديث smm_orders
        await q(
          `UPDATE smm_orders
           SET status = ?, remains = ?
           WHERE id = ?`,
          [map.smm, statusData.remains || null, row.id]
        );

        // 2) تجهيز Admin Reply لو الطلب صار Accepted
        let adminReply = null;
        if (map.order === 'Accepted') {
          adminReply =
            '✅ Your social media order has been completed successfully. Thank you for using AK Cell.';
          // فيك تغيّرها لأي نص بدك ياه (إنجليزي/عربي أو مدموج)
          // مثلاً:
          // adminReply = '✅ تم تنفيذ طلب السوشيال ميديا بنجاح. شكرًا لاستخدامك AK Cell.';
        }

        // 3) تحديث orders.status + admin_reply (فقط لو فاضية)
        await q(
          `UPDATE orders
           SET status = ?,
               admin_reply = IF(
                 (admin_reply IS NULL OR admin_reply = ''),
                 ?,
                 admin_reply
               )
           WHERE id = ?`,
          [map.order, adminReply, row.order_id]
        );
      }
    } catch (err) {
      console.error('❌ syncSmmOrders job error:', err.message || err);
    }
  };
}

module.exports = makeSyncSmmOrdersJob;
