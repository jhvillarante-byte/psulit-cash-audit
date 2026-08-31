/**
 * audit.js
 *
 * Two reports per branch per day, driven by schedule.js:
 *
 *   Report 1 — CLOSING. Fires on the scheduled closing count.
 *              Checks every transaction in the shift against the closing count.
 *              Solaire: 11AM→5AM (Mon-Fri), 9AM→5AM (Sat/Sun/holidays)
 *              Alphaland: 10AM→9PM (daily)
 *
 *   Report 2 — OPENING. Fires on the scheduled opening count.
 *              Compares the previous closing against this opening. Nothing
 *              should have moved in between, so any difference is flagged
 *              before the day's trading starts.
 *
 * Both post to the branch's cash count channel.
 */

const { reconcile } = require('./reconcile');
const { history, postMessage } = require('./slack');
const { parseCashCount, parseTransaction } = require('./parse');
const {
  isScheduledOpening,
  isScheduledClosing,
  windowLabel
} = require('./schedule');

const TICKET_RE = /(?:VN|ARN|AR)\s*#?\s*0*\d+/i;

/* ------------------------------------------------------------------ */
/* REPORT 1 — closing: transactions vs closing count                   */
/* ------------------------------------------------------------------ */

async function runShiftAudit(closingEvent, closingCount, branchConfig) {
  const { cashCountChannelId, transactionsChannelId } = branchConfig;

  try {
    const openingCount = await findPriorCount(
      cashCountChannelId, closingEvent.ts, closingCount, isScheduledOpening
    );

    if (!openingCount) {
      await postMessage(cashCountChannelId,
        `⚠️ *Shift Audit — ${branchConfig.name}*\n` +
        `No opening count found for this shift (${windowLabel(closingCount)}) — cannot reconcile.`
      );
      return;
    }

    const txMessages = await history(transactionsChannelId, {
      oldest: openingCount._ts,
      latest: closingEvent.ts,
      limit: 500
    });

    const tickets = txMessages
      .filter(m => m.text && TICKET_RE.test(m.text))
      .map(m => parseTransaction(m.text))
      .filter(Boolean);

    const openingTotals = { ...openingCount.totals, ...openingCount.others };
    const closingTotals = { ...closingCount.totals, ...closingCount.others };
    const results = reconcile(openingTotals, closingTotals, tickets, {});

    await postMessage(cashCountChannelId, buildShiftAuditReport({
      branchConfig, closingCount, openingCount, results, tickets
    }));

  } catch (err) {
    console.error('runShiftAudit error:', err);
    await postMessage(
      branchConfig.cashCountChannelId,
      `⚠️ Audit bot error for ${branchConfig.name}: ${err.message}`
    ).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* REPORT 2 — opening: previous closing vs this opening                */
/* ------------------------------------------------------------------ */

async function runCloseVsOpenCheck(openingEvent, openingCount, branchConfig) {
  const { cashCountChannelId, transactionsChannelId } = branchConfig;

  try {
    const closingCount = await findPriorCount(
      cashCountChannelId, openingEvent.ts, openingCount, isScheduledClosing
    );

    if (!closingCount) {
      await postMessage(cashCountChannelId,
        `⚠️ *Handover Check — ${branchConfig.name}*\nNo prior closing count found to compare against.`
      );
      return;
    }

    // Nothing should trade between close and open, but check anyway so a
    // legitimate off-hours ticket doesn't get reported as a mystery.
    const gapMessages = await history(transactionsChannelId, {
      oldest: closingCount._ts,
      latest: openingEvent.ts,
      limit: 100
    });
    const gapTickets = gapMessages
      .filter(m => m.text && TICKET_RE.test(m.text))
      .map(m => parseTransaction(m.text))
      .filter(Boolean);

    const closingTotals = { ...closingCount.totals, ...closingCount.others };
    const openingTotals = { ...openingCount.totals, ...openingCount.others };
    const allCcy = new Set([...Object.keys(closingTotals), ...Object.keys(openingTotals)]);

    const discrepancies = [];
    const matched = [];

    for (const ccy of allCcy) {
      const closeVal = closingTotals[ccy] || 0;
      const openVal  = openingTotals[ccy] || 0;
      const diff = openVal - closeVal;
      const tolerance = ccy === 'PHP' ? 1 : 0.01;

      if (Math.abs(diff) <= tolerance) { matched.push(ccy); continue; }

      const gapMovement = movementFor(gapTickets, ccy);
      const explained = Math.abs(diff - gapMovement) <= tolerance;

      discrepancies.push({ ccy, closeVal, openVal, diff, explained, gapMovement });
    }

    await postMessage(cashCountChannelId, buildCloseVsOpenReport({
      branchConfig, closingCount, openingCount, discrepancies, matched, gapTickets
    }));

  } catch (err) {
    console.error('runCloseVsOpenCheck error:', err);
    await postMessage(
      branchConfig.cashCountChannelId,
      `⚠️ Audit bot error (handover) for ${branchConfig.name}: ${err.message}`
    ).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Walks back through the cash count channel for the most recent count of the
 * same branch that satisfies `predicate` (isScheduledOpening / isScheduledClosing).
 * Returns the parsed count with its Slack ts attached as `_ts`.
 */
async function findPriorCount(channelId, beforeTs, referenceCount, predicate) {
  const msgs = await history(channelId, { latest: beforeTs, limit: 100 });
  for (const msg of msgs) {
    const parsed = parseCashCount(msg.text || '');
    if (!parsed) continue;
    if (parsed.branch !== referenceCount.branch) continue;
    if (!predicate(parsed)) continue;
    return { ...parsed, _ts: msg.ts };
  }
  return null;
}

/** Net company-side movement in one currency across a set of tickets. */
function movementFor(tickets, ccy) {
  let sum = 0;
  for (const tx of tickets) {
    for (const mv of (tx.movements || [])) {
      if (mv.ccy !== ccy) continue;
      // Client BUY = client buys FCY from us => our stock down.
      // Wholesale tickets describe OUR action, so the verb flips.
      const sign = tx.isWholesale
        ? (mv.action === 'SELL' ? -1 : 1)
        : (mv.action === 'BUY'  ? -1 : 1);
      sum += sign * mv.fcyAmount;
    }
  }
  return sum;
}

function buildShiftAuditReport({ branchConfig, closingCount, openingCount, results, tickets }) {
  const lines = [];
  const date = (closingCount.timestamp || '').split(',')[0].trim();
  const clientTx = tickets.filter(t => !t.isWholesale).length;
  const wholesaleTx = tickets.filter(t => t.isWholesale).length;
  const mismatches = results.filter(r => !r.match);
  const matched = results.filter(r => r.match);

  lines.push(`🔍 *SHIFT AUDIT — ${branchConfig.name}*`);
  lines.push(`📅 ${date} | ${windowLabel(closingCount)}`);
  lines.push(`👤 Opening: ${openingCount.teller || '?'} → Closing: ${closingCount.teller || '?'}`);
  lines.push(`📝 ${tickets.length} transactions (${clientTx} client, ${wholesaleTx} wholesale)`);
  lines.push('');

  if (mismatches.length === 0) {
    lines.push('✅ *Everything tallies — no discrepancies.*');
    if (matched.length) lines.push(`Matched: ${matched.map(r => r.ccy).join(', ')}`);
  } else {
    lines.push(`⚠️ *${mismatches.length} discrepanc${mismatches.length > 1 ? 'ies' : 'y'} found:*`);
    for (const r of mismatches) {
      const diff = r.diff >= 0 ? `+${fmt(r.diff)}` : fmt(r.diff);
      lines.push(`• *${r.ccy}*: expected ${fmt(r.expected)}, actual ${fmt(r.actual)} _(${diff})_`);
    }
    if (matched.length) lines.push(`✅ Matched: ${matched.map(r => r.ccy).join(', ')}`);
  }

  lines.push('');
  lines.push('_Auto-generated by Psulit Audit Bot._');
  return lines.join('\n');
}

function buildCloseVsOpenReport({ branchConfig, closingCount, openingCount, discrepancies, matched, gapTickets }) {
  const lines = [];
  const date = (openingCount.timestamp || '').split(',')[0].trim();
  const closeTime = (closingCount.timestamp || '').split(',')[1]?.trim() || '?';
  const openTime  = (openingCount.timestamp || '').split(',')[1]?.trim() || '?';

  const unexplained = discrepancies.filter(d => !d.explained);
  const explained   = discrepancies.filter(d => d.explained);

  lines.push(`🔄 *HANDOVER CHECK — ${branchConfig.name}*`);
  lines.push(`📅 ${date} | Close ${closeTime} → Open ${openTime}`);
  lines.push(`👤 ${closingCount.teller || '?'} → ${openingCount.teller || '?'}`);
  if (gapTickets.length) lines.push(`📝 ${gapTickets.length} transaction(s) posted in the gap`);
  lines.push('');

  if (!unexplained.length && !explained.length) {
    lines.push('✅ *All balances match — clean handover.*');
    if (matched.length) lines.push(`Matched: ${matched.join(', ')}`);
  } else {
    if (unexplained.length) {
      lines.push(`⚠️ *${unexplained.length} unexplained difference(s) — resolve before trading:*`);
      for (const d of unexplained) {
        const diff = d.diff >= 0 ? `+${fmt(d.diff)}` : fmt(d.diff);
        lines.push(`• *${d.ccy}*: closing ${fmt(d.closeVal)} → opening ${fmt(d.openVal)} _(${diff})_`);
      }
    }
    if (explained.length) {
      lines.push('');
      lines.push(`✅ Explained by gap transactions: ${explained.map(d => d.ccy).join(', ')}`);
    }
    if (matched.length) lines.push(`✅ Matched: ${matched.join(', ')}`);
  }

  lines.push('');
  lines.push('_Auto-generated by Psulit Audit Bot._');
  return lines.join('\n');
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
