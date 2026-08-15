// openingDiscrepancyCheck.js
// Runs when a Morning (Opening) cash count is posted. Audit cycle is a full
// 24h: this Opening back to the PRIOR Opening. Walks every shift report in
// between (Morning -> Mid-Shift -> Night -> Morning) to pinpoint exactly which
// shift a discrepancy first appeared in, and tags that shift's teller directly
// — rather than lumping every finding onto one generic "please explain."
// Transaction/AR issues tag the actual Slack poster of that message, since
// tickets are posted by tellers under their own accounts (not a bot), so
// msg.user is already the real culprit — no name-matching needed there.

const { parseCashCount, parseDenominations, parseTransaction, parseHiveEntry, parseExpenseEntry } = require('./parse');
const { history, postMessage, fetchThreadReplies } = require('./slack');
const { reconcile } = require('./reconcile');

// Which checks run for which branch. Both branches now get businessDay
// reconciliation. Solaire's real ticket data has more format variance
// (missing currency codes, typos, word-order differences) than Alphaland's,
// which can cause parseTransaction to silently drop some tickets — the
// businessDay section below flags this explicitly whenever it happens, so
// the reconciled numbers are never presented as fact without that caveat.
const ENABLED_CHECKS = {
  Solaire: ['overnight', 'businessDay'],
  Alphaland: ['businessDay'],
};
function getEnabledChecks(branch) {
  return ENABLED_CHECKS[branch] || ['overnight'];
}

// Fallback only — used if a cash count report's teller name doesn't match any
// known account (e.g. a name typo in the report itself). Real transaction
// tagging never needs this, since those messages carry the poster's own user ID.
const TELLER_DIRECTORY = {
  'ANGELICA BESID': 'U08C3FTFVKJ',
  'CRISTINA MIRANG': 'U09NUV8HM0S',
  'JAZELLE O. ESPIRITU': 'U0BELEHF022',
  'JAZELLE ESPIRITU': 'U0BELEHF022',
  'IRENE MALIGAT': 'U06MXPACGNS',
  'JOAN LEGASPI': 'U06N49ADX8B',
};

function resolveTellerUserId(name) {
  return TELLER_DIRECTORY[(name || '').trim().toUpperCase()] || null;
}

function subtractSecond(ts) {
  return (parseFloat(ts) - 0.000001).toFixed(6);
}

// Manila is UTC+8 year-round — matches the same anchoring approach server.js
// already uses for Closing counts.
function manilaEpoch(year, month, day, hour, min, sec) {
  return (Date.UTC(year, month - 1, day, hour, min, sec) - 8 * 3600 * 1000) / 1000;
}

function parseReportTimestamp(parsedReport) {
  const m = (parsedReport.timestamp || '').match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, month, day, year, hour, min, sec] = m.map(Number);
  return { year, month, day, hour, min, sec, epoch: manilaEpoch(year, month, day, hour, min, sec) };
}

// Max drift allowed between a candidate baseline report's own internal
// Timestamp and the ideal 24h-prior anchor. Keeps a stray/manual test entry
// (which won't land anywhere near the real ~9AM schedule slot) from ever
// being mistaken for yesterday's real Opening report.
const BASELINE_TOLERANCE_SECONDS = 4 * 3600; // 4 hours either side

// The bot posts each report as a compact summary + a threaded reply
// containing the full denomination breakdown. Fetches and appends that
// reply's text so parseCashCount/parseDenominations see the whole picture.
// Safe to call on messages with no thread — just returns the parent text.
async function withThreadDetail(channelId, msg) {
  let combinedText = msg.text || '';
  if (msg.thread_ts || msg.reply_count) {
    try {
      const thread = await fetchThreadReplies(channelId, msg.ts);
      for (const reply of thread.slice(1)) { // [0] is the parent itself
        combinedText += '\n' + (reply.text || '');
      }
    } catch (err) {
      console.error(`Failed to fetch thread replies for ${msg.ts}:`, err.message);
      // Fall through with parent-only text — better a partial result than none.
    }
  }
  return combinedText;
}

// Teller names that indicate a manual/placeholder test entry rather than a
// real report — filtered out entirely so they can never be mistaken for a
// legitimate baseline or closing report, regardless of timing.
function isTestEntry(teller) {
  return /^test\b/i.test((teller || '').trim());
}

