const assert = require('assert');
const {
  parseCashCount,
  parseExpenseEntry,
  parseTransaction
} = require('./parse');
const { reconcile } = require('./reconcile');
const { buildExpenseAdjustments, expenseForexPhpEffect } = require('./audit');

const alphalandReceivable = parseExpenseEntry(`
Expense ID: ALP-20260907-003
Posted by: Angelica Besid
Category: Receivable
Description: 400 SGD @ 49.45 (xe rate)
Amount: ₱19,780.00
Posted at: 09/07/2026, 01:00:00
`);

assert.ok(alphalandReceivable);
assert.equal(alphalandReceivable.isReceivable, true);
assert.equal(alphalandReceivable.pesoValuation, 19780);
assert.equal(alphalandReceivable.amount, 0);
assert.deepEqual(alphalandReceivable.cashMovement, {
  ccy: 'SGD',
  amount: -400,
  source: 'Forex drawer'
});
assert.equal(alphalandReceivable.needsReview, false);

const smartReceivable = parseExpenseEntry(`
Expense ID: ALP-20260907-002
Posted by: Joan Legaspi
Category: Receivable
Description: SMART Postpaid- Sir Jay Ricky Villarante,
Receivable from Secuna
Amount: ₱15,012.00
Posted at: Sep 7, 2026, 5:56:29 PM
`);

assert.equal(smartReceivable.pesoValuation, 15012);
assert.equal(smartReceivable.amount, 0);
assert.equal(smartReceivable.fundingSource, 'Scratch');
assert.deepEqual(smartReceivable.cashMovement, {
  ccy: 'PHP',
  amount: -15012,
  source: 'Scratch'
});
assert.equal(smartReceivable.needsReview, false);

const closingCount = parseCashCount(`
:clipboard: *PSULIT CASH COUNT REPORT*
:bank: Branch: Alphaland
:arrows_counterclockwise: Shift: Mid-Shift (Closing)
:bust_in_silhouette: Teller: Joan Legaspi
:clock1: Timestamp: 09/07/2026, 21:09:09
:key: Ref Code: PSC-MTR9BRHL-1HGZ
:flag-ph: PHP: ₱211,119.84
:flag-sg: SGD: S$67
:flag-hk: HKD: HK$500
:flag-ca: CAD: C$30
:jp: JPY: ¥7,000
:flag-au: AUD: A$250
:gb: GBP: £20
:flag-eu: EUR: €100
:flag-th: THB: ฿500
:flag-tw: TWD: NT$500
:dollar: *Grand Total: ₱244,854.42*
:bee: Hive: ₱444,741.03
:ticket: Scratch: ₱2,798.00
:inbox_tray: Receivables (PHP): ₱34,792.00
:white_check_mark: *Submitted &amp; Locked*
`);

assert.equal(closingCount.totals.TWD, 500);
assert.equal(closingCount.totals.SGD, 67);
assert.equal(closingCount.others.Scratch, 2798);

const ar5777 = parseTransaction(`
*AR 0005777* — 09/07/2026, 01:28 PM
:bust_in_silhouette: NEW CLIENT: Regie Mor Lugao
:large_green_circle: BUY 67 SGD @48.52 → ₱3,250.84
:large_green_circle: BUY 500 TWD @1.905 → ₱952.50
:moneybag: Total: ₱4,203.34
:office_worker: Teller: Joan
`);

const adjustments = buildExpenseAdjustments(
  [smartReceivable, alphalandReceivable],
  0
);

assert.deepEqual(adjustments, {
  SGD: -400
});

const results = reconcile(
  {
    SGD: 400,
    PHP: 100000,
    TWD: 0,
    AUD: 250
  },
  {
    SGD: 67,
    PHP: 95796.66,
    TWD: 500,
    AUD: 245
  },
  [ar5777],
  adjustments
);

const sgd = results.find(result => result.ccy === 'SGD');
const php = results.find(result => result.ccy === 'PHP');
const twd = results.find(result => result.ccy === 'TWD');
const aud = results.find(result => result.ccy === 'AUD');

assert.deepEqual(
  {
    expected: sgd.expected,
    actual: sgd.actual,
    diff: sgd.diff,
    match: sgd.match
  },
  {
    expected: 67,
    actual: 67,
    diff: 0,
    match: true
  }
);

assert.equal(php.expected, 95796.66);
assert.equal(php.diff, 0);
assert.equal(php.match, true);

assert.equal(twd.expected, 500);
assert.equal(twd.diff, 0);
assert.equal(twd.match, true);

assert.equal(aud.diff, -5);
assert.equal(aud.match, false);

const phpReceivable = parseExpenseEntry(`
Category: Receivable
Description: PHP 2,500 employee cash advance
Amount: ₱2,500.00
`);

assert.deepEqual(phpReceivable.cashMovement, {
  ccy: 'PHP',
  amount: -2500,
  source: null
});
assert.equal(phpReceivable.amount, 0);
assert.equal(phpReceivable.needsReview, true);

const ambiguousReceivable = parseExpenseEntry(`
Category: Receivable
Description: Employee cash advance
Amount: ₱19,780.00
`);

assert.equal(ambiguousReceivable.amount, 0);
assert.equal(ambiguousReceivable.pesoValuation, 19780);
assert.equal(ambiguousReceivable.cashMovement, null);
assert.equal(ambiguousReceivable.needsReview, true);

const ordinaryExpense = parseExpenseEntry(`
Category: Fare
Description: Taxi fare
Amount: ₱116.00
`);

assert.equal(ordinaryExpense.amount, -116);
assert.equal(ordinaryExpense.isReceivable, false);
assert.equal(ordinaryExpense.cashMovement, null);

const replenishment = parseExpenseEntry(`
Category: Others
Description: Petty cash replenishment
Amount: ₱100,000.00
`);

assert.equal(replenishment.amount, 100000);
assert.equal(replenishment.isReceivable, false);

const lottomatikExpense = parseExpenseEntry(`
*EXPENSE*
Expense ID: ALP-20260909-001
Category: Others — Reload on lottomatik wallet
*Amount: 4,000.00 PHP*
Fund: Lottomatik
Description: Top up 4k to lottomatik account
Posted by: Irene Maligat
Posted at: Sep 9, 2026, 4:24:39 PM
`);
assert.equal(lottomatikExpense.amount, -4000, 'structured EXPENSE must remain cash-out');
assert.equal(lottomatikExpense.fundingSource, 'Lottomatik');
assert.equal(expenseForexPhpEffect(lottomatikExpense), 0, 'non-Forex expense must not change Forex PHP');

const forexExpense = parseExpenseEntry(`
*EXPENSE*
Expense ID: TEST-FOREX-EXPENSE
Category: Others
*Amount: 4,000.00 PHP*
Fund: Forex Drawer
Description: Top up external account
`);
assert.equal(forexExpense.amount, -4000);
assert.equal(expenseForexPhpEffect(forexExpense), -4000);
assert.deepEqual(
  buildExpenseAdjustments([forexExpense], expenseForexPhpEffect(forexExpense)),
  { PHP: -4000 },
  'one Forex expense must be applied exactly once'
);

console.log('foreign-currency receivable reconciliation: PASS');
console.log('actual TWD NT$ cash-count format: PASS');
console.log('Scratch-funded SMART receivable exclusion: PASS');
console.log('PHP receivable cash movement: PASS');
console.log('ambiguous receivable review flag: PASS');
console.log('unrelated overall discrepancy preserved: PASS');
console.log('ordinary expense and replenishment regression: PASS');
console.log('structured expense direction and fund scope: PASS');
