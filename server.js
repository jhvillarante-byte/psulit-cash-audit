const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { parseCashCount, parseTransaction, parseHiveEntry, parseExpenseEntry } = require('./parse');
const { reconcile } = require('./reconcile');
const { history } = require('./slack');
const { broadcast } = require('./telegram');

const app = express();

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const RECIPIENT_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// BRANCHES format: "BranchName:cashCountChannelId:transactionsChannelId:hiveChannelId:expensesChannelId,..."
// hiveChannelId and expensesChannelId are optional — leave blank if a branch doesn't use one.
// e.g. "Solaire:C0B734364T0:C0B75NZJFJ6:C0B8P9MM3BQ:C09NGT3FP5J,Alphaland:C06NDDD1D0U:C06N4AWS878::"
const BRANCHES = (process.env.BRANCHES || '').split(',').filter(Boolean).map(entry => {
  const [name, cashCountChannelId, transactionsChannelId, hiveChannelId, expensesChannelId] = entry.split(':').map(s => (s || '').trim());
  return { name, cashCountChannelId, transactionsChannelId, hiveChannelId: hiveChannelId || null, expensesChannelId: expensesChannelId || null };
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
  if (!event || event.type !== 'message' || !event.text) return;
  // Reject edits/deletions/joins etc, but allow bot_message — cash count reports
  // are posted by a bot, so filtering out all subtypes was silently dropping them.
  if (event.subtype && event.subtype !== 'bot_message') return;
  console.log(`Received message in ${event.channel} (subtype: ${event.subtype || 'none'}): ${event.text.slice(0, 60)}`);
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
  const { cashCountChannelId, transactionsChannelId, hiveChannelId, expensesChannelId } = branchConfig;
  const current = parseCashCount(event.text);
  if (!current) return;
  if (!isClosingCount(current)) return; // only report once per shift, at close-out

  const eventTime = parseReportTimestamp(current);
  if (!eventTime) return;

  // Anchor the window to the FIXED schedule, not whenever a report happened to post.
  // Mid-Shift's report covers the combined Morning+Mid-Shift day (9AM same day -> now).
  // Night's report covers the overnight window (8PM previous day -> now).
  const anchorEpoch = current.shift === 'Night'
    ? manilaEpoch(eventTime.year, eventTime.month, eventTime.day - 1, 20, 0, 0)
    : manilaEpoch(eventTime.year, eventTime.month, eventTime.day, 9, 0, 0);

  // Find the cash count whose own internal Timestamp is closest to (at or before)
  // that anchor — this gives the correct opening VALUES for the window.
  const priorMessages = await history(cashCountChannelId, { latest: subtractSecond(event.ts), limit: 50 });
  let previous = null;
  let bestDiff = Infinity;
  for (const msg of priorMessages) {
    const parsed = parseCashCount(msg.text || '');
    if (!parsed || parsed.branch !== current.branch) continue;
    const t = parseReportTimestamp(parsed);
    if (!t) continue;
    const diff = anchorEpoch - t.epoch;
    if (diff >= 0 && diff < bestDiff) {
      bestDiff = diff;
      previous = parsed;
    }
  }

  if (!previous) {
    await broadcast(
      RECIPIENT_CHAT_IDS,
      `⚠️ No prior cash count found for *${current.branch}* (${current.shift} shift) to reconcile against — this may be the first count on record, or the branch name doesn't match a prior entry exactly.`
    );
    return;
  }

  // Transaction window is anchored to the fixed schedule time, not to whenever
  // the baseline report was posted — e.g. a stray ticket posted at 8:20 AM
  // belongs to neither shift under the 9AM-8PM / 8PM-5AM schedule and is excluded.
  const windowStart = anchorEpoch.toFixed(6);

  // Pull all transactions logged in the anchored window.
  const txMessages = await history(transactionsChannelId, {
    oldest: windowStart,
    latest: event.ts
  });
  const transactions = txMessages
    .map(m => ({ parsed: parseTransaction(m.text || ''), raw: m.text || '' }))
    .filter(x => x.raw.match(/(?:VN|ARN|AR)\s*#?\s*0*\d+/i)) // looks like a ticket at all
    .map(x => x.parsed ? x.parsed : { unparseable: true, raw: x.raw });

  const goodTransactions = transactions.filter(t => !t.unparseable);
  const badTransactions = transactions.filter(t => t.unparseable);

  // Hive moves independently of forex tickets — sum any balance-update entries
  // posted in the same window so they don't show up as unexplained mismatches.
  let adjustments = {};
  if (hiveChannelId) {
    const hiveMessages = await history(hiveChannelId, { oldest: windowStart, latest: event.ts });
    const hiveDelta = hiveMessages
      .map(m => parseHiveEntry(m.text || ''))
      .filter(Boolean)
      .reduce((sum, entry) => sum + entry.amount, 0);
    if (hiveDelta !== 0) adjustments.Hive = hiveDelta;
  }
  if (expensesChannelId) {
    const expenseMessages = await history(expensesChannelId, { oldest: windowStart, latest: event.ts });
    const expenseTotal = expenseMessages
      .map(m => parseExpenseEntry(m.text || ''))
      .filter(Boolean)
      .reduce((sum, entry) => sum + entry.amount, 0);
    if (expenseTotal !== 0) adjustments.Opex = expenseTotal;
  }

  const openingTotals = { ...previous.totals, ...previous.others };
  const actualTotals = { ...current.totals, ...current.others };
  const results = reconcile(openingTotals, actualTotals, goodTransactions, adjustments);
  const annotated = annotateWithFlagHistory(results, current);

  // For the combined Morning+Mid-Shift report, credit both tellers — find the
  // Morning teller from the same batch of messages already fetched above.
  let morningTeller = null;
  if (current.shift === 'Mid-Shift') {
    for (const msg of priorMessages) {
      const parsed = parseCashCount(msg.text || '');
      if (parsed && parsed.branch === current.branch && parsed.shift === 'Morning') {
        morningTeller = parsed.teller;
        break; // newest-first, so this is the Morning shift's closing teller
      }
    }
  }

  await broadcast(RECIPIENT_CHAT_IDS, formatReport(current, annotated, goodTransactions, badTransactions, morningTeller));
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

function formatReport(current, results, transactions, badTransactions = [], morningTeller = null) {
  const mismatches = results.filter(r => !r.match);
  const clientTx = transactions.filter(t => !t.isWholesale);
  const wholesaleTx = transactions.filter(t => t.isWholesale);

  let lines = [];
  const shiftLabel = current.shift === 'Mid-Shift' ? 'Morning and Mid-Shift' : current.shift;
  lines.push(`📊 *${current.branch} — ${shiftLabel} Cash Count*`);
  const datePart = (current.timestamp || '').split(',')[0].trim(); // e.g. "08/14/2026" from "08/14/2026, 20:11:26"
  if (datePart) lines.push(`Date: ${datePart}`);
  if (current.shift === 'Mid-Shift' && morningTeller) {
    lines.push(`Tellers: ${morningTeller} (Morning), ${current.teller || 'n/a'} (Mid-Shift)`);
  } else {
    lines.push(`Teller: ${current.teller || 'n/a'}`);
  }
  lines.push(`${clientTx.length} client transaction(s)${wholesaleTx.length ? `, ${wholesaleTx.length} wholesale` : ''} checked since the last count.`);
  lines.push('');

  const needsAttention = results.filter(r => !r.match || r.note);
  if (needsAttention.length === 0) {
    lines.push('✅ Everything reconciles — no discrepancies to report.');
  } else {
    for (const r of needsAttention) {
      const icon = r.match ? '✅🔁' : '⚠️';
      const diffStr = r.match ? '' : ` — off by ${formatNum(r.diff)}`;
      lines.push(`${icon} *${r.ccy}*: expected ${formatNum(r.expected)}, actual ${formatNum(r.actual)}${diffStr}`);
      if (r.note) lines.push(`     _${r.note}_`);
    }
  }

  lines.push('');
  lines.push(mismatches.length
    ? `*Bottom line:* ${mismatches.length} currenc${mismatches.length > 1 ? 'ies' : 'y'} need checking — ${mismatches.map(m => m.ccy).join(', ')}.`
    : `*Bottom line:* everything reconciles ✅`);

  if (badTransactions.length) {
    lines.push('');
    lines.push(`⚠️ *${badTransactions.length} ticket(s) couldn't be read* and are EXCLUDED from the math above — check these manually:`);
    for (const bad of badTransactions) {
      lines.push(`  • ${bad.raw.split('\n')[0].slice(0, 80)}`);
    }
  }

  lines.push('_Auto-generated from logged tickets — please verify against physical slips before treating as final._');

  return lines.join('\n');
}

function formatNum(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function subtractSecond(ts) {
  return (parseFloat(ts) - 0.000001).toFixed(6);
}

// Manila is UTC+8 year-round (no DST) — convert a Manila-local date/time to a
// Unix epoch (seconds), matching the format Slack timestamps use.
function manilaEpoch(year, month, day, hour, min, sec) {
  return (Date.UTC(year, month - 1, day, hour, min, sec) - 8 * 3600 * 1000) / 1000;
}

// Parses the "Timestamp:" field inside a cash count report (e.g. "08/14/2026,
// 20:11:26") into its components plus a Manila-based Unix epoch for comparison.
function parseReportTimestamp(parsedReport) {
  const m = (parsedReport.timestamp || '').match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, month, day, year, hour, min, sec] = m.map(Number);
  return { year, month, day, hour, min, sec, epoch: manilaEpoch(year, month, day, hour, min, sec) };
}

// Solaire's reports (Morning/Mid-Shift/Night) don't explicitly say "opening" or
// "closing" — each shift label is posted twice a day. Alphaland sometimes DOES
// label it explicitly ("Shift: Closing"), so check that first. Otherwise, fall
// back to a time-of-day window around each shift's scheduled end (per the real
// schedule: Morning 9AM-6PM, Mid-Shift 11AM-8PM, Night 8PM-5AM).
//
// Morning and Mid-Shift overlap on one shared till, so Morning's own close is
// skipped entirely — Mid-Shift's close already covers that same ground, and
// splitting it into two reports would double up on the same cash movements.
const SHIFT_END_HOUR = { 'Mid-Shift': 20, 'Night': 5 };
const CLOSE_WINDOW_HOURS = 2; // tolerance either side of the scheduled end time

function isClosingCount(current) {
  if (!current.shift) return false;
  if (current.shift === 'Morning') return false;
  if (/close/i.test(current.shift)) return true; // explicit label (e.g. Alphaland "Closing")

  const endHour = SHIFT_END_HOUR[current.shift];
  if (endHour == null) return true; // unknown shift label — report it rather than silently drop it

  const timeMatch = (current.timestamp || '').match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!timeMatch) return true; // can't parse timestamp — err toward reporting

  const hour = parseInt(timeMatch[1], 10) + parseInt(timeMatch[2], 10) / 60;
  // Handle the Night shift's end time (5 AM) wrapping past midnight.
  const diff = Math.min(
    Math.abs(hour - endHour),
    24 - Math.abs(hour - endHour)
  );
  return diff <= CLOSE_WINDOW_HOURS;
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

// Keep-alive: free-tier Render instances spin down after ~15 min of no traffic,
// and Slack gives up on an event delivery if the server doesn't respond in time.
// Pinging our own public URL every 10 minutes keeps the instance awake so real
// Slack events never get dropped due to a cold start.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    axios.get(SELF_URL).catch(err => console.error('Keep-alive ping failed:', err.message));
  }, 10 * 60 * 1000);
}