// Some branches label their opening report "Morning", others "Opening" —
// treat both as equivalent. Checks the RAW (pre-stripped) label first: a
// label like "Morning (Closing)" must never match just because its stripped
// base name happens to be "Morning" — the explicit "(Closing)" suffix always
// wins over the base name.
function isOpeningShift(report) {
  const label = report.shiftLabel || report.shift || '';
  if (/\(closing\)/i.test(label)) return false;
  if (report.shift === 'Morning' || report.shift === 'Opening') return true;
  // Symmetric to isClosingReport's "(Closing)" check below — a label like
  // "Mid-Shift (Opening)" (Alphaland's current real format) must count as an
  // opening trigger even though its stripped base name is "Mid-Shift", not
  // "Morning"/"Opening".
  return /\(opening\)/i.test(label);
}

// A report counts as a "closing" report if its normalized shift is Night/
// Closing, OR if the ORIGINAL (pre-stripped) label contains "(Closing)" —
// e.g. Alphaland's "Mid-Shift (Closing)" normalizes to just "Mid-Shift",
// which would otherwise lose the closing signal entirely.
function isClosingReport(report) {
  if (report.shift === 'Night' || report.shift === 'Closing') return true;
  return /closing/i.test(report.shiftLabel || '');
}

/**
 * MAIN ENTRY POINT — call this from server.js's /slack/events handler when
 * a "PSULIT CASH COUNT REPORT" message has shift === 'Morning' or 'Opening'.
 */
