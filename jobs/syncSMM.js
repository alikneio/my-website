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
        console.error("❌ Invalid API response");
        return;
      }

      console.log(`📦 Received ${data.length} services.`);

      for (const srv of data) {
        await new Promise((resolve, reject) => {
          db.query(
            `
              INSERT INTO smm_services
              (provider_service_id, name, category, rate, min_quantity, max_quantity, type, description, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
              ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                category = VALUES(category),
                rate = VALUES(rate),
                min_quantity = VALUES(min_quantity),
                max_quantity = VALUES(max_quantity),
                type = VALUES(type),
                description = VALUES(description),
                updated_at = NOW()
            `,
            [
              srv.service,
              srv.name,
              srv.category,
              srv.rate,
              srv.min,
              srv.max,
              srv.type || null,
              srv.description || null,
            ],
            (err) => (err ? reject(err) : resolve())
          );
        });
      }

      console.log("✅ SMM Services synced successfully!");
    } catch (err) {
      console.error("❌ SMM Sync Error:", err.response?.data || err.message);
    }
  };
};
