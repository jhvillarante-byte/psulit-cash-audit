const assert = require('assert');
const { parseExpenseEntry } = require('./parse');
const { reconcile } = require('./reconcile');

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
  amount: -400
});
assert.equal(alphalandReceivable.needsReview, false);

const adjustments = {
  [alphalandReceivable.cashMovement.ccy]:
    alphalandReceivable.cashMovement.amount
};

const results = reconcile(
  {
    SGD: 400,
    PHP: 100000,
    TWD: 500
  },
  {
    SGD: 67,
    PHP: 100000,
    TWD: 450
  },
  [
    {
      movements: [
        {
          action: 'BUY',
          ccy: 'SGD',
          fcyAmount: 67
        }
      ],
      phpAmount: null
    }
  ],
  adjustments
);

const sgd = results.find(result => result.ccy === 'SGD');
const php = results.find(result => result.ccy === 'PHP');
const twd = results.find(result => result.ccy === 'TWD');

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

assert.equal(php.expected, 100000);
assert.equal(php.diff, 0);
assert.equal(php.match, true);

assert.equal(twd.diff, -50);
assert.equal(twd.match, false);

const phpReceivable = parseExpenseEntry(`
Category: Receivable
Description: PHP 2,500 employee cash advance
Amount: ₱2,500.00
`);

assert.deepEqual(phpReceivable.cashMovement, {
  ccy: 'PHP',
  amount: -2500
});
assert.equal(phpReceivable.amount, 0);

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

console.log('foreign-currency receivable reconciliation: PASS');
console.log('PHP receivable cash movement: PASS');
console.log('ambiguous receivable review flag: PASS');
console.log('separate TWD discrepancy preserved: PASS');
console.log('ordinary expense and replenishment regression: PASS');
