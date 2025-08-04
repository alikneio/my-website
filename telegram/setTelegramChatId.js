

const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/set-telegram/:chatId', (req, res) => {
  const sessionUser = req.session?.user;
  const chatId = req.params.chatId;

  if (!sessionUser || !chatId) {
    return res.send("❌ Unauthorized or invalid.");
  }

  const userId = sessionUser.id;

  db.query("UPDATE users SET telegram_chat_id = ? WHERE id = ?", [chatId, userId], (err) => {
    if (err) {
      console.error("❌ Failed to save chat ID:", err);
      return res.send("❌ Failed to save Telegram chat ID.");
    }

    res.send("✅ Telegram chat ID saved successfully. You'll now receive order updates.");
  });
});

module.exports = router;
