const assert = require('assert');
const {
  APPROVED_CORRECTIONS,
  applyApprovedOpeningCorrections,
  buildCorrectionRegistry,
  isExplicitlyApproved
} = require('./corrections');
const { parseCashCount } = require('./parse');
const { reconcile } = require('./reconcile');

const approved = APPROVED_CORRECTIONS[0];
const openingText = `PSULIT CASH COUNT REPORT
Branch: Solaire
Shift: Morning (Opening)
Teller: Cristina
Timestamp: 09/08/2026, 10:57:29
Ref Code: PSC-MTS2WZJV-9LGR
:flag-eu: EUR: €235.00
:flag-ca: CAD: C$150.00
:flag-ph: PHP: ₱795,651.95`;
const closingText = `PSULIT CASH COUNT REPORT
Branch: Solaire
Shift: Night (Closing)
Teller: Joan
Timestamp: 09/09/2026, 04:33:07
Ref Code: PSC-MTT4MJPX-SQXH
:flag-ph: PHP: ₱617,541.95`;

const opening = parseCashCount(openingText);
const closing = parseCashCount(closingText);
assert(opening && closing, 'cash-count fixtures must parse');

const corrected = applyApprovedOpeningCorrections(opening);
assert.strictEqual(opening.totals.EUR, 235, 'locked source count must remain unchanged');
assert.strictEqual(corrected.effectiveTotals.EUR, 255);
assert.strictEqual(corrected.applied.length, 1);
assert.deepStrictEqual(
  reconcile(corrected.effectiveTotals, { EUR: 0 }, [
    { movements: [{ action: 'BUY', ccy: 'EUR', fcyAmount: 300 }], phpAmount: null },
    { movements: [{ action: 'SELL', ccy: 'EUR', fcyAmount: 555 }], phpAmount: null }
  ]).find(result => result.ccy === 'EUR'),
  { ccy: 'EUR', expected: 0, actual: 0, diff: 0, match: true }
);

assert.strictEqual(applyApprovedOpeningCorrections({ ...opening, refCode: 'WRONG-REF' }).applied.length, 0);
assert.throws(() => buildCorrectionRegistry([approved, approved]), /Duplicate approved correction/);
assert.throws(() => buildCorrectionRegistry([approved, { ...approved, id: 'conflict', correctedValue: 275 }]), /Conflicting approved corrections/);
const unapproved = { ...approved, id: 'reply-only', approval: { ...approved.approval, status: 'unapproved' } };
assert.strictEqual(isExplicitlyApproved(unapproved), false);
assert.strictEqual(applyApprovedOpeningCorrections(opening, [unapproved]).effectiveTotals.EUR, 235);
assert.strictEqual(isExplicitlyApproved({ ...approved, id: 'arbitrary-reply', evidence: null }), false);
assert.throws(
  () => applyApprovedOpeningCorrections({ ...opening, totals: { ...opening.totals, EUR: 236 } }),
  /original value mismatch/
);

const slack = require('./slack');
const parse = require('./parse');
const phpMovements = new Map([
  ['1621', ['SELL', 625.70]],
  ['1622', ['BUY', 21363.00]],
  ['1623', ['SELL', 13734.00]],
  ['1624', ['BUY', 12474.00]],
  ['1625', ['BUY', 99752.00]],
  ['1626', ['BUY', 18711.00]],
  ['1627', ['BUY', 44480.00]],
  ['1628', ['BUY', 31185.00]],
  ['1629', ['BUY', 47769.00]],
  ['1630', ['SELL', 453014.30]],
  ['1631', ['SELL', 36261.00]],
  ['1632', ['BUY', 6238.00]],
  ['1633', ['BUY', 6238.00]],
  ['1634', ['BUY', 62380.00]],
  ['1635', ['BUY', 6238.00]],
  ['1636', ['BUY', 6238.00]],
  ['1637', ['BUY', 270047.00]],
  ['1638', ['SELL', 87766.00]],
  ['1639', ['BUY', 12476.00]],
  ['1640', ['BUY', 23922.00]]
]);

const originalParseTransaction = parse.parseTransaction;
parse.parseTransaction = text => {
  const ref = String(text).match(/AR\s+0*(\d+)/i)?.[1];
  const php = phpMovements.get(ref);
  if (!php) return originalParseTransaction(text);
  const movements = [];
  if (ref === '1622') movements.push({ action: 'BUY', ccy: 'EUR', fcyAmount: 300 });
  if (ref === '1627') movements.push({ action: 'BUY', ccy: 'CAD', fcyAmount: 1000 });
  if (ref === '1630') {
    movements.push({ action: 'SELL', ccy: 'EUR', fcyAmount: 555 });
    movements.push({ action: 'BUY', ccy: 'CAD', fcyAmount: 1150 });
  }
  if (!movements.length) movements.push({ action: php[0], ccy: 'USD', fcyAmount: 0 });
  return { ref, movements, phpAmount: php[1], raw: text };
};

slack.history = async (channelId, options = {}) => {
  if (channelId === 'cash' && options.oldest) return [];
  if (channelId === 'cash') return [
    { ts: '1788928387.000000', text: closingText },
    { ts: '1788837409.940699', text: openingText },
    { ts: '1788700000.000000', text: openingText.replace('PSC-MTS2WZJV-9LGR', 'OLDER-OPENING') }
  ];
  if (channelId === 'transactions') return [...phpMovements.keys()].map((ref, index) => ({
    ts: `178889${String(index).padStart(4, '0')}.000000`,
    text: `AR ${ref}`
  }));
  return [];
};
slack.postMessage = async () => { throw new Error('Slack posting must not occur in correction tests'); };
slack.replyInThread = async () => { throw new Error('Slack posting must not occur in correction tests'); };

delete require.cache[require.resolve('./audit')];
delete require.cache[require.resolve('./test-routes')];
const { runShiftAudit } = require('./audit');
const { findCountByReference } = require('./test-routes');

(async () => {
  const exact = await findCountByReference('cash', 'Solaire', 'PSC-MTS2WZJV-9LGR');
  assert.strictEqual(exact.parsed.refCode, 'PSC-MTS2WZJV-9LGR', 'historical lookup must select the exact reference');
  assert.strictEqual(await findCountByReference('cash', 'Solaire', 'MISSING-REF'), null);

  const branch = { name: 'Solaire', cashCountChannelId: 'cash', transactionsChannelId: 'transactions', expensesChannelId: null };
  const openingOverride = { ...opening, _ts: '1788837409.940699' };
  const first = await runShiftAudit(
    { ts: '1788928387.000000' }, closing, branch,
    { dryRun: true, openingCountOverride: openingOverride }
  );
  const second = await runShiftAudit(
    { ts: '1788928387.000000' }, closing, branch,
    { dryRun: true, openingCountOverride: openingOverride }
  );
  assert.strictEqual(first, second, 'historical reruns must be deterministic and not double-apply corrections');
  assert(first.includes('Approved opening correction — EUR: €235.00 → €255.00'));
  assert(first.includes('approved by Corporate Psulit; Slack 1788908073.626909'));
  assert(!first.includes('❗ EUR:'), 'EUR must reconcile after 255 + 300 - 555 = 0');
  assert(first.includes('❗ CAD: expected C$2,300.00, but missing from closing count'), 'CAD discrepancy must remain independent');
  assert(first.includes('❗ PHP: short ₱100,000.00'), 'PHP discrepancy must remain independent');
  assert.strictEqual(opening.totals.EUR, 235, 'reruns must not mutate the original count');

  console.log(first);
  console.log('\nCorrection tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
