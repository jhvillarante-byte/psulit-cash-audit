/**
 * audit.js
 *
 * Two reports per branch per day, driven by schedule.js:
 *
 *   Report 1 — CLOSING. Fires on the scheduled closing count (5AM).
 *              Checks every transaction in the shift against the closing
 *              count. Anything that doesn't add up is turned into a plain
 *              question, tagged to the opening + closing tellers, and
 *              tracked until it's resolved (i.e. a later shift's numbers
 *              come back in balance for that currency).
 *
 *   Report 2 — OPENING. Fires on the scheduled opening count (11AM/9AM).
 *              Compares the previous closing against this opening — nothing
 *              should move overnight (5AM → 9/11AM), so any difference is
 *              flagged before the day's trading starts, same question style.
 *
 * Both post to the branch's cash count channel.
 *
 * NOTE on OPEN_FLAGS: in-memory only, resets on redeploy. A flag lost this
 * way just reappears as "new" next time the currency is still off — nothing
 * breaks, it just loses the "unresolved since <date>" framing for one cycle.
 */

const { reconcile } = require('./reconcile');
const { history, postMessage } = require('./slack');
const { parseCashCount, parseTransaction } = require('./parse');
const { isScheduledOpening, isScheduledClosing, windowLabel } = require('./schedule');

const TICKET_RE = /(?:VN|ARN|AR)\s*#?\s*0*\d+/i;

// key: `${branch}|${ccy}` -> { diff, firstFlaggedLabel }
// firstFlaggedLabel is a human date string (e.g. "Jul 17") captured the first
// time this currency went out of balance, so later reports can say
// "still unresolved since Jul 17" instead of re-flagging it as brand new.
const OPEN_FLAGS = new Map();

const CCY_EMOJI = {
  USD: '💵', PHP: '💴', EUR: '💶', GBP: '💷',
  Hive: '🐝', Opex: '🧾'
};

// Buckets with no transaction feed the bot can check — always excluded from
// both reports so every shift doesn't get flagged for something we can
// never actually verify. (Revisit separately once/if these get their own
// tracked channel.)
const UNTRACKED_BUCKETS = ['Hive', 'Opex', 'Scratch', 'Receivables (PHP)', 'Receivables (USD)'];

/** "Cristina Mirang" -> "Cristina". Falls back to the full string if there's no space. */
function firstName(fullName) {
  if (!fullName) return '?';
  return fullName.trim().split(/\s+/)[0];
}

// Rate-limits the "couldn't find a matching count" failure messages so a burst
// of duplicate/retried Slack webhook deliveries (e.g. from Render cold-start
// restarts re-triggering the same event) doesn't flood the channel with the
// same error over and over. Real successful reports are NEVER rate-limited —
// only the "can't check this one" / "no prior count" failure notices are.
// In-memory only; resets on redeploy, same caveat as OPEN_FLAGS below.
const LAST_FAILURE_NOTICE = new Map(); // key: `${branch}|${kind}` -> timestamp (ms)
const FAILURE_NOTICE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function shouldPostFailureNotice(branch, kind) {
  const key = `${branch}|${kind}`;
  const last = LAST_FAILURE_NOTICE.get(key);
  const now = Date.now();
  if (last && now - last < FAILURE_NOTICE_COOLDOWN_MS) return false;
  LAST_FAILURE_NOTICE.set(key, now);
  return true;
}

/* ------------------------------------------------------------------ */
/* REPORT 1 — closing: transactions vs closing count                   */
/* ------------------------------------------------------------------ */

/**
 * dryRun: when true, returns the report text instead of posting it to Slack,
 * and does NOT mutate OPEN_FLAGS (a dry run shouldn't affect what the next
 * real report considers "already flagged" / "newly resolved").
 */
