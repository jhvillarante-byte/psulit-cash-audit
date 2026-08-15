// openingDiscrepancyCheck.js
// Runs when a Morning (Opening) cash count is posted. Audit cycle is a full
// 24h: this Opening back to the PRIOR Opening. Walks every shift report in
// between (Morning -> Mid-Shift -> Night -> Morning) to pinpoint exactly which
// shift a discrepancy first appeared in, and tags that shift's teller directly
// — rather than lumping every finding onto one generic "please explain."
// Transaction/AR issues tag the actual Slack poster of that message, since
// tickets are posted by tellers under their own accounts (not a bot), so
// msg.user is already the real culprit — no name-matching needed there.

const { parseCashCount, parseDenominations, parseTransaction } = require('./parse');
const { history, postMessage, fetchThreadReplies } = require('./slack');

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
// treat both as equivalent for trigger/baseline-matching purposes.
function isOpeningShift(shift) {
  return shift === 'Morning' || shift === 'Opening';
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
  if (!current || !isOpeningShift(current.shift)) return;
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
    if (!isOpeningShift(c.parsed.shift)) continue;
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

  // 3. Cash-count total/denomination diffing only makes sense over the
  //    NARROW overnight gap (last Night Closing -> this Morning Opening) —
  //    that's the only stretch where nothing should have happened at all,
  //    so a raw diff is meaningful. Diffing across the FULL 24h cycle
  //    instead would flag completely normal business activity (bills
  //    naturally move as clients buy/sell all day) as "discrepancies."
  //    The 24h cycle is still used below for AR/transaction scanning, since
  //    ticket irregularities are meaningful to check across the whole day.
  let closingReport = null;
  for (let i = fullCycle.length - 2; i >= 0; i--) {
    if (isClosingReport(fullCycle[i])) { closingReport = fullCycle[i]; break; }
  }
  // Fallback: no Night report found in the cycle (e.g. missing/late report)
  // — use whichever report immediately precedes this Opening instead, so we
  // still check SOMETHING rather than silently skipping the check entirely.
  if (!closingReport && fullCycle.length >= 2) closingReport = fullCycle[fullCycle.length - 2];
  if (!closingReport) return; // nothing to compare the overnight gap against

  const baselineTotals = { ...closingReport.totals, ...closingReport.others };
  const openingTotals = { ...opening.totals, ...opening.others };
  const totalFindings = diffTotals(baselineTotals, openingTotals);
  const denomFindings = diffDenominations(closingReport.denoms, opening.denoms);

  // 4. Attribute every overnight-gap finding to the CLOSING teller directly —
  //    not via pinpointShift. With only two points (closing, opening), a
  //    changed value means the closing count was the wrong one (that's the
  //    whole premise of the overnight gap check), so responsibility belongs
  //    to whoever closed, not to the opening teller who correctly caught it.
  const closingResponsible = {
    teller: closingReport.teller,
    userId: resolveTellerUserId(closingReport.teller),
    shift: closingReport.shift,
  };
  for (const f of denomFindings) f.responsibleTeller = closingResponsible;
  for (const f of totalFindings) f.responsibleTeller = closingResponsible;

  // 5. Scan the full 24h cycle's transactions for AR irregularities — tag the
  //    ACTUAL poster (msg.user) for each, since tickets aren't bot-posted.
  let arIssues = [];
  if (transactionsChannelId) {
    arIssues = await scanTransactionLog(transactionsChannelId, baseline.ts, opening.ts);
  }

  if (totalFindings.length === 0 && denomFindings.length === 0 && arIssues.length === 0) {
    return; // clean cycle — stay silent
  }

  const message = buildExplainMessage(current.branch, closingReport, opening, totalFindings, denomFindings, arIssues);
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
      issues.push({ text: `Ticket #${parsed.ref} — voided, check reason given`, userId: msg.user });
    }

    const rateMatch = /@\s*([\d.]+)/.exec(text);
    if (rateMatch && /USD/i.test(text)) {
      const rate = parseFloat(rateMatch[1]);
      if (rate > 0 && rate < 20) {
        issues.push({ text: `Ticket #${parsed.ref} — rate ${rate} looks like a typo (missing a digit?)`, userId: msg.user });
      }
    }
  }

  for (const [ref, entries] of seenRef.entries()) {
    if (entries.length > 1) {
      const clientNames = new Set(entries.map(e => /CLIENT\s*[:\-]\s*([^\n]+)/i.exec(e.text)?.[1]?.trim()).filter(Boolean));
      const posters = [...new Set(entries.map(e => e.userId).filter(Boolean))];
      if (clientNames.size > 1) {
        issues.push({ text: `Ticket #${ref} reused for ${clientNames.size} different clients`, userIds: posters });
      } else if (entries.length >= 3) {
        issues.push({ text: `Ticket #${ref} logged ${entries.length}× for the same client — confirm if duplicate or separate transactions`, userIds: posters });
      }
    }
  }

  return issues;
}

function buildExplainMessage(branch, closingReport, opening, totalFindings, denomFindings, arIssues) {
  const closingDate = (closingReport.timestamp || '').split(',')[0] || '';
  const openingDate = (opening.timestamp || '').split(',')[0] || '';
  const closingTime = (closingReport.timestamp || '').split(', ')[1] || '';
  const openingTime = (opening.timestamp || '').split(', ')[1] || '';
  const dateRange = closingDate === openingDate ? closingDate : `${closingDate} → ${openingDate}`;

  const lines = [];
  lines.push(`*Please explain the following — ${branch}, ${dateRange} (${closingTime} → ${openingTime} overnight handover):*`, '');

  let n = 1;

  const tagFor = (responsible) => {
    if (!responsible) return "_(couldn't isolate to one shift — please all confirm)_";
    return responsible.userId ? `<@${responsible.userId}>` : `${responsible.teller} (${responsible.shift})`;
  };

  for (const f of totalFindings) {
    if (f.type === 'missing') {
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — why ${f.ccy} wasn't in your closing count (present at opening: ${formatAmt(f.after)})`);
    } else {
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} variance of ${f.diff > 0 ? '+' : ''}${formatAmt(f.diff)} between closing and opening`);
    }
  }

  for (const f of denomFindings) {
    if (f.type === 'missing') {
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} ${f.denom} not counted at closing (${f.after} pcs at opening)`);
    } else {
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} ${f.denom}: ${f.before} vs ${f.after} pcs`);
    }
  }

  for (const issue of arIssues) {
    const tag = issue.userIds
      ? issue.userIds.map(id => `<@${id}>`).join(' & ')
      : (issue.userId ? `<@${issue.userId}>` : '_(unknown poster)_');
    lines.push(`${n++}. ${tag} — ${issue.text}`);
  }

  const openingUserId = resolveTellerUserId(opening.teller);
  const openingTag = openingUserId ? `<@${openingUserId}>` : opening.teller;
  if (totalFindings.length > 0 || denomFindings.length > 0) {
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
