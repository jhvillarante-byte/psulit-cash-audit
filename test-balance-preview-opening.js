const assert = require('node:assert/strict');
const { parseCashCount } = require('./parse');
const { selectOpeningCashCountForPreview, manilaBusinessDateFromSlackTs } = require('./audit');

function tsUtc(year, month, day, hour, minute) {
  return String((Date.UTC(year, month - 1, day, hour, minute) / 1000));
}

function count(ref, phase, ts) {
  return {
    ts,
    text: `*PSULIT CASH COUNT REPORT*\nBranch: Alphaland\nShift: Morning (${phase})\nTeller: Test\nTimestamp: x\nRef Code: ${ref}\n🇵🇭 *PHP — Philippine Peso*\n  *Subtotal: ₱100,000*`
  };
}

const opening = count('OPEN-0917', 'Opening', tsUtc(2026, 9, 17, 1, 0));
const midshift = count('MID-0917', 'Closing', tsUtc(2026, 9, 17, 9, 0));
const nextOpening = count('OPEN-0918', 'Opening', tsUtc(2026, 9, 18, 1, 0));
const asOf = tsUtc(2026, 9, 17, 12, 0);

assert.equal(manilaBusinessDateFromSlackTs(asOf), '2026-09-17');
const selected = selectOpeningCashCountForPreview(
  [midshift, opening, nextOpening].map(message => ({ ...message, parsed: parseCashCount(message.text) })),
  'Alphaland',
  asOf
);
assert.equal(selected.message.ts, opening.ts, 'Opening remains the preview base after a later checkpoint');
assert.equal(selected.parsed.refCode, 'OPEN-0917');

const noOpening = selectOpeningCashCountForPreview([midshift], 'Alphaland', asOf);
assert.equal(noOpening, null, 'No same-day Opening must not guess from Closing');

console.log('Opening-base balance preview tests passed');