async function onMorningOpeningPosted(event, branchConfig) {
  const current = parseCashCount(event.text);
  if (!current || !isOpeningShift(current)) return;
  if (isTestEntry(current.teller)) return; // never trigger a real audit off a test entry

  const currentTime = parseReportTimestamp(current);
  if (!currentTime) return; // can't anchor without a readable internal timestamp

  const { cashCountChannelId, transactionsChannelId } = branchConfig;
  const anchorEpoch = currentTime.epoch - 86400; // ideal: exactly 24h before this Opening

  // 1. Pull a wide window of prior cash count reports for this branch, and
  //    find whichever Opening report's OWN internal Timestamp lands closest
  //    to the 24h-prior anchor — not just "the first Opening-tagged message
  //    encountered." This is what keeps a stray manual test entry (or any
  //    other out-of-schedule message) from being mistaken for the real
  //    prior Opening report. Test-teller entries are excluded outright.
  const priorMessages = await history(cashCountChannelId, { latest: subtractSecond(event.ts), limit: 100 });
  const candidates = []; // { parsed, ts, msg } for every same-branch, non-test report in the window
  for (const msg of priorMessages) {
    const parsed = parseCashCount(msg.text || '');
    if (!parsed || parsed.branch !== current.branch) continue;
    if (isTestEntry(parsed.teller)) continue;
    candidates.push({ parsed, ts: msg.ts, msg });
  }

  let baselineCandidate = null;
  let bestDrift = Infinity;
  for (const c of candidates) {
    if (!isOpeningShift(c.parsed)) continue;
    const t = parseReportTimestamp(c.parsed);
    if (!t) continue;
    const drift = Math.abs(t.epoch - anchorEpoch);
    if (drift < bestDrift) {
      bestDrift = drift;
      baselineCandidate = c;
    }
  }
  if (!baselineCandidate || bestDrift > BASELINE_TOLERANCE_SECONDS) {
    console.error(`No valid 24h-prior Opening report found for ${current.branch} within tolerance (best drift: ${bestDrift === Infinity ? 'n/a' : (bestDrift / 3600).toFixed(1) + 'h'}) — skipping this cycle.`);
    return;
  }

  // 2. Build the full cycle: every same-branch report between the confirmed
  //    baseline and this Opening, chronological order (oldest -> newest).
  const cycleCandidates = candidates.filter(c => parseFloat(c.ts) >= parseFloat(baselineCandidate.ts));
  cycleCandidates.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  const cycleReports = [];
  for (const c of cycleCandidates) {
    const fullText = await withThreadDetail(cashCountChannelId, c.msg);
    cycleReports.push({
      ...parseCashCount(fullText), // re-parse with thread detail included, for accurate totals
      ts: c.ts,
      rawText: fullText,
      denoms: parseDenominations(fullText),
    });
  }

  const openingFullText = await withThreadDetail(cashCountChannelId, event);
  const opening = {
    ...parseCashCount(openingFullText),
    ts: event.ts,
    rawText: openingFullText,
    denoms: parseDenominations(openingFullText),
  };
  const fullCycle = [...cycleReports, opening]; // oldest (confirmed baseline) -> newest (this Morning)
  const baseline = fullCycle[0];

  // 3. Cash-count checking splits into two modes depending on the branch:
  //    - 'overnight' (Solaire): diff closingReport (yesterday's Night Close)
  //      directly against opening (today) — nothing should have changed in
  //      that gap, so a raw diff is meaningful.
  //    - 'businessDay' (Alphaland): diff baseline (yesterday's Opening)
  //      against closingReport (yesterday's Closing, same day) — business
  //      was actively happening in that window, so raw diffs would just
  //      show normal cash movement. Needs the day's actual transactions
  //      netted out via reconcile() before a mismatch means anything.
  let closingReport = null;
  for (let i = fullCycle.length - 2; i >= 0; i--) {
    if (isClosingReport(fullCycle[i])) { closingReport = fullCycle[i]; break; }
  }
  // Fallback: no Closing report found in the cycle (e.g. missing/late report)
  // — use whichever report immediately precedes this Opening instead, so we
  // still check SOMETHING rather than silently skipping the check entirely.
  if (!closingReport && fullCycle.length >= 2) closingReport = fullCycle[fullCycle.length - 2];
  if (!closingReport) return; // nothing to compare against

  const enabledChecks = getEnabledChecks(current.branch);
  let totalFindings = [];
  let denomFindings = [];
  let reconcileFindings = [];

  const closingResponsible = {
    teller: closingReport.teller,
    userId: resolveTellerUserId(closingReport.teller),
    shift: closingReport.shift,
  };

  if (enabledChecks.includes('overnight')) {
    // Raw diff: closingReport (before) vs opening (after) — the overnight
    // no-activity gap. Nothing should move here, so a raw diff is meaningful.
    const beforeTotals = { ...closingReport.totals, ...closingReport.others };
    const afterTotals = { ...opening.totals, ...opening.others };
    totalFindings = diffTotals(beforeTotals, afterTotals);
    denomFindings = diffDenominations(closingReport.denoms, opening.denoms);

    // Attribute every finding to the CLOSING teller directly (not via
    // pinpointShift) — with only two points, a changed value means the
    // closing count was the wrong one, so responsibility is theirs.
    for (const f of denomFindings) f.responsibleTeller = closingResponsible;
    for (const f of totalFindings) f.responsibleTeller = closingResponsible;
  }

  if (enabledChecks.includes('businessDay')) {
    // baseline (this cycle's Opening, before) vs closingReport (same day's
    // Closing, after) — reconciled against the day's actual transactions
    // via reconcile(), since business was actively happening in that window
    // and a raw diff would just show normal cash movement.
    const dayOpeningTotals = { ...baseline.totals, ...baseline.others };
    const dayClosingTotals = { ...closingReport.totals, ...closingReport.others };

    const txMessages = transactionsChannelId
      ? await history(transactionsChannelId, { oldest: baseline.ts, latest: closingReport.ts, limit: 200 })
      : [];
    // Track which messages LOOK like a ticket (AR/ARN/VN + a number) but
    // failed to parse into usable movements — these are silently excluded
    // from the reconciliation math below, so anyone reading the result needs
    // to know the numbers may be incomplete, not treated as confirmed fact.
    const looksLikeTicket = t => /(?:VN|ARN|AR)\s*#?\s*0*\d+/i.test(t);
    let unparsedTicketCount = 0;
    const dayTransactions = [];
    for (const m of txMessages) {
      const text = m.text || '';
      const parsed = parseTransaction(text);
      if (parsed) {
        dayTransactions.push(parsed);
      } else if (looksLikeTicket(text) && !/void/i.test(text)) {
        unparsedTicketCount++; // void tickets are expected to have no movements — don't flag those
      }
    }

    // Optional Hive/Opex adjustments, same pattern as server.js's
    // handleCashCount — only applies if those channels are configured.
    const adjustments = {};
    if (branchConfig.hiveChannelId) {
      const hiveMessages = await history(branchConfig.hiveChannelId, { oldest: baseline.ts, latest: closingReport.ts });
      const hiveDelta = hiveMessages.map(m => parseHiveEntry(m.text || '')).filter(Boolean).reduce((s, e) => s + e.amount, 0);
      if (hiveDelta !== 0) adjustments.Hive = hiveDelta;
    }
    if (branchConfig.expensesChannelId) {
      const expenseMessages = await history(branchConfig.expensesChannelId, { oldest: baseline.ts, latest: closingReport.ts });
      const expenseTotal = expenseMessages.map(m => parseExpenseEntry(m.text || '')).filter(Boolean).reduce((s, e) => s + e.amount, 0);
      if (expenseTotal !== 0) adjustments.Opex = expenseTotal;
    }

    const results = reconcile(dayOpeningTotals, dayClosingTotals, dayTransactions, adjustments);
    reconcileFindings = results
      .filter(r => !r.match)
      .map(r => ({ ...r, responsibleTeller: closingResponsible, unparsedTicketCount }));
  }

  // 4. Scan the full 24h cycle's transactions for AR irregularities — tag the
  //    ACTUAL poster (msg.user) for each, since tickets aren't bot-posted.
  let arIssues = [];
  if (transactionsChannelId) {
    arIssues = await scanTransactionLog(transactionsChannelId, baseline.ts, opening.ts);
  }

  if (totalFindings.length === 0 && denomFindings.length === 0 && reconcileFindings.length === 0 && arIssues.length === 0) {
    return; // clean cycle — stay silent
  }

  const message = buildExplainMessage(current.branch, closingReport, opening, totalFindings, denomFindings, arIssues, reconcileFindings, enabledChecks);
  await postMessage(cashCountChannelId, message);
}

