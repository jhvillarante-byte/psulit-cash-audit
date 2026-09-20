/**
 * audit.js
 *
 * Two automatic checks:
 * 1) SHIFT AUDIT at the scheduled closing count.
 * 2) HANDOVER CHECK at the next scheduled opening count.
 *
 * Audit windows use the Slack message timestamps of the locked opening and
 * closing reports. Embedded report timestamps remain display/schedule data;
 * they can reflect when counting started rather than final submission.
 */

const { APPROVED_CORRECTIONS, applyApprovedOpeningCorrections, applyApprovedTransactionCorrections } = require('./corrections');
const { reconcile, transactionPhpEffect } = require('./reconcile');
const { readScratchTransactions, reconcileScratch, scratchSummary } = require('./scratch-audit');
const { correctionFromResolution, reportBlocks } = require('./discrepancy-resolutions');

const {
  history,
  postMessage,
  replyInThread,
  threadReplies
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

function manilaBusinessDateFromSlackTs(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(Number(ts) * 1000));
}

function selectOpeningCashCountForPreview(countMessages, branchName, asOfTs) {
  const businessDate = manilaBusinessDateFromSlackTs(asOfTs);
  return countMessages
    .map(message => ({ message, parsed: parseCashCount(message.text || '') }))
    .filter(item => item.parsed
      && item.parsed.branch === branchName
      && item.parsed.refCode
      && String(item.parsed.phase || '').toLowerCase() === 'opening'
      && manilaBusinessDateFromSlackTs(item.message.ts) === businessDate
      && Number(item.message.ts) <= Number(asOfTs))
    .sort((a, b) => Number(b.message.ts) - Number(a.message.ts))[0] || null;
}

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
  CNY: '¥',
  IDR: 'Rp'
};

