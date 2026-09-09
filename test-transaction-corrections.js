'use strict';

const assert = require('assert');
const { parseTransaction } = require('./parse');
const { reconcile, transactionPhpEffect } = require('./reconcile');
const {
  APPROVED_TRANSACTION_CORRECTIONS,
  applyApprovedTransactionCorrections,
  buildTransactionCorrectionRegistry,
  isApprovedTransactionCorrection
} = require('./corrections');

const ar1630 = `AR 0001630 — 09/08/2026, 05:50 PM
CZARINA
SELL 5,536 USD @62.4 → ₱345,446.40
SELL 10,000 JPY @0.4029 → ₱4,029.00
SELL 200 AUD @44.27 → ₱8,854.00
SELL 40 GBP @83.77 → ₱3,350.80
BUY 1,150 CAD @44.76 → ₱51,474.00
SELL 555 EUR @71.82 → ₱39,860.10
Total: ₱453,014.30`;

const original = parseTransaction(ar1630);
assert(original, 'AR 0001630 fixture must parse');
assert.strictEqual(original.movements.find(m => m.ccy === 'CAD').action, 'BUY');
assert.strictEqual(transactionPhpEffect(original), 350066.30);

const result = applyApprovedTransactionCorrections(original);
const corrected = result.effectiveTransaction;
assert.strictEqual(result.applied.length, 1);
assert.strictEqual(corrected.movements.find(m => m.ccy === 'CAD').action, 'SELL');
assert.strictEqual(original.movements.find(m => m.ccy === 'CAD').action, 'BUY', 'original ticket must remain immutable');
assert.strictEqual(transactionPhpEffect(corrected), 453014.30);

const cadOriginal = reconcile({ CAD: 150 }, { CAD: 0 }, [
  { ref: '1627', movements: [{ action: 'BUY', ccy: 'CAD', fcyAmount: 1000 }], phpAmount: null },
  original
]).find(row => row.ccy === 'CAD');
const cadCorrected = reconcile({ CAD: 150 }, { CAD: 0 }, [
  { ref: '1627', movements: [{ action: 'BUY', ccy: 'CAD', fcyAmount: 1000 }], phpAmount: null },
  corrected
]).find(row => row.ccy === 'CAD');
assert.strictEqual(cadOriginal.expected, 2300);
assert.strictEqual(cadCorrected.expected, 0);
assert.strictEqual(cadCorrected.match, true);

assert.throws(
  () => buildTransactionCorrectionRegistry([
    APPROVED_TRANSACTION_CORRECTIONS[0],
    APPROVED_TRANSACTION_CORRECTIONS[0]
  ]),
  /Duplicate or conflicting/
);
assert.throws(
  () => applyApprovedTransactionCorrections({ ...original, ref: '1630', movements: original.movements.map(m =>
    m.ccy === 'CAD' ? { ...m, fcyAmount: 1149 } : { ...m }
  ) }),
  /movement mismatch/
);
assert.strictEqual(
  applyApprovedTransactionCorrections({ ...original, ref: '9999' }).applied.length,
  0,
  'wrong transaction references must not receive the correction'
);
assert.throws(
  () => applyApprovedTransactionCorrections({ ...original, raw: 'AR 0001630 — unrelated transaction' }),
  /source evidence mismatch/
);
assert.strictEqual(
  isApprovedTransactionCorrection({
    ...APPROVED_TRANSACTION_CORRECTIONS[0],
    id: 'unapproved',
    approval: { ...APPROVED_TRANSACTION_CORRECTIONS[0].approval, status: 'unapproved' }
  }),
  false
);

// A correction applied to its immutable source is deterministic. Applying it
// to an already corrected derivative is rejected, preventing double counting.
assert.deepStrictEqual(
  applyApprovedTransactionCorrections(original).effectiveTransaction,
  corrected
);
assert.throws(
  () => applyApprovedTransactionCorrections(corrected),
  /original direction mismatch/
);

// The verified expense path remains independent: only an explicit adjustment
// changes PHP, and it is counted once.
const beforeExpense = reconcile({ PHP: 264527.65 }, { PHP: 617541.95 }, [corrected])
  .find(row => row.ccy === 'PHP');
const afterExpense = reconcile({ PHP: 264527.65 }, { PHP: 617541.95 }, [corrected], { PHP: -100000 })
  .find(row => row.ccy === 'PHP');
assert.strictEqual(beforeExpense.diff, -100000);
assert.strictEqual(afterExpense.diff, 0);

console.log('Transaction correction tests passed.');
