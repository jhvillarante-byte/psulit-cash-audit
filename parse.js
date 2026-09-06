
// Parses the two message formats we get from Slack:
//  1. "PSULIT CASH COUNT REPORT" - posted by the Psulit Cash Count bot
//  2. Transaction tickets (VN #####, AR #####, ARN #####) - posted by tellers

const CCY_LINE = /:flag-[a-z]+:\s*\*([A-Z]{3})[^*]*\*|:([a-z]{2}):\s*\*([A-Z]{3})[^*]*\*/g;
const SUBTOTAL_LINE = /\*Subtotal:\s*([^\d\-.,]*)\s*([\d,]+\.?\d*)\*/;

// Currency symbol -> ISO code map
const SYMBOL_TO_CCY = {
  '₱': 'PHP',
  'P': 'PHP',
  '$': 'USD',
  'S$': 'SGD',
  'HK$': 'HKD',
  '¥': 'CNY',
  '£': 'GBP',
  '€': 'EUR'
};

/**
 * Parses a PSULIT CASH COUNT REPORT.
 */
function parseCashCount(text) {
  if (!text || !text.includes('PSULIT CASH COUNT REPORT')) return null;

  const branch = matchOne(text, /Branch:\s*(.+)/);
  const rawShift = matchOne(text, /Shift:\s*(.+)/);

  let shift = rawShift;
  let phase = null;

  const phaseMatch = (rawShift || '').match(
    /^(.+?)\s*\((Opening|Closing)\)\s*$/i
  );

  if (phaseMatch) {
    shift = phaseMatch[1].trim();
    phase = phaseMatch[2];
  }

  const teller = matchOne(text, /Teller:\s*(.+)/);
  const timestamp = matchOne(text, /Timestamp:\s*(.+)/);
  const refCode = matchOne(text, /Ref Code:\s*(.+)/);

  const forexSection = text.split('*OTHERS*')[0];
  const othersSection = text.split('*OTHERS*')[1] || '';

  const forex = extractCurrencyBlocks(forexSection);
  const others = extractNamedBlocks(othersSection);

  // Newer cash-count messages put Hive/Opex/etc. directly
  // in the report instead of inside an OTHERS section.
  const flatOthers = extractFlatNamedAmounts(text);

  for (const [name, amount] of Object.entries(flatOthers)) {
    if (!(name in others.totals)) {
      others.totals[name] = amount;
    }
  }

  return {
    branch,
    shift,
    phase,
    teller,
    timestamp,
    refCode,
    totals: forex.totals,
    others: others.totals,
    denominations: {
      ...forex.denominations,
      ...others.denominations
    }
  };
}

const FLAT_OTHER_LABELS = [
  'Hive',
  'Opex',
  'JuanPay',
  'Scratch',
  'Receivables (PHP)',
  'Receivables (USD)'
];

function extractFlatNamedAmounts(text) {
  const totals = {};

  for (const label of FLAT_OTHER_LABELS) {
    const escaped = label.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

    const re = new RegExp(
      `${escaped}:\\s*(?:₱|\\$|€|£|¥|HK\\$|S\\$|A\\$|C\\$|SR|฿|₩)?\\s*([\\d,]+\\.?\\d*)`,
      'i'
    );

    const m = text.match(re);

    if (m) {
      const amount = parseFloat(
        m[1].replace(/,/g, '')
      );

      if (!isNaN(amount)) {
        totals[label] = amount;
      }
    }
  }

  return totals;
}

/**
 * Parses denomination lines such as:
 * ₱1,000 × 175 = ₱175,000
 * 25¢ × 2 = ₱0.50
 */
function parseDenominationLines(block) {
  const lines = [];

  const lineRegex =
    /(?:₱|\$|€|£|¥|HK\$|S\$)?\s*([\d,]+\.?\d*)\s*(¢)?\s*[×x]\s*(\d+)\s*=/g;

  let m;

  while ((m = lineRegex.exec(block)) !== null) {
    let value = parseFloat(
      m[1].replace(/,/g, '')
    );

    if (m[2]) {
      value = value / 100;
    }

    lines.push({
      value,
      count: parseInt(m[3], 10)
    });
  }

  return lines;
}

/**
 * Extract currency blocks from cash-count reports.
 */
function extractCurrencyBlocks(section) {
  const totals = {};
  const denominations = {};

  const headerRegex = /\*([A-Z]{3})\s*—[^*]*\*/g;

  let match;
  const headers = [];

  while ((match = headerRegex.exec(section)) !== null) {
    headers.push({
      ccy: match[1],
      index: match.index
    });
  }

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;

    const end =
      i + 1 < headers.length
        ? headers[i + 1].index
        : section.length;

    const block = section.slice(start, end);

    const subtotalMatch = block.match(
      /\*Subtotal:\s*[^\d]*([\d,]+\.?\d*)\*/
    );

    if (subtotalMatch) {
      totals[headers[i].ccy] = parseFloat(
        subtotalMatch[1].replace(/,/g, '')
      );
    }

    denominations[headers[i].ccy] =
      parseDenominationLines(block);
  }

  // Newer flat cash-count format:
  // :flag-ph: PHP: ₱341,699.64
  if (headers.length === 0) {
    const flatLineRegex =
      /:[\w-]+:\s*([A-Z]{3}):\s*(?:₱|\$|€|£|¥|HK\$|S\$|A\$|C\$|SR|฿|₩)?\s*([\d,]+\.?\d*)/g;

    let flatMatch;

    while (
      (flatMatch = flatLineRegex.exec(section)) !== null
    ) {
      const ccy = flatMatch[1];

      const amount = parseFloat(
        flatMatch[2].replace(/,/g, '')
      );

      if (!isNaN(amount)) {
        totals[ccy] = amount;
      }
    }
  }

  return {
    totals,
    denominations
  };
}