// Walks a chronological list of reports, extracting a value with `getValue`
// for each, and finds the report where the value FIRST changed away from the
// baseline and never reverted back — that's the shift that introduced it.
// Returns { teller, userId, shift } or null if it can't be isolated.
function pinpointShift(fullCycle, getValue) {
  const baselineVal = getValue(fullCycle[0]) ?? 0;
  for (let i = 1; i < fullCycle.length; i++) {
    const val = getValue(fullCycle[i]) ?? 0;
    if (val !== baselineVal) {
      return {
        teller: fullCycle[i].teller,
        userId: resolveTellerUserId(fullCycle[i].teller),
        shift: fullCycle[i].shift,
      };
    }
  }
  return null; // couldn't isolate to one transition
}

function diffTotals(baselineTotals, openingTotals) {
  const findings = [];
  const allCcy = new Set([...Object.keys(baselineTotals), ...Object.keys(openingTotals)]);
  for (const ccy of allCcy) {
    const before = baselineTotals[ccy];
    const after = openingTotals[ccy];
    if (before === undefined && after !== undefined) {
      findings.push({ type: 'missing', ccy, after });
    } else if (before !== undefined && after !== undefined && Math.abs(before - after) > 0.005) {
      findings.push({ type: 'variance', ccy, before, after, diff: after - before });
    }
  }
  return findings;
}

function diffDenominations(baselineDenoms, openingDenoms) {
  const findings = [];
  for (const ccy of Object.keys(openingDenoms)) {
    const baselineCcy = baselineDenoms[ccy] || {};
    const openingCcy = openingDenoms[ccy];
    for (const denom of Object.keys(openingCcy)) {
      const before = baselineCcy[denom];
      const after = openingCcy[denom];
      if (before === undefined) {
        findings.push({ ccy, denom, type: 'missing', after });
      } else if (before !== after) {
        findings.push({ ccy, denom, type: 'mismatch', before, after });
      }
    }
  }
  return findings;
}

async function scanTransactionLog(transactionsChannelId, oldestTs, latestTs) {
  const messages = await history(transactionsChannelId, { oldest: oldestTs, latest: latestTs, limit: 200 });
  const issues = [];
  const seenRef = new Map(); // ref -> [{ text, userId }]

  for (const msg of messages) {
    const text = msg.text || '';
    const parsed = parseTransaction(text);
    if (!parsed) continue;

    if (!seenRef.has(parsed.ref)) seenRef.set(parsed.ref, []);
    seenRef.get(parsed.ref).push({ text, userId: msg.user || null });

    if (/void/i.test(text)) {
      issues.push({ text: `AR #${parsed.ref} — please explain why this was voided`, userId: msg.user });
    }

    const rateMatch = /@\s*([\d.]+)/.exec(text);
    if (rateMatch && /USD/i.test(text)) {
      const rate = parseFloat(rateMatch[1]);
      if (rate > 0 && rate < 20) {
        issues.push({ text: `AR #${parsed.ref} — the rate ${rate} looks wrong, might be missing a digit. Please confirm the correct rate.`, userId: msg.user });
      }
    }
  }

  for (const [ref, entries] of seenRef.entries()) {
    if (entries.length > 1) {
      const clientNames = new Set(entries.map(e => /CLIENT\s*[:\-]\s*([^\n]+)/i.exec(e.text)?.[1]?.trim()).filter(Boolean));
      const posters = [...new Set(entries.map(e => e.userId).filter(Boolean))];
      if (clientNames.size > 1) {
        issues.push({ text: `AR #${ref} — this same number was used for ${clientNames.size} different clients. Please explain.`, userIds: posters });
      } else if (entries.length >= 3) {
        issues.push({ text: `AR #${ref} — logged ${entries.length} times for the same client. Was this one transaction posted repeatedly, or separate ones?`, userIds: posters });
      }
    }
  }

  return issues;
}

