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

// Tracks which posted messages are "awaiting a reply" for the computation-
// on-demand feature: key = the Slack ts of the SHORT summary message we
// just posted, value = { branchName, kind: 'shift-audit' | 'handover' }.
// server.js checks this when a thread reply comes in, to know whether to
// post the full math breakdown and which builder function to use.
// In-memory only — same caveat as the flag stores above: a reply on an old
// thread stops being recognized after a redeploy. Given replies typically
// happen within the same day, this is an acceptable tradeoff for now.
const AWAITING_REPLY = new Map();

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
      // Attach the raw opening balance here (not just reconcile()'s computed
      // `expected`) so a later thread-reply computation can still show
      // "started the shift with X" even if it's rebuilt from the flag store
      // alone, long after this run finished.
      r.openingAmount = (openingCount.totals && openingCount.totals[r.ccy] != null)
        ? openingCount.totals[r.ccy]
        : (openingCount.others && openingCount.others[r.ccy] != null ? openingCount.others[r.ccy] : 0);
    }

    const report = buildShiftAuditReport({
      branchConfig, closingCount, openingCount, results, tickets, expenseEntries, dryRun
    });

    if (dryRun) return report;
    const posted = await postMessage(cashCountChannelId, report);
    // Only track for a reply if there's actually something to compute —
    // no point listening for a reply on a clean "all good" message.
    const hasOpenDiscrepancies = results.some(r => !r.match);
    if (posted && posted.ts && hasOpenDiscrepancies) {
      AWAITING_REPLY.set(posted.ts, { branchName: branchConfig.name, kind: 'shift-audit' });
    }

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

    for (const r of asResults) {
      r.missingFromOpening = !(r.ccy in closingTotals); // "opening" side of THIS check is the prior closing count
      r.missingFromClosing = !(r.ccy in openingTotals); // "closing" side of THIS check is the new opening count
      r.openingAmount = closingTotals[r.ccy] != null ? closingTotals[r.ccy] : 0;
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
      gapTickets,
      dryRun
    });

    if (dryRun) return report;
    const posted = await postMessage(cashCountChannelId, report);
    const hasOpenDiscrepancies = asResults.some(r => !r.match);
    if (posted && posted.ts && hasOpenDiscrepancies) {
      // Store the gap window too — a later reply needs to re-fetch the same
      // gapTickets, since we don't keep the original array around in memory
      // long-term (same reasoning as the flag stores: must survive a redeploy).
      AWAITING_REPLY.set(posted.ts, {
        branchName: branchConfig.name, kind: 'handover',
        gapOldest: closingCount._ts, gapLatest: openingEvent.ts
      });
    }

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
      if (!dryRun) flagStore.set(key, {
        diff: r.diff, firstFlaggedLabel: dateLabel,
        missingFromOpening: r.missingFromOpening, missingFromClosing: r.missingFromClosing,
        expected: r.expected, actual: r.actual, openingAmount: r.openingAmount
      });
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
  return getOpenFlagsFrom(SHIFT_AUDIT_FLAGS, branch);
}

/** Same shape as getOpenShiftAuditFlags, but for the Handover Check's own tracker. */
function getOpenHandoverFlags(branch) {
  return getOpenFlagsFrom(HANDOVER_FLAGS, branch);
}

function getOpenFlagsFrom(flagStore, branch) {
  const open = [];
  for (const [key, value] of flagStore.entries()) {
    const [flagBranch, ccy] = key.split('|');
    if (flagBranch === branch) {
      open.push({
        ccy, diff: value.diff, since: value.firstFlaggedLabel,
        missingFromOpening: value.missingFromOpening,
        missingFromClosing: value.missingFromClosing,
        expected: value.expected, actual: value.actual, openingAmount: value.openingAmount
      });
    }
  }
  return open;
}

