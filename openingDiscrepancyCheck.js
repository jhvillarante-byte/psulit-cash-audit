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
const { history, postMessage } = require('./slack');

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

/**
 * MAIN ENTRY POINT — call this from server.js's /slack/events handler when
 * a "PSULIT CASH COUNT REPORT" message has shift === 'Morning'.
 */
async function onMorningOpeningPosted(event, branchConfig) {
  const current = parseCashCount(event.text);
  if (!current || current.shift !== 'Morning') return;

  const { cashCountChannelId, transactionsChannelId } = branchConfig;

  // 1. Pull every cash count report for this branch since the prior Morning
  //    Opening (i.e. the whole 24h cycle: Morning -> Mid-Shift -> Night -> Morning).
  const priorMessages = await history(cashCountChannelId, { latest: subtractSecond(event.ts), limit: 80 });
  const cycleReports = []; // chronological, oldest first, populated below
  for (const msg of priorMessages) {
    const parsed = parseCashCount(msg.text || '');
    if (!parsed || parsed.branch !== current.branch) continue;
    cycleReports.unshift({ // priorMessages is newest-first; unshift to build oldest-first
      ...parsed,
      ts: msg.ts,
      rawText: msg.text,
      userId: msg.user || null, // usually the bot's ID, not the teller — see resolveTellerUserId fallback
      denoms: parseDenominations(msg.text || ''),
    });
    if (parsed.shift === 'Morning') break; // this is the prior Opening — cycle boundary, stop here
  }
  if (cycleReports.length === 0 || cycleReports[0].shift !== 'Morning') return; // no full cycle to compare

  const opening = {
    ...current,
    ts: event.ts,
    rawText: event.text,
    denoms: parseDenominations(event.text),
  };
  const fullCycle = [...cycleReports, opening]; // oldest (prior Morning) -> newest (this Morning)
  const baseline = fullCycle[0];

  // 2. Diff currency totals and denominations, baseline vs this morning
  const baselineTotals = { ...baseline.totals, ...baseline.others };
  const openingTotals = { ...opening.totals, ...opening.others };
  const totalFindings = diffTotals(baselineTotals, openingTotals);
  const denomFindings = diffDenominations(baseline.denoms, opening.denoms);

  // 3. For each finding, walk the full cycle to pinpoint which shift-to-shift
  //    transition it first appeared in, and attribute it to that shift's teller.
  for (const f of denomFindings) {
    f.responsibleTeller = pinpointShift(fullCycle, (r) => r.denoms[f.ccy]?.[f.denom]);
  }
  for (const f of totalFindings) {
    const combinedTotals = (r) => ({ ...r.totals, ...r.others })[f.ccy];
    f.responsibleTeller = pinpointShift(fullCycle, combinedTotals);
  }

  // 4. Scan the full 24h cycle's transactions for AR irregularities — tag the
  //    ACTUAL poster (msg.user) for each, since tickets aren't bot-posted.
  let arIssues = [];
  if (transactionsChannelId) {
    arIssues = await scanTransactionLog(transactionsChannelId, baseline.ts, opening.ts);
  }

  if (totalFindings.length === 0 && denomFindings.length === 0 && arIssues.length === 0) {
    return; // clean 24h cycle — stay silent
  }

  const message = buildExplainMessage(current.branch, baseline, opening, totalFindings, denomFindings, arIssues);
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

function buildExplainMessage(branch, baseline, opening, totalFindings, denomFindings, arIssues) {
  const dateStr = (opening.timestamp || '').split(',')[0] || '';
  const baselineDate = (baseline.timestamp || '').split(',')[0] || '';

  const lines = [];
  lines.push(`*Please explain the following — ${branch}, ${baselineDate} 8AM to ${dateStr} 8AM (24h cycle):*`, '');

  let n = 1;

  const tagFor = (responsible) => {
    if (!responsible) return "_(couldn't isolate to one shift — please all confirm)_";
    return responsible.userId ? `<@${responsible.userId}>` : `${responsible.teller} (${responsible.shift})`;
  };

  for (const f of totalFindings) {
    if (f.type === 'missing') {
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — why ${f.ccy} wasn't in the prior opening count (present now: ${formatAmt(f.after)})`);
    } else {
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} variance of ${f.diff > 0 ? '+' : ''}${formatAmt(f.diff)} over the 24h cycle`);
    }
  }

  for (const f of denomFindings) {
    if (f.type === 'missing') {
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} ${f.denom} not counted (${f.after} pcs now)`);
    } else {
      lines.push(`${n++}. ${tagFor(f.responsibleTeller)} — ${f.ccy} ${f.denom}: changed from ${f.before} to ${f.after} pcs`);
    }
  }

  for (const issue of arIssues) {
    const tag = issue.userIds
      ? issue.userIds.map(id => `<@${id}>`).join(' & ')
      : (issue.userId ? `<@${issue.userId}>` : '_(unknown poster)_');
    lines.push(`${n++}. ${tag} — ${issue.text}`);
  }

  lines.push('');
  lines.push('_Please respond directly under your tagged item(s) above._');

  return lines.join('\n');
}

function formatAmt(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { onMorningOpeningPosted };
