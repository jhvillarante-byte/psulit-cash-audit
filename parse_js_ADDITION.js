// ============================================================================
// ADD THIS to parse.js — append near the bottom, before module.exports,
// then add `parseDenominations` to the module.exports list at the end.
// ============================================================================

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

// Add `parseDenominations` here:
// module.exports = { parseCashCount, parseTransaction, parseHiveEntry, parseExpenseEntry, parseDenominations };
