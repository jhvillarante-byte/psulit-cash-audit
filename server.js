const express = require('express');
const crypto = require('crypto');
const { parseCashCount, parseTransaction } = require('./parse');
const { reconcile } = require('./reconcile');
const { history } = require('./slack');
const { broadcast } = require('./telegram');

const app = express();

const CASH_COUNT_CHANNEL_ID = process.env.CASH_COUNT_CHANNEL_ID; // #psulit-solaire-general
const TRANSACTIONS_CHANNEL_ID = process.env.TRANSACTIONS_CHANNEL_ID; // #psulit-solaire-transactions
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const RECIPIENT_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// BRANCHES format: "BranchName:cashCountChannelId:transactionsChannelId,BranchName2:...:..."
// e.g. "Solaire:C0B734364T0:C0XXXXXXX01,Alphaland:C0YYYYYYY00:C0YYYYYYY01"
const BRANCHES = (process.env.BRANCHES || '').split(',').filter(Boolean).map(entry => {
  const [name, cashCountChannelId, transactionsChannelId] = entry.split(':').map(s => s.trim());
  return { name, cashCountChannelId, transactionsChannelId };
});
const BY_CASH_COUNT_CHANNEL = new Map(BRANCHES.map(b => [b.cashCountChannelId, b]));
const PROCESSED = new Set(); // dedupe Slack's at-least-once delivery retries
// Tracks unresolved discrepancies per branch+currency, so we can note when a later
// shift's count comes back in balance (i.e. the issue didn't recur / was corrected).
// NOTE: this is in-memory only — it resets if the Render service restarts or redeploys.
// A flag lost this way just reappears as "new" next time it's still off, so nothing breaks,
// it just loses the "previously flagged" context for that one instance.
const OPEN_FLAGS = new Map(); // key: `${branch}|${ccy}` -> { diff, shift, ts }

// Slack requires the raw body to verify the request signature.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.post('/slack/events', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).send('invalid signature');

  const body = req.body;

  // 1. URL verification handshake (one-time, when you first save the Events URL in Slack)
  if (body.type === 'url_verification') {
    return res.send(body.challenge);
  }

  // 2. Respond immediately so Slack doesn't retry, then process async.
  res.status(200).send();

  const event = body.event;
  if (!event || event.type !== 'message' || event.subtype || !event.text) return;
  const branchConfig = BY_CASH_COUNT_CHANNEL.get(event.channel);
  if (!branchConfig) return; // message isn't in a channel we're watching
  if (!event.text.includes('PSULIT CASH COUNT REPORT')) return;
  if (PROCESSED.has(event.ts)) return;
  PROCESSED.add(event.ts);

  try {
    await handleCashCount(event, branchConfig);
  } catch (err) {
    console.error('Failed to process cash count:', err);
  }
});

async function handleCashCount(event, branchConfig) {
  const { cashCountChannelId, transactionsChannelId } = branchConfig;
  const current = parseCashCount(event.text);
  if (!current) return;

  // Find the previous cash count for the same branch, posted before this one.
  const priorMessages = await history(cashCountChannelId, { latest: subtractSecond(event.ts), limit: 50 });
  let previous = null;
  for (const msg of priorMessages) {
    const parsed = parseCashCount(msg.text || '');
    if (parsed && parsed.branch === current.branch) {
      previous = { ...parsed, ts: msg.ts };
      break; // history() returns newest-first
    }
  }

  if (!previous) {
    await broadcast(
      RECIPIENT_CHAT_IDS,
      `⚠️ No prior cash count found for *${current.branch}* (${current.shift} shift) to reconcile against — this may be the first count on record, or the branch name doesn't match a prior entry exactly.`
    );
    return;
  }

  // Pull all transactions logged between the previous and current cash count.
  const txMessages = await history(transactionsChannelId, {
    oldest: previous.ts,
    latest: event.ts
  });
  const transactions = txMessages
    .map(m => parseTransaction(m.text || ''))
    .filter(Boolean);

  const openingTotals = { ...previous.totals, ...previous.others };
  const actualTotals = { ...current.totals, ...current.others };
  const results = reconcile(openingTotals, actualTotals, transactions);
  const annotated = annotateWithFlagHistory(results, current);

  await broadcast(RECIPIENT_CHAT_IDS, formatReport(current, annotated, transactions));
}

// Compares this shift's results against any open flags from prior shifts for this branch.
// Clears flags that reconciled, keeps/carries forward ones that didn't, and records new ones.
function annotateWithFlagHistory(results, current) {
  return results.map(r => {
    const key = `${current.branch}|${r.ccy}`;
    const priorFlag = OPEN_FLAGS.get(key);

    if (r.match) {
      if (priorFlag) {
        OPEN_FLAGS.delete(key);
        return { ...r, note: `resolved — was off by ${priorFlag.diff >= 0 ? '+' : ''}${priorFlag.diff.toFixed(2)} as of ${priorFlag.shift}, back in balance since.` };
      }
      return r;
    }

    // still a mismatch
    if (priorFlag) {
      OPEN_FLAGS.set(key, { diff: r.diff, shift: current.shift, ts: Date.now() });
      return { ...r, note: `outstanding since ${priorFlag.shift} — not yet corrected.` };
    }
    OPEN_FLAGS.set(key, { diff: r.diff, shift: current.shift, ts: Date.now() });
    return { ...r, note: 'newly flagged this shift.' };
  });
}

function formatReport(current, results, transactions) {
  const mismatches = results.filter(r => !r.match);
  const clientTx = transactions.filter(t => !t.isWholesale);
  const wholesaleTx = transactions.filter(t => t.isWholesale);

  let lines = [];
  lines.push(`📊 *${current.branch} — ${current.shift} Shift Closed*`);
  lines.push(`Teller: ${current.teller || 'n/a'}`);
  lines.push(`${clientTx.length} client transaction(s)${wholesaleTx.length ? `, ${wholesaleTx.length} wholesale` : ''} checked since the last count.`);
  lines.push('');

  for (const r of results) {
    const icon = r.match ? (r.note ? '✅🔁' : '✅') : '⚠️';
    const diffStr = r.match ? '' : ` — off by ${formatNum(r.diff)}`;
    lines.push(`${icon} *${r.ccy}*: expected ${formatNum(r.expected)}, actual ${formatNum(r.actual)}${diffStr}`);
    if (r.note) lines.push(`     _${r.note}_`);
  }

  lines.push('');
  lines.push(mismatches.length
    ? `*Bottom line:* ${mismatches.length} currenc${mismatches.length > 1 ? 'ies' : 'y'} need checking — ${mismatches.map(m => m.ccy).join(', ')}.`
    : `*Bottom line:* everything reconciles ✅`);
  lines.push('_Auto-generated from logged tickets — please verify against physical slips before treating as final._');

  return lines.join('\n');
}

function formatNum(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function subtractSecond(ts) {
  return (parseFloat(ts) - 0.000001).toFixed(6);
}

function verifySlackSignature(req) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!timestamp || !sig || !req.rawBody) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 60 * 5) return false; // replay protection

  const base = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

app.get('/', (req, res) => res.send('Psulit Cash Audit is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
