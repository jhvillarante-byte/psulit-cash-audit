// Parses the two message formats we get from Slack:
//  1. "PSULIT CASH COUNT REPORT" - posted by the Psulit Cash Count bot
//  2. Transaction tickets (VN ##### / AR #####) - posted by tellers

const CCY_LINE = /:flag-[a-z]+:\s*\*([A-Z]{3})[^*]*\*|:([a-z]{2}):\s*\*([A-Z]{3})[^*]*\*/g;
const SUBTOTAL_LINE = /\*Subtotal:\s*([^\d\-.,]*)\s*([\d,]+\.?\d*)\*/;

// Currency symbol -> ISO code map (for parsing "Subtotal" lines, which show symbol not code)
const SYMBOL_TO_CCY = {
  '₱': 'PHP', 'P': 'PHP',
  '$': 'USD',
  'S$': 'SGD',
  'HK$': 'HKD',
  '¥': 'CNY', // ambiguous with JPY, disambiguated by section header below
  '£': 'GBP',
  '€': 'EUR'
};

/**
 * Parses a "PSULIT CASH COUNT REPORT" message into structured totals.
 * Returns { branch, shift, teller, timestamp, refCode, totals: { USD: 123.45, PHP: ..., ... }, others: { Hive: ..., Opex: ... } }
 */
function parseCashCount(text) {
  if (!text || !text.includes('PSULIT CASH COUNT REPORT')) return null;

  const branch = matchOne(text, /\*Branch:\*\s*(.+)/);
  const shift = matchOne(text, /\*Shift:\*\s*(.+)/);
  const teller = matchOne(text, /\*Teller:\*\s*(.+)/);
  const timestamp = matchOne(text, /\*Timestamp:\*\s*(.+)/);
  const refCode = matchOne(text, /\*Ref Code:\*\s*(.+)/);

  // Split into FOREX section and OTHERS section
  const forexSection = text.split('*OTHERS*')[0];
  const othersSection = text.split('*OTHERS*')[1] || '';

  const totals = extractCurrencyBlocks(forexSection);
  const others = extractNamedBlocks(othersSection);

  return { branch, shift, teller, timestamp, refCode, totals, others };
}

// Extracts currency name headers (e.g. ":flag-ph: *PHP — Philippine Peso*") and the Subtotal that follows each
function extractCurrencyBlocks(section) {
  const totals = {};
  const headerRegex = /\*([A-Z]{3})\s*—[^*]*\*/g;
  let match;
  const headers = [];
  while ((match = headerRegex.exec(section)) !== null) {
    headers.push({ ccy: match[1], index: match.index });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : section.length;
    const block = section.slice(start, end);
    const subtotalMatch = block.match(/\*Subtotal:\s*[^\d]*([\d,]+\.?\d*)\*/);
    if (subtotalMatch) {
      totals[headers[i].ccy] = parseFloat(subtotalMatch[1].replace(/,/g, ''));
    }
  }
  return totals;
}

// Extracts named blocks under OTHERS (e.g. "Hive", "Opex") with their Subtotal
function extractNamedBlocks(section) {
  const others = {};
  const headerRegex = /:[\w_]+:\s*([A-Za-z]+)\n/g;
  let match;
  const headers = [];
  while ((match = headerRegex.exec(section)) !== null) {
    headers.push({ name: match[1], index: match.index });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : section.length;
    const block = section.slice(start, end);
    const subtotalMatch = block.match(/\*Subtotal:\s*[^\d]*([\d,]+\.?\d*)\*/);
    if (subtotalMatch) {
      others[headers[i].name] = parseFloat(subtotalMatch[1].replace(/,/g, ''));
    }
  }
  return others;
}

/**
 * Parses denomination-level line items from a "PSULIT CASH COUNT REPORT"
 * message, e.g. "₱1,000 × 283 = ₱283,000" -> { PHP: { '1000': 283, ... } }.
 * Needed to catch discrepancies that a currency subtotal alone can hide —
 * e.g. a whole denomination being skipped even though other denominations
 * in the same currency are correct (the subtotal just comes out short).
 *
 * Returns { PHP: { '1000': 283, '500': 297, ... }, USD: { '100': 271, ... }, ... }
 */