/**
 * Builds the SHORT summary posted right after a shift closes — one line per
 * discrepancy plus a single tag asking the tellers to reply. Deliberately
 * does NOT include the full math breakdown; that only gets posted (via
 * buildComputationReply, below) once someone actually replies in the
 * thread, so a clean shift stays a two-line message instead of a wall of
 * text nobody asked to see yet.
 */
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

  if (expenseEntries.length > 0) {
    const netLabel = expenseEntries.reduce((s, e) => s + e.amount, 0);
    const sign = netLabel >= 0 ? '+' : '';
    lines.push(`💼 ${expenseEntries.length} expense/replenishment entr${expenseEntries.length > 1 ? 'ies' : 'y'} this shift (net ${sign}${moneyLabel('PHP', netLabel)}) already included.`);
    lines.push('');
  }

  if (stillOpen.length === 0 && resolved.length === 0) {
    lines.push(`✅ All good. ${tickets.length} transactions checked, everything matches.`);
    return lines.join('\n');
  }

  if (stillOpen.length > 0) {
    lines.push(`*${stillOpen.length} discrepanc${stillOpen.length > 1 ? 'ies' : 'y'} this shift:*`);
    for (const r of stillOpen) {
      const emoji = CCY_EMOJI[r.ccy] || '❗';
      if (r.missingFromOpening && !r.missingFromClosing) {
        lines.push(`❗ ${r.ccy}: not in the opening count, ${moneyLabel(r.ccy, r.actual)} at closing`);
      } else if (r.missingFromClosing && !r.missingFromOpening) {
        lines.push(`❗ ${r.ccy}: ${moneyLabel(r.ccy, r.expected)} at opening, not in the closing count`);
      } else {
        const short = r.diff < 0;
        lines.push(`❗ ${r.ccy}: ${short ? 'short' : 'extra'} ${moneyLabel(r.ccy, Math.abs(r.diff))}`);
      }
    }
    lines.push('');
  }

  for (const r of resolved) {
    lines.push(`✅ ${r.ccy} is fixed now.`);
  }
  if (resolved.length) lines.push('');

  const who = [openName, closeName].filter((v, i, a) => a.indexOf(v) === i);
  lines.push(`${who.map(n => '@' + n).join(' ')} — can you explain these? Reply here and I'll walk through the numbers with you 🙏`);
  return lines.join('\n');
}

/**
 * Builds the FULL math breakdown for every currently-open discrepancy on a
 * branch — posted as a threaded reply once someone actually responds to the
 * short summary above, rather than automatically. Re-derives everything
 * from SHIFT_AUDIT_FLAGS plus a fresh ticket list, so this works correctly
 * even if it's triggered long after the original runShiftAudit() call (e.g.
 * after a Render restart, or the next day) — nothing here depends on
 * in-memory state from that original run except the flags themselves.
 */
// One shared set of questions appended ONCE at the end of a computation
// reply — not repeated after every currency's math. A currency flagged as
// "missing from one count" already carries its own specific question
// inline (see buildQuestionBlock above), so this generic list is only
// worth including when at least one currency has REAL transaction-based
// math to question (a genuine unexplained gap, not just an omitted line).
function sharedQuestions(openFlags) {
  const hasRealGap = openFlags.some(f => !f.missingFromOpening && !f.missingFromClosing);
  if (!hasRealGap) return [];
  return [
    '',
    'Questions:',
    "1. Did anyone drop off extra cash into the drawer that wasn't from a client transaction (e.g. replenishment, change fund, an owner's deposit)?",
    '2. Could the closing count have included cash that actually belongs to a different bucket (like Hive, Receivables, or petty cash)?'
  ];
}

function buildComputationReply(branchConfig, tickets) {
  const openFlags = getOpenShiftAuditFlags(branchConfig.name);
  if (openFlags.length === 0) {
    return 'Looks like everything already reconciled — nothing open to walk through right now.';
  }

  const lines = [];
  lines.push(`Here's the full math for ${branchConfig.name}:`);
  lines.push('');
  for (let i = 0; i < openFlags.length; i++) {
    const f = openFlags[i];
    lines.push(buildQuestionBlock(f.ccy, f.diff, tickets, f.openingAmount, f.expected, f.actual, f.since, f.missingFromOpening, f.missingFromClosing));
    if (i < openFlags.length - 1) lines.push(''); // blank line BETWEEN currencies only, not trailing
  }
  lines.push(...sharedQuestions(openFlags));
  lines.push('');
  lines.push(`Reply here once you've figured it out. 🙏`);
  return lines.join('\n');
}

/**
 * Same idea as buildComputationReply, but for the Handover Check's own
 * flags (overnight close-vs-open mismatches), triggered the same way — a
 * thread reply on the short Handover Check summary.
 */
