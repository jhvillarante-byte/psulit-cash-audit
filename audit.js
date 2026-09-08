/**
 * audit.js
 *
 * Two automatic checks:
 * 1) SHIFT AUDIT at the scheduled closing count.
 * 2) HANDOVER CHECK at the next scheduled opening count.
 *
 * Important: audit windows use the timestamp INSIDE the cash-count report,
 * not the later Slack posting time. This prevents delayed Slack posts from
 * accidentally excluding/including transactions.
 */

const { reconcile } = require('./reconcile');
const { applyApprovedOpeningCorrections } = require('./corrections');

const {
  history,
  postMessage,
  replyInThread
} = require('./slack');

const {
  parseCashCount,
  parseTransaction,
  parseExpenseEntry
} = require('./parse');

const {
  isScheduledOpening,
  isScheduledClosing,
  windowLabel,
  shiftDateForClose,
  dateParts,
  decimalHour
} = require('./schedule');

const TICKET_RE = /(?:VN|ARN|AR)\s*#?\s*0*\d+/i;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

// Non-physical / separately tracked buckets are intentionally excluded
// from physical Forex drawer reconciliation.
const UNTRACKED_BUCKETS = [
  'Hive',
  'Opex',
  'JuanPay',
  'Scratch',
  'Receivables (PHP)',
  'Receivables (USD)'
];

const SHIFT_AUDIT_FLAGS = new Map();
const HANDOVER_FLAGS = new Map();

const CCY_SYMBOL = {
  PHP: '₱',
  USD: '$',
  GBP: '£',
  EUR: '€',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  HKD: 'HK$',
  JPY: '¥',
  KRW: '₩',
  BND: 'B$',
  SAR: 'SR',
  THB: '฿',
  CNY: '¥'
};

const CCY_EMOJI = {
  PHP: '💴',
  USD: '💵',
  EUR: '💶',
  GBP: '💷',
  JPY: '💴',
  KRW: '💴'
};

const LAST_FAILURE_NOTICE = new Map();
const FAILURE_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;

function firstName(fullName) {
  if (!fullName) return '?';
  return fullName.trim().split(/\s+/)[0];
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function moneyLabel(ccy, amount) {
  const symbol = CCY_SYMBOL[ccy];

  return symbol
    ? `${symbol}${fmt(amount)}`
    : `${fmt(amount)} ${ccy}`;
}

function shouldPostFailureNotice(branch, kind) {
  const key = `${branch}|${kind}`;
  const last = LAST_FAILURE_NOTICE.get(key);
  const now = Date.now();

  if (
    last &&
    now - last < FAILURE_NOTICE_COOLDOWN_MS
  ) {
    return false;
  }

  LAST_FAILURE_NOTICE.set(key, now);
  return true;
}

/**
 * Convert a report timestamp like:
 * 09/06/2026, 10:14:34
 * to a Slack-compatible epoch timestamp in Manila time (UTC+8).
 */
function countTimestampToSlackTs(timestamp) {
  const m = String(timestamp || '').match(
    /(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})/
  );

  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);

  const epochMs = Date.UTC(
    year,
    month - 1,
    day,
    hour - 8,
    minute,
    second
  );

  return (epochMs / 1000).toFixed(6);
}

function stripUntracked(totals) {
  const copy = {
    ...totals
  };

  for (const key of UNTRACKED_BUCKETS) {
    delete copy[key];
  }

  return copy;
}

function sameDateParts(a, b) {
  return (
    !!a &&
    !!b &&
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day
  );
}

function shiftDatePartsForClosing(count) {
  const d = dateParts(
    count &&
    count.timestamp
  );

  const h = decimalHour(
    count &&
    count.timestamp
  );

  if (!d || h == null) {
    return d;
  }

  return shiftDateForClose(
    count.branch,
    d.year,
    d.month,
    d.day,
    h
  );
}

/**
 * Find the scheduled opening belonging to THIS closing shift.
 *
 * This is safer than simply taking the nearest opening message,
 * because a Mid-Shift opening can sometimes be close enough to
 * the branch opening hour.
 */
