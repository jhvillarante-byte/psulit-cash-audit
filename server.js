const { registerTestRoutes } = require('./test-routes');
const { registerDebugRoutes } = require('./debug-routes');
const { runShiftAudit, runCloseVsOpenCheck, isScheduledOpening, isScheduledClosing } = require('./audit');
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { parseCashCount, parseTransaction, parseHiveEntry, parseExpenseEntry } = require('./parse');
const { reconcile } = require('./reconcile');
const { history, postMessage, recoverFromReceiptImage, deepCheckMismatches } = require('./slack');
const { broadcast } = require('./telegram');

const app = express();
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const RECIPIENT_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const BRANCHES = (process.env.BRANCHES || '').split(',').filter(Boolean).map(entry => {
  const [name, cashCountChannelId, transactionsChannelId, hiveChannelId, expensesChannelId] = entry.split(':').map(s => (s || '').trim());
  return { name, cashCountChannelId, transactionsChannelId, hiveChannelId: hiveChannelId || null, expensesChannelId: expensesChannelId || null };
});
const BY_CASH_COUNT_CHANNEL = new Map(BRANCHES.map(b => [b.cashCountChannelId, b]));
registerTestRoutes(app, BRANCHES);
registerDebugRoutes(app, BRANCHES);
const PROCESSED = new Set();
const OPEN_FLAGS = new Map();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.post('/slack/events', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).send('invalid signature');

  const body = req.body;

  if (body.type === 'url_verification') {
    return res.send(body.challenge);
  }

  res.status(200).send();

  const event = body.event;
  if (!event || event.type !== 'message' || !event.text) return;
  if (event.subtype && event.subtype !== 'bot_message') return;
  console.log(`Received message in ${event.channel} (subtype: ${event.subtype || 'none'}): ${event.text.slice(0, 60)}`);
  const branchConfig = BY_CASH_COUNT_CHANNEL.get(event.channel);
  if (!branchConfig) return;

  // NOTE: this used to also listen for thread replies (to post a full math
  // breakdown on demand). That feature was removed — a single real reply
  // getting redelivered by Slack's webhook retries produced 75-79 duplicate
  // posts in production, twice. The full math now auto-posts immediately as
  // a threaded reply right after the short summary (see audit.js), so there
  // is nothing left here that listens for or reacts to incoming replies —
  // eliminating that entire class of bug rather than trying to patch it
  // further.
  if (PROCESSED.has(event.ts)) return;
  PROCESSED.add(event.ts);

  if (!event.text.includes('PSULIT CASH COUNT REPORT')) return;

  try {
    await handleCashCount(event, branchConfig);
    await handleDailyReport(event, branchConfig);
  } catch (err) {
    console.error('Failed to process cash count:', err);
  }
});