function buildExplainMessage(branch, closingReport, opening, totalFindings, denomFindings, arIssues, reconcileFindings = [], enabledChecks = ['overnight']) {
  const closingDate = (closingReport.timestamp || '').split(',')[0] || '';
  const openingDate = (opening.timestamp || '').split(',')[0] || '';
  const closingTime = (closingReport.timestamp || '').split(', ')[1] || '';
  const openingTime = (opening.timestamp || '').split(', ')[1] || '';

  const lines = [];
  lines.push(`*Please explain the following — ${branch}, ${closingDate}${openingDate !== closingDate ? ' → ' + openingDate : ''}:*`, '');

  let n = 1;

  const tagFor = (responsible) => {
    if (!responsible) return "_(couldn't isolate to one shift — please all confirm)_";
    return responsible.userId ? `<@${responsible.userId}>` : `${responsible.teller} (${responsible.shift})`;
  };

  const hasOvernightFindings = totalFindings.length > 0 || denomFindings.length > 0;
  const hasReconcileFindings = reconcileFindings.length > 0;
  const showSubHeaders = enabledChecks.includes('overnight') && enabledChecks.includes('businessDay');

  if (hasOvernightFindings) {
    if (showSubHeaders) lines.push(`_Overnight (${closingTime} → ${openingTime}, nothing should have changed):_`);
    for (const f of totalFindings) {
      if (f.type === 'missing') {
        lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — why ${f.ccy} wasn't in your closing count (present at opening: ${formatAmt(f.after)})`);
      } else {
        const direction = f.diff > 0 ? 'more' : 'less';
        lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} is ${formatAmt(Math.abs(f.diff))} ${direction} at opening than at closing. Where did this come from?`);
      }
    }
    for (const f of denomFindings) {
      if (f.type === 'missing') {
        lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} ${f.denom} bills weren't in your closing count (Opening has ${f.after} pcs = present)`);
      } else {
        lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} ${f.denom} bills: you counted ${f.before} pcs at closing, but opening shows ${f.after} pcs`);
      }
    }
    if (showSubHeaders) lines.push('');
  }

  if (hasReconcileFindings) {
    if (showSubHeaders) lines.push(`_Business Day (Opening → Closing) Check:_`);
    const unparsedCount = reconcileFindings[0]?.unparsedTicketCount || 0;
    if (unparsedCount > 0) {
      lines.push(`:warning: _${unparsedCount} AR ticket(s) today were hard to read — please check these against the paper AR book. The numbers below might change once they're fixed._`);
    }
    for (const f of reconcileFindings) {
      const direction = f.diff > 0 ? 'extra' : 'short';
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy}: you counted ${formatAmt(f.actual)} at closing, but based on today's tickets it should be ${formatAmt(f.expected)}. That's ${formatAmt(Math.abs(f.diff))} ${direction}. Please check.`);
    }
    if (showSubHeaders) lines.push('');
  }

  for (const issue of arIssues) {
    const tag = issue.userIds
      ? issue.userIds.map(id => `<@${id}>`).join(' & ')
      : (issue.userId ? `<@${issue.userId}>` : '_(unknown poster)_');
    lines.push(`${n++}. ${tag} — ${issue.text}`);
  }

  const openingUserId = resolveTellerUserId(opening.teller);
  const openingTag = openingUserId ? `<@${openingUserId}>` : opening.teller;
  if (hasOvernightFindings) {
    lines.push('');
    lines.push(`${n++}. ${openingTag} — please confirm the amounts above were already in the drawer when you opened, or added by you before submission.`);
  }

  lines.push('');
  lines.push('_Please respond directly under your tagged item(s) above._');

  return lines.join('\n');
}

function formatAmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { onMorningOpeningPosted };
