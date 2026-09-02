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
        `No opening count found for this shift (${windowLabel(closingCount)}) — can't check this one.`
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
      .map(m => ({ parsed: parseTransaction(m.text), raw: m.text, ts: m.ts }))
      .filter(t => t.parsed);

    const openingTotals = { ...openingCount.totals, ...openingCount.others };
    const closingTotals = { ...closingCount.totals, ...closingCount.others };
    const results = reconcile(openingTotals, closingTotals, tickets.map(t => t.parsed), {});

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

    await postMessage(cashCountChannelId, buildQuestionReport({
      branchConfig,
      title: 'HANDOVER CHECK',
      dateLabel: (openingCount.timestamp || '').split(',')[0].trim(),
      windowText: `Close ${(closingCount.timestamp || '').split(',')[1]?.trim() || '?'} → Open ${(openingCount.timestamp || '').split(',')[1]?.trim() || '?'}`,
      openingTeller: closingCount.teller,   // who handed off
      closingTeller: openingCount.teller,   // who received
      txCount: gapTickets.length,
      txLabel: 'transaction(s) posted in the gap',
      results: asResults
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
      const sign = tx.isWholesale
        ? (mv.action === 'SELL' ? -1 : 1)
        : (mv.action === 'BUY'  ? -1 : 1);
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

/** Builds one plain-language question + a short evidence list for a mismatched currency. */
function buildQuestionBlock(ccy, diff, tickets) {
  const emoji = CCY_EMOJI[ccy] || '•';
  const short = diff < 0;
  const label = moneyLabel(ccy, Math.abs(diff));
  const phrase = short ? `is short by ${label}` : `has ${label} extra than expected`;

  const lines = [];
  lines.push(`${emoji} *${ccy}* ${phrase}.`);

  const relevant = ticketsForCurrency(tickets, ccy);
  if (relevant.length === 0) {
    lines.push(`   We didn't see any ${ccy} transaction this shift. Was something missed, or moved outside a normal transaction?`);
  } else {
    // Prefer the largest tickets — most likely to explain a big gap.
    const sorted = [...relevant].sort((a, b) => {
      const amtA = ccy === 'PHP' ? (a.parsed.phpAmount || 0) : Math.max(...a.parsed.movements.filter(m => m.ccy === ccy).map(m => m.fcyAmount));
      const amtB = ccy === 'PHP' ? (b.parsed.phpAmount || 0) : Math.max(...b.parsed.movements.filter(m => m.ccy === ccy).map(m => m.fcyAmount));
      return amtB - amtA;
    });
    const shown = sorted.slice(0, 3);
    for (const t of shown) {
      const who = t.parsed.isWholesale ? 'wholesale' : (clientLabel(t.raw) || 'client');
      if (ccy === 'PHP') {
        // PHP has no per-ticket movements entry — describe it via the PHP amount
        // and the ticket's primary action instead (same convention reconcile.js uses).
        const primary = t.parsed.movements[0];
        const verb = primary && primary.action === 'BUY' ? 'Paid out' : 'Received';
        lines.push(`   – ${verb} ${moneyLabel('PHP', t.parsed.phpAmount)} (${who}) at ${timeLabel(t.ts)}`);
      } else {
        const mv = t.parsed.movements.find(m => m.ccy === ccy);
        lines.push(`   – ${mv.action === 'BUY' ? 'Bought' : 'Sold'} ${fmt(mv.fcyAmount)} ${ccy} (${who}) at ${timeLabel(t.ts)}`);
      }
    }
    if (sorted.length > shown.length) {
      lines.push(`   – +${sorted.length - shown.length} more ${ccy} transaction(s) this shift`);
    }
    lines.push(`   Can you check if these were entered correctly?`);
  }

  return lines.join('\n');
}

/**
 * Compares this shift's results against OPEN_FLAGS, clears anything that's
 * back in balance (announcing the resolution), and tags anything still off
 * as either new or "still unresolved since <date>".
 */
function annotateFlags(branch, results, dateLabel) {
  const stillOpen = [];
  const resolved = [];

  for (const r of results) {
    const key = `${branch}|${r.ccy}`;
    const prior = OPEN_FLAGS.get(key);

    if (r.match) {
      if (prior) {
        OPEN_FLAGS.delete(key);
        resolved.push({ ccy: r.ccy, since: prior.firstFlaggedLabel });
      }
      continue;
    }

    if (prior) {
      stillOpen.push({ ...r, since: prior.firstFlaggedLabel });
    } else {
      OPEN_FLAGS.set(key, { diff: r.diff, firstFlaggedLabel: dateLabel });
      stillOpen.push({ ...r, since: null });
    }
  }

  return { stillOpen, resolved };
}

function buildShiftAuditReport({ branchConfig, closingCount, openingCount, results, tickets }) {
  const dateLabel = (closingCount.timestamp || '').split(',')[0].trim();
  const { stillOpen, resolved } = annotateFlags(branchConfig.name, results, dateLabel);

  const lines = [];
  lines.push(`🔍 *SHIFT AUDIT — ${branchConfig.name}*`);
  lines.push(`📅 ${dateLabel} | ${windowLabel(closingCount)}`);
  lines.push(`${openingCount.teller || '?'} (opening) ${closingCount.teller || '?'} (closing)`);
  lines.push('');

  const clientCount = tickets.filter(t => !t.parsed.isWholesale).length;
  const wholesaleCount = tickets.filter(t => t.parsed.isWholesale).length;

  if (stillOpen.length === 0 && resolved.length === 0) {
    lines.push(`${tickets.length} transactions checked — everything matches. ✅ Nothing to ask about.`);
    return lines.join('\n');
  }

  if (stillOpen.length > 0) {
    const s = stillOpen.length > 1;
    lines.push(`${tickets.length} transactions checked (${clientCount} client, ${wholesaleCount} wholesale) — ${stillOpen.length} thing${s ? 's' : ''} ${s ? "don't" : "doesn't"} match. Can you two help answer ${s ? 'these' : 'this'}?`);
    lines.push('');
    for (const r of stillOpen) {
      lines.push(buildQuestionBlock(r.ccy, r.diff, tickets));
      if (r.since) lines.push(`   _(Still unresolved since ${r.since} — please check.)_`);
      lines.push('');
    }
  }

  if (resolved.length > 0) {
    for (const r of resolved) {
      lines.push(`✅ *${r.ccy}* is now correct — resolved${r.since ? ` (was off since ${r.since})` : ''}.`);
    }
    lines.push('');
  }

  lines.push('Reply here so we can close this out. 🙏');
  return lines.join('\n');
}

function buildQuestionReport({ branchConfig, title, dateLabel, windowText, openingTeller,
  closingTeller, txCount, txLabel, results }) {

  const { stillOpen, resolved } = annotateFlags(branchConfig.name, results, dateLabel);

  const lines = [];
  lines.push(`🔄 *${title} — ${branchConfig.name}*`);
  lines.push(`📅 ${dateLabel} | ${windowText}`);
  lines.push(`${openingTeller || '?'} → ${closingTeller || '?'}`);
  if (txCount) lines.push(`${txCount} ${txLabel}`);
  lines.push('');

  if (stillOpen.length === 0 && resolved.length === 0) {
    lines.push('Everything matches. ✅ Nothing to ask about.');
    return lines.join('\n');
  }

  if (stillOpen.length > 0) {
    const s = stillOpen.length > 1;
    lines.push(`${stillOpen.length} thing${s ? 's' : ''} ${s ? "don't" : "doesn't"} match — please check before trading:`);
    lines.push('');
    for (const r of stillOpen) {
      const emoji = CCY_EMOJI[r.ccy] || '•';
      const short = r.diff < 0;
      const label = moneyLabel(r.ccy, Math.abs(r.diff));
      const phrase = short ? `is short by ${label}` : `has ${label} extra than expected`;
      lines.push(`${emoji} *${r.ccy}* ${phrase}. Can you check what happened between the two counts?`);
      if (r.since) lines.push(`   _(Still unresolved since ${r.since}.)_`);
      lines.push('');
    }
  }

  if (resolved.length > 0) {
    for (const r of resolved) {
      lines.push(`✅ *${r.ccy}* is now correct — resolved${r.since ? ` (was off since ${r.since})` : ''}.`);
    }
    lines.push('');
  }

  lines.push('Reply here so we can close this out. 🙏');
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
