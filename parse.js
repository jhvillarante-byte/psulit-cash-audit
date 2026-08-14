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

function matchOne(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

/**
 * Parses a transaction ticket message (VN ##### or AR #####).
 * Returns { ref, action: 'BUY'|'SELL', ccy, fcyAmount, phpAmount, counterparty } or null if unparseable.
 */
function parseTransaction(text) {
  if (!text) return null;

  const refMatch = text.match(/(?:VN|AR)\s*#?\s*0*(\d+)/i);
  if (!refMatch) return null;
  const ref = refMatch[1];

  const actionMatch = text.match(/\b(BUY|SELL)\b/i);
  if (!actionMatch) return null;
  const action = actionMatch[1].toUpperCase();

  // e.g. "BUY 1000 USD@61.11" / "BUY 300  USD @ 61.16" / "SELL 21,000 USD @ 61.30" / "BUY 7000JPY @0.3749"
  const fcyMatch = text.match(/\b(?:BUY|SELL)\s*([\d,]+)\s*([A-Z]{3})\b/i);
  if (!fcyMatch) return null;
  const fcyAmount = parseFloat(fcyMatch[1].replace(/,/g, ''));
  const ccy = fcyMatch[2].toUpperCase();

  // PHP value is the last ₱/P-prefixed number in the message, or the value after "="
  const phpMatches = [...text.matchAll(/(?:₱|=\s*)\s*([\d,]+\.?\d*)/g)];
  const phpAmount = phpMatches.length
    ? parseFloat(phpMatches[phpMatches.length - 1][1].replace(/,/g, ''))
    : null;

  const isWholesale = /CORPORATION|FOREX|EXCHANGE|CZARINA|SUNFOREX|MONEYBEES/i.test(text)
    && !/NEW CLIENT|OLD CLIENT/i.test(text);

  return { ref, action, ccy, fcyAmount, phpAmount, isWholesale, raw: text };
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

module.exports = { parseCashCount, parseTransaction, parseHiveEntry };
