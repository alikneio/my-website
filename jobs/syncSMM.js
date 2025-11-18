const axios = require("axios");

module.exports = function makeSyncSMM(db) {
  return async function syncSMM() {
    console.log("🔄 Sync SMM Services Started...");

    try {
      const { data } = await axios.post(
        "https://smmgen.com/api/v2",
        new URLSearchParams({
          key: process.env.SMMGEN_API_KEY,
          action: "services",
        })
      );

      if (!Array.isArray(data)) {
        console.error("❌ Invalid API response (not an array)");
        return;
      }

      console.log(`📦 Received ${data.length} services.`);

      const sql = `
        INSERT INTO smm_services
        (provider_service_id, name, category, type, rate, min_qty, max_qty, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          name     = VALUES(name),
          category = VALUES(category),
          type     = VALUES(type),
          rate     = VALUES(rate),
          min_qty  = VALUES(min_qty),
          max_qty  = VALUES(max_qty),
          is_active = 1
      `;

      for (const srv of data) {
        const params = [
          srv.service,
          srv.name,
          srv.category || "Other",
          srv.type || "default",
          srv.rate,
          srv.min,
          srv.max
        ];

          if (providerCat) {
    await q(`
      INSERT INTO smm_categories (name, provider_category, slug, sort_order, is_active)
      VALUES (?, ?, '', 0, 0)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name)
    `, [providerCat, providerCat]);
  }


        await new Promise((resolve, reject) => {
          db.query(sql, params, (err) => (err ? reject(err) : resolve()));
        });
      }

      console.log("✅ SMM Services synced successfully!");
    } catch (err) {
      console.error("❌ SMM Sync Error:", err.response?.data || err.message);
    }
  };
};
