const assert = require('assert');
const { applyApprovedOpeningCorrections } = require('./corrections');
const { correctionFromResolution, RESOLUTION_EVENT } = require('./discrepancy-resolutions');
const { reconcile } = require('./reconcile');

const lockedPriorClosing = {
  branch: 'Alphaland',
  refCode: 'PSC-ALP-PRIOR-CLOSE',
  totals: { PHP: 205832.18, TWD: 1000 }
};
const formal = (currency, correctedValue, ts) => ({
  ts,
  text: '✅ DISCREPANCY RESOLVED',
  metadata: { event_type: RESOLUTION_EVENT, event_payload: {
    reason: 'Cash count encoding error',
    affected_ref: lockedPriorClosing.refCode,
    closing_ref: lockedPriorClosing.refCode,
    currency,
    corrected_value: String(correctedValue),
    resolver: 'U-MANAGER',
    resolved_at: '2026-09-12T05:00:00.000Z'
  } }
});

const phpOverlay = correctionFromResolution(formal('PHP', 200832.18, '200.001'), lockedPriorClosing, {
  channel: 'C-ALPHALAND', parentTs: '199.001'
});
const twdOverlay = correctionFromResolution(formal('TWD', 500, '200.002'), lockedPriorClosing, {
  channel: 'C-ALPHALAND', parentTs: '199.001'
});
const applied = applyApprovedOpeningCorrections(lockedPriorClosing, [phpOverlay, twdOverlay]);

assert.deepStrictEqual(lockedPriorClosing.totals, { PHP: 205832.18, TWD: 1000 }, 'locked count must remain immutable');
assert.strictEqual(applied.effectiveTotals.PHP, 200832.18);
assert.strictEqual(applied.effectiveTotals.TWD, 500);
assert.strictEqual(reconcile(applied.effectiveTotals, { PHP: 200832.18, TWD: 500 }, [])
  .every(result => result.match), true, 'later shift must use corrected effective opening');

const unresolved = { ts: '200.003', text: 'Irene says it should be lower' };
assert.strictEqual(correctionFromResolution(unresolved, lockedPriorClosing), null, 'ordinary replies must not alter balances');
assert.strictEqual(correctionFromResolution(formal('PHP', 200832.18, '200.004'), {
  ...lockedPriorClosing, refCode: 'OTHER-REF'
}), null, 'overlay must be reference-specific');
assert.strictEqual(applied.effectiveTotals.TWD, 500, 'PHP correction must not affect TWD and vice versa');
assert.throws(
  () => applyApprovedOpeningCorrections(lockedPriorClosing, [phpOverlay, phpOverlay]),
  /Duplicate approved correction/,
  'duplicate formal resolutions must not apply twice'
);

console.log('same-day corrected effective opening: PASS');
console.log('locked count immutability: PASS');
console.log('unresolved reply isolation: PASS');
console.log('currency/reference scoping: PASS');
console.log('duplicate overlay protection: PASS');

// Integration: discover only a formal event from the audit thread and carry its
// corrected closing forward as the next same-day shift's effective opening.
const slack = require('./slack');
slack.history = async () => [{
  ts: '199.001', reply_count: 1, text: 'Alphaland SHIFT AUDIT'
}];
slack.threadReplies = async () => [formal('PHP', 200832.18, '200.001')];
delete require.cache[require.resolve('./audit')];
const { resolutionOverlaysForCounts } = require('./audit');
(async () => {
  const overlays = await resolutionOverlaysForCounts('C-ALPHALAND', [lockedPriorClosing]);
  assert.strictEqual(overlays.length, 1);
  const laterOpening = applyApprovedOpeningCorrections(lockedPriorClosing, overlays);
  const php = reconcile(laterOpening.effectiveTotals, { PHP: 200832.18, TWD: 1000 }, [])
    .find(result => result.ccy === 'PHP');
  assert.deepStrictEqual(php, {
    ccy: 'PHP', expected: 200832.18, actual: 200832.18, diff: 0, match: true
  });
  console.log('formal Slack event overlay discovery: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