async function handleCashCount(event, branchConfig) {
  const { cashCountChannelId, transactionsChannelId, hiveChannelId, expensesChannelId } = branchConfig;
  const current = parseCashCount(event.text);
  if (!current) return;
  if (!isClosingCount(current)) return;

  if (isScheduledClosing(current)) {
    await runShiftAudit(event, current, branchConfig).catch(err => console.error('Shift audit failed:', err));
  }

  const eventTime = parseReportTimestamp(current);
  if (!eventTime) return;

  const anchorEpoch = current.shift === 'Night'
    ? manilaEpoch(eventTime.year, eventTime.month, eventTime.day - 1, 20, 0, 0)
    : manilaEpoch(eventTime.year, eventTime.month, eventTime.day, 9, 0, 0);

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

  const windowStart = anchorEpoch.toFixed(6);

  const txMessages = await history(transactionsChannelId, {
    oldest: windowStart,
    latest: event.ts
  });
  const rawTickets = txMessages
    .map(m => ({ parsed: parseTransaction(m.text || ''), raw: m.text || '', files: m.files || [] }))
    .filter(x => x.raw.match(/(?:VN|ARN|AR)\s*#?\s*0*\d+/i));

  const transactions = [];
  for (const t of rawTickets) {
    if (t.parsed) { transactions.push(t.parsed); continue; }
    const photo = t.files.find(f => (f.mimetype || '').startsWith('image/'));
    let recovered = null;
    if (photo && photo.url_private) {
      try {
        recovered = await recoverFromReceiptImage(photo.url_private, t.raw);
      } catch (err) {
        console.error('Receipt image recovery failed:', err.message);
      }
    }
    transactions.push(recovered || { unparseable: true, raw: t.raw });
  }

  const goodTransactions = transactions.filter(t => !t.unparseable);
  const badTransactions = transactions.filter(t => t.unparseable);

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

  let morningTeller = null;
  if (current.shift === 'Mid-Shift') {
    for (const msg of priorMessages) {
      const parsed = parseCashCount(msg.text || '');
      if (parsed && parsed.branch === current.branch && parsed.shift === 'Morning') {
        morningTeller = parsed.teller;
        break;
      }
    }
  }

  let deepCheck = null;
  const stillMismatched = annotated.filter(r => !r.match);
  if (stillMismatched.length) {
    try {
      deepCheck = await deepCheckMismatches(stillMismatched, goodTransactions, badTransactions);
    } catch (err) {
      console.error('Deep-check failed:', err.message);
    }
  }

  await broadcast(RECIPIENT_CHAT_IDS, formatReport(current, annotated, goodTransactions, badTransactions, morningTeller, deepCheck));
}

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

    if (priorFlag) {
      OPEN_FLAGS.set(key, { diff: r.diff, shift: current.shift, ts: Date.now() });
      return { ...r, note: `outstanding since ${priorFlag.shift} — not yet corrected.` };
    }
    OPEN_FLAGS.set(key, { diff: r.diff, shift: current.shift, ts: Date.now() });
    return { ...r, note: 'newly flagged this shift.' };
  });
}