async function findOpeningForClosing(
  channelId,
  closingSlackTs,
  closingCount
) {
  const wantedDate =
    shiftDatePartsForClosing(
      closingCount
    );

  let latest =
    closingSlackTs;

  let best =
    null;

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
          limit:
            PAGE_SIZE
        }
      );

    if (!msgs.length) {
      break;
    }

    for (
      const msg of
      msgs
    ) {
      if (
        parseFloat(msg.ts) >=
        parseFloat(closingSlackTs)
      ) {
        continue;
      }

      const parsed =
        parseCashCount(
          msg.text || ''
        );

      if (
        !parsed ||
        parsed.branch !==
          closingCount.branch
      ) {
        continue;
      }

      if (
        !isScheduledOpening(
          parsed
        )
      ) {
        continue;
      }

      const d =
        dateParts(
          parsed.timestamp
        );

      if (
        wantedDate &&
        !sameDateParts(
          d,
          wantedDate
        )
      ) {
        continue;
      }

      const ts =
        countTimestampToSlackTs(
          parsed.timestamp
        ) ||
        msg.ts;

      if (
        !best ||
        parseFloat(ts) <
          parseFloat(
            best.boundaryTs
          )
      ) {
        best = {
          ...parsed,
          _ts:
            msg.ts,
          boundaryTs:
            ts
        };
      }
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

  return best;
}

