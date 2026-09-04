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
const { parseCashCount, parseTransaction, parseExpenseEntry } = require('./parse');
const { isScheduledOpening, isScheduledClosing, windowLabel } = require('./schedule');

const TICKET_RE = /(?:VN|ARN|AR)\s*#?\s*0*\d+/i;

// key: `${branch}|${ccy}` -> { diff, firstFlaggedLabel }
// firstFlaggedLabel is a human date string (e.g. "Jul 17") captured the first
// time this currency went out of balance, so later reports can say
// "still unresolved since Jul 17" instead of re-flagging it as brand new.
//
// Two SEPARATE trackers, not one shared map — a Shift Audit question ("PHP
// surplus during the trading day") and a Handover Check question ("does the
// closing count match the next opening count") are answering completely
// different questions. A currency matching in one report must NEVER silently
// mark the other report's flag as resolved -- that previously caused a real
// Shift Audit gap to be misreported as "fixed" just because an UNRELATED
// overnight handover happened to match, which tells you nothing about
// whether the original gap was ever explained.
const SHIFT_AUDIT_FLAGS = new Map();
const HANDOVER_FLAGS = new Map();

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
  const { cashCountChannelId, transactionsChannelId, expensesChannelId } = branchConfig;

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

    // PHP also moves through the expenses channel — replenishments (payroll,
    // petty cash top-ups) add PHP to the drawer outside any buy/sell ticket,
    // and small cash expenses (trash bags, supplies, fares) remove it. Fold
    // these into the same reconciliation so a real, logged replenishment
    // doesn't show up as a mystery "extra PHP" surplus, the way the
    // Sept 2 Alphaland shift's ₱63,466 gap turned out to be.
    let expenseTotal = 0;
    let expenseEntries = [];
    if (expensesChannelId) {
      const expenseMessages = await history(expensesChannelId, {
        oldest: openingCount._ts,
        latest: closingEvent.ts,
        limit: 200
      });
      for (const m of expenseMessages) {
        const parsed = parseExpenseEntry(m.text || '');
        if (parsed) {
          expenseTotal += parsed.amount;
          expenseEntries.push({ ...parsed, raw: m.text, ts: m.ts });
        }
      }
    }

    const openingTotals = stripUntracked({ ...openingCount.totals, ...openingCount.others });
    const closingTotals = stripUntracked({ ...closingCount.totals, ...closingCount.others });
    const adjustments = expenseTotal !== 0 ? { PHP: expenseTotal } : {};
    const results = reconcile(openingTotals, closingTotals, tickets.map(t => t.parsed), adjustments);

    // A currency that's completely ABSENT from one count's report (e.g. a
    // teller simply forgot to type a "JuanPay:" line) is a different
    // situation from one that was counted and genuinely changed — the first
    // is very likely a data-entry gap, not a real cash movement, and should
    // be asked about differently. reconcile() can't tell these apart (both
    // collapse to 0 via `|| 0`), so record which currencies were actually
    // present in each raw count before it runs.
    for (const r of results) {
      r.missingFromOpening = !(r.ccy in openingTotals);
      r.missingFromClosing = !(r.ccy in closingTotals);
    }

    const report = buildShiftAuditReport({
      branchConfig, closingCount, openingCount, results, tickets, expenseEntries, dryRun
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
/**
 * Builds a full, specific, easy-to-follow breakdown for one mismatched
 * currency: the starting balance, what the transactions say should have
 * happened, what was actually counted, and a short list of concrete
 * yes/no-style questions a teller can answer without needing to do any
 * math themselves. `openingAmount` is the currency's balance at the start
 * of the shift, used to show the arithmetic in plain terms rather than
 * just stating the final gap.
 */
function buildQuestionBlock(ccy, diff, tickets, openingAmount, expectedAmount, actualAmount, since, missingFromOpening, missingFromClosing) {
  const emoji = CCY_EMOJI[ccy] || '•';
  const short = diff < 0;
  const gapLabel = moneyLabel(ccy, Math.abs(diff));
  const verb = short ? 'is short' : 'has extra';

  // A currency that's simply ABSENT from one of the two raw counts (not
  // counted at all, vs. counted as a real number) is very likely a data
  // entry gap — someone forgot to include that line — not a real cash
  // movement. Ask about it as a reporting question, not an accusation that
  // money appeared or vanished, and skip the full transaction math (there's
  // nothing to reconcile against if the starting or ending point was never
  // actually recorded).
  if (missingFromOpening && !missingFromClosing) {
    const lines = [];
    lines.push(`${emoji} *${ccy} wasn't included in the opening count*, but the closing count shows ${moneyLabel(ccy, actualAmount)}.`);
    lines.push(`This might just be a reporting gap rather than a real cash issue — can you confirm ${ccy} was actually ${moneyLabel(ccy, actualAmount)} at the start of the shift too?`);
    if (since) lines.push('');
    if (since === '(would be newly flagged)') {
      lines.push(`_(This would be a new question as of this report.)_`);
    } else if (since) {
      lines.push(`_(Still unresolved since ${since} — this will keep showing up until it's sorted out.)_`);
    }
    return lines.join('\n');
  }
  if (missingFromClosing && !missingFromOpening) {
    const lines = [];
    lines.push(`${emoji} *${ccy} was in the opening count* (${moneyLabel(ccy, openingAmount)}), *but wasn't included in the closing count.*`);
    lines.push(`This might just be a reporting gap rather than money going missing — can you confirm what ${ccy} actually was at closing?`);
    if (since === '(would be newly flagged)') {
      lines.push('');
      lines.push(`_(This would be a new question as of this report.)_`);
    } else if (since) {
      lines.push('');
      lines.push(`_(Still unresolved since ${since} — this will keep showing up until it's sorted out.)_`);
    }
    return lines.join('\n');
  }

  const lines = [];
  lines.push(`${emoji} *The drawer ${verb} ${gapLabel}* than it should${short ? "n't" : ''}.`);

  // Plain-language math, so nobody has to trust the bot's arithmetic blind —
  // every number here is something they can check against their own count.
  lines.push('');
  lines.push(`Here's the math:`);
  lines.push(`• Started the shift with: ${moneyLabel(ccy, openingAmount)}`);

  const relevant = ticketsForCurrency(tickets, ccy);
  if (relevant.length === 0) {
    lines.push(`• No ${ccy} transactions were logged this shift`);
  } else {
    const sorted = [...relevant].sort((a, b) => {
      const amtA = ccy === 'PHP' ? (a.parsed.phpAmount || 0) : Math.max(...a.parsed.movements.filter(m => m.ccy === ccy).map(m => m.fcyAmount));
      const amtB = ccy === 'PHP' ? (b.parsed.phpAmount || 0) : Math.max(...b.parsed.movements.filter(m => m.ccy === ccy).map(m => m.fcyAmount));
      return amtB - amtA;
    });
    const biggest = sorted[0];
    const who = biggest.parsed.isWholesale ? 'a wholesale deal' : `${firstName(clientLabel(biggest.raw)) || 'a client'}`;
    const amountLabel = ccy === 'PHP'
      ? moneyLabel('PHP', biggest.parsed.phpAmount)
      : (() => { const mv = biggest.parsed.movements.find(m => m.ccy === ccy); return `${fmt(mv.fcyAmount)} ${ccy}`; })();
    // A retail ticket's BUY means the client handed US that currency (we
    // bought it FROM them); a wholesale ticket's SELL means WE sold it TO
    // the counterparty. Pick one verb, not two, so this doesn't read as
    // "sold ... sold to".
    const summaryVerb = biggest.parsed.isWholesale ? 'sold' : 'bought';
    const preposition = biggest.parsed.isWholesale ? 'to' : 'from';
    lines.push(`• ${relevant.length} transaction${relevant.length > 1 ? 's' : ''} happened (biggest: ${summaryVerb} ${amountLabel} ${preposition} ${who} at ${timeLabel(biggest.ts)})`);
  }

  lines.push(`• Based on those transactions, should have ended with: ${moneyLabel(ccy, expectedAmount)}`);
  lines.push(`• But the actual count at closing was: ${moneyLabel(ccy, actualAmount)}`);
  lines.push(`• *That's ${gapLabel} that isn't explained by any transaction.*`);
  lines.push('');

  // Concrete, answerable questions — not "can you check if this is right?"
  // but specific things a teller can say yes/no to.
  lines.push(`Questions:`);
  let qNum = 1;
  lines.push(`${qNum++}. Did anyone drop off extra cash into the drawer that wasn't from a client transaction (e.g. replenishment, change fund, an owner's deposit)?`);
  if (relevant.length > 0) {
    const sorted = [...relevant].sort((a, b) => {
      const amtA = ccy === 'PHP' ? (a.parsed.phpAmount || 0) : Math.max(...a.parsed.movements.filter(m => m.ccy === ccy).map(m => m.fcyAmount));
      const amtB = ccy === 'PHP' ? (b.parsed.phpAmount || 0) : Math.max(...b.parsed.movements.filter(m => m.ccy === ccy).map(m => m.fcyAmount));
      return amtB - amtA;
    });
    const biggest = sorted[0];
    const who = biggest.parsed.isWholesale ? 'the wholesale deal' : (firstName(clientLabel(biggest.raw)) || 'that client');
    const amountLabel = ccy === 'PHP'
      ? moneyLabel('PHP', biggest.parsed.phpAmount)
      : (() => { const mv = biggest.parsed.movements.find(m => m.ccy === ccy); return `${fmt(mv.fcyAmount)} ${ccy}`; })();
    lines.push(`${qNum++}. Was the ${timeLabel(biggest.ts)} transaction with ${who} (${amountLabel}) entered correctly — could it have been entered twice, or the amount typed wrong?`);
  }
  lines.push(`${qNum++}. Could the closing count have included cash that actually belongs to a different bucket (like Hive, Receivables, or petty cash)?`);

  if (since === '(would be newly flagged)') {
    lines.push('');
    lines.push(`_(This would be a new question as of this report.)_`);
  } else if (since) {
    lines.push('');
    lines.push(`_(Still unresolved since ${since} — this will keep showing up until it's sorted out.)_`);
  }

  return lines.join('\n');
}

/**
 * Compares this shift's results against OPEN_FLAGS, clears anything that's
 * back in balance (announcing the resolution), and tags anything still off
 * as either new or "still unresolved since <date>".
 */
function annotateFlags(flagStore, branch, results, dateLabel, dryRun = false) {
  const stillOpen = [];
  const resolved = [];

  for (const r of results) {
    const key = `${branch}|${r.ccy}`;
    const prior = flagStore.get(key);

    if (r.match) {
      if (prior) {
        if (!dryRun) flagStore.delete(key);
        resolved.push({ ccy: r.ccy, since: prior.firstFlaggedLabel });
      }
      continue;
    }

    if (prior) {
      stillOpen.push({ ...r, since: prior.firstFlaggedLabel });
    } else {
      if (!dryRun) flagStore.set(key, { diff: r.diff, firstFlaggedLabel: dateLabel });
      stillOpen.push({ ...r, since: dryRun ? '(would be newly flagged)' : null });
    }
  }

  return { stillOpen, resolved };
}

/**
 * Returns any currently-open Shift Audit flags for a branch, WITHOUT
 * mutating them — used by the Handover Check to surface "there's still an
 * unanswered question from an earlier shift" without touching the Shift
 * Audit's own tracking (only a real Shift Audit run should ever resolve one
 * of its own flags).
 */
function getOpenShiftAuditFlags(branch) {
  const open = [];
  for (const [key, value] of SHIFT_AUDIT_FLAGS.entries()) {
    const [flagBranch, ccy] = key.split('|');
    if (flagBranch === branch) {
      open.push({ ccy, diff: value.diff, since: value.firstFlaggedLabel });
    }
  }
  return open;
}

function buildShiftAuditReport({ branchConfig, closingCount, openingCount, results, tickets, expenseEntries = [], dryRun = false }) {
  const dateLabel = (closingCount.timestamp || '').split(',')[0].trim();
  const { stillOpen, resolved } = annotateFlags(SHIFT_AUDIT_FLAGS, branchConfig.name, results, dateLabel, dryRun);

  const openName = firstName(openingCount.teller);
  const closeName = firstName(closingCount.teller);

  const lines = [];
  if (dryRun) lines.push('_[DRY RUN — not posted to Slack]_');
  lines.push(`🔍 ${branchConfig.name} — ${dateLabel}, ${windowLabel(closingCount)}`);
  lines.push(`${openName} (opened) → ${closeName} (closed)`);
  lines.push('');

  // Surface any replenishments/expenses that were already folded into the
  // math, so a clean result doesn't look suspiciously "too clean" and a
  // flagged result doesn't get a redundant question about something that's
  // already accounted for.
  if (expenseEntries.length > 0) {
    const netLabel = expenseEntries.reduce((s, e) => s + e.amount, 0);
    const sign = netLabel >= 0 ? '+' : '';
    lines.push(`💼 ${expenseEntries.length} expense/replenishment entr${expenseEntries.length > 1 ? 'ies' : 'y'} this shift (net ${sign}${moneyLabel('PHP', netLabel)}) already included below.`);
    lines.push('');
  }

  if (stillOpen.length === 0 && resolved.length === 0) {
    lines.push(`✅ All good. ${tickets.length} transactions checked, everything matches.`);
    return lines.join('\n');
  }

  // SUMMARY FIRST: one line per discrepancy, so the whole picture is
  // scannable before diving into any single one's full math breakdown. A
  // report with several mismatched currencies used to read as one long wall
  // of repeated "Here's the math" sections — this puts the headline numbers
  // up top and pushes the detail (and the specific questions) below it.
  if (stillOpen.length > 0) {
    lines.push(`*${stillOpen.length} discrepanc${stillOpen.length > 1 ? 'ies' : 'y'} this shift:*`);
    for (const r of stillOpen) {
      const emoji = CCY_EMOJI[r.ccy] || '•';
      if (r.missingFromOpening && !r.missingFromClosing) {
        lines.push(`${emoji} ${r.ccy}: not in the opening count, ${moneyLabel(r.ccy, r.actual)} at closing`);
      } else if (r.missingFromClosing && !r.missingFromOpening) {
        lines.push(`${emoji} ${r.ccy}: ${moneyLabel(r.ccy, r.expected)} at opening, not in the closing count`);
      } else {
        const short = r.diff < 0;
        lines.push(`${emoji} ${r.ccy}: ${short ? 'short' : 'extra'} ${moneyLabel(r.ccy, Math.abs(r.diff))}`);
      }
    }
    lines.push('');
  }

  for (const r of stillOpen) {
    const openingAmount = (openingCount.totals && openingCount.totals[r.ccy] != null)
      ? openingCount.totals[r.ccy]
      : (openingCount.others && openingCount.others[r.ccy] != null ? openingCount.others[r.ccy] : 0);
    lines.push(buildQuestionBlock(r.ccy, r.diff, tickets, openingAmount, r.expected, r.actual, r.since, r.missingFromOpening, r.missingFromClosing));
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

  const { stillOpen, resolved } = annotateFlags(HANDOVER_FLAGS, branchConfig.name, results, dateLabel, dryRun);
  const openShiftAuditFlags = getOpenShiftAuditFlags(branchConfig.name);

  const openName = firstName(openingTeller);
  const closeName = firstName(closingTeller);

  const lines = [];
  if (dryRun) lines.push('_[DRY RUN — not posted to Slack]_');
  lines.push(`🔄 ${branchConfig.name} — ${dateLabel}, ${windowText}`);
  lines.push(`${openName} → ${closeName}`);
  lines.push('');

  const hasOvernightIssue = stillOpen.length > 0;
  const hasLeftoverQuestion = openShiftAuditFlags.length > 0;

  // Section 1: the overnight consistency check itself — did the closing
  // count match this opening count? This is ALWAYS shown, clean or not, so
  // "all good" here is never confused with "no open questions anywhere."
  if (!hasOvernightIssue) {
    lines.push('✅ Overnight is fine — nothing moved that shouldn\'t have.');
  } else {
    lines.push('⚠️ *1 new thing doesn\'t match — please check before trading:*'
      .replace('1 new thing', stillOpen.length > 1 ? `${stillOpen.length} new things` : '1 new thing'));
    for (const r of stillOpen) {
      const emoji = CCY_EMOJI[r.ccy] || '•';
      const short = r.diff < 0;
      const label = moneyLabel(r.ccy, Math.abs(r.diff));
      const verb = short ? 'is short by' : 'has extra';
      lines.push(`${emoji} *${r.ccy}* ${verb} ${label}${short ? '' : ' than expected'}. Can you check what happened between the two counts?`);
    }
  }

  for (const r of resolved) {
    lines.push('');
    lines.push(`✅ ${r.ccy} is fixed now.`);
  }

  // Section 2: any Shift Audit question from an EARLIER shift that's still
  // unanswered. Kept visually separate from Section 1 (a blank line + its
  // own ⚠️ header) so nobody reads this as part of the overnight check —
  // it's a different question, about a different comparison, that just
  // happens to still be waiting for a reply.
  if (hasLeftoverQuestion) {
    lines.push('');
    lines.push(`⚠️ *There${openShiftAuditFlags.length > 1 ? ' are' : '\'s'} still ${openShiftAuditFlags.length > 1 ? 'open questions' : 'an open question'} from ${openShiftAuditFlags.length > 1 ? 'earlier shifts' : 'yesterday\'s shift'}:*`);
    lines.push('');
    for (const f of openShiftAuditFlags) {
      const emoji = CCY_EMOJI[f.ccy] || '•';
      const short = f.diff < 0;
      const label = moneyLabel(f.ccy, Math.abs(f.diff));
      const verb = short ? 'was short' : 'had extra';
      const sinceLabel = f.since ? ` (from the ${f.since} shift)` : '';
      lines.push(`${emoji} The drawer ${verb} ${label} that was never explained${sinceLabel}.`);
    }
  }

  if (!hasOvernightIssue && !hasLeftoverQuestion) {
    return lines.join('\n');
  }

  lines.push('');
  const who = [openName, closeName].filter((v, i, a) => a.indexOf(v) === i);
  const askVerb = hasLeftoverQuestion && !hasOvernightIssue
    ? 'this is still waiting on an answer'
    : (hasLeftoverQuestion ? 'please check both' : 'please check before trading');
  lines.push(`${who.map(n => '@' + n).join(' ')} — ${askVerb}. Reply here 🙏`);
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