function formatReport(current, results, transactions, badTransactions = [], morningTeller = null, deepCheck = null) {
  const mismatches = results.filter(r => !r.match);
  const clientTx = transactions.filter(t => !t.isWholesale);
  const wholesaleTx = transactions.filter(t => t.isWholesale);

  let lines = [];
  const shiftLabel = current.shift === 'Mid-Shift' ? 'Morning and Mid-Shift' : current.shift;
  lines.push(`📊 *${current.branch} — ${shiftLabel} Cash Count*`);
  const datePart = (current.timestamp || '').split(',')[0].trim();
  if (datePart) lines.push(`Date: ${datePart}`);
  if (current.shift === 'Mid-Shift' && morningTeller) {
    lines.push(`Tellers: ${morningTeller} (Morning), ${current.teller || 'n/a'} (Mid-Shift)`);
  } else {
    lines.push(`Teller: ${current.teller || 'n/a'}`);
  }
  lines.push(`${clientTx.length} client transaction(s)${wholesaleTx.length ? `, ${wholesaleTx.length} wholesale` : ''} checked since the last count.`);
  const recovered = transactions.filter(t => t.recoveredFromImage);
  if (recovered.length) {
    lines.push(`(${recovered.length} of these had no caption details — recovered by reading the receipt photo.)`);
  }
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

  if (deepCheck) {
    lines.push('');
    lines.push('🔍 *Second look at the mismatches:*');
    lines.push(deepCheck.trim());
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

function isMorningOpening(current) {
  if (current.shift !== 'Morning') return false;
  if (current.phase) return current.phase.toLowerCase() === 'opening';
  const timeMatch = (current.timestamp || '').match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!timeMatch) return false;
  const hour = parseInt(timeMatch[1], 10) + parseInt(timeMatch[2], 10) / 60;
  const diff = Math.min(Math.abs(hour - 9), 24 - Math.abs(hour - 9));
  return diff <= 2;
}

function diagnoseDenominations(openingDenoms = [], actualDenoms = []) {
  const values = new Set([...openingDenoms.map(d => d.value), ...actualDenoms.map(d => d.value)]);
  const diffs = [];
  for (const v of values) {
    const openCount = (openingDenoms.find(d => d.value === v) || { count: 0 }).count;
    const actCount = (actualDenoms.find(d => d.value === v) || { count: 0 }).count;
    const countDiff = actCount - openCount;
    if (countDiff !== 0) diffs.push({ value: v, countDiff, amountDiff: countDiff * v });
  }
  diffs.sort((a, b) => Math.abs(b.amountDiff) - Math.abs(a.amountDiff));
  return diffs;
}

function formatDenomLabel(value) {
  if (value < 1) return `${Math.round(value * 100)}¢`;
  return `₱${value.toLocaleString()}`;
}

async function handleDailyReport(event, branchConfig) {
  const { cashCountChannelId, transactionsChannelId, hiveChannelId, expensesChannelId } = branchConfig;
  const current = parseCashCount(event.text);
  if (!current) return;

  if (isScheduledOpening(current)) {
    await runCloseVsOpenCheck(event, current, branchConfig).catch(err => console.error('Handover check failed:', err));
  }

  const isSolaireStyle = isMorningOpening(current);
  const isAlphalandStyle = !isSolaireStyle && (
    (current.shift || '').toLowerCase() === 'opening' ||
    (current.phase || '').toLowerCase() === 'opening'
  );
  if (!isSolaireStyle && !isAlphalandStyle) return;

  const priorMessages = await history(cashCountChannelId, { latest: subtractSecond(event.ts), limit: 100 });
  let previous = null;
  let previousMsg = null;
  let windowStartMsg = null;

  if (isSolaireStyle) {
    for (const msg of priorMessages) {
      const parsed = parseCashCount(msg.text || '');
      if (parsed && parsed.branch === current.branch && isMorningOpening(parsed)) {
        previous = parsed;
        previousMsg = msg;
        break;
      }
    }
    windowStartMsg = previousMsg;
  } else {
    let closingMsg = null, closingParsed = null;
    for (const msg of priorMessages) {
      const parsed = parseCashCount(msg.text || '');
      const isClose = parsed && ((parsed.shift || '').toLowerCase() === 'closing' || (parsed.phase || '').toLowerCase() === 'closing');
      if (parsed && parsed.branch === current.branch && isClose) {
        closingMsg = msg;
        closingParsed = parsed;
        break;
      }
    }
    if (!closingMsg) return;
    for (const msg of priorMessages) {
      if (parseFloat(msg.ts) >= parseFloat(closingMsg.ts)) continue;
      const parsed = parseCashCount(msg.text || '');
      const isOpen = parsed && ((parsed.shift || '').toLowerCase() === 'opening' || (parsed.phase || '').toLowerCase() === 'opening');
      if (parsed && parsed.branch === current.branch && isOpen) {
        previous = parsed;
        previousMsg = msg;
        break;
      }
    }
    if (!previous) return;
    current.totals = closingParsed.totals;
    current.others = closingParsed.others;
    current.denominations = closingParsed.denominations;
    current.teller = closingParsed.teller;
    current.timestamp = closingParsed.timestamp;
    windowStartMsg = previousMsg;
    event = { ...event, ts: closingMsg.ts, user: closingMsg.user };
  }

  if (!previous) return;

  const windowOldest = previousMsg.ts;
  const windowLatest = event.ts;

  const txMessages = await history(transactionsChannelId, { oldest: windowOldest, latest: windowLatest });
  const txParsed = txMessages
    .map(m => ({ parsed: parseTransaction(m.text || ''), raw: m.text || '', user: m.user }))
    .filter(x => x.raw.match(/(?:VN|ARN|AR)\s*#?\s*0*\d+/i));
  const goodTx = txParsed.filter(x => x.parsed).map(x => x.parsed);
  const posters = new Set(txParsed.map(x => x.user).filter(Boolean));

  let adjustments = {};
  if (hiveChannelId) {
    const hiveMessages = await history(hiveChannelId, { oldest: windowOldest, latest: windowLatest });
    const hiveDelta = hiveMessages.map(m => parseHiveEntry(m.text || '')).filter(Boolean).reduce((s, e) => s + e.amount, 0);
    if (hiveDelta !== 0) adjustments.Hive = hiveDelta;
  }
  if (expensesChannelId) {
    const expenseMessages = await history(expensesChannelId, { oldest: windowOldest, latest: windowLatest });
    const expenseTotal = expenseMessages.map(m => parseExpenseEntry(m.text || '')).filter(Boolean).reduce((s, e) => s + e.amount, 0);
    if (expenseTotal !== 0) adjustments.Opex = expenseTotal;
  }

  const openingTotals = { ...previous.totals, ...previous.others };
  const actualTotals = { ...current.totals, ...current.others };
  const results = reconcile(openingTotals, actualTotals, goodTx, adjustments);
  const mismatches = results.filter(r => !r.match);
  if (mismatches.length === 0) return;

  if (previousMsg.user) posters.add(previousMsg.user);
  if (event.user) posters.add(event.user);

  const noTransactions = goodTx.length === 0 && txParsed.length === 0;
  const dateLabel = (current.timestamp || '').split(',')[0].trim();
  const prevTimeLabel = (previous.timestamp || '').split(',')[1]?.trim() || '';
  const currTimeLabel = (current.timestamp || '').split(',')[1]?.trim() || '';

  let lines = [];
  lines.push(`*${current.branch} Discrepancy — ${dateLabel}, ${prevTimeLabel} → ${currTimeLabel}*`);
  lines.push('');
  for (const r of mismatches) {
    let line = `• *${r.ccy}* off by ${formatNum(Math.abs(r.diff))}`;
    if (noTransactions) {
      const openDenoms = previous.denominations?.[r.ccy];
      const actDenoms = current.denominations?.[r.ccy];
      const diag = diagnoseDenominations(openDenoms, actDenoms);
      if (diag.length) {
        const top = diag[0];
        const direction = top.countDiff < 0 ? 'not counted' : 'extra, unexplained';
        line += ` — mainly ${Math.abs(top.countDiff)} × ${formatDenomLabel(top.value)} ${direction} (${formatNum(Math.abs(top.amountDiff))})`;
      }
    }
    lines.push(line);
  }
  lines.push('');
  lines.push(noTransactions
    ? 'No transactions in the gap, so this isn\'t explained by a sale.'
    : `${goodTx.length} transaction(s) checked in this window — still doesn't fully reconcile.`);
  lines.push('Please explain.');

  if (posters.size) {
    lines.push('');
    lines.push([...posters].map(u => `<@${u}>`).join(' '));
  }

  if (process.env.ENABLE_SLACK_DAILY_REPORT === 'true') {
    await postMessage(cashCountChannelId, lines.join('\n'));
  } else {
    console.log('Slack daily report paused (ENABLE_SLACK_DAILY_REPORT is not "true") — would have posted:\n' + lines.join('\n'));
  }
}

function manilaEpoch(year, month, day, hour, min, sec) {
  return (Date.UTC(year, month - 1, day, hour, min, sec) - 8 * 3600 * 1000) / 1000;
}

function parseReportTimestamp(parsedReport) {
  const m = (parsedReport.timestamp || '').match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, month, day, year, hour, min, sec] = m.map(Number);
  return { year, month, day, hour, min, sec, epoch: manilaEpoch(year, month, day, hour, min, sec) };
}

const SHIFT_END_HOUR = { 'Mid-Shift': 20, 'Night': 5 };
const CLOSE_WINDOW_HOURS = 2;

function isClosingCount(current) {
  if (!current.shift) return false;
  if (current.shift === 'Morning') return false;
  if (current.phase) return current.phase.toLowerCase() === 'closing';
  if (/close/i.test(current.shift)) return true;

  const endHour = SHIFT_END_HOUR[current.shift];
  if (endHour == null) return true;

  const timeMatch = (current.timestamp || '').match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!timeMatch) return true;

  const hour = parseInt(timeMatch[1], 10) + parseInt(timeMatch[2], 10) / 60;
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
  if (Math.abs(Date.now() / 1000 - timestamp) > 60 * 5) return false;

  const base = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

app.get('/', (req, res) => res.send('Psulit Cash Audit is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    axios.get(SELF_URL).catch(err => console.error('Keep-alive ping failed:', err.message));
  }, 10 * 60 * 1000);
}