async function findPriorScheduledClosing(
  channelId,
  beforeSlackTs,
  referenceCount
) {
  let latest =
    beforeSlackTs;

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
          limit:
            PAGE_SIZE
        }
      );

    if (!msgs.length) {
      break;
    }

    for (
      const msg of
      msgs
    ) {
      if (
        parseFloat(msg.ts) >=
        parseFloat(beforeSlackTs)
      ) {
        continue;
      }

      const parsed =
        parseCashCount(
          msg.text || ''
        );

      if (
        !parsed ||
        parsed.branch !==
          referenceCount.branch
      ) {
        continue;
      }

      if (
        !isScheduledClosing(
          parsed
        )
      ) {
        continue;
      }

      return {
        ...parsed,

        _ts:
          msg.ts,

        boundaryTs:
          countTimestampToSlackTs(
            parsed.timestamp
          ) ||
          msg.ts
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

function statedExpenseDate(
  text
) {
  if (!text) {
    return null;
  }

  const numeric =
    String(text).match(
      /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/
    );

  if (numeric) {
    return [
      String(
        Number(
          numeric[1]
        )
      ).padStart(
        2,
        '0'
      ),

      String(
        Number(
          numeric[2]
        )
      ).padStart(
        2,
        '0'
      ),

      numeric[3]
    ].join('/');
  }

  const monthMap = {
    jan: 1,
    january: 1,

    feb: 2,
    february: 2,

    mar: 3,
    march: 3,

    apr: 4,
    april: 4,

    may: 5,

    jun: 6,
    june: 6,

    jul: 7,
    july: 7,

    aug: 8,
    august: 8,

    sep: 9,
    sept: 9,
    september: 9,

    oct: 10,
    october: 10,

    nov: 11,
    november: 11,

    dec: 12,
    december: 12
  };

  const m =
    String(text).match(
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\s*,?\s*(20\d{2})\b/i
    );

  if (!m) {
    return null;
  }

  const month =
    monthMap[
      m[1]
        .toLowerCase()
    ];

  const day =
    Number(
      m[2]
    );

  const year =
    Number(
      m[3]
    );

  if (
    !month ||
    !day ||
    !year
  ) {
    return null;
  }

  return [
    String(month)
      .padStart(
        2,
        '0'
      ),

    String(day)
      .padStart(
        2,
        '0'
      ),

    String(year)
  ].join('/');
}

function buildExpenseAdjustments(
  expenseEntries,
  phpAdjustment
) {
  const adjustments =
    {};

  if (
    phpAdjustment !==
      0
  ) {
    adjustments.PHP =
      phpAdjustment;
  }

  for (
    const entry of
      expenseEntries
  ) {
    if (
      !entry.cashMovement ||
      entry.cashMovement.source !==
        'Forex drawer'
    ) {
      continue;
    }

    const {
      ccy,
      amount
    } = entry.cashMovement;

    adjustments[ccy] =
      (
        adjustments[ccy] ||
        0
      ) +
      amount;
  }

  return adjustments;
}

/**
 * Reads natural-language PHP cash movements
 * posted in the general channel.
 */
function parseForexFundMovement(
  text
) {
  if (!text) {
    return null;
  }

  const normalized =
    String(text)
      .replace(
        /\u00A0/g,
        ' '
      )
      .replace(
        /[–—]/g,
        '-'
      )
      .trim();

  if (
    !/forex/i.test(
      normalized
    )
  ) {
    return null;
  }

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
        .replace(
          /,/g,
          ''
        )
    );

  if (
    !Number.isFinite(
      amount
    )
  ) {
    return null;
  }

  const moneyIntoForex =
    /retur(?:n|ne|ned|ed|e|d)?[\s\S]{0,60}forex/i.test(
      normalized
    ) ||

    /retured[\s\S]{0,60}forex/i.test(
      normalized
    ) ||

    /added?[\s\S]{0,60}forex/i.test(
      normalized
    ) ||

    /deposit(?:ed)?[\s\S]{0,60}forex/i.test(
      normalized
    ) ||

    /replenish(?:ed|ment)?[\s\S]{0,60}forex/i.test(
      normalized
    ) ||

    /transfer(?:red)?[\s\S]{0,60}(?:to|into)[\s\S]{0,30}forex/i.test(
      normalized
    ) ||

    /forex[\s\S]{0,40}(?:cash\s*)?in/i.test(
      normalized
    );

  const moneyOutOfForex =
    /(?:taken|take)[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||

    /withdraw(?:n)?[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||

    /paid[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||

    /transfer(?:red)?[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||

    /moved[\s\S]{0,60}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||

    /forex[\s\S]{0,40}(?:cash\s*)?out/i.test(
      normalized
    );

  if (
    moneyIntoForex
  ) {
    return {
      amount,
      direction:
        'IN',
      raw:
        text
    };
  }

  if (
    moneyOutOfForex
  ) {
    return {
      amount:
        -amount,

      direction:
        'OUT',

      raw:
        text
    };
  }

  return null;
}

function transactionPhpEffect(
  tx
) {
  if (
    !tx ||
    tx.phpAmount ==
      null
  ) {
    return 0;
  }

  const first =
    (
      tx.movements ||
      []
    )[0];

  if (!first) {
    return 0;
  }

  return first.action ===
    'BUY'
      ? -tx.phpAmount
      : tx.phpAmount;
}

function transactionEffectForCurrency(
  tx,
  ccy
) {
  if (
    ccy ===
    'PHP'
  ) {
    return transactionPhpEffect(
      tx
    );
  }

  let sum =
    0;

  for (
    const mv of
    tx.movements ||
    []
  ) {
    if (
      mv.ccy !==
      ccy
    ) {
      continue;
    }

    sum +=
      mv.action ===
        'BUY'
          ? mv.fcyAmount
          : -mv.fcyAmount;
  }

  return sum;
}

function rawTicketRef(
  ticket
) {
  const ref =
    ticket &&
    ticket.parsed &&
    ticket.parsed.ref;

  return ref
    ? `AR ${String(ref).padStart(7, '0')}`
    : 'Transaction';
}

function expenseLabel(
  raw
) {
  const text =
    String(
      raw ||
      ''
    );

  const p =
    text.match(
      /Particulars?\s*:\s*([^\n]+)/i
    );

  if (p) {
    return p[1]
      .replace(
        /[*_]/g,
        ''
      )
      .trim();
  }

  const first =
    text
      .split('\n')
      .map(
        s =>
          s
            .replace(
              /[*_]/g,
              ''
            )
            .trim()
      )
      .find(Boolean);

  return first ||
    'Expense / replenishment';
}

function movementLabel(
  raw
) {
  const first =
    String(
      raw ||
      ''
    )
      .split('\n')
      .map(
        s =>
          s
            .replace(
              /[*_]/g,
              ''
            )
            .trim()
      )
      .find(Boolean);

  return first ||
    'Forex Fund movement';
}

function annotateFlags(
  store,
  branch,
  results,
  dateLabel,
  cycleId,
  dryRun
) {
  const stillOpen =
    [];

  const resolved =
    [];

  for (
    const r of
    results
  ) {
    const key =
      `${branch}|${r.ccy}`;

    const prior =
      store.get(
        key
      );

    if (r.match) {
      if (
        prior &&
        prior.cycleId ===
          cycleId
      ) {
        if (!dryRun) {
          store.delete(
            key
          );
        }

        resolved.push({
          ccy:
            r.ccy,

          since:
            prior.dateLabel
        });
      }

      continue;
    }

    if (!dryRun) {
      store.set(
        key,
        {
          ...r,
          dateLabel,
          cycleId
        }
      );
    }

    stillOpen.push({
      ...r,

      since:
        prior
          ? prior.dateLabel
          : null
    });
  }

  return {
    stillOpen,
    resolved
  };
}

function getOpenShiftFlags(
  branch
) {
  const out =
    [];

  for (
    const [
      key,
      value
    ] of
    SHIFT_AUDIT_FLAGS.entries()
  ) {
    const [
      flagBranch
    ] =
      key.split('|');

    if (
      flagBranch ===
      branch
    ) {
      out.push(
        value
      );
    }
  }

  return out;
}

function buildShiftSummary({
  branchConfig,
  openingCount,
  closingCount,
  tickets,
  expenseEntries,
  cashMovementEntries,
  appliedCorrections,
  stillOpen,
  resolved,
  dryRun
}) {
  const dateLabel =
    (
      closingCount.timestamp ||
      ''
    )
      .split(',')[0]
      .trim();

  const lines =
    [];

  if (dryRun) {
    lines.push(
      '_[DRY RUN — not posted to Slack]_'
    );
  }

  lines.push(
    `🔍 ${branchConfig.name} — ${dateLabel}, ${windowLabel(closingCount)}`
  );

  lines.push(
    `${firstName(openingCount.teller)} (opened) → ${firstName(closingCount.teller)} (closed)`
  );

  lines.push('');

  for (const correction of appliedCorrections || []) {
    lines.push(
      `✏️ Approved opening correction — ${correction.currency}: ` +
      `${moneyLabel(correction.currency, correction.originalValue)} → ` +
      `${moneyLabel(correction.currency, correction.correctedValue)} ` +
      `(${correction.openingRef}; approved by ${correction.approval.approver}; ` +
      `Slack ${correction.approval.sourceMessageTs}).`
    );
  }

  if ((appliedCorrections || []).length) lines.push('');

  if (
    expenseEntries.length
  ) {
    const total =
      expenseEntries.reduce(
        (
          s,
          e
        ) =>
          s +
          e.amount,

        0
      );

    lines.push(
      `💼 ${expenseEntries.length} expense/replenishment entr${expenseEntries.length > 1 ? 'ies' : 'y'} included (net ${total >= 0 ? '+' : '-'}${moneyLabel('PHP', Math.abs(total))}).`
    );

    for (const entry of expenseEntries) {
      if (!entry.isReceivable) {
        continue;
      }

      if (entry.cashMovement) {
        lines.push(
          `💳 ${expenseLabel(entry.raw)}: ${moneyLabel(entry.cashMovement.ccy, Math.abs(entry.cashMovement.amount))} cash out from ${entry.cashMovement.source || 'unconfirmed source'}; peso valuation ${moneyLabel('PHP', entry.pesoValuation)}.`
        );
      } else {
        lines.push(
          `⚠️ ${expenseLabel(entry.raw)}: receivable cash movement could not be determined; peso valuation ${moneyLabel('PHP', entry.pesoValuation)}. Review required.`
        );
      }
    }
  }

  if (
    cashMovementEntries.length
  ) {
    const total =
      cashMovementEntries.reduce(
        (
          s,
          e
        ) =>
          s +
          e.amount,

        0
      );

    lines.push(
      `💵 ${cashMovementEntries.length} Forex Fund cash movement${cashMovementEntries.length > 1 ? 's' : ''} included (net ${total >= 0 ? '+' : '-'}${moneyLabel('PHP', Math.abs(total))}).`
    );
  }

  if (
    expenseEntries.length ||
    cashMovementEntries.length
  ) {
    lines.push('');
  }

  if (
    !stillOpen.length &&
    !resolved.length
  ) {
    if (
      expenseEntries.some(
        entry =>
          entry.needsReview
      )
    ) {
      lines.push(
        '⚠️ Cash reconciliation cannot be cleared until the receivable cash movement is reviewed.'
      );

      return lines.join(
        '\n'
      );
    }

    lines.push(
      `✅ All forex currencies reconciled. ${tickets.length} transactions checked.`
    );

    lines.push(
      'ℹ️ Scratch, JuanPay, Hive, Opex, and other funds are not yet fully reconciled.'
    );

    return lines.join(
      '\n'
    );
  }

  if (
    stillOpen.length
  ) {
    lines.push(
      `*${stillOpen.length} discrepanc${stillOpen.length > 1 ? 'ies' : 'y'} this shift:*`
    );

    for (
      const r of
      stillOpen
    ) {
      if (
        r.missingFromOpening &&
        !r.missingFromClosing
      ) {
        lines.push(
          `❗ ${r.ccy}: not in opening count; ${moneyLabel(r.ccy, r.actual)} at closing`
        );

      } else if (
        r.missingFromClosing &&
        !r.missingFromOpening
      ) {
        lines.push(
          `❗ ${r.ccy}: expected ${moneyLabel(r.ccy, r.expected)}, but missing from closing count`
        );

      } else {
        lines.push(
          `❗ ${r.ccy}: ${r.diff < 0 ? 'short' : 'extra'} ${moneyLabel(r.ccy, Math.abs(r.diff))}`
        );
      }
    }

    lines.push('');
  }

  for (
    const r of
    resolved
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

  if (
    stillOpen.length
  ) {
    const names =
      [
        firstName(
          openingCount.teller
        ),

        firstName(
          closingCount.teller
        )
      ].filter(
        (
          v,
          i,
          a
        ) =>
          a.indexOf(v) ===
          i
      );

    lines.push(
      `${names.map(n => '@' + n).join(' ')} — please check. Full math is in the thread below. 🙏`
    );
  }

  return lines.join(
    '\n'
  );
}

function buildShiftMath({
  branchConfig,
  openingTotals,
  closingTotals,
  results,
  tickets,
  expenseEntries,
  cashMovementEntries
}) {
  const mismatches =
    results.filter(
      r =>
        !r.match
    );

  if (
    !mismatches.length
  ) {
    return '';
  }

  const lines =
    [
      `*Full math — ${branchConfig.name}*`,
      ''
    ];

  for (
    let i = 0;
    i < mismatches.length;
    i++
  ) {
    const r =
      mismatches[i];

    const ccy =
      r.ccy;

    const emoji =
      CCY_EMOJI[
        ccy
      ] ||
      '•';

    lines.push(
      `${emoji} *${ccy}*`
    );

    lines.push(
      `Opening: ${moneyLabel(ccy, openingTotals[ccy] || 0)}`
    );

    const relevant =
      [];

    for (
      const ticket of
      [...tickets].sort(
        (
          a,
          b
        ) =>
          parseFloat(a.ts) -
          parseFloat(b.ts)
      )
    ) {
      const effect =
        transactionEffectForCurrency(
          ticket.parsed,
          ccy
        );

      if (!effect) {
        continue;
      }

      relevant.push(
        effect
      );

      lines.push(
        `${effect >= 0 ? '+' : '-'} ${rawTicketRef(ticket)}: ${moneyLabel(ccy, Math.abs(effect))}`
      );
    }

    if (
      ccy ===
      'PHP'
    ) {
      for (
        const e of
        [...expenseEntries].sort(
          (
            a,
            b
          ) =>
            parseFloat(a.ts) -
            parseFloat(b.ts)
        )
      ) {
        lines.push(
          `${e.amount >= 0 ? '+' : '-'} ${expenseLabel(e.raw)}: ${moneyLabel('PHP', Math.abs(e.amount))}`
        );
      }

      for (
        const m of
        [...cashMovementEntries].sort(
          (
            a,
            b
          ) =>
            parseFloat(a.ts) -
            parseFloat(b.ts)
        )
      ) {
        lines.push(
          `${m.amount >= 0 ? '+' : '-'} ${movementLabel(m.raw)}: ${moneyLabel('PHP', Math.abs(m.amount))}`
        );
      }
    }

    if (
      !relevant.length &&
      ccy !==
        'PHP'
    ) {
      lines.push(
        'No logged transaction movement for this currency.'
      );
    }

    lines.push(
      '────────────────────'
    );

    lines.push(
      `Expected closing: *${moneyLabel(ccy, r.expected)}*`
    );

    lines.push(
      `Actual closing:   *${moneyLabel(ccy, r.actual)}*`
    );

    lines.push(
      `Difference:       *${r.diff < 0 ? 'SHORT' : 'EXTRA'} ${moneyLabel(ccy, Math.abs(r.diff))}*`
    );

    if (
      i <
      mismatches.length - 1
    ) {
      lines.push('');
    }
  }

  lines.push('');

  lines.push(
    "Please check for any cash-in/cash-out, replenishment, transfer, expense, or transaction that was not posted before closing."
  );

  return lines.join(
    '\n'
  );
}

async function runShiftAudit(
  closingEvent,
  closingCount,
  branchConfig,
  { dryRun = false, openingCountOverride = null } = {}
) {
  const {
    cashCountChannelId,
    transactionsChannelId,
    expensesChannelId
  } = branchConfig;

  try {
    const openingCount =
      openingCountOverride ||
      await findOpeningForClosing(
        cashCountChannelId,
        closingEvent.ts,
        closingCount
      );

    if (
      !openingCount
    ) {
      const msg =
        `⚠️ *Shift Audit — ${branchConfig.name}*\n` +
        `No opening count found for this shift (${windowLabel(closingCount)}).`;

      if (dryRun) {
        return msg;
      }

      if (
        shouldPostFailureNotice(
          branchConfig.name,
          'shift-no-opening'
        )
      ) {
        await postMessage(
          cashCountChannelId,
          msg
        );
      }

      return;
    }

    const openingBoundaryTs =
      countTimestampToSlackTs(
        openingCount.timestamp
      ) ||
      openingCount._ts;

    const closingBoundaryTs =
      countTimestampToSlackTs(
        closingCount.timestamp
      ) ||
      closingEvent.ts;

    const txMessages =
      await history(
        transactionsChannelId,
        {
          oldest:
            openingBoundaryTs,

          latest:
            closingBoundaryTs,

          limit:
            500
        }
      );

    const tickets =
      txMessages
        .filter(
          m =>
            m.text &&
            TICKET_RE.test(
              m.text
            )
        )
        .map(
          m => ({
            parsed:
              parseTransaction(
                m.text
              ),

            raw:
              m.text,

            ts:
              m.ts
          })
        )
        .filter(
          t =>
            t.parsed
        );

    let expenseTotal =
      0;

    const expenseEntries =
      [];

    if (
      expensesChannelId
    ) {
      const expenseMessages =
        await history(
          expensesChannelId,
          {
            oldest:
              openingBoundaryTs,

            latest:
              closingBoundaryTs,

            limit:
              300
          }
        );

      const shiftStartDate =
        (
          openingCount.timestamp ||
          ''
        )
          .split(',')[0]
          .trim();

      const shiftEndDate =
        (
          closingCount.timestamp ||
          ''
        )
          .split(',')[0]
          .trim();

      for (
        const m of
        expenseMessages
      ) {
        const text =
          m.text ||
          '';

        const entryDate =
          statedExpenseDate(
            text
          );

        if (
          entryDate &&
          entryDate !==
            shiftStartDate &&
          entryDate !==
            shiftEndDate
        ) {
          continue;
        }

        const parsed =
          parseExpenseEntry(
            text
          );

        if (!parsed) {
          continue;
        }

        expenseTotal +=
          parsed.amount;

        expenseEntries.push({
          ...parsed,

          raw:
            text,

          ts:
            m.ts
        });
      }
    }

    const generalMessages =
      await history(
        cashCountChannelId,
        {
          oldest:
            openingBoundaryTs,

          latest:
            closingBoundaryTs,

          limit:
            500
        }
      );

    const cashMovementEntries =
      [];

    for (
      const m of
      generalMessages
    ) {
      const parsed =
        parseForexFundMovement(
          m.text || ''
        );

      if (!parsed) {
        continue;
      }

      cashMovementEntries.push({
        ...parsed,

        ts:
          m.ts
      });
    }

    const cashMovementTotal =
      cashMovementEntries.reduce(
        (
          sum,
          movement
        ) =>
          sum +
          movement.amount,

        0
      );

    const correctionResult =
      applyApprovedOpeningCorrections(
        openingCount
      );

    const openingTotals =
      stripUntracked({
        ...correctionResult.effectiveTotals,
        ...openingCount.others
      });

    const closingTotals =
      stripUntracked({
        ...closingCount.totals,
        ...closingCount.others
      });

    const phpAdjustment =
      expenseTotal +
      cashMovementTotal;

    const adjustments =
      buildExpenseAdjustments(
        expenseEntries,
        phpAdjustment
      );

    const results =
      reconcile(
        openingTotals,
        closingTotals,

        tickets.map(
          t =>
            t.parsed
        ),

        adjustments
      );

    for (
      const r of
      results
    ) {
      r.missingFromOpening =
        !(
          r.ccy in
          openingTotals
        );

      r.missingFromClosing =
        !(
          r.ccy in
          closingTotals
        );

      r.openingAmount =
        openingTotals[
          r.ccy
        ] ||
        0;
    }

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
        cycleId,
        dryRun
      );

    const report =
      buildShiftSummary({
        branchConfig,
        openingCount,
        closingCount,
        tickets,
        expenseEntries,
        cashMovementEntries,
        appliedCorrections:
          correctionResult.applied,
        stillOpen,
        resolved,
        dryRun
      });

    const math =
      buildShiftMath({
        branchConfig,
        openingTotals,
        closingTotals,
        results,
        tickets,
        expenseEntries,
        cashMovementEntries
      });

    if (dryRun) {
      return math
        ? `${report}\n\n_[THREAD PREVIEW]_\n${math}`
        : report;
    }

    const posted =
      await postMessage(
        cashCountChannelId,
        report
      );

    if (
      posted &&
      posted.ts &&
      math
    ) {
      await replyInThread(
        cashCountChannelId,
        posted.ts,
        math
      ).catch(
        err =>
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

    if (dryRun) {
      return msg;
    }

    if (
      shouldPostFailureNotice(
        branchConfig.name,
        'shift-error'
      )
    ) {
      await postMessage(
        branchConfig
          .cashCountChannelId,

        msg
      ).catch(
        () => {}
      );
    }
  }
}

function buildHandoverMath({
  branchConfig,
  closingTotals,
  openingTotals,
  results,
  gapTickets
}) {
  const mismatches =
    results.filter(
      r =>
        !r.match
    );

  if (
    !mismatches.length
  ) {
    return '';
  }

  const lines =
    [
      `*Full handover math — ${branchConfig.name}*`,
      ''
    ];

  for (
    let i = 0;
    i < mismatches.length;
    i++
  ) {
    const r =
      mismatches[i];

    const ccy =
      r.ccy;

    lines.push(
      `*${ccy}*`
    );

    lines.push(
      `Previous closing: ${moneyLabel(ccy, closingTotals[ccy] || 0)}`
    );

    for (
      const t of
      gapTickets
    ) {
      const effect =
        transactionEffectForCurrency(
          t,
          ccy
        );

      if (!effect) {
        continue;
      }

      lines.push(
        `${effect >= 0 ? '+' : '-'} Transaction ${t.ref || ''}: ${moneyLabel(ccy, Math.abs(effect))}`
      );
    }

    lines.push(
      '────────────────────'
    );

    lines.push(
      `Expected opening: *${moneyLabel(ccy, r.expected)}*`
    );

    lines.push(
      `Actual opening:   *${moneyLabel(ccy, r.actual)}*`
    );

    lines.push(
      `Difference:       *${r.diff < 0 ? 'SHORT' : 'EXTRA'} ${moneyLabel(ccy, Math.abs(r.diff))}*`
    );

    if (
      i <
      mismatches.length - 1
    ) {
      lines.push('');
    }
  }

  return lines.join(
    '\n'
  );
}

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
      await findPriorScheduledClosing(
        cashCountChannelId,
        openingEvent.ts,
        openingCount
      );

    if (
      !closingCount
    ) {
      const msg =
        `⚠️ *Handover Check — ${branchConfig.name}*\n` +
        `No prior closing count found to compare against.`;

      if (dryRun) {
        return msg;
      }

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

    const closingBoundaryTs =
      countTimestampToSlackTs(
        closingCount.timestamp
      ) ||
      closingCount._ts;

    const openingBoundaryTs =
      countTimestampToSlackTs(
        openingCount.timestamp
      ) ||
      openingEvent.ts;

    const gapMessages =
      await history(
        transactionsChannelId,
        {
          oldest:
            closingBoundaryTs,

          latest:
            openingBoundaryTs,

          limit:
            200
        }
      );

    const gapTickets =
      gapMessages
        .filter(
          m =>
            m.text &&
            TICKET_RE.test(
              m.text
            )
        )
        .map(
          m =>
            parseTransaction(
              m.text
            )
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
        ...Object.keys(
          closingTotals
        ),

        ...Object.keys(
          openingTotals
        )
      ]);

    for (
      const t of
      gapTickets
    ) {
      for (
        const mv of
        t.movements ||
        []
      ) {
        allCcy.add(
          mv.ccy
        );
      }

      if (
        t.phpAmount !=
        null
      ) {
        allCcy.add(
          'PHP'
        );
      }
    }

    const results =
      [];

    for (
      const ccy of
      allCcy
    ) {
      const closeVal =
        closingTotals[
          ccy
        ] ||
        0;

      const openVal =
        openingTotals[
          ccy
        ] ||
        0;

      const gapMovement =
        gapTickets.reduce(
          (
            sum,
            tx
          ) =>
            sum +
            transactionEffectForCurrency(
              tx,
              ccy
            ),

          0
        );

      const expected =
        closeVal +
        gapMovement;

      const diff =
        Math.round(
          (
            openVal -
            expected
          ) *
          100
        ) /
        100;

      const tolerance =
        ccy ===
          'PHP'
          ? 1
          : 0.01;

      results.push({
        ccy,

        expected:
          Math.round(
            expected *
            100
          ) /
          100,

        actual:
          Math.round(
            openVal *
            100
          ) /
          100,

        diff,

        match:
          Math.abs(
            diff
          ) <=
          tolerance,

        missingFromOpening:
          !(
            ccy in
            closingTotals
          ),

        missingFromClosing:
          !(
            ccy in
            openingTotals
          ),

        openingAmount:
          closeVal
      });
    }

    results.sort(
      (
        a,
        b
      ) =>
        a.ccy.localeCompare(
          b.ccy
        )
    );

    const dateLabel =
      (
        openingCount.timestamp ||
        ''
      )
        .split(',')[0]
        .trim();

    const closeTime =
      (
        closingCount.timestamp ||
        ''
      )
        .split(',')[1]
        ?.trim() ||
      '?';

    const openTime =
      (
        openingCount.timestamp ||
        ''
      )
        .split(',')[1]
        ?.trim() ||
      '?';

    const cycleId =
      `${branchConfig.name}|handover|${closingCount.timestamp}|${openingCount.timestamp}`;

    const {
      stillOpen,
      resolved
    } =
      annotateFlags(
        HANDOVER_FLAGS,
        branchConfig.name,
        results,
        dateLabel,
        cycleId,
        dryRun
      );

    const lines =
      [];

    if (dryRun) {
      lines.push(
        '_[DRY RUN — not posted to Slack]_'
      );
    }

    lines.push(
      `🔄 ${branchConfig.name} — ${dateLabel}, Close ${closeTime} → Open ${openTime}`
    );

    lines.push(
      `${firstName(closingCount.teller)} → ${firstName(openingCount.teller)}`
    );

    lines.push('');

    const oldShiftFlags =
      getOpenShiftFlags(
        branchConfig.name
      );

    if (
      !stillOpen.length
    ) {
      lines.push(
        "✅ Overnight is fine — nothing moved that shouldn't have."
      );

    } else {
      lines.push(
        `⚠️ *${stillOpen.length} handover discrepanc${stillOpen.length > 1 ? 'ies' : 'y'}:*`
      );

      for (
        const r of
        stillOpen
      ) {
        lines.push(
          `❗ ${r.ccy}: ${r.diff < 0 ? 'short' : 'extra'} ${moneyLabel(r.ccy, Math.abs(r.diff))}`
        );
      }
    }

    for (
      const r of
      resolved
    ) {
      lines.push(
        `✅ ${r.ccy} handover now reconciles.`
      );
    }

    if (
      oldShiftFlags.length
    ) {
      lines.push('');

      lines.push(
        `⚠️ There ${oldShiftFlags.length > 1 ? 'are' : 'is'} still ${oldShiftFlags.length} unresolved shift-audit question${oldShiftFlags.length > 1 ? 's' : ''} from earlier.`
      );
    }

    if (
      stillOpen.length ||
      oldShiftFlags.length
    ) {
      lines.push('');

      lines.push(
        `@${firstName(openingCount.teller)} — please check before trading. 🙏`
      );
    }

    const report =
      lines.join(
        '\n'
      );

    const math =
      buildHandoverMath({
        branchConfig,
        closingTotals,
        openingTotals,
        results,
        gapTickets
      });

    if (dryRun) {
      return math
        ? `${report}\n\n_[THREAD PREVIEW]_\n${math}`
        : report;
    }

    const posted =
      await postMessage(
        cashCountChannelId,
        report
      );

    if (
      posted &&
      posted.ts &&
      math
    ) {
      await replyInThread(
        cashCountChannelId,
        posted.ts,
        math
      ).catch(
        err =>
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

    if (dryRun) {
      return msg;
    }

    if (
      shouldPostFailureNotice(
        branchConfig.name,
        'handover-error'
      )
    ) {
      await postMessage(
        branchConfig
          .cashCountChannelId,

        msg
      ).catch(
        () => {}
      );
    }
  }
}

module.exports = {
  runShiftAudit,
  runCloseVsOpenCheck,
  buildExpenseAdjustments,
  isScheduledOpening,
  isScheduledClosing
};
