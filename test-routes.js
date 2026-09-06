/**
 * audit.js
 *
 * Two reports per branch per day, driven by schedule.js:
 *
 *   Report 1 — CLOSING. Fires on the scheduled closing count (5AM).
 *              Checks every transaction in the shift against the closing
 *              count. Anything that doesn't add up is turned into a plain
 *              question, tagged to the opening + closing tellers, and
 *              tracked until it's resolved.
 *
 *   Report 2 — OPENING. Fires on the scheduled opening count (11AM/9AM).
 *              Compares the previous closing against this opening.
 *
 * Both post to the branch's cash count channel.
 */

const { reconcile } = require('./reconcile');
const { history, postMessage, replyInThread } = require('./slack');
const { parseCashCount, parseTransaction, parseExpenseEntry } = require('./parse');
const { isScheduledOpening, isScheduledClosing, windowLabel } = require('./schedule');

const TICKET_RE = /(?:VN|ARN|AR)\s*#?\s*0*\d+/i;

const SHIFT_AUDIT_FLAGS = new Map();
const HANDOVER_FLAGS = new Map();

const CCY_EMOJI = {
  USD: '💵', PHP: '💴', EUR: '💶', GBP: '💷',
  Hive: '🐝', Opex: '🧾'
};

const UNTRACKED_BUCKETS = [
  'Hive',
  'Opex',
  'Scratch',
  'Receivables (PHP)',
  'Receivables (USD)'
];

function firstName(fullName) {
  if (!fullName) return '?';
  return fullName.trim().split(/\s+/)[0];
}

const LAST_FAILURE_NOTICE = new Map();
const FAILURE_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;

function shouldPostFailureNotice(branch, kind) {
  const key = `${branch}|${kind}`;
  const last = LAST_FAILURE_NOTICE.get(key);
  const now = Date.now();

  if (last && now - last < FAILURE_NOTICE_COOLDOWN_MS) {
    return false;
  }

  LAST_FAILURE_NOTICE.set(key, now);
  return true;
}

/* ------------------------------------------------------------------ */
/* REPORT 1 — SHIFT AUDIT                                              */
/* ------------------------------------------------------------------ */

