const axios = require('axios');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendMessage(chatId, text) {
  const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  });
  return res.data;
}

// Sends the same message to a list of chat IDs. Logs failures per-recipient
// instead of throwing, so one bad chat ID doesn't block delivery to the rest.
async function broadcast(chatIds, text) {
  const results = await Promise.allSettled(
    chatIds.map(id => sendMessage(id, text))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Telegram send failed for chat ${chatIds[i]}:`, r.reason?.response?.data || r.reason);
    }
  });
  return results;
}

module.exports = { sendMessage, broadcast };