function buildHandoverComputationReply(branchConfig, gapTickets) {
  const openFlags = getOpenHandoverFlags(branchConfig.name);
  if (openFlags.length === 0) {
    return 'Looks like everything already reconciled — nothing open to walk through right now.';
  }

  const lines = [];
  lines.push(`Here's the full math for ${branchConfig.name}'s handover:`);
  lines.push('');
  for (let i = 0; i < openFlags.length; i++) {
    const f = openFlags[i];
    lines.push(buildQuestionBlock(f.ccy, f.diff, gapTickets || [], f.openingAmount, f.expected, f.actual, f.since, f.missingFromOpening, f.missingFromClosing));
    if (i < openFlags.length - 1) lines.push('');
  }
  lines.push(...sharedQuestions(openFlags));
  lines.push('');
  lines.push(`Reply here once you've figured it out. 🙏`);
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
    lines.push('⚠️ *1 new thing doesn\'t match:*'
      .replace('1 new thing', stillOpen.length > 1 ? `${stillOpen.length} new things` : '1 new thing'));
    for (const r of stillOpen) {
      const emoji = CCY_EMOJI[r.ccy] || '❗';
      const short = r.diff < 0;
      const label = moneyLabel(r.ccy, Math.abs(r.diff));
      lines.push(`❗ ${r.ccy}: ${short ? 'short' : 'extra'} ${label}`);
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
      const sinceLabel = f.since ? ` (from the ${f.since} shift)` : '';
      // Same distinction as the Shift Audit itself: a currency that was
      // simply never mentioned in one of the two counts gets the gentler
      // "reporting gap" framing, not "the drawer was short/had extra" —
      // restating it as a cash discrepancy here would contradict the
      // original, correctly-worded question this is just echoing.
      if (f.missingFromOpening && !f.missingFromClosing) {
        lines.push(`${emoji} ${f.ccy} was never confirmed at opening that day, but showed ${moneyLabel(f.ccy, f.diff >= 0 ? Math.abs(f.diff) : f.diff)} at closing${sinceLabel} — still waiting to hear if that was a reporting gap or a real change.`);
      } else if (f.missingFromClosing && !f.missingFromOpening) {
        lines.push(`${emoji} ${f.ccy} was never confirmed at closing that day${sinceLabel} — still waiting to hear if that was a reporting gap or a real change.`);
      } else {
        const short = f.diff < 0;
        const label = moneyLabel(f.ccy, Math.abs(f.diff));
        const verb = short ? 'was short' : 'had extra';
        lines.push(`${emoji} The drawer ${verb} ${label} that was never explained${sinceLabel}.`);
      }
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

/**
 * Single entry point for server.js: given the ts of a message someone just
 * replied to (in a thread), checks whether that message was one of our
 * short discrepancy summaries and, if so, returns the full computation text
 * to post back. Returns null if the ts isn't something we're tracking (so
 * server.js knows to do nothing — this wasn't a reply to one of our reports).
 *
 * `branchConfig` must be the SAME branch the original report was for — the
 * caller (server.js) already knows this from which channel the reply landed
 * in, so it's passed in rather than re-derived here.
 */
async function handleThreadReply(threadTs, branchConfig) {
  const awaiting = AWAITING_REPLY.get(threadTs);
  if (!awaiting) return null;
  if (awaiting.branchName !== branchConfig.name) return null; // shouldn't happen, but don't cross branches

  if (awaiting.kind === 'shift-audit') {
    return buildComputationReply(branchConfig, []);
  }

  if (awaiting.kind === 'handover') {
    // Re-fetch the gap transactions fresh, rather than relying on an array
    // held in memory since the original run (which may be long gone by the
    // time a reply actually comes in).
    const gapMessages = await history(branchConfig.transactionsChannelId, {
      oldest: awaiting.gapOldest,
      latest: awaiting.gapLatest,
      limit: 100
    });
    const gapTickets = gapMessages
      .filter(m => m.text && TICKET_RE.test(m.text))
      .map(m => parseTransaction(m.text))
      .filter(Boolean);
    return buildHandoverComputationReply(branchConfig, gapTickets);
  }

  return null;
}

module.exports = {
  runShiftAudit,
  runCloseVsOpenCheck,
  isScheduledOpening,
  isScheduledClosing,
  buildComputationReply,
  buildHandoverComputationReply,
  getOpenShiftAuditFlags,
  getOpenHandoverFlags,
  handleThreadReply
};