async function runShiftAudit(
  closingEvent,
  closingCount,
  branchConfig,
  { dryRun = false } = {}
) {
  const {
    cashCountChannelId,
    transactionsChannelId,
    expensesChannelId
  } = branchConfig;

  try {
    const openingCount = await findPriorCount(
      cashCountChannelId,
      closingEvent.ts,
      closingCount,
      isScheduledOpening
    );

    if (!openingCount) {
      const msg =
        `⚠️ *Shift Audit — ${branchConfig.name}*\n` +
        `No opening count found for this shift (${windowLabel(closingCount)}) — can't check this one.`;

      if (dryRun) return msg;

      if (shouldPostFailureNotice(branchConfig.name, 'shift-no-opening')) {
        await postMessage(cashCountChannelId, msg);
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
      .map(m => ({
        parsed: parseTransaction(m.text),
        raw: m.text,
        ts: m.ts
      }))
      .filter(t => t.parsed);

    let expenseTotal = 0;
    const expenseEntries = [];

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

          expenseEntries.push({
            ...parsed,
            raw: m.text,
            ts: m.ts
          });
        }
      }
    }

    // Include documented cash movement posted in the branch/general channel.
    const generalMessages = await history(cashCountChannelId, {
      oldest: openingCount._ts,
      latest: closingEvent.ts,
      limit: 500
    });

    const cashMovementEntries = [];

    for (const m of generalMessages) {
      const parsed = parseForexFundMovement(m.text || '');

      if (!parsed) continue;

      cashMovementEntries.push({
        ...parsed,
        ts: m.ts
      });
    }

    const cashMovementTotal = cashMovementEntries.reduce(
      (sum, movement) => sum + movement.amount,
      0
    );

    const openingTotals = stripUntracked({
      ...openingCount.totals,
      ...openingCount.others
    });

    const closingTotals = stripUntracked({
      ...closingCount.totals,
      ...closingCount.others
    });

    // Expected PHP now includes:
    // forex transactions
    // + expenses/replenishments
    // + documented Forex Fund cash movements
    const phpAdjustment =
      expenseTotal +
      cashMovementTotal;

    const adjustments =
      phpAdjustment !== 0
        ? { PHP: phpAdjustment }
        : {};

    const results = reconcile(
      openingTotals,
      closingTotals,
      tickets.map(t => t.parsed),
      adjustments
    );

    for (const r of results) {
      r.missingFromOpening =
        !(r.ccy in openingTotals);

      r.missingFromClosing =
        !(r.ccy in closingTotals);

      r.openingAmount =
        openingCount.totals &&
        openingCount.totals[r.ccy] != null
          ? openingCount.totals[r.ccy]
          : (
              openingCount.others &&
              openingCount.others[r.ccy] != null
                ? openingCount.others[r.ccy]
                : 0
            );
    }

    const report = buildShiftAuditReport({
      branchConfig,
      closingCount,
      openingCount,
      results,
      tickets,
      expenseEntries,
      cashMovementEntries,
      dryRun
    });

    if (dryRun) return report;

    const posted =
      await postMessage(
        cashCountChannelId,
        report
      );

    const hasOpenDiscrepancies =
      results.some(r => !r.match);

    if (
      posted &&
      posted.ts &&
      hasOpenDiscrepancies
    ) {
      const computation =
        buildComputationReply(
          branchConfig,
          tickets
        );

      await replyInThread(
        cashCountChannelId,
        posted.ts,
        computation
      ).catch(err =>
        console.error(
          'Failed to post computation reply:',
          err
        )
      );
    }

  } catch (err) {
    console.error(
      'runShiftAudit error:',
      err
    );

    const msg =
      `⚠️ Audit bot error for ${branchConfig.name}: ${err.message}\n\n` +
      `${err.stack || ''}`;

    if (dryRun) return msg;

    if (
      shouldPostFailureNotice(
        branchConfig.name,
        'shift-error'
      )
    ) {
      await postMessage(
        branchConfig.cashCountChannelId,
        msg
      ).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* REPORT 2 — HANDOVER CHECK                                           */
/* ------------------------------------------------------------------ */

async function runCloseVsOpenCheck(
  openingEvent,
  openingCount,
  branchConfig,
  { dryRun = false } = {}
) {
  const {
    cashCountChannelId,
    transactionsChannelId
  } = branchConfig;

  try {
    const closingCount =
      await findPriorCount(
        cashCountChannelId,
        openingEvent.ts,
        openingCount,
        isScheduledClosing
      );

    if (!closingCount) {
      const msg =
        `⚠️ *Handover Check — ${branchConfig.name}*\n` +
        `No prior closing count found to compare against.`;

      if (dryRun) return msg;

      if (
        shouldPostFailureNotice(
          branchConfig.name,
          'handover-no-closing'
        )
      ) {
        await postMessage(
          cashCountChannelId,
          msg
        );
      }

      return;
    }

    const gapMessages =
      await history(
        transactionsChannelId,
        {
          oldest: closingCount._ts,
          latest: openingEvent.ts,
          limit: 100
        }
      );

    const gapTickets =
      gapMessages
        .filter(
          m =>
            m.text &&
            TICKET_RE.test(m.text)
        )
        .map(
          m =>
            parseTransaction(m.text)
        )
        .filter(Boolean);

    const closingTotals =
      stripUntracked({
        ...closingCount.totals,
        ...closingCount.others
      });

    const openingTotals =
      stripUntracked({
        ...openingCount.totals,
        ...openingCount.others
      });

    const allCcy =
      new Set([
        ...Object.keys(closingTotals),
        ...Object.keys(openingTotals)
      ]);

    const asResults = [];

    for (const ccy of allCcy) {
      const closeVal =
        closingTotals[ccy] || 0;

      const openVal =
        openingTotals[ccy] || 0;

      const diff =
        openVal - closeVal;

      const tolerance =
        ccy === 'PHP'
          ? 1
          : 0.01;

      const gapMovement =
        movementFor(
          gapTickets,
          ccy
        );

      const netDiff =
        diff - gapMovement;

      asResults.push({
        ccy,
        expected:
          closeVal + gapMovement,
        actual:
          openVal,
        diff:
          Math.round(
            netDiff * 100
          ) / 100,
        match:
          Math.abs(netDiff) <=
          tolerance
      });
    }

    for (const r of asResults) {
      r.missingFromOpening =
        !(r.ccy in closingTotals);

      r.missingFromClosing =
        !(r.ccy in openingTotals);

      r.openingAmount =
        closingTotals[r.ccy] != null
          ? closingTotals[r.ccy]
          : 0;
    }

    const report =
      buildQuestionReport({
        branchConfig,
        title: 'HANDOVER CHECK',

        dateLabel:
          (
            openingCount.timestamp ||
            ''
          )
            .split(',')[0]
            .trim(),

        windowText:
          `Close ${
            (
              closingCount.timestamp ||
              ''
            )
              .split(',')[1]
              ?.trim() ||
            '?'
          } → Open ${
            (
              openingCount.timestamp ||
              ''
            )
              .split(',')[1]
              ?.trim() ||
            '?'
          }`,

        openingTeller:
          closingCount.teller,

        closingTeller:
          openingCount.teller,

        txCount:
          gapTickets.length,

        txLabel:
          'transaction(s) posted in the gap',

        results:
          asResults,

        gapTickets,

        dryRun
      });

    if (dryRun) return report;

    const posted =
      await postMessage(
        cashCountChannelId,
        report
      );

    const hasOpenDiscrepancies =
      asResults.some(
        r => !r.match
      );

    if (
      posted &&
      posted.ts &&
      hasOpenDiscrepancies
    ) {
      const computation =
        buildHandoverComputationReply(
          branchConfig,
          gapTickets
        );

      await replyInThread(
        cashCountChannelId,
        posted.ts,
        computation
      ).catch(err =>
        console.error(
          'Failed to post handover computation reply:',
          err
        )
      );
    }

  } catch (err) {
    console.error(
      'runCloseVsOpenCheck error:',
      err
    );

    const msg =
      `⚠️ Audit bot error (handover) for ${branchConfig.name}: ${err.message}\n\n` +
      `${err.stack || ''}`;

    if (dryRun) return msg;

    if (
      shouldPostFailureNotice(
        branchConfig.name,
        'handover-error'
      )
    ) {
      await postMessage(
        branchConfig.cashCountChannelId,
        msg
      ).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function stripUntracked(totals) {
  const copy = { ...totals };

  for (const key of UNTRACKED_BUCKETS) {
    delete copy[key];
  }

  return copy;
}

/**
 * Reads natural-language PHP cash movements posted to the general channel.
 *
 * Examples supported:
 *
 * Petty Cash returned to Forex fund
 * amount: 1459.16
 *
 * Petty Cash retured to Forex fund
 * amount: 1459.16
 *
 * PHP 5,000 added to Forex fund
 *
 * Paid from Forex fund amount: 1000
 */
function parseForexFundMovement(text) {
  if (!text) return null;

  const normalized =
    String(text)
      .replace(/\u00A0/g, ' ')
      .replace(/[–—]/g, '-')
      .trim();

  if (!/forex/i.test(normalized)) {
    return null;
  }

  // Do not accidentally parse bot reports or cash-count reports.
  if (
    /SHIFT AUDIT|HANDOVER CHECK|PSULIT CASH COUNT REPORT|full math/i.test(
      normalized
    )
  ) {
    return null;
  }

  const amountMatch =
    normalized.match(
      /(?:₱|PHP\s*)\s*([\d,]+(?:\.\d+)?)/i
    ) ||
    normalized.match(
      /\bamount\s*:?\s*₱?\s*([\d,]+(?:\.\d+)?)/i
    );

  if (!amountMatch) {
    return null;
  }

  const amount =
    parseFloat(
      amountMatch[1]
        .replace(/,/g, '')
    );

  if (!Number.isFinite(amount)) {
    return null;
  }

  const moneyIntoForex =
    /retur(?:n|ne|ned|ed|e|d)?[\s\S]{0,60}forex/i.test(normalized) ||
    /retured[\s\S]{0,60}forex/i.test(normalized) ||
    /added?[\s\S]{0,60}forex/i.test(normalized) ||
    /deposit(?:ed)?[\s\S]{0,60}forex/i.test(normalized) ||
    /replenish(?:ed|ment)?[\s\S]{0,60}forex/i.test(normalized) ||
    /transfer(?:red)?[\s\S]{0,60}(?:to|into)[\s\S]{0,30}forex/i.test(normalized) ||
    /forex[\s\S]{0,40}(?:cash\s*)?in/i.test(normalized);

  const moneyOutOfForex =
    /(?:taken|take)[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(normalized) ||
    /withdraw(?:n)?[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(normalized) ||
    /paid[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(normalized) ||
    /transfer(?:red)?[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(normalized) ||
    /moved[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(normalized) ||
    /forex[\s\S]{0,40}(?:cash\s*)?out/i.test(normalized);

  if (moneyIntoForex) {
    return {
      amount,
      direction: 'IN',
      raw: text
    };
  }

  if (moneyOutOfForex) {
    return {
      amount: -amount,
      direction: 'OUT',
      raw: text
    };
  }

  return null;
}
async function findPriorCount(
  channelId,
  beforeTs,
  referenceCount,
  predicate
) {
  const PAGE_SIZE = 200;
  const MAX_PAGES = 10;

  let latest = beforeTs;

  for (
    let page = 0;
    page < MAX_PAGES;
    page++
  ) {
    const msgs =
      await history(
        channelId,
        {
          latest,
          limit: PAGE_SIZE
        }
      );

    if (msgs.length === 0) {
      break;
    }

    for (const msg of msgs) {
      const parsed =
        parseCashCount(
          msg.text || ''
        );

      if (!parsed) continue;

      if (
        parsed.branch !==
        referenceCount.branch
      ) {
        continue;
      }

      if (!predicate(parsed)) {
        continue;
      }

      return {
        ...parsed,
        _ts: msg.ts
      };
    }

    if (
      msgs.length <
      PAGE_SIZE
    ) {
      break;
    }

    latest =
      (
        parseFloat(
          msgs[
            msgs.length - 1
          ].ts
        ) -
        0.000001
      ).toFixed(6);
  }

  return null;
}

function movementFor(
  tickets,
  ccy
) {
  let sum = 0;

  for (const tx of tickets) {
    for (
      const mv of
      (tx.movements || [])
    ) {
      if (
        mv.ccy !== ccy
      ) {
        continue;
      }

      const sign =
        mv.action === 'BUY'
          ? 1
          : -1;

      sum +=
        sign *
        mv.fcyAmount;
    }
  }

  return sum;
}

function ticketsForCurrency(
  tickets,
  ccy
) {
  if (ccy === 'PHP') {
    return tickets.filter(
      t =>
        t.parsed.phpAmount != null
    );
  }

  return tickets.filter(
    t =>
      (
        t.parsed.movements ||
        []
      ).some(
        mv =>
          mv.ccy === ccy
      )
  );
}

function timeLabel(ts) {
  if (!ts) return '';

  return new Date(
    parseFloat(ts) * 1000
  ).toLocaleTimeString(
    'en-PH',
    {
      timeZone:
        'Asia/Manila',
      hour:
        'numeric',
      minute:
        '2-digit'
    }
  );
}

function clientLabel(raw) {
  const m =
    raw.match(
      /(?:NEW|OLD)\s+CLIENT\s*:\s*([^\n]+)/i
    );

  return m
    ? m[1].trim()
    : null;
}

function buildQuestionBlock(
  ccy,
  diff,
  tickets,
  openingAmount,
  expectedAmount,
  actualAmount,
  since,
  missingFromOpening,
  missingFromClosing
) {
  const emoji =
    CCY_EMOJI[ccy] ||
    '•';

  const short =
    diff < 0;

  const gapLabel =
    moneyLabel(
      ccy,
      Math.abs(diff)
    );

  const verb =
    short
      ? 'is short'
      : 'has extra';

  if (
    missingFromOpening &&
    !missingFromClosing
  ) {
    const lines = [];

    lines.push(
      `${emoji} *${ccy} wasn't included in the opening count*, but the closing count shows ${moneyLabel(ccy, actualAmount)}.`
    );

    lines.push(
      `This might just be a reporting gap rather than a real cash issue — can you confirm ${ccy} was actually ${moneyLabel(ccy, actualAmount)} at the start of the shift too?`
    );

    if (since) {
      lines.push('');
    }

    if (
      since ===
      '(would be newly flagged)'
    ) {
      lines.push(
        `_(This would be a new question as of this report.)_`
      );
    } else if (since) {
      lines.push(
        `_(Still unresolved since ${since} — this will keep showing up until it's sorted out.)_`
      );
    }

    return lines.join('\n');
  }

  if (
    missingFromClosing &&
    !missingFromOpening
  ) {
    const lines = [];

    lines.push(
      `${emoji} *${ccy} was in the opening count* (${moneyLabel(ccy, openingAmount)}), *but wasn't included in the closing count.*`
    );

    lines.push(
      `This might just be a reporting gap rather than money going missing — can you confirm what ${ccy} actually was at closing?`
    );

    if (
      since ===
      '(would be newly flagged)'
    ) {
      lines.push('');
      lines.push(
        `_(This would be a new question as of this report.)_`
      );
    } else if (since) {
      lines.push('');
      lines.push(
        `_(Still unresolved since ${since} — this will keep showing up until it's sorted out.)_`
      );
    }

    return lines.join('\n');
  }

  const lines = [];

  lines.push(
    `${emoji} *The drawer ${verb} ${gapLabel}* than it should${short ? "n't" : ''}.`
  );

  lines.push('');
  lines.push(
    `Here's the math:`
  );

  lines.push(
    `• Started the shift with: ${moneyLabel(ccy, openingAmount)}`
  );

  const relevant =
    ticketsForCurrency(
      tickets,
      ccy
    );

  if (
    relevant.length === 0
  ) {
    lines.push(
      `• No ${ccy} transactions were logged this shift`
    );
  } else {
    const sorted =
      [...relevant].sort(
        (a, b) => {
          const amtA =
            ccy === 'PHP'
              ? (
                  a.parsed
                    .phpAmount ||
                  0
                )
              : Math.max(
                  ...a.parsed
                    .movements
                    .filter(
                      m =>
                        m.ccy ===
                        ccy
                    )
                    .map(
                      m =>
                        m.fcyAmount
                    )
                );

          const amtB =
            ccy === 'PHP'
              ? (
                  b.parsed
                    .phpAmount ||
                  0
                )
              : Math.max(
                  ...b.parsed
                    .movements
                    .filter(
                      m =>
                        m.ccy ===
                        ccy
                    )
                    .map(
                      m =>
                        m.fcyAmount
                    )
                );

          return amtB - amtA;
        }
      );

    const biggest =
      sorted[0];

    const who =
      biggest.parsed
        .isWholesale
        ? 'a wholesale deal'
        : `${
            firstName(
              clientLabel(
                biggest.raw
              )
            ) ||
            'a client'
          }`;

    const amountLabel =
      ccy === 'PHP'
        ? moneyLabel(
            'PHP',
            biggest.parsed
              .phpAmount
          )
        : (() => {
            const mv =
              biggest.parsed
                .movements
                .find(
                  m =>
                    m.ccy ===
                    ccy
                );

            return `${fmt(mv.fcyAmount)} ${ccy}`;
          })();

    const summaryVerb =
      biggest.parsed
        .isWholesale
        ? 'sold'
        : 'bought';

    const preposition =
      biggest.parsed
        .isWholesale
        ? 'to'
        : 'from';

    lines.push(
      `• ${relevant.length} transaction${relevant.length > 1 ? 's' : ''} happened (biggest: ${summaryVerb} ${amountLabel} ${preposition} ${who} at ${timeLabel(biggest.ts)})`
    );
  }

  lines.push(
    `• Based on those transactions, should have ended with: ${moneyLabel(ccy, expectedAmount)}`
  );

  lines.push(
    `• But the actual count at closing was: ${moneyLabel(ccy, actualAmount)}`
  );

  lines.push(
    `• *That's ${gapLabel} that isn't explained by any transaction.*`
  );

  if (
    since ===
    '(would be newly flagged)'
  ) {
    lines.push('');
    lines.push(
      `_(This would be a new question as of this report.)_`
    );
  } else if (since) {
    lines.push('');
    lines.push(
      `_(Still unresolved since ${since} — this will keep showing up until it's sorted out.)_`
    );
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* DISCREPANCY TRACKING                                                */
/* ------------------------------------------------------------------ */

function annotateFlags(
  flagStore,
  branch,
  results,
  dateLabel,
  dryRun = false,
  cycleId = dateLabel
) {
  const stillOpen = [];
  const resolved = [];

  for (const r of results) {
    const key =
      `${branch}|${r.ccy}`;

    const prior =
      flagStore.get(key);

    if (r.match) {
      // Only the SAME audit cycle
      // can resolve its own flag.
      //
      // A clean later shift must
      // never clear an older
      // discrepancy just because
      // the same currency balances.
      if (
        prior &&
        prior.cycleId ===
          cycleId
      ) {
        if (!dryRun) {
          flagStore.delete(key);
        }

        resolved.push({
          ccy: r.ccy,
          since:
            prior.firstFlaggedLabel,
          correctedCount: true
        });
      }

      continue;
    }

    if (prior) {
      stillOpen.push({
        ...r,
        since:
          prior.firstFlaggedLabel
      });
    } else {
      if (!dryRun) {
        flagStore.set(
          key,
          {
            diff:
              r.diff,

            firstFlaggedLabel:
              dateLabel,

            cycleId,

            missingFromOpening:
              r.missingFromOpening,

            missingFromClosing:
              r.missingFromClosing,

            expected:
              r.expected,

            actual:
              r.actual,

            openingAmount:
              r.openingAmount
          }
        );
      }

      stillOpen.push({
        ...r,
        since:
          dryRun
            ? '(would be newly flagged)'
            : null
      });
    }
  }

  return {
    stillOpen,
    resolved
  };
}

function getOpenShiftAuditFlags(
  branch
) {
  return getOpenFlagsFrom(
    SHIFT_AUDIT_FLAGS,
    branch
  );
}

function getOpenHandoverFlags(
  branch
) {
  return getOpenFlagsFrom(
    HANDOVER_FLAGS,
    branch
  );
}

function getOpenFlagsFrom(
  flagStore,
  branch
) {
  const open = [];

  for (
    const [key, value]
    of flagStore.entries()
  ) {
    const [
      flagBranch,
      ccy
    ] =
      key.split('|');

    if (
      flagBranch === branch
    ) {
      open.push({
        ccy,

        diff:
          value.diff,

        since:
          value.firstFlaggedLabel,

        missingFromOpening:
          value.missingFromOpening,

        missingFromClosing:
          value.missingFromClosing,

        expected:
          value.expected,

        actual:
          value.actual,

        openingAmount:
          value.openingAmount
      });
    }
  }

  return open;
}

/* ------------------------------------------------------------------ */
/* SHIFT AUDIT REPORT                                                  */
/* ------------------------------------------------------------------ */

function buildShiftAuditReport({
  branchConfig,
  closingCount,
  openingCount,
  results,
  tickets,
  expenseEntries = [],
  cashMovementEntries = [],
  dryRun = false
}) {
  const dateLabel =
    (
      closingCount.timestamp ||
      ''
    )
      .split(',')[0]
      .trim();

  const cycleId =
    `${branchConfig.name}|shift|${dateLabel}|${windowLabel(closingCount)}`;

  const {
    stillOpen,
    resolved
  } =
    annotateFlags(
      SHIFT_AUDIT_FLAGS,
      branchConfig.name,
      results,
      dateLabel,
      dryRun,
      cycleId
    );

  const openName =
    firstName(
      openingCount.teller
    );

  const closeName =
    firstName(
      closingCount.teller
    );

  const lines = [];

  if (dryRun) {
    lines.push(
      '_[DRY RUN — not posted to Slack]_'
    );
  }

  lines.push(
    `🔍 ${branchConfig.name} — ${dateLabel}, ${windowLabel(closingCount)}`
  );

  lines.push(
    `${openName} (opened) → ${closeName} (closed)`
  );

  lines.push('');

  if (
    expenseEntries.length >
    0
  ) {
    const netLabel =
      expenseEntries.reduce(
        (s, e) =>
          s + e.amount,
        0
      );

    const sign =
      netLabel >= 0
        ? '+'
        : '';

    lines.push(
      `💼 ${expenseEntries.length} expense/replenishment entr${expenseEntries.length > 1 ? 'ies' : 'y'} this shift (net ${sign}${moneyLabel('PHP', netLabel)}) already included.`
    );

    lines.push('');
  }

  // Show all documented cash
  // movements that were included
  // in the PHP reconciliation.
  if (
    cashMovementEntries.length >
    0
  ) {
    const netMovement =
      cashMovementEntries.reduce(
        (sum, movement) =>
          sum +
          movement.amount,
        0
      );

    for (
      const movement of
      cashMovementEntries
    ) {
      lines.push(
        `💵 Forex Fund ${movement.direction}: ${moneyLabel('PHP', Math.abs(movement.amount))} included.`
      );
    }

    const sign =
      netMovement >= 0
        ? '+'
        : '-';

    lines.push(
      `Net Forex Fund movement: ${sign}${moneyLabel('PHP', Math.abs(netMovement))}.`
    );

    lines.push('');
  }

  if (
    stillOpen.length === 0 &&
    resolved.length === 0
  ) {
    lines.push(
      `✅ All good. ${tickets.length} transactions checked, everything matches.`
    );

    return lines.join('\n');
  }

  if (
    stillOpen.length > 0
  ) {
    lines.push(
      `*${stillOpen.length} discrepanc${stillOpen.length > 1 ? 'ies' : 'y'} this shift:*`
    );

    for (
      const r of stillOpen
    ) {
      if (
        r.missingFromOpening &&
        !r.missingFromClosing
      ) {
        lines.push(
          `❗ ${r.ccy}: not in the opening count, ${moneyLabel(r.ccy, r.actual)} at closing`
        );
      } else if (
        r.missingFromClosing &&
        !r.missingFromOpening
      ) {
        lines.push(
          `❗ ${r.ccy}: ${moneyLabel(r.ccy, r.expected)} at opening, not in the closing count`
        );
      } else {
        const short =
          r.diff < 0;

        lines.push(
          `❗ ${r.ccy}: ${short ? 'short' : 'extra'} ${moneyLabel(r.ccy, Math.abs(r.diff))}`
        );
      }
    }

    lines.push('');
  }

  for (
    const r of resolved
  ) {
    lines.push(
      `✅ ${r.ccy} resolved — corrected closing cash count now reconciles.`
    );
  }

  if (
    resolved.length
  ) {
    lines.push('');
  }

  // Do NOT ask tellers to explain
  // anything if everything has
  // already been resolved.
  if (
    stillOpen.length > 0
  ) {
    const who =
      [
        openName,
        closeName
      ].filter(
        (v, i, a) =>
          a.indexOf(v) === i
      );

    lines.push(
      `${who.map(n => '@' + n).join(' ')} — can you explain these? See the thread below for the full math. 🙏`
    );
  }

  return lines.join('\n');
}
/* ------------------------------------------------------------------ */
/* FULL COMPUTATION REPLIES                                            */
/* ------------------------------------------------------------------ */

function sharedQuestions(openFlags) {
  const hasRealGap =
    openFlags.some(
      f =>
        !f.missingFromOpening &&
        !f.missingFromClosing
    );

  if (!hasRealGap) {
    return [];
  }

  return [
    '',
    'Questions:',
    "1. Did anyone drop off extra cash into the drawer that wasn't from a client transaction (e.g. replenishment, change fund, an owner's deposit)?",
    '2. Could the closing count have included cash that actually belongs to a different bucket (like Hive, Receivables, or petty cash)?'
  ];
}

function buildComputationReply(
  branchConfig,
  tickets
) {
  const openFlags =
    getOpenShiftAuditFlags(
      branchConfig.name
    );

  if (
    openFlags.length === 0
  ) {
    return 'Looks like everything already reconciled — nothing open to walk through right now.';
  }

  const lines = [];

  lines.push(
    `Here's the full math for ${branchConfig.name}:`
  );

  lines.push('');

  for (
    let i = 0;
    i < openFlags.length;
    i++
  ) {
    const f =
      openFlags[i];

    lines.push(
      buildQuestionBlock(
        f.ccy,
        f.diff,
        tickets,
        f.openingAmount,
        f.expected,
        f.actual,
        f.since,
        f.missingFromOpening,
        f.missingFromClosing
      )
    );

    if (
      i <
      openFlags.length - 1
    ) {
      lines.push('');
    }
  }

  lines.push(
    ...sharedQuestions(
      openFlags
    )
  );

  lines.push('');

  lines.push(
    `Let us know here once it's sorted out. 🙏`
  );

  return lines.join('\n');
}

function buildHandoverComputationReply(
  branchConfig,
  gapTickets
) {
  const openFlags =
    getOpenHandoverFlags(
      branchConfig.name
    );

  if (
    openFlags.length === 0
  ) {
    return 'Looks like everything already reconciled — nothing open to walk through right now.';
  }

  const lines = [];

  lines.push(
    `Here's the full math for ${branchConfig.name}'s handover:`
  );

  lines.push('');

  for (
    let i = 0;
    i < openFlags.length;
    i++
  ) {
    const f =
      openFlags[i];

    lines.push(
      buildQuestionBlock(
        f.ccy,
        f.diff,
        gapTickets || [],
        f.openingAmount,
        f.expected,
        f.actual,
        f.since,
        f.missingFromOpening,
        f.missingFromClosing
      )
    );

    if (
      i <
      openFlags.length - 1
    ) {
      lines.push('');
    }
  }

  lines.push(
    ...sharedQuestions(
      openFlags
    )
  );

  lines.push('');

  lines.push(
    `Let us know here once it's sorted out. 🙏`
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* HANDOVER REPORT                                                     */
/* ------------------------------------------------------------------ */

function buildQuestionReport({
  branchConfig,
  title,
  dateLabel,
  windowText,
  openingTeller,
  closingTeller,
  txCount,
  txLabel,
  results,
  dryRun = false
}) {
  const cycleId =
    `${branchConfig.name}|handover|${dateLabel}|${windowText}`;

  const {
    stillOpen,
    resolved
  } =
    annotateFlags(
      HANDOVER_FLAGS,
      branchConfig.name,
      results,
      dateLabel,
      dryRun,
      cycleId
    );

  const openShiftAuditFlags =
    getOpenShiftAuditFlags(
      branchConfig.name
    );

  const openName =
    firstName(
      openingTeller
    );

  const closeName =
    firstName(
      closingTeller
    );

  const lines = [];

  if (dryRun) {
    lines.push(
      '_[DRY RUN — not posted to Slack]_'
    );
  }

  lines.push(
    `🔄 ${branchConfig.name} — ${dateLabel}, ${windowText}`
  );

  lines.push(
    `${openName} → ${closeName}`
  );

  lines.push('');

  const hasOvernightIssue =
    stillOpen.length > 0;

  const hasLeftoverQuestion =
    openShiftAuditFlags.length > 0;

  if (
    !hasOvernightIssue
  ) {
    lines.push(
      "✅ Overnight is fine — nothing moved that shouldn't have."
    );
  } else {
    lines.push(
      `⚠️ *${
        stillOpen.length > 1
          ? `${stillOpen.length} new things don't match:`
          : `1 new thing doesn't match:`
      }*`
    );

    for (
      const r of stillOpen
    ) {
      const short =
        r.diff < 0;

      const label =
        moneyLabel(
          r.ccy,
          Math.abs(r.diff)
        );

      lines.push(
        `❗ ${r.ccy}: ${short ? 'short' : 'extra'} ${label}`
      );
    }
  }

  for (
    const r of resolved
  ) {
    lines.push('');

    lines.push(
      `✅ ${r.ccy} handover now reconciles.`
    );
  }

  if (
    hasLeftoverQuestion
  ) {
    lines.push('');

    lines.push(
      `⚠️ *There${
        openShiftAuditFlags.length > 1
          ? ' are'
          : "'s"
      } still ${
        openShiftAuditFlags.length > 1
          ? 'open questions'
          : 'an open question'
      } from ${
        openShiftAuditFlags.length > 1
          ? 'earlier shifts'
          : "yesterday's shift"
      }:*`
    );

    lines.push('');

    for (
      const f of
      openShiftAuditFlags
    ) {
      const emoji =
        CCY_EMOJI[f.ccy] ||
        '•';

      const sinceLabel =
        f.since
          ? ` (from the ${f.since} shift)`
          : '';

      if (
        f.missingFromOpening &&
        !f.missingFromClosing
      ) {
        lines.push(
          `${emoji} ${f.ccy} was never confirmed at opening that day, but showed ${moneyLabel(f.ccy, f.diff >= 0 ? Math.abs(f.diff) : f.diff)} at closing${sinceLabel} — still waiting to hear if that was a reporting gap or a real change.`
        );
      } else if (
        f.missingFromClosing &&
        !f.missingFromOpening
      ) {
        lines.push(
          `${emoji} ${f.ccy} was never confirmed at closing that day${sinceLabel} — still waiting to hear if that was a reporting gap or a real change.`
        );
      } else {
        const short =
          f.diff < 0;

        const label =
          moneyLabel(
            f.ccy,
            Math.abs(f.diff)
          );

        const verb =
          short
            ? 'was short'
            : 'had extra';

        lines.push(
          `${emoji} The drawer ${verb} ${label} that was never explained${sinceLabel}.`
        );
      }
    }
  }

  if (
    !hasOvernightIssue &&
    !hasLeftoverQuestion
  ) {
    return lines.join('\n');
  }

  lines.push('');

  const who =
    [
      openName,
      closeName
    ].filter(
      (v, i, a) =>
        a.indexOf(v) === i
    );

  const askVerb =
    hasLeftoverQuestion &&
    !hasOvernightIssue
      ? 'this is still waiting on an answer'
      : (
          hasLeftoverQuestion
            ? 'please check both'
            : 'please check before trading'
        );

  lines.push(
    `${who.map(n => '@' + n).join(' ')} — ${askVerb}. Reply here 🙏`
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* MONEY FORMATTING                                                    */
/* ------------------------------------------------------------------ */

const CCY_SYMBOL = {
  USD: '$',
  GBP: '£',
  EUR: '€',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  HKD: 'HK$',
  PHP: '₱',
  Hive: '₱',
  Opex: '₱'
};

function moneyLabel(
  ccy,
  amount
) {
  const symbol =
    CCY_SYMBOL[ccy];

  return symbol
    ? `${symbol}${fmt(amount)}`
    : `${fmt(amount)} ${ccy}`;
}

function fmt(n) {
  return (
    n || 0
  ).toLocaleString(
    'en-US',
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }
  );
}

/* ------------------------------------------------------------------ */
/* EXPORTS                                                             */
/* ------------------------------------------------------------------ */

module.exports = {
  runShiftAudit,
  runCloseVsOpenCheck,
  isScheduledOpening,
  isScheduledClosing
};
