const assert = require('assert');
const { buildShiftMath } = require('./audit');
const { reportBlocks } = require('./discrepancy-resolutions');

const base = {
  branchConfig: { name: 'Alphaland' },
  openingTotals: { PHP: 1000, IDR: 200000 },
  closingTotals: { PHP: 1000, IDR: 200000 },
  tickets: [],
  expenseEntries: [],
  cashMovementEntries: []
};

assert.strictEqual(buildShiftMath({
  ...base,
  results: [
    { ccy: 'PHP', expected: 1000, actual: 1000, diff: 0, match: true },
    { ccy: 'IDR', expected: 200000, actual: 200000, diff: 0, match: true }
  ],
  hiveAudit: { status: 'MATCH', previous: 1000, expected: 1000, actual: 1000, difference: 0, movements: [] }
}), '', 'fully reconciled audits do not generate Full Math');

const hiveMath = buildShiftMath({
  ...base,
  results: [{ ccy: 'PHP', expected: 1000, actual: 1000, diff: 0, match: true }],
  hiveAudit: { status: 'EXTRA', previous: 1000, expected: 1000, actual: 11000, difference: 10000, movements: [] }
});
assert.match(hiveMath, /Hive/);
assert.match(hiveMath, /Difference: .*EXTRA/);

const forexMath = buildShiftMath({
  ...base,
  results: [{ ccy: 'PHP', expected: 1000, actual: 900, diff: -100, match: false }],
  hiveAudit: { status: 'MATCH', previous: 1000, expected: 1000, actual: 1000, difference: 0, movements: [] }
});
assert.match(forexMath, /PHP/);
assert.doesNotMatch(forexMath, /🐝 Hive/);

const blocks = reportBlocks('Hive discrepancy', [{
  channel: 'C-ALPHA', branch: 'Alphaland', openingRef: 'OPEN', closingRef: 'CLOSE',
  currency: 'Hive', amount: 11000, direction: 'EXTRA'
}]);
assert.strictEqual(blocks.length, 2);
assert.strictEqual(blocks[1].elements[0].text.text, '✅ Resolve Discrepancy');

console.log('report behavior: PASS');