function parseDenominations(text) {
  if (!text || !text.includes('PSULIT CASH COUNT REPORT')) return {};

  const forexSection = text.split('*OTHERS*')[0];
  const headerRegex = /\*([A-Z]{3})\s*—[^*]*\*/g;
  const headers = [];
  let match;
  while ((match = headerRegex.exec(forexSection)) !== null) {
    headers.push({ ccy: match[1], index: match.index });
  }

  const denoms = {};
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : forexSection.length;
    const block = forexSection.slice(start, end);

    // Matches lines like "₱1,000 × 283 = ₱283,000" or "5¢ × 4 = ₱0.20"
    const lineRegex = /([₱$¥€£]?[\d,]+\.?\d*¢?)\s*×\s*(\d+)\s*=/g;
    let lineMatch;
    const ccyDenoms = {};
    while ((lineMatch = lineRegex.exec(block)) !== null) {
      // Normalize the denomination label to a bare number string for comparison
      // (strip currency symbols/commas so "₱1,000" and "1000" match consistently).
      const label = lineMatch[1].replace(/[₱$¥€£,]/g, '');
      ccyDenoms[label] = parseInt(lineMatch[2], 10);
    }
    if (Object.keys(ccyDenoms).length > 0) {
      denoms[headers[i].ccy] = ccyDenoms;
    }
  }
  return denoms;
}

function matchOne(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

/**
 * Parses a transaction ticket message (VN #####, AR #####, or ARN #####).
 * Handles both single-currency client tickets and multi-currency wholesale
 * tickets (one message can list several BUY/SELL lines, one per currency).
 *
 * Returns { ref, isWholesale, movements: [{ action, ccy, fcyAmount }],
 *           phpAmount, raw } or null if unparseable.
 */
function parseTransaction(text) {
  if (!text) return null;

  // Ticket prefix: check ARN before AR, since "ARN" also contains "AR" as a substring.
  const refMatch = text.match(/(?:VN|ARN|AR)\s*#?\s*0*(\d+)/i);
  if (!refMatch) return null;
  const ref = refMatch[1];

  // Every BUY/SELL <amount> <CCY> line in the message — wholesale tickets often
  // list several currencies in one post (e.g. a multi-currency Sun Forex deal).
  const movements = [];
  const lineRegex = /\b(BUY|SELL)\s*([\d,]+)\s*([A-Z]{3})\b/gi;
  let m;
  while ((m = lineRegex.exec(text)) !== null) {
    movements.push({
      action: m[1].toUpperCase(),
      ccy: m[3].toUpperCase(),
      fcyAmount: parseFloat(m[2].replace(/,/g, ''))
    });
  }
  if (movements.length === 0) return null;

  // Overall PHP value: prefer an explicit "TOTAL" line (used on multi-currency
  // tickets), otherwise fall back to the last ₱/= amount in the message.
  const totalMatch = text.match(/TOTAL\s*:?\s*[₱P]?\s*([\d,]+\.?\d*)/i);
  let phpAmount = null;
  if (totalMatch) {
    phpAmount = parseFloat(totalMatch[1].replace(/,/g, ''));
  } else {
    const phpMatches = [...text.matchAll(/(?:₱|=\s*)\s*([\d,]+\.?\d*)/g)];
    if (phpMatches.length) {
      phpAmount = parseFloat(phpMatches[phpMatches.length - 1][1].replace(/,/g, ''));
    }
  }

  const isWholesale = /CORPORATION|FOREX|EXCHANGE|CZARINA|SUNFOREX|MONEYBEES/i.test(text)
    && !/NEW CLIENT|OLD CLIENT/i.test(text);

  return { ref, isWholesale, movements, phpAmount, raw: text };
}

/**
 * Parses a Hive balance-update message, e.g.:
 *   "*Updated Balance (PHP)*\n*Amount: 100,000.00*"
 * Returns { amount } (can be negative) or null if unparseable.
 */
function parseHiveEntry(text) {
  if (!text || !text.includes('Updated Balance')) return null;
  const match = text.match(/\*Amount:\s*(-?[\d,]+\.?\d*)\*/);
  if (!match) return null;
  return { amount: parseFloat(match[1].replace(/,/g, '')) };
}

/**
 * Parses an expense entry (e.g. "Date: Aug 13, 2026\nAMOUNT: 4,500\nPurpose: ...").
 * Most entries are outflows that reduce the till's Opex float. An entry containing
 * "TOP-UP" or "REPLENISH" is treated as money going the other way (added to Opex).
 * Handles "100k" shorthand (= 100,000) alongside plain/comma'd numbers.
 * Returns { amount } — already signed (negative = spent, positive = topped up) — or null.
 */
function parseExpenseEntry(text) {
  if (!text) return null;
  const match = text.match(/amount\s*:?\s*([\d,]+\.?\d*)\s*(k)?/i);
  if (!match) return null;
  let amount = parseFloat(match[1].replace(/,/g, ''));
  if (match[2]) amount *= 1000; // "100k" shorthand
  const isTopUp = /top[\s-]?up|replenish/i.test(text);
  return { amount: isTopUp ? amount : -amount };
}

module.exports = { parseCashCount, parseTransaction, parseHiveEntry, parseExpenseEntry, parseDenominations };
