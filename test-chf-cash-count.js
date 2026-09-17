const assert = require('assert');
const { parseCashCount } = require('./parse');

function report(refCode, chf, php = '₱698,185.01') {
  return `*PSULIT CASH COUNT REPORT*
Branch: Solaire
Shift: Night (Closing)
Timestamp: 09/18/2026, 04:30:10
Ref Code: ${refCode}
:flag-ph: PHP: ${php}
:flag-ch: CHF: ${chf}
:us: USD: $10,006`;
}

const opening = parseCashCount(report('PSC-MU5J3SG1-Y3ND', 'Fr30', '₱1,242,707.65'));
const closing = parseCashCount(report('PSC-MU5ZHF6O-9RGU', 'Fr30'));
assert.equal(opening.totals.CHF, 30);
assert.equal(closing.totals.CHF, 30);

for (const [text, expected] of [['Fr30', 30], ['Fr1,000', 1000], ['Fr1,234.50', 1234.5]]) {
  assert.equal(parseCashCount(report('TEST', text)).totals.CHF, expected, text);
}

console.log('CHF Fr-prefix Cash Count parsing: PASS');