async function runShiftAudit(closingEvent, closingCount, branchConfig, { dryRun = false } = {}) {
  const { cashCountChannelId, transactionsChannelId } = branchConfig;

  try {
    const openingCount = await findPriorCount(
      cashCountChannelId, closingEvent.ts, closingCount, isScheduledOpening
    );

    if (!openingCount) {
      const msg = `⚠️ *Shift Audit — ${branchConfig.name}*\n` +
        `No opening count found for this shift (${windowLabel(closingCount)}) — can't check this one.`;
      if (dryRun) return msg;
      if (shouldPostFailureNotice(branchConfig.name, 'shift-no-opening')) {
        await postMessage(cashCountChannelId, msg);
      } else {
        console.log(`[rate-limited] Suppressed duplicate "no opening count" notice for ${branchConfig.name}`);
      }
      return;
    }

    const txMessages = await history(transactionsChannelId, {
      oldest: openingCount._ts,
      latest: closingEvent.ts,
      limit: 500
    });

    const tickets = txMessages
      .filter(m => m.text && TICKET_RE.test(m.text))
      .map(m => ({ parsed: parseTransaction(m.text), raw: m.text, ts: m.ts }))
      .filter(t => t.parsed);

    const openingTotals = stripUntracked({ ...openingCount.totals, ...openingCount.others });
    const closingTotals = stripUntracked({ ...closingCount.totals, ...closingCount.others });
    const results = reconcile(openingTotals, closingTotals, tickets.map(t => t.parsed), {});

    const report = buildShiftAuditReport({
      branchConfig, closingCount, openingCount, results, tickets, dryRun
    });

    if (dryRun) return report;
    await postMessage(cashCountChannelId, report);

  } catch (err) {
    console.error('runShiftAudit error:', err);
    const msg = `⚠️ Audit bot error for ${branchConfig.name}: ${err.message}\n\n${err.stack || ''}`;
    if (dryRun) return msg;
    if (shouldPostFailureNotice(branchConfig.name, 'shift-error')) {
      await postMessage(branchConfig.cashCountChannelId, msg).catch(() => {});
    } else {
      console.log(`[rate-limited] Suppressed duplicate shift-audit error notice for ${branchConfig.name}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* REPORT 2 — opening: previous closing vs this opening                */
/* ------------------------------------------------------------------ */

async function runCloseVsOpenCheck(openingEvent, openingCount, branchConfig, { dryRun = false } = {}) {
  const { cashCountChannelId, transactionsChannelId } = branchConfig;

  try {
    const closingCount = await findPriorCount(
      cashCountChannelId, openingEvent.ts, openingCount, isScheduledClosing
    );

    if (!closingCount) {
      const msg = `⚠️ *Handover Check — ${branchConfig.name}*\nNo prior closing count found to compare against.`;
      if (dryRun) return msg;
      if (shouldPostFailureNotice(branchConfig.name, 'handover-no-closing')) {
        await postMessage(cashCountChannelId, msg);
      } else {
        console.log(`[rate-limited] Suppressed duplicate "no closing count" notice for ${branchConfig.name}`);
      }
      return;
    }

    const gapMessages = await history(transactionsChannelId, {
      oldest: closingCount._ts,
      latest: openingEvent.ts,
      limit: 100
    });
    const gapTickets = gapMessages
      .filter(m => m.text && TICKET_RE.test(m.text))
      .map(m => parseTransaction(m.text))
      .filter(Boolean);

    const closingTotals = stripUntracked({ ...closingCount.totals, ...closingCount.others });
    const openingTotals = stripUntracked({ ...openingCount.totals, ...openingCount.others });
    const allCcy = new Set([...Object.keys(closingTotals), ...Object.keys(openingTotals)]);

    const asResults = [];
    for (const ccy of allCcy) {
      const closeVal = closingTotals[ccy] || 0;
      const openVal  = openingTotals[ccy] || 0;
      const diff = openVal - closeVal;
      const tolerance = ccy === 'PHP' ? 1 : 0.01;

      const gapMovement = movementFor(gapTickets, ccy);
      const netDiff = diff - gapMovement; // portion NOT explained by a gap transaction
      asResults.push({
        ccy,
        expected: closeVal + gapMovement,
        actual: openVal,
        diff: Math.round(netDiff * 100) / 100,
        match: Math.abs(netDiff) <= tolerance
      });
    }

    const report = buildQuestionReport({
      branchConfig,
      title: 'HANDOVER CHECK',
      dateLabel: (openingCount.timestamp || '').split(',')[0].trim(),
      windowText: `Close ${(closingCount.timestamp || '').split(',')[1]?.trim() || '?'} → Open ${(openingCount.timestamp || '').split(',')[1]?.trim() || '?'}`,
      openingTeller: closingCount.teller,   // who handed off
      closingTeller: openingCount.teller,   // who received
      txCount: gapTickets.length,
      txLabel: 'transaction(s) posted in the gap',
      results: asResults,
      dryRun
    });

    if (dryRun) return report;
    await postMessage(cashCountChannelId, report);

  } catch (err) {
    console.error('runCloseVsOpenCheck error:', err);
    const msg = `⚠️ Audit bot error (handover) for ${branchConfig.name}: ${err.message}\n\n${err.stack || ''}`;
    if (dryRun) return msg;
    if (shouldPostFailureNotice(branchConfig.name, 'handover-error')) {
      await postMessage(branchConfig.cashCountChannelId, msg).catch(() => {});
    } else {
      console.log(`[rate-limited] Suppressed duplicate handover-check error notice for ${branchConfig.name}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Walks back through the cash count channel looking for the most recent
 * message matching `predicate` for the same branch. Pages through Slack's
 * history in batches rather than a single fixed-size call — a channel busy
 * enough to post 100+ messages between one shift's open and close (cash
 * count confirmations, CCTV notices, etc. all count) would otherwise push
 * the count we're looking for past a single page and we'd wrongly report
 * "no opening count found" even though one genuinely exists.
 */
/** Removes UNTRACKED_BUCKETS keys before reconciliation, so they never show up as a mismatch. */
function stripUntracked(totals) {
  const copy = { ...totals };
  for (const key of UNTRACKED_BUCKETS) delete copy[key];
  return copy;
}

async function findPriorCount(channelId, beforeTs, referenceCount, predicate) {
  const PAGE_SIZE = 200;
  const MAX_PAGES = 10; // hard ceiling — 2,000 messages back is well past any
                         // realistic single-shift gap; stop rather than loop forever
                         // if something is fundamentally wrong (e.g. wrong channel).

  let latest = beforeTs;
  for (let page = 0; page < MAX_PAGES; page++) {
    const msgs = await history(channelId, { latest, limit: PAGE_SIZE });
    if (msgs.length === 0) break;

    for (const msg of msgs) {
      const parsed = parseCashCount(msg.text || '');
      if (!parsed) continue;
      if (parsed.branch !== referenceCount.branch) continue;
      if (!predicate(parsed)) continue;
      return { ...parsed, _ts: msg.ts };
    }

    if (msgs.length < PAGE_SIZE) break; // reached the actual start of the channel
    // msgs is newest-first, so the oldest ts in this page becomes the next page's boundary
    latest = (parseFloat(msgs[msgs.length - 1].ts) - 0.000001).toFixed(6);
  }
  return null;
}

/**
 * Net company-side movement in one currency across a set of tickets.
 * BUY = counterparty hands Psulit that FX, Psulit hands back PHP -> Psulit's
 *       FX stock goes UP.
 * SELL = Psulit hands the counterparty that FX -> Psulit's FX stock goes DOWN.
 * Identical rule for retail and wholesale tickets (confirmed against real
 * transactions) — matches reconcile.js exactly, no separate flip needed.
 */
function movementFor(tickets, ccy) {
  let sum = 0;
  for (const tx of tickets) {
    for (const mv of (tx.movements || [])) {
      if (mv.ccy !== ccy) continue;
      const sign = mv.action === 'BUY' ? 1 : -1;
      sum += sign * mv.fcyAmount;
    }
  }
  return sum;
}

/**
 * The transactions (raw text + ts) that touched a given currency.
 * PHP is special: parseTransaction puts the peso side on tx.phpAmount, not in
 * movements[] (which only lists the FOREIGN currency legs) — so a PHP lookup
 * has to match ANY ticket with a phpAmount, not one with a PHP movement entry
 * (which will never exist).
 */
function ticketsForCurrency(tickets, ccy) {
  if (ccy === 'PHP') {
    return tickets.filter(t => t.parsed.phpAmount != null);
  }
  return tickets.filter(t =>
    (t.parsed.movements || []).some(mv => mv.ccy === ccy)
  );
}

function timeLabel(ts) {
  if (!ts) return '';
  return new Date(parseFloat(ts) * 1000).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit'
  });
}

function clientLabel(raw) {
  const m = raw.match(/(?:NEW|OLD)\s+CLIENT\s*:\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Builds one short, plain block for a mismatched currency: the amount and
 * direction, plus (if any transactions touched it) the single biggest one as
 * a lead — not a list, just one clue to start with.
 */
function buildQuestionBlock(ccy, diff, tickets) {
  const emoji = CCY_EMOJI[ccy] || '•';
  const short = diff < 0;
  const label = moneyLabel(ccy, Math.abs(diff));
  const verb = short ? 'is missing' : 'has extra';

  const lines = [];
  lines.push(`${emoji} ${ccy} ${verb} ${label}`);

  const relevant = ticketsForCurrency(tickets, ccy);
  if (relevant.length > 0) {
    const sorted = [...relevant].sort((a, b) => {
      const amtA = ccy === 'PHP' ? (a.parsed.phpAmount || 0) : Math.max(...a.parsed.movements.filter(m => m.ccy === ccy).map(m => m.fcyAmount));
      const amtB = ccy === 'PHP' ? (b.parsed.phpAmount || 0) : Math.max(...b.parsed.movements.filter(m => m.ccy === ccy).map(m => m.fcyAmount));
      return amtB - amtA;
    });
    const biggest = sorted[0];
    const who = biggest.parsed.isWholesale ? 'wholesale' : firstName(clientLabel(biggest.raw));
    if (ccy === 'PHP') {
      lines.push(`Biggest transaction: ${who}, ${moneyLabel('PHP', biggest.parsed.phpAmount)} at ${timeLabel(biggest.ts)}.`);
    } else {
      const mv = biggest.parsed.movements.find(m => m.ccy === ccy);
      lines.push(`Biggest transaction: ${who}, ${fmt(mv.fcyAmount)} ${ccy} at ${timeLabel(biggest.ts)}.`);
    }
  }

  return lines.join('\n');
}

/**
 * Compares this shift's results against OPEN_FLAGS, clears anything that's
 * back in balance (announcing the resolution), and tags anything still off
 * as either new or "still unresolved since <date>".
 */
function annotateFlags(branch, results, dateLabel, dryRun = false) {
  const stillOpen = [];
  const resolved = [];

  for (const r of results) {
    const key = `${branch}|${r.ccy}`;
    const prior = OPEN_FLAGS.get(key);

    if (r.match) {
      if (prior) {
        if (!dryRun) OPEN_FLAGS.delete(key);
        resolved.push({ ccy: r.ccy, since: prior.firstFlaggedLabel });
      }
      continue;
    }

    if (prior) {
      stillOpen.push({ ...r, since: prior.firstFlaggedLabel });
    } else {
      if (!dryRun) OPEN_FLAGS.set(key, { diff: r.diff, firstFlaggedLabel: dateLabel });
      stillOpen.push({ ...r, since: dryRun ? '(would be newly flagged)' : null });
    }
  }

  return { stillOpen, resolved };
}

function buildShiftAuditReport({ branchConfig, closingCount, openingCount, results, tickets, dryRun = false }) {
  const dateLabel = (closingCount.timestamp || '').split(',')[0].trim();
  const { stillOpen, resolved } = annotateFlags(branchConfig.name, results, dateLabel, dryRun);

  const openName = firstName(openingCount.teller);
  const closeName = firstName(closingCount.teller);

  const lines = [];
  if (dryRun) lines.push('_[DRY RUN — not posted to Slack]_');
  lines.push(`🔍 ${branchConfig.name} — ${dateLabel}, ${windowLabel(closingCount)}`);
  lines.push(`${openName} (opened) → ${closeName} (closed)`);
  lines.push('');

  if (stillOpen.length === 0 && resolved.length === 0) {
    lines.push(`✅ All good. ${tickets.length} transactions checked, everything matches.`);
    return lines.join('\n');
  }

  for (const r of stillOpen) {
    lines.push(buildQuestionBlock(r.ccy, r.diff, tickets));
    lines.push('');
  }

  for (const r of resolved) {
    lines.push(`✅ ${r.ccy} is fixed now.`);
  }
  if (resolved.length) lines.push('');

  const who = [openName, closeName].filter((v, i, a) => a.indexOf(v) === i);
  lines.push(`${who.map(n => '@' + n).join(' ')} — do you know what happened? Reply here 🙏`);
  return lines.join('\n');
}

function buildQuestionReport({ branchConfig, title, dateLabel, windowText, openingTeller,
  closingTeller, txCount, txLabel, results, dryRun = false }) {

  const { stillOpen, resolved } = annotateFlags(branchConfig.name, results, dateLabel, dryRun);

  const openName = firstName(openingTeller);
  const closeName = firstName(closingTeller);

  const lines = [];
  if (dryRun) lines.push('_[DRY RUN — not posted to Slack]_');
  lines.push(`🔄 ${branchConfig.name} — ${dateLabel}, ${windowText}`);
  lines.push(`${openName} → ${closeName}`);
  lines.push('');

  if (stillOpen.length === 0 && resolved.length === 0) {
    lines.push('✅ All good. Nothing missing before trading starts.');
    return lines.join('\n');
  }

  for (const r of stillOpen) {
    const emoji = CCY_EMOJI[r.ccy] || '•';
    const short = r.diff < 0;
    const label = moneyLabel(r.ccy, Math.abs(r.diff));
    const verb = short ? 'is missing' : 'has extra';
    lines.push(`${emoji} ${r.ccy} ${verb} ${label}`);
  }
  lines.push('');

  for (const r of resolved) {
    lines.push(`✅ ${r.ccy} is fixed now.`);
  }
  if (resolved.length) lines.push('');

  const who = [openName, closeName].filter((v, i, a) => a.indexOf(v) === i);
  lines.push(`${who.map(n => '@' + n).join(' ')} — please check before trading. Reply here 🙏`);
  return lines.join('\n');
}

const CCY_SYMBOL = {
  USD: '$', GBP: '£', EUR: '€', AUD: 'A$', CAD: 'C$', SGD: 'S$',
  HKD: 'HK$', PHP: '₱', Hive: '₱', Opex: '₱'
};

/** "$4,755.00" for symbol currencies, "4,755.00 JPY" for the rest. */
function moneyLabel(ccy, amount) {
  const symbol = CCY_SYMBOL[ccy];
  return symbol ? `${symbol}${fmt(amount)}` : `${fmt(amount)} ${ccy}`;
}

function fmt(n) {
  return (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = {
  runShiftAudit,
  runCloseVsOpenCheck,
  isScheduledOpening,
  isScheduledClosing
};
