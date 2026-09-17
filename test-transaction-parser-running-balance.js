const assert = require('node:assert/strict');
const { parseTransaction } = require('./parse');
const { transactionPhpEffect } = require('./reconcile');

function check(text, expectedAmount, expectedCurrency, expectedFx, expectedEffect) {
  const parsed = parseTransaction(text);
  assert.ok(parsed, 'transaction should parse');
  assert.equal(parsed.phpAmount, expectedAmount);
  assert.equal(parsed.movements[0].ccy, expectedCurrency);
  assert.equal(parsed.movements[0].fcyAmount, expectedFx);
  assert.equal(transactionPhpEffect(parsed), expectedEffect);
}

check(
  'AR 0005835\nBUY 100 USD @ 62.59 → ₱6,259.00\nPHP: -₱6,259.00 → Balance: ₱116,178.93',
  6259,
  'USD',
  100,
  -6259
);

check(
  'AR 0005836\nBUY 100 USD @ 62.61 → ₱6,261.00\nPHP: -₱6,261.00 → Balance: ₱109,917.93',
  6261,
  'USD',
  100,
  -6261
);

check(
  'AR 0005837\nBUY 25 USD @ 62.41 → ₱1,560.25\nPHP: -₱1,560.25 → Balance: ₱108,357.68',
  1560.25,
  'USD',
  25,
  -1560.25
);

check(
  'AR 0005840\nSELL 10 EUR @ 70.00 → ₱700.00\nPHP: +₱700.00 → Balance: ₱50,000.00',
  700,
  'EUR',
  10,
  700
);

const explicitTotal = parseTransaction(
  'AR 0005841\nBUY 100 USD @ 62.59\nTOTAL: ₱6,259.00\nPHP: -₱6,259.00 → Balance: ₱40,000.00'
);
assert.equal(explicitTotal.phpAmount, 6259);

const totalFallback = parseTransaction(
  'AR 0005841\nBUY 100 USD @ 62.59\nTOTAL: ₱6,259.00\nPHP settlement recorded separately → Balance: ₱40,000.00'
);
assert.equal(totalFallback.phpAmount, 6259);

const multi = parseTransaction(
  'ARN 0005842\nBUY 100 USD @ 62.59 → ₱6,259.00\nSELL 10 EUR @ 70.00 → ₱700.00\nPHP: net → Balance: ₱30,000.00'
);
assert.equal(multi.phpAmount, 6959);
assert.equal(transactionPhpEffect(multi), -5559);

const currentFormat = parseTransaction('AR 0005843\nBUY 5 USD @ 62.00 → ₱310.00');
assert.equal(currentFormat.phpAmount, 310);

console.log('Transaction parser running-balance regressions passed');
