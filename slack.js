const axios = require('axios');

const SLACK_API = 'https://slack.com/api';
const token = () => process.env.SLACK_BOT_TOKEN;

function client() {
  return axios.create({
    baseURL: SLACK_API,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

// Fetches message history for a channel between two timestamps (exclusive of `latest`).
async function history(channelId, { oldest, latest, limit = 200 } = {}) {
  const res = await client().get('/conversations.history', {
    params: { channel: channelId, oldest, latest, limit, inclusive: true }
  });
  if (!res.data.ok) throw new Error(`Slack history error: ${res.data.error}`);
  return res.data.messages || [];
}

// Posts a threaded reply on a message.
async function replyInThread(channelId, threadTs, text) {
  const res = await client().post('/chat.postMessage', {
    channel: channelId,
    thread_ts: threadTs,
    text,
    unfurl_links: false
  });
  if (!res.data.ok) throw new Error(`Slack postMessage error: ${res.data.error}`);
  return res.data;
}

// Posts a new top-level message to a channel (not a thread reply).
async function postMessage(channelId, text) {
  const res = await client().post('/chat.postMessage', {
    channel: channelId,
    text,
    unfurl_links: false
  });
  if (!res.data.ok) throw new Error(`Slack postMessage error: ${res.data.error}`);
  return res.data;
}

// Downloads a Slack file (using the bot token for auth) and asks Claude to read
// the actual receipt photo when a ticket's caption is missing transaction details
// (e.g. a teller forgot to type the BUY/SELL line, but the photo has it).
// Only called for tickets that failed to parse from caption text alone, to keep
// this cheap — most tickets never need it.
async function recoverFromReceiptImage(fileUrl, caption) {
  if (!process.env.ANTHROPIC_API_KEY) return null; // feature not configured — skip silently

  const imgRes = await axios.get(fileUrl, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer'
  });
  const base64 = Buffer.from(imgRes.data).toString('base64');
  const mediaType = imgRes.headers['content-type'] || 'image/jpeg';

  const claudeRes = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        {
          type: 'text',
          text: `This is a money changer receipt. The Slack caption for this ticket was: "${caption}" — but it's missing the transaction details (BUY/SELL, currency, amount).\n\nRead the receipt and respond with ONLY a JSON object, nothing else:\n{"action": "BUY" or "SELL", "ccy": "3-letter code", "fcyAmount": number, "phpAmount": number, "confident": true or false}\n\nIf you can't read it clearly enough to be confident, set "confident": false.`
        }
      ]
    }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    }
  });

  const text = claudeRes.data.content.find(c => c.type === 'text')?.text || '';
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!parsed.confident) return null;
    return {
      isWholesale: false,
      movements: [{ action: parsed.action, ccy: parsed.ccy, fcyAmount: parsed.fcyAmount }],
      phpAmount: parsed.phpAmount,
      raw: caption,
      recoveredFromImage: true
    };
  } catch {
    return null; // couldn't parse Claude's response — leave ticket excluded, as before
  }
}

// When a report still has unresolved mismatches after normal reconciliation,
// ask Claude to look over the transaction list the way a human would when
// double-checking — likely duplicate entries (same client/amount, slightly
// different spelling), obviously suspicious tickets, etc. Only runs when
// there's something to explain, to keep clean reports fast and free.
async function deepCheckMismatches(mismatches, transactions, badTransactions) {
  if (!process.env.ANTHROPIC_API_KEY) return null; // feature not configured — skip silently
  if (!mismatches.length) return null;

  const ticketList = transactions.map(t =>
    `Ref ${t.ref || '?'}: ${t.movements.map(m => `${m.action} ${m.fcyAmount} ${m.ccy}`).join(', ')}${t.phpAmount ? `, ₱${t.phpAmount}` : ''}${t.isWholesale ? ' (wholesale)' : ''}`
  ).join('\n');
  const badList = badTransactions.map(t => t.raw.split('\n')[0]).join('\n');
  const mismatchList = mismatches.map(m => `${m.ccy}: expected ${m.expected}, actual ${m.actual}, off by ${m.diff}`).join('\n');

  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `A money-changer cash reconciliation has unresolved mismatches. Look at the transaction list below the way a human auditor double-checking the numbers would, and flag anything worth a second look — likely duplicate entries (same client name with a slight spelling variant, same amount, close together), any ticket whose math looks internally inconsistent, or anything else suspicious. Don't just restate the mismatches — look for a concrete explanation.

MISMATCHES:
${mismatchList}

PARSED TRANSACTIONS:
${ticketList}

TICKETS THAT COULDN'T BE READ AT ALL:
${badList || '(none)'}

Respond with a short bullet list (2-4 bullets max) of concrete, specific findings. If you genuinely see nothing suspicious beyond the mismatches themselves, say so in one line instead of padding with generic advice.`
    }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    }
  });

  return res.data.content.find(c => c.type === 'text')?.text || null;
}

module.exports = { history, replyInThread, postMessage, recoverFromReceiptImage, deepCheckMismatches };
