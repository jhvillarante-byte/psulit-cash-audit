'use strict';

const assert = require('assert');
const { parseCashCount, parseExpenseEntry } = require('./parse');
const { expenseForexPhpEffect } = require('./audit');
const { reconcile } = require('./reconcile');

const closingText = `PSULIT CASH COUNT REPORT
Branch: Alphaland
Shift: Night (Closing)
Teller: Angelica Besid
Timestamp: 09/09/2026, 20:32:08
Ref Code: PSC-MTU2VV19-CG5R
:flag-ph: PHP: ₱216,443.56
:flag-id: IDR: Rp200,000`;

const closing = parseCashCount(closingText);
assert(closing, 'locked closing fixture must parse');
assert.strictEqual(closing.refCode, 'PSC-MTU2VV19-CG5R');
assert.strictEqual(closing.totals.IDR, 200000, 'Rp-prefixed IDR must be recognized');

const expense = parseExpenseEntry(`
*EXPENSE*
Expense ID: ALP-20260909-001
Category: Others — Reload on lottomatik wallet
*Amount: 4,000.00 PHP*
Fund: Lottomatik
Description: Top up 4k to lottomatik account
Posted by: Irene Maligat
Posted at: Sep 9, 2026, 4:24:39 PM
`);

const phpMovements = [
  ['BUY', 6223.00], ['BUY', 697.20], ['BUY', 1356.32],
  ['BUY', 12456.00], ['BUY', 12456.00], ['SELL', 178026.13]
].map(([action, phpAmount], index) => ({
  ref: String(5790 + index),
  movements: [{ action, ccy: index === 1 ? 'IDR' : 'USD', fcyAmount: index === 1 ? 200000 : 0 }],
  phpAmount
}));

const originalWrong = reconcile(
  { PHP: 71605.95 },
  { PHP: 216443.56, IDR: 0 },
  phpMovements,
  { PHP: 4000 }
);
assert.deepStrictEqual(
  originalWrong.find(row => row.ccy === 'IDR'),
  { ccy: 'IDR', expected: 200000, actual: 0, diff: -200000, match: false }
);
assert.deepStrictEqual(
  originalWrong.find(row => row.ccy === 'PHP'),
  { ccy: 'PHP', expected: 220443.56, actual: 216443.56, diff: -4000, match: false }
);

const corrected = reconcile(
  { PHP: 71605.95 },
  { PHP: closing.totals.PHP, IDR: closing.totals.IDR },
  phpMovements,
  { PHP: expenseForexPhpEffect(expense) }
);
assert.strictEqual(corrected.find(row => row.ccy === 'IDR').match, true);
assert.strictEqual(corrected.find(row => row.ccy === 'PHP').match, true);
assert.strictEqual(corrected.find(row => row.ccy === 'PHP').expected, 216443.56);

// If the record were explicitly Forex-funded, its correct negative direction
// would produce an EXTRA ₱4,000 against the unchanged locked closing count.
const explicitForexResult = reconcile(
  { PHP: 71605.95 },
  { PHP: closing.totals.PHP },
  phpMovements,
  { PHP: -4000 }
).find(row => row.ccy === 'PHP');
assert.deepStrictEqual(
  explicitForexResult,
  { ccy: 'PHP', expected: 212443.56, actual: 216443.56, diff: 4000, match: false }
);

console.log(`Historical dry run: PSC-MTTDSQHG-XOWT → ${closing.refCode}`);
console.log('IDR: expected 200,000; actual 200,000; difference 0');
console.log('PHP: expected ₱216,443.56; actual ₱216,443.56; difference ₱0.00');
console.log('Alphaland September 9 regression: PASS');