/**
 * Extract older OTHERS blocks such as Hive and Opex.
 */
function extractNamedBlocks(section) {
  const totals = {};
  const denominations = {};

  const headerRegex =
    /:[\w_]+:\s*([A-Za-z]+)\n/g;

  let match;
  const headers = [];

  while ((match = headerRegex.exec(section)) !== null) {
    headers.push({
      name: match[1],
      index: match.index
    });
  }

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;

    const end =
      i + 1 < headers.length
        ? headers[i + 1].index
        : section.length;

    const block = section.slice(start, end);

    const subtotalMatch = block.match(
      /\*Subtotal:\s*[^\d]*([\d,]+\.?\d*)\*/
    );

    if (subtotalMatch) {
      totals[headers[i].name] = parseFloat(
        subtotalMatch[1].replace(/,/g, '')
      );
    }

    denominations[headers[i].name] =
      parseDenominationLines(block);
  }

  return {
    totals,
    denominations
  };
}

function matchOne(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

/**
 * Parses transaction tickets.
 *
 * Supports:
 * VN #####
 * AR #####
 * ARN #####
 *
 * Also supports multi-currency wholesale transactions.
 */
function parseTransaction(text) {
  if (!text) return null;

  const refMatch = text.match(
    /(?:VN|ARN|AR)\s*#?\s*0*(\d+)/i
  );

  if (!refMatch) return null;

  const ref = refMatch[1];

  const movements = [];

  const lineRegex =
    /\b(BUY|SELL)\s*([\d,]+)\s*([A-Z]{3})\b/gi;

  let m;

  while ((m = lineRegex.exec(text)) !== null) {
    movements.push({
      action: m[1].toUpperCase(),
      ccy: m[3].toUpperCase(),
      fcyAmount: parseFloat(
        m[2].replace(/,/g, '')
      )
    });
  }

  if (movements.length === 0) {
    return null;
  }

  // Prefer an explicit TOTAL for multi-currency tickets.
  const totalMatch = text.match(
    /TOTAL\s*:?\s*[₱P]?\s*([\d,]+\.?\d*)/i
  );

  let phpAmount = null;

  if (totalMatch) {
    phpAmount = parseFloat(
      totalMatch[1].replace(/,/g, '')
    );
  } else {
    const phpMatches = [
      ...text.matchAll(
        /(?:₱|=\s*)\s*([\d,]+\.?\d*)/g
      )
    ];

    if (phpMatches.length) {
      phpAmount = parseFloat(
        phpMatches[
          phpMatches.length - 1
        ][1].replace(/,/g, '')
      );
    }
  }

  const isWholesale =
    /CORPORATION|FOREX|EXCHANGE|CZARINA|SUNFOREX|MONEYBEES/i.test(
      text
    ) &&
    !/NEW CLIENT|OLD CLIENT/i.test(text);

  return {
    ref,
    isWholesale,
    movements,
    phpAmount,
    raw: text
  };
}

/**
 * Parses Hive balance updates.
 */
function parseHiveEntry(text) {
  if (
    !text ||
    !text.includes('Updated Balance')
  ) {
    return null;
  }

  const match = text.match(
    /\*Amount:\s*(-?[\d,]+\.?\d*)\*/
  );

  if (!match) return null;

  return {
    amount: parseFloat(
      match[1].replace(/,/g, '')
    )
  };
}

/**
 * Parses expense/replenishment Slack entries.
 *
 * Supports old manual messages and new Expense Report messages.
 *
 * The final number on the Amount line is the stated total.
 *
 * Amount: Php 68 + 108 = Php 176 -> -176
 * Amount: ₱116.00 -> -116
 * Amount: Php 2,199 + 12 biller fee = Php 2,211 -> -2211
 * Replenishment amount: 100k -> +100000
 *
 * Replenishment / Top-up = money IN
 * Normal expense = money OUT
 */
function parseExpenseEntry(text) {
  if (!text) return null;

  // Read only the Amount line, not dates, IDs or approvals.
  const amountLineMatch = String(text).match(
    /(?:^|\n)\s*\*?\s*amount\s*:?\s*([^\n\r]+)/i
  );

  if (!amountLineMatch) return null;

  const amountLine = amountLineMatch[1]
    .replace(/\*/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();

  // Accept peso symbols, PHP labels, centavos and shorthand.
  // The final number on the line is the stated total.
  const numberMatches = [
    ...amountLine.matchAll(
      /(?:₱|PHP|PHP\.|P\s*)?\s*([\d,]+(?:\.\d{1,2})?)\s*(k)?(?=\s|$|[*_,.)])/gi
    )
  ];

  if (numberMatches.length === 0) return null;

  const last = numberMatches[numberMatches.length - 1];

  let amount = parseFloat(
    last[1].replace(/,/g, '')
  );

  if (!Number.isFinite(amount)) return null;

  if (last[2]) {
    amount *= 1000;
  }

  const isTopUp =
    /top[\s-]?up|replenish/i.test(text);

  return {
    amount: isTopUp ? amount : -amount
  };
}

module.exports = {
  parseCashCount,
  parseTransaction,
  parseHiveEntry,
  parseExpenseEntry
};