const CCY_FLAG = {
  PHP: '🇵🇭',
  USD: '🇺🇸',
  JPY: '🇯🇵',
  HKD: '🇭🇰',
  CAD: '🇨🇦',
  GBP: '🇬🇧',
  EUR: '🇪🇺',
  CHF: '🇨🇭',
  SGD: '🇸🇬',
  AUD: '🇦🇺',
  BHD: '🇧🇭',
  NZD: '🇳🇿',
  MYR: '🇲🇾',
  SAR: '🇸🇦',
  THB: '🇹🇭',
  TWD: '🇹🇼',
  AED: '🇦🇪',
  CNY: '🇨🇳',
  IDR: '🇮🇩',
  BND: '🇧🇳',
  KRW: '🇰🇷',
  QAR: '🇶🇦',
  KWD: '🇰🇼',
  JOD: '🇯🇴',
  VND: '🇻🇳'
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

function currencyHeading(ccy) {
  return CCY_FLAG[ccy]
    ? `${CCY_FLAG[ccy]} ${ccy}`
    : ccy;
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

function slackAuditWindow(openingSlackTs, closingSlackTs) {
  const opening = Number(openingSlackTs);
  const closing = Number(closingSlackTs);
  if (!Number.isFinite(opening) || !Number.isFinite(closing) || opening >= closing) {
    throw new Error('Valid ordered opening and closing Slack timestamps are required.');
  }
  return { oldest: String(openingSlackTs), latest: String(closingSlackTs) };
}

function isSlackTsWithinAuditWindow(messageTs, window) {
  const message = Number(messageTs);
  return Number.isFinite(message) && message > Number(window.oldest) && message <= Number(window.latest);
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

async function resolutionOverlaysForCounts(channelId, counts) {
  const wanted = new Map(counts.filter(Boolean).map(count => [count.refCode, count]));
  if (!wanted.size) return [];
  const overlays = new Map();
  let latest;
  for (let page = 0; page < MAX_PAGES; page++) {
    const messages = await history(channelId, { latest, limit: PAGE_SIZE });
    if (!messages.length) break;
    for (const parent of messages) {
      if (!parent.reply_count && !/SHIFT AUDIT|HANDOVER CHECK/i.test(parent.text || '')) continue;
      const replies = await threadReplies(channelId, parent.ts);
      for (const reply of replies) {
        for (const count of wanted.values()) {
          const correction = correctionFromResolution(reply, count, {
            channel: channelId,
            parentTs: parent.ts,
            parentText: parent.text || ''
          });
          if (!correction) continue;
          const key = `${correction.cashCountRef}|${correction.currency}`;
          const existing = overlays.get(key);
          if (existing && (existing.correctedValue !== correction.correctedValue || existing.id !== correction.id)) {
            throw new Error(`Conflicting formal resolution overlays for ${key}`);
          }
          overlays.set(key, correction);
        }
      }
    }
    if (messages.length < PAGE_SIZE) break;
    latest = (parseFloat(messages[messages.length - 1].ts) - 0.000001).toFixed(6);
  }
  return [...overlays.values()];
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

      const ts = msg.ts;

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

        boundaryTs: msg.ts
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
    if (entry.structuredLegs) {
      for (const leg of entry.structuredLegs) {
        adjustments[leg.ccy] = (adjustments[leg.ccy] || 0) + leg.amount;
      }
      continue;
    }
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

function expenseForexPhpEffect(entry) {
  if (!entry) return 0;
  if (entry.isReceivable) return entry.amount;
  if (!entry.fundingSource) return entry.amount;
  return /^forex(?:\s+drawer)?$/i.test(entry.fundingSource)
    ? entry.amount
    : 0;
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

function structuredMovementEffect(entry) {
  if (!entry || entry.status && entry.status !== 'Posted') return [];
  const legs = [];
  const add = (ccy, amount, fund, assetType) => {
    if (fund !== 'Forex Drawer' || assetType !== 'Physical Cash') return;
    const value = Number(amount);
    if (ccy && Number.isFinite(value) && value !== 0) legs.push({ ccy: String(ccy).toUpperCase(), amount: value });
  };
  const source = () => add(entry.actualCurrency, -Number(entry.actualAmount), entry.fundDrawerUsed, entry.assetType);
  const destination = () => add(entry.receivedCurrency || entry.actualCurrency, entry.receivedAmount ?? entry.actualAmount, entry.destinationFund || entry.fundDrawerUsed, entry.receivedAssetType || entry.assetType);
  switch (entry.category) {
    case 'Receivable Settlement':
      if (entry.settlementMethod === 'Cash Received') destination();
      break;
    case 'Internal Transfer':
    case 'Currency Exchange':
      source();
      destination();
      break;
    case 'Inter-Branch Transfer IN':
      destination();
      break;
    case 'Inter-Branch Transfer OUT':
      source();
      break;
    default:
      source();
      break;
  }
  return legs;
}

function structuredHiveMovementEffects(movement) {
  if (!movement || movement.status && movement.status !== 'Posted') return [];
  const category = String(movement.category || '').trim();
  const amount = Number(movement.actualAmount);
  if (!Number.isFinite(amount) || amount <= 0) return [];
  const actualCurrency = String(movement.actualCurrency || '').toUpperCase();
  if (actualCurrency !== 'PHP') return [];
  const effects = [];
  const add = (signedAmount, direction) => {
    if (Number.isFinite(signedAmount) && signedAmount !== 0) effects.push({ amount: signedAmount, direction });
  };

  if (category === 'Hive In') {
    if (movement.fundDrawerUsed === 'Hive' && movement.assetType === 'Physical Cash') add(amount, 'IN');
  } else if (category === 'Hive Out') {
    if (movement.fundDrawerUsed === 'Hive' && movement.assetType === 'Physical Cash') add(-amount, 'OUT');
  } else if (category === 'Internal Transfer' || category === 'Internal Fund Transfer' || category === 'Currency Exchange') {
    if (movement.fundDrawerUsed === 'Hive' && movement.assetType === 'Physical Cash') add(-amount, 'OUT');
    if (movement.destinationFund === 'Hive' && (movement.receivedAssetType || movement.assetType) === 'Physical Cash') {
      add(Number(movement.receivedAmount ?? amount), 'IN');
    }
  }
  return effects;
}

function buildStructuredHiveMovements(movements, oldestTs = -Infinity, latestTs = Infinity) {
  const seenIds = new Set();
  const seenReferences = new Set();
  const out = [];
  for (const movement of Array.isArray(movements) ? movements : []) {
    const id = String(movement.expenseId || movement.referenceId || '');
    const reference = String(movement.hiveTransactionReference || movement.hive_transaction_reference || movement.transferReference || id).trim().toUpperCase();
    if (!id || seenIds.has(id) || seenReferences.has(reference)) continue;
    const ts = structuredMovementTimestamp(movement);
    if (!ts || ts <= Number(oldestTs) || ts > Number(latestTs)) continue;
    const effects = structuredHiveMovementEffects(movement);
    if (!effects.length) continue;
    seenIds.add(id); seenReferences.add(reference);
    for (const effect of effects) {
      out.push({
        expenseId: id,
        reference: /^Internal (?:Fund )?Transfer$/i.test(String(movement.category || '')) ? id : reference,
        category: movement.category,
        ts,
        amount: effect.amount,
        direction: effect.direction,
        sourceFund: movement.fundDrawerUsed || null,
        destinationFund: movement.destinationFund || null
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts || a.expenseId.localeCompare(b.expenseId));
}

function parseLegacyHiveInternalTransfer(text, ts) {
  if (!/INTERNAL\s+FUND\s+TRANSFER/i.test(String(text || ''))) return null;
  const recordId = String(text).match(/(?:^|\n)\s*\*?Record ID\s*:\s*\*?([^\n*]+)/i)?.[1]?.trim();
  const amountMatch = String(text).match(/(?:^|\n)\s*\*?Amount Given\s*:\s*₱?\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})/i);
  const from = String(text).match(/(?:^|\n)\s*From\s*:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const to = String(text).match(/(?:^|\n)\s*To\s*:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const transferReference = String(text).match(/(?:^|\n)\s*Transfer Reference\s*:\s*([^\n]+)/i)?.[1]?.trim() || '';
  if (!recordId || !amountMatch || !transferReference) return null;
  if (String(amountMatch[2]).toUpperCase() !== 'PHP') return null;
  const amount = Number(amountMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const fromHive = /\bhive\b/i.test(from);
  const toHive = /\bhive\b/i.test(to);
  if (fromHive === toHive) return null;
  return {
    expenseId: recordId,
    reference: recordId,
    transferReference: transferReference.trim().toUpperCase(),
    category: 'Internal Transfer',
    ts: Number(ts) || 0,
    amount: toHive ? amount : -amount,
    direction: toHive ? 'IN' : 'OUT',
    legacy: true,
    sourceFund: from,
    destinationFund: to
  };
}

function buildLegacyHiveMovements(messages, structuredMovements = [], oldestTs = -Infinity, latestTs = Infinity) {
  const structuredKeys = new Set();
  for (const movement of structuredMovements || []) {
    if (movement.expenseId) structuredKeys.add(String(movement.expenseId).trim().toUpperCase());
    if (movement.reference) structuredKeys.add(String(movement.reference).trim().toUpperCase());
    if (movement.transferReference) structuredKeys.add(String(movement.transferReference).trim().toUpperCase());
  }
  const seen = new Set();
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const ts = Number(message?.ts) || 0;
    if (!ts || ts <= Number(oldestTs) || ts > Number(latestTs)) continue;
    const movement = parseLegacyHiveInternalTransfer(message?.text || '', ts);
    if (!movement) continue;
    const keys = [movement.expenseId, movement.reference].map(value => String(value).trim().toUpperCase());
    if (keys.some(key => structuredKeys.has(key) || seen.has(key))) continue;
    keys.forEach(key => seen.add(key));
    out.push(movement);
  }
  return out.sort((a, b) => a.ts - b.ts || a.expenseId.localeCompare(b.expenseId));
}

function reconcileHiveCash({ previous, actual, movements, feedAvailable }) {
  if (!feedAvailable) return { status: 'UNAVAILABLE', previous: Number(previous) || 0, actual: Number(actual) || 0, movements: [], expected: null, difference: null };
  if (previous == null || actual == null) return { status: 'UNAVAILABLE', previous: Number(previous) || 0, actual: Number(actual) || 0, movements: movements || [], expected: null, difference: null };
  const opening = Number(previous) || 0;
  const ending = Number(actual) || 0;
  const net = (movements || []).reduce((sum, movement) => sum + movement.amount, 0);
  const expected = opening + net;
  return { status: Math.abs(ending - expected) < 0.005 ? 'MATCH' : 'DISCREPANCY', previous: opening, actual: ending, movements: movements || [], expected, difference: ending - expected };
}

function structuredMovementTimestamp(entry) {
  const value = entry?.timestamp || entry?.postedAt || entry?.createdAt || entry?.occurredAt ||
    entry?.submittedAtUtc || entry?.submittedAt || entry?.submitted_at_utc;
  if (value == null) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric / 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function structuredExpenseLabel(entry) {
  const id = entry?.expenseId || entry?.referenceId || 'Expense movement';
  const category = entry?.category || entry?.type || 'Expense';
  return `${category} ${id}`;
}

function buildStructuredExpenseEntries(movements, oldestTs = -Infinity, latestTs = Infinity) {
  const seen = new Set();
  const entries = [];
  for (const movement of Array.isArray(movements) ? movements : []) {
    const id = movement?.expenseId || movement?.referenceId;
    if (!id || seen.has(String(id))) continue;
    seen.add(String(id));
    const timestamp = structuredMovementTimestamp(movement);
    if (!timestamp || timestamp <= Number(oldestTs) || timestamp > Number(latestTs)) continue;
    const legs = structuredMovementEffect(movement);
    if (!legs.length) continue;
    const phpAmount = legs.filter(leg => leg.ccy === 'PHP').reduce((sum, leg) => sum + leg.amount, 0);
    entries.push({
      structured: true,
      expenseId: String(id),
      raw: structuredExpenseLabel(movement),
      ts: timestamp,
      structuredLegs: legs,
      reconciliationAmount: phpAmount,
      amount: phpAmount,
      needsReview: false
    });
  }
  return entries;
}

function buildStructuredExpenseAdjustments(entries) {
  const adjustments = {};
  for (const entry of entries || []) {
    for (const leg of entry.structuredLegs || []) {
      adjustments[leg.ccy] = (adjustments[leg.ccy] || 0) + leg.amount;
    }
  }
  return adjustments;
}

async function fetchStructuredMovementFeed(branchConfig, oldestTs, asOfTs) {
  if (!branchConfig?.expenseMovementsUrl || !branchConfig?.expenseMovementsSecret) return null;
  const url = new URL(branchConfig.expenseMovementsUrl);
  url.searchParams.set('branch', branchConfig.name);
  url.searchParams.set('afterUtc', new Date(Number(oldestTs) * 1000).toISOString());
  url.searchParams.set('beforeUtc', new Date(Number(asOfTs) * 1000).toISOString());
  const response = await fetch(url, { headers: { 'x-expense-movements-secret': branchConfig.expenseMovementsSecret } });
  if (!response.ok) throw new Error(`Expense movement feed returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload || payload.authoritative !== true || !Array.isArray(payload.movements)) throw new Error('Expense movement feed returned an invalid payload.');
  return payload.movements;
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
  appliedTransactionCorrections,
  results,
  stillOpen,
  resolved,
  dryRun,
  hiveAudit
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
      '✏️ Approved opening correction'
    );
    lines.push(
      `${currencyHeading(correction.currency)}: ` +
      `${moneyLabel(correction.currency, correction.originalValue)} → ` +
      `${moneyLabel(correction.currency, correction.correctedValue)}`
    );
    if (correction.resolutionOverlay) {
      lines.push(`Opening record: ${moneyLabel(correction.currency, correction.originalValue)}`);
      lines.push(`Resolved correction: ${moneyLabel(correction.currency, correction.correctedValue)}`);
      lines.push(`Effective opening used: ${moneyLabel(correction.currency, correction.correctedValue)}`);
    }
    lines.push(
      `*Opening ref ${correction.openingRef} · Approved by ${correction.approval.approver} · ` +
      `Slack evidence ${correction.approval.sourceMessageTs}*`
    );

    const correctedResult = (results || []).find(
      result => result.ccy === correction.currency
    );
    if (correctedResult && correctedResult.match) {
      const movementTerms = tickets
        .map(ticket => transactionEffectForCurrency(ticket.parsed, correction.currency))
        .filter(effect => effect !== 0)
        .sort((left, right) => Number(right > 0) - Number(left > 0))
        .map(effect =>
          `${effect > 0 ? '+' : '−'} ${moneyLabel(correction.currency, Math.abs(effect))}`
        );
      lines.push(
        `✅ ${currencyHeading(correction.currency)} reconciled: ` +
        `${moneyLabel(correction.currency, correction.correctedValue)}` +
        `${movementTerms.length ? ` ${movementTerms.join(' ')}` : ''} = ` +
        `${moneyLabel(correction.currency, correctedResult.actual)}.`
      );
    }
  }

  if ((appliedCorrections || []).length) lines.push('');

  for (const correction of appliedTransactionCorrections || []) {
    lines.push('✏️ Approved transaction correction');
    lines.push(
      `${currencyHeading(correction.currency)} · AR ${String(correction.transactionRef).padStart(7, '0')}: ` +
      `${correction.originalDirection} ${correction.amount.toLocaleString('en-US')} → ` +
      `${correction.correctedDirection} ${correction.amount.toLocaleString('en-US')}`
    );
    lines.push(
      `*Original receipt preserved · Approved by ${correction.approval.approver} · ` +
      `Slack evidence ${correction.approval.sourceMessageTs}*`
    );
    const correctedResult = (results || []).find(result => result.ccy === correction.currency);
    if (correctedResult && correctedResult.match) {
      const openingAmount = correctedResult.openingAmount || 0;
      const movementTerms = tickets
        .map(ticket => transactionEffectForCurrency(ticket.parsed, correction.currency))
        .filter(effect => effect !== 0)
        .map(effect => `${effect > 0 ? '+' : '−'} ${moneyLabel(correction.currency, Math.abs(effect))}`);
      lines.push(
        `✅ ${currencyHeading(correction.currency)} reconciled: ` +
        `${moneyLabel(correction.currency, openingAmount)} ` +
        `${movementTerms.join(' ')} = ${moneyLabel(correction.currency, correctedResult.actual)}.`
      );
    }
  }

  if ((appliedTransactionCorrections || []).length) lines.push('');

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
          (e.reconciliationAmount ?? e.amount),

        0
      );

    lines.push(
      `💼 ${expenseEntries.length} expense/replenishment entr${expenseEntries.length > 1 ? 'ies' : 'y'} included (net ${total >= 0 ? '+' : '-'}${moneyLabel('PHP', Math.abs(total))}).`
    );

    for (const entry of expenseEntries) {
      if (entry.structuredLegs) {
        const effects = entry.structuredLegs
          .map(leg => `${leg.amount >= 0 ? '+' : '−'}${moneyLabel(leg.ccy, Math.abs(leg.amount))}`)
          .join(', ');
        lines.push(`💼 ${entry.raw}: ${effects}`);
        continue;
      }
      if (entry.isOwnerCollection && entry.cashMovement) {
        lines.push(
          `💼 ${expenseLabel(entry.raw)}: ${moneyLabel(entry.cashMovement.ccy, Math.abs(entry.cashMovement.amount))} ` +
          `Owner Collection cash out from ${entry.cashMovement.source || 'unconfirmed source'}; ` +
          `${entry.cashMovement.ccy === 'PHP' ? 'PHP cash movement recorded.' : 'no Forex PHP impact.'}`
        );
        continue;
      }
      if (!entry.isReceivable && entry.fundingSource &&
          (entry.reconciliationAmount ?? entry.amount) === 0) {
        const id = String(entry.raw || '').match(/Expense ID:\s*([^\n\r]+)/i)?.[1]?.trim() || 'Expense';
        lines.push(
          `ℹ️ ${id}: ${moneyLabel('PHP', Math.abs(entry.amount))} cash out from ` +
          `${entry.fundingSource}; no Forex PHP impact.`
        );
      }
    }

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

  if (hiveAudit) {
    lines.push('');
    if (hiveAudit.status === 'UNAVAILABLE') {
      lines.push('⚠️ Hive audit unavailable — structured movement feed unavailable.');
    } else {
      lines.push(`${hiveAudit.status === 'MATCH' ? '✅' : '❌'} Hive ${hiveAudit.status === 'MATCH' ? 'reconciled' : 'discrepancy'}: Expected ${moneyLabel('PHP', hiveAudit.expected)} | Actual ${moneyLabel('PHP', hiveAudit.actual)} | Difference ${moneyLabel('PHP', hiveAudit.difference)}`);
    }
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

    lines.push(hiveAudit?.status === 'MATCH'
      ? 'ℹ️ JuanPay, Opex, and other funds are not yet fully reconciled. Scratch cash is reported separately.'
      : 'ℹ️ JuanPay, Hive, Opex, and other funds are not yet fully reconciled. Scratch cash is reported separately.');

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
          `❗ ${currencyHeading(r.ccy)}: not in opening count; ${moneyLabel(r.ccy, r.actual)} at closing`
        );

      } else if (
        r.missingFromClosing &&
        !r.missingFromOpening
      ) {
        lines.push(
          `❗ ${currencyHeading(r.ccy)}: expected ${moneyLabel(r.ccy, r.expected)}, but missing from closing count`
        );

      } else {
        lines.push(
          `❗ ${currencyHeading(r.ccy)}: ${r.diff < 0 ? 'short' : 'extra'} ${moneyLabel(r.ccy, Math.abs(r.diff))}`
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
      `✅ ${currencyHeading(r.ccy)} resolved — corrected closing cash count now reconciles.`
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
  cashMovementEntries,
  appliedCorrections = [],
  hiveAudit
}) {
  const correctedCurrencies = new Set(appliedCorrections.map(correction => correction.currency));
  let mathResults = results.filter(result => !result.match || correctedCurrencies.has(result.ccy));

  const hiveNeedsMath = hiveAudit && hiveAudit.status !== 'MATCH';

  // Full Math is an exception detail, not a duplicate of a clean summary.
  if (!mathResults.length && !hiveNeedsMath) {
    return '';
  }

  const lines =
    [
      `*Full math — ${branchConfig.name}*`,
      ''
    ];

  for (
    let i = 0;
    i < mathResults.length;
    i++
  ) {
    const r =
      mathResults[i];

    const ccy =
      r.ccy;

    lines.push(
      `*${currencyHeading(ccy)}*`
    );

    lines.push(
      `Opening: ${moneyLabel(ccy, openingTotals[ccy] || 0)}`
    );

    const appliedCorrection = appliedCorrections.find(correction => correction.currency === ccy);
    if (appliedCorrection) {
      const compact = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
      lines.push(
        `Resolved Opening Correction: ${ccy} ${compact(appliedCorrection.originalValue)} → ` +
        `${ccy} ${compact(appliedCorrection.correctedValue)}`
      );
    }

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

    if (ccy !== 'PHP') {
      for (const entry of [...expenseEntries].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))) {
        if (entry.structuredLegs) {
          for (const leg of entry.structuredLegs.filter(item => item.ccy === ccy)) {
            relevant.push(leg.amount);
            lines.push(
              `${leg.amount >= 0 ? '+' : '-'} ${entry.raw}: ${moneyLabel(ccy, Math.abs(leg.amount))}`
            );
          }
          continue;
        }
        if (!entry.cashMovement || entry.cashMovement.ccy !== ccy ||
            entry.cashMovement.source !== 'Forex drawer') continue;
        const effect = entry.cashMovement.amount;
        relevant.push(effect);
        lines.push(
          `${effect >= 0 ? '+' : '-'} ${expenseLabel(entry.raw)}: ${moneyLabel(ccy, Math.abs(effect))}`
        );
      }
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
        if (e.structuredLegs) {
          for (const leg of e.structuredLegs.filter(item => item.ccy === 'PHP')) {
            lines.push(
              `${leg.amount >= 0 ? '+' : '-'} ${e.raw}: ${moneyLabel('PHP', Math.abs(leg.amount))}`
            );
          }
          continue;
        }
        const effect = e.reconciliationAmount ?? e.amount;
        if (!effect) continue;
        lines.push(
          `${effect >= 0 ? '+' : '-'} ${expenseLabel(e.raw)}: ${moneyLabel('PHP', Math.abs(effect))}`
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
      r.match
        ? `Difference:       *${moneyLabel(ccy, 0)}*`
        : `Difference:       *${r.diff < 0 ? 'SHORT' : 'EXTRA'} ${moneyLabel(ccy, Math.abs(r.diff))}*`
    );

    if (
      i <
      mathResults.length - 1
    ) {
      lines.push('');
    }
  }

  lines.push('');

  if (hiveNeedsMath) {
    lines.push('*🐝 Hive*');
    if (hiveAudit.status === 'UNAVAILABLE') {
      lines.push('⚠️ Structured Hive movement feed unavailable.');
    } else {
      lines.push(`Opening: ${moneyLabel('PHP', hiveAudit.previous)}`);
      for (const movement of hiveAudit.movements || []) {
        const label = `${movement.reference}${movement.legacy ? ' (legacy)' : ''}`;
        const route = movement.sourceFund && movement.destinationFund ? ` — ${movement.sourceFund} → ${movement.destinationFund}` : '';
        const sign = movement.amount >= 0 ? '+' : '-';
        lines.push(`${label}${route}: ${sign}${moneyLabel('PHP', Math.abs(movement.amount))}`);
      }
      lines.push(`Expected: ${moneyLabel('PHP', hiveAudit.expected)}`);
      lines.push(`Actual: ${moneyLabel('PHP', hiveAudit.actual)}`);
      lines.push(`Difference: ${moneyLabel('PHP', hiveAudit.difference)} — ${hiveAudit.status}`);
    }
    lines.push('');
  }

  lines.push(
    results.some(result => !result.match)
      ? "Please check for any cash-in/cash-out, replenishment, transfer, expense, or transaction that was not posted before closing."
      : 'Formal resolution overlay applied; original locked cash count remains unchanged.'
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

    const auditWindow = slackAuditWindow(openingCount._ts, closingEvent.ts);
    const openingBoundaryTs = auditWindow.oldest;
    const closingBoundaryTs = auditWindow.latest;

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
        .map(m => {
          const originalParsed = parseTransaction(m.text);
          const correctionResult = applyApprovedTransactionCorrections(originalParsed);
          return {
            parsed: correctionResult.effectiveTransaction,
            originalParsed,
            appliedTransactionCorrections: correctionResult.applied,
            raw: m.text,
            ts: m.ts
          };
        })
        .filter(
          t =>
            t.parsed
        );

    let expenseTotal =
      0;

    const expenseEntries =
      [];

    let structuredExpenseFeedUsed = false;
    let structuredMovementsForHive = null;
    let legacyHiveMovements = [];
    if (branchConfig.expenseMovementsUrl && branchConfig.expenseMovementsSecret) {
      try {
        const structuredMovements = await fetchStructuredMovementFeed(
          branchConfig,
          openingBoundaryTs,
          closingBoundaryTs
        );
        structuredMovementsForHive = structuredMovements;
        if (expensesChannelId) {
          const legacyHiveMessages = await history(expensesChannelId, {
            oldest: openingBoundaryTs,
            latest: closingBoundaryTs,
            limit: 300
          });
          legacyHiveMovements = buildLegacyHiveMovements(
            legacyHiveMessages,
            structuredMovements,
            openingBoundaryTs,
            closingBoundaryTs
          );
        }
        const structuredEntries = buildStructuredExpenseEntries(
          structuredMovements,
          openingBoundaryTs,
          closingBoundaryTs
        );
        expenseEntries.push(...structuredEntries);
        expenseTotal = structuredEntries.reduce(
          (sum, entry) => sum + (entry.reconciliationAmount || 0),
          0
        );
        structuredExpenseFeedUsed = true;
        console.info('Structured Expense App movement feed succeeded for shift audit', {
          branch: branchConfig.name,
          movementCount: structuredMovements.length,
          afterUtc: new Date(Number(openingBoundaryTs) * 1000).toISOString(),
          beforeUtc: new Date(Number(closingBoundaryTs) * 1000).toISOString()
        });
      } catch (error) {
        console.warn('Structured Expense App movement feed unavailable for shift audit; using legacy Slack expense fallback.', {
          message: error?.message || String(error)
        });
      }
    }

    if (
      expensesChannelId &&
      !structuredExpenseFeedUsed
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

        const reconciliationAmount = expenseForexPhpEffect(parsed);

        expenseTotal +=
          reconciliationAmount;

        expenseEntries.push({
          ...parsed,

          reconciliationAmount,

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

    const resolutionCorrections = await resolutionOverlaysForCounts(
      cashCountChannelId, [openingCount, closingCount]
    );
    const allCorrections = [...APPROVED_CORRECTIONS, ...resolutionCorrections];
    const correctionResult =
      applyApprovedOpeningCorrections(
        openingCount,
        allCorrections
      );
    const closingCorrectionResult = applyApprovedOpeningCorrections(closingCount, allCorrections);

    const appliedTransactionCorrections = tickets.flatMap(
      ticket => ticket.appliedTransactionCorrections || []
    );

    const openingTotals =
      stripUntracked({
        ...correctionResult.effectiveTotals,
        ...openingCount.others
      });

    const closingTotals =
      stripUntracked({
        ...closingCorrectionResult.effectiveTotals,
        ...closingCount.others
      });

    const phpAdjustment =
      expenseTotal +
      cashMovementTotal;

    const adjustments =
      buildExpenseAdjustments(
        expenseEntries,
        structuredExpenseFeedUsed ? cashMovementTotal : phpAdjustment
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

    const hiveClosingCorrection = resolutionCorrections.find(
      correction => correction.currency === 'Hive' && correction.cashCountRef === closingCount?.refCode
    );
    const structuredHiveMovements = buildStructuredHiveMovements(
      structuredMovementsForHive || [],
      openingBoundaryTs,
      closingBoundaryTs
    );
    const hiveAudit = reconcileHiveCash({
      previous: openingCount?.others?.Hive,
      actual: hiveClosingCorrection ? hiveClosingCorrection.correctedValue : closingCount?.others?.Hive,
      movements: [...structuredHiveMovements, ...legacyHiveMovements].sort((a, b) => a.ts - b.ts || a.expenseId.localeCompare(b.expenseId)),
      feedAvailable: structuredExpenseFeedUsed
    });

    let scratchAudit;
    try {
      const scratchMovements = [];
      if (!structuredExpenseFeedUsed) throw new Error('Cash movement feed unavailable');
      for (const movement of structuredMovementsForHive || []) {
        const ts = structuredMovementTimestamp(movement);
        if (ts <= openingBoundaryTs || ts > closingBoundaryTs) continue;
        const mapped = { ...movement,
          fundDrawerUsed: movement.fundDrawerUsed === 'Scratch' ? 'Forex Drawer' : '__other__',
          destinationFund: (movement.destinationFund || movement.fundDrawerUsed) === 'Scratch' ? 'Forex Drawer' : '__other__'
        };
        const legs = structuredMovementEffect(mapped);
        if (legs.some(leg => leg.ccy !== 'PHP')) throw new Error('Non-PHP Scratch movement requires review');
        if (legs.length) scratchMovements.push({ reference: movement.expenseId || movement.referenceId, amount: legs.reduce((sum, leg) => sum + leg.amount, 0) });
      }
      const transactions = await readScratchTransactions(branchConfig.name, openingBoundaryTs, closingBoundaryTs);
      const closingCorrection = resolutionCorrections.find(c => c.currency === 'Scratch' && c.cashCountRef === closingCount.refCode);
      const openingCorrection = resolutionCorrections.find(c => c.currency === 'Scratch' && c.cashCountRef === openingCount.refCode);
      scratchAudit = reconcileScratch({
        opening: openingCorrection ? openingCorrection.correctedValue : openingCount?.others?.Scratch,
        closing: closingCorrection ? closingCorrection.correctedValue : closingCount?.others?.Scratch,
        transactions, movements: scratchMovements, branch: branchConfig.name,
        oldest: openingBoundaryTs, latest: closingBoundaryTs
      });
    } catch (_) { scratchAudit = { status: 'UNAVAILABLE', reason: 'Scratch ledger or cash movement feed unavailable; configuration and records require review' }; }

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

    let report =
      buildShiftSummary({
        branchConfig,
        openingCount,
        closingCount,
        tickets,
        expenseEntries,
        cashMovementEntries,
        appliedCorrections:
          correctionResult.applied,
        appliedTransactionCorrections,
        results,
        stillOpen,
        resolved,
        dryRun,
        hiveAudit
      });

    report += `\n\n${scratchSummary(scratchAudit)}`;

    const math =
      buildShiftMath({
        branchConfig,
        openingTotals,
        closingTotals,
        results,
        tickets,
        expenseEntries,
        cashMovementEntries,
        appliedCorrections: correctionResult.applied,
        hiveAudit
      });

    if (dryRun) {
      return math
        ? `${report}\n\n_[THREAD PREVIEW]_\n${math}`
        : report;
    }

    const resolutionDiscrepancies = stillOpen.map(item => ({
      channel: cashCountChannelId,
      branch: branchConfig.name,
      openingRef: openingCount.refCode,
      closingRef: closingCount.refCode,
      currency: item.ccy,
      amount: Math.abs(item.diff),
      direction: item.diff < 0 ? 'SHORT' : 'EXTRA'
    }));
    if (hiveAudit && hiveAudit.status !== 'MATCH' && hiveAudit.status !== 'UNAVAILABLE') {
      resolutionDiscrepancies.push({
        channel: cashCountChannelId,
        branch: branchConfig.name,
        openingRef: openingCount.refCode,
        closingRef: closingCount.refCode,
        currency: 'Hive',
        amount: Math.abs(hiveAudit.difference),
        direction: hiveAudit.difference < 0 ? 'SHORT' : 'EXTRA'
      });
    }

    if (scratchAudit.status === 'DISCREPANCY') resolutionDiscrepancies.push({
      channel: cashCountChannelId, branch: branchConfig.name,
      openingRef: openingCount.refCode, closingRef: closingCount.refCode,
      currency: 'Scratch', amount: Math.abs(scratchAudit.difference),
      direction: scratchAudit.difference < 0 ? 'SHORT' : 'EXTRA'
    });

    const posted =
      await postMessage(
        cashCountChannelId,
        report,
        {
          blocks: reportBlocks(report, resolutionDiscrepancies)
        }
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

    return posted;

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
      `*${currencyHeading(ccy)}*`
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

    const handoverWindow = slackAuditWindow(closingCount._ts, openingEvent.ts);
    const closingBoundaryTs = handoverWindow.oldest;
    const openingBoundaryTs = handoverWindow.latest;

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

    const handoverResolutionCorrections = await resolutionOverlaysForCounts(
      cashCountChannelId, [closingCount, openingCount]
    );
    const handoverCorrections = [...APPROVED_CORRECTIONS, ...handoverResolutionCorrections];
    const effectiveClosing = applyApprovedOpeningCorrections(closingCount, handoverCorrections);
    const effectiveOpening = applyApprovedOpeningCorrections(openingCount, handoverCorrections);

    const closingTotals =
      stripUntracked({
        ...effectiveClosing.effectiveTotals,
        ...closingCount.others
      });

    const openingTotals =
      stripUntracked({
        ...effectiveOpening.effectiveTotals,
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
          `❗ ${currencyHeading(r.ccy)}: ${r.diff < 0 ? 'short' : 'extra'} ${moneyLabel(r.ccy, Math.abs(r.diff))}`
        );
      }
    }

    for (
      const r of
      resolved
    ) {
      lines.push(
        `✅ ${currencyHeading(r.ccy)} handover now reconciles.`
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
        report,
        {
          blocks: reportBlocks(report, stillOpen.map(item => ({
            channel: cashCountChannelId,
            branch: branchConfig.name,
            openingRef: openingCount.refCode,
            closingRef: closingCount.refCode,
            currency: item.ccy,
            amount: Math.abs(item.diff),
            direction: item.diff < 0 ? 'SHORT' : 'EXTRA'
          })))
        }
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

// Read-only balance preview used by Transaction Entry.  This deliberately
// reuses the same Slack parsing/correction rules as the audit instead of
// maintaining a second balance calculator.  It never posts, writes, or
// changes any audit state.
async function previewPostTransactionBalance({
  branchConfig,
  lines,
  totalPhpAmount,
  arNumber,
  asOfTs = (Date.now() / 1000).toFixed(6)
}) {
  if (!branchConfig?.cashCountChannelId || !branchConfig?.transactionsChannelId) {
    throw new Error('Balance preview is not configured for this branch.');
  }

  async function messagesBefore(channelId, latestTs) {
    const result = [];
    let latest = latestTs;
    for (let page = 0; page < MAX_PAGES; page++) {
      const pageMessages = await history(channelId, { latest, limit: PAGE_SIZE });
      if (!pageMessages.length) break;
      result.push(...pageMessages.filter(m => Number(m.ts) <= Number(asOfTs)));
      if (pageMessages.length < PAGE_SIZE) break;
      latest = (Number(pageMessages[pageMessages.length - 1].ts) - 0.000001).toFixed(6);
    }
    return result;
  }

  const countMessages = await messagesBefore(branchConfig.cashCountChannelId, asOfTs);
  // Transaction Entry previews always anchor to the same business day's
  // morning Opening count. Midshift and Closing counts remain audit
  // checkpoints and must not reset the continuous running balance.
  const latestCountMessage = selectOpeningCashCountForPreview(
    countMessages,
    branchConfig.name,
    asOfTs
  );

  if (!latestCountMessage) {
    return { authoritative: false, reason: 'No valid Cash Count found for this branch.' };
  }

  const latestCount = { ...latestCountMessage.parsed, _ts: latestCountMessage.message.ts };
  const overlays = await resolutionOverlaysForCounts(branchConfig.cashCountChannelId, [latestCount]);
  const effectiveCount = applyApprovedOpeningCorrections(
    latestCount,
    [...APPROVED_CORRECTIONS, ...overlays]
  ).effectiveTotals;
  const balances = stripUntracked({ ...effectiveCount, ...latestCount.others });
  const oldestTs = latestCount._ts;

  const txMessages = await messagesBefore(branchConfig.transactionsChannelId, asOfTs);
  const tickets = txMessages
    .filter(message => Number(message.ts) > Number(oldestTs) && TICKET_RE.test(message.text || ''))
    .map(message => {
      const original = parseTransaction(message.text || '');
      if (!original) return null;
      return {
        message,
        parsed: applyApprovedTransactionCorrections(original).effectiveTransaction,
        ref: String(original.ref || '')
      };
    })
    .filter(Boolean);

  for (const ticket of tickets) {
    for (const movement of ticket.parsed.movements || []) {
      const sign = movement.action === 'BUY' ? 1 : -1;
      balances[movement.ccy] = (balances[movement.ccy] || 0) + sign * movement.fcyAmount;
    }
    balances.PHP = (balances.PHP || 0) + transactionPhpEffect(ticket.parsed);
  }

  // Apply the same supported non-ticket cash movements the audit uses.  If a
  // source cannot be parsed, it is intentionally not guessed into the preview.
  const generalMessages = countMessages.filter(message => Number(message.ts) > Number(oldestTs));
  for (const message of generalMessages) {
    const movement = parseForexFundMovement(message.text || '');
    if (movement) balances[movement.ccy] = (balances[movement.ccy] || 0) + movement.amount;
  }

  let structuredMovementsUsed = false;
  if (branchConfig.expenseMovementsUrl && branchConfig.expenseMovementsSecret) {
    try {
      const structuredMovements = await fetchStructuredMovementFeed(branchConfig, oldestTs, asOfTs);
      console.info('Structured Expense App movement feed succeeded', {
        branch: branchConfig.name,
        movementCount: structuredMovements.length,
        afterUtc: new Date(Number(oldestTs) * 1000).toISOString(),
        beforeUtc: new Date(Number(asOfTs) * 1000).toISOString()
      });
      const seen = new Set();
      for (const entry of structuredMovements) {
        if (!entry?.expenseId || seen.has(entry.expenseId)) continue;
        seen.add(entry.expenseId);
        for (const leg of structuredMovementEffect(entry)) balances[leg.ccy] = (balances[leg.ccy] || 0) + leg.amount;
      }
      structuredMovementsUsed = true;
    } catch (error) {
      console.warn('Structured Expense App movement feed unavailable; using legacy Slack expense fallback.', { message: error?.message || String(error) });
    }
  }

  if (!structuredMovementsUsed && branchConfig.expensesChannelId) {
    const expenseMessages = await messagesBefore(branchConfig.expensesChannelId, asOfTs);
    const expenseEntries = expenseMessages
      .filter(message => Number(message.ts) > Number(oldestTs))
      .map(message => parseExpenseEntry(message.text || ''))
      .filter(Boolean);
    const expenseAdjustments = buildExpenseAdjustments(expenseEntries, expenseEntries.reduce(
      (sum, entry) => sum + expenseForexPhpEffect(entry), 0
    ));
    for (const [ccy, amount] of Object.entries(expenseAdjustments)) {
      balances[ccy] = (balances[ccy] || 0) + amount;
    }
  }

  const proposed = {
    movements: (lines || []).map(line => ({
      action: String(line.deal || '').toUpperCase(),
      ccy: String(line.currency || '').toUpperCase(),
      fcyAmount: Number(line.fxAmount),
      phpAmount: Number(line.phpAmount)
    })),
    phpAmount: Number(totalPhpAmount)
  };
  const alreadyPosted = arNumber && tickets.some(ticket => ticket.ref === String(arNumber).replace(/^0+/, '') || ticket.ref === String(arNumber));
  if (!alreadyPosted) {
    for (const movement of proposed.movements) {
      const sign = movement.action === 'BUY' ? 1 : -1;
      balances[movement.ccy] = (balances[movement.ccy] || 0) + sign * movement.fcyAmount;
    }
    balances.PHP = (balances.PHP || 0) + transactionPhpEffect(proposed);
  }

  const affected = new Set(proposed.movements.map(movement => movement.ccy));
  affected.add('PHP');
  return {
    authoritative: true,
    sourceCashCount: {
      refCode: latestCount.refCode,
      phase: latestCount.phase,
      slackTs: latestCount._ts
    },
    alreadyPosted,
    balances: [...affected].map(ccy => ({ ccy, balance: balances[ccy] || 0 }))
  };
}

module.exports = {
  runShiftAudit,
  runCloseVsOpenCheck,
  buildExpenseAdjustments,
  expenseForexPhpEffect,
  buildShiftMath,
  slackAuditWindow,
  isSlackTsWithinAuditWindow,
  currencyHeading,
  resolutionOverlaysForCounts,
  isScheduledOpening,
  isScheduledClosing,
  previewPostTransactionBalance,
  structuredMovementEffect,
  buildStructuredExpenseEntries,
  buildStructuredExpenseAdjustments,
  buildStructuredHiveMovements,
  parseLegacyHiveInternalTransfer,
  buildLegacyHiveMovements,
  reconcileHiveCash,
  manilaBusinessDateFromSlackTs,
  selectOpeningCashCountForPreview
};
