const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/set-telegram', (req, res) => {
  const sessionUser = req.session?.user;
  const token = String(req.query.token || '').trim();

  if (!sessionUser) return res.status(401).send("❌ Please login first.");
  if (!token) return res.status(400).send("❌ Invalid link.");

  db.query(
    "SELECT chat_id, expires_at FROM telegram_link_tokens WHERE token=? LIMIT 1",
    [token],
    (err, rows) => {
      if (err) return res.status(500).send("❌ Database error.");
      if (!rows || rows.length === 0) return res.status(400).send("❌ Invalid or used token.");

      const { chat_id, expires_at } = rows[0];
      if (Date.now() > new Date(expires_at).getTime()) {
        return res.status(400).send("❌ Link expired. Go back to the bot and /start again.");
      }

      db.query(
        "UPDATE users SET telegram_chat_id=? WHERE id=?",
        [chat_id, sessionUser.id],
        (err2) => {
          if (err2) return res.status(500).send("❌ Failed to save Telegram chat id.");

          db.query("DELETE FROM telegram_link_tokens WHERE token=?", [token], () => {});
          return res.send("✅ Linked successfully! You will receive order updates on Telegram.");
        }
      );
    }
  );
});

module.exports = router;
