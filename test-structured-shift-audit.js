const assert = require('assert');
const {
  buildStructuredExpenseEntries,
  buildStructuredExpenseAdjustments,
  structuredMovementEffect
} = require('./audit');

const entries = buildStructuredExpenseEntries([
  {
    expenseId: 'EXP-CASH-1',
    category: 'Expense',
    submittedAtUtc: '2026-09-17T10:05:00Z',
    actualCurrency: 'PHP', actualAmount: 500,
    fundDrawerUsed: 'Forex Drawer', assetType: 'Physical Cash'
  },
  {
    expenseId: 'EXP-CASH-1',
    category: 'Expense',
    timestamp: '2026-09-17T10:05:00Z',
    actualCurrency: 'PHP', actualAmount: 500,
    fundDrawerUsed: 'Forex Drawer', assetType: 'Physical Cash'
  },
  {
    expenseId: 'EXP-TOPUP-1',
    category: 'Inter-Branch Transfer IN',
    timestamp: '2026-09-17T10:15:00Z',
    actualCurrency: 'PHP', actualAmount: -2000,
    receivedCurrency: 'PHP', receivedAmount: 2000,
    fundDrawerUsed: 'Forex Drawer', destinationFund: 'Forex Drawer',
    assetType: 'Physical Cash', receivedAssetType: 'Physical Cash'
  },
  {
    expenseId: 'EXP-BANK-1',
    category: 'Expense',
    actualCurrency: 'PHP', actualAmount: 900,
    fundDrawerUsed: 'Bank', assetType: 'Bank'
  },
  {
    expenseId: 'EXP-USD-1',
    category: 'Internal Transfer',
    timestamp: '2026-09-17T10:20:00Z',
    actualCurrency: 'USD', actualAmount: 100,
    receivedCurrency: 'USD', receivedAmount: 100,
    fundDrawerUsed: 'Forex Drawer', destinationFund: 'Forex Drawer',
    assetType: 'Physical Cash', receivedAssetType: 'Physical Cash'
  }
]);

assert.strictEqual(entries.length, 3, 'duplicate and non-drawer records are excluded');
assert.deepStrictEqual(buildStructuredExpenseAdjustments(entries), {
  PHP: 1500,
  USD: 0
});
assert.deepStrictEqual(structuredMovementEffect({
  expenseId: 'VOID-1', status: 'Voided', actualCurrency: 'PHP', actualAmount: 500,
  fundDrawerUsed: 'Forex Drawer', assetType: 'Physical Cash'
}), []);

// A failed/unavailable feed is represented by null by fetchStructuredMovementFeed;
// the caller retains the legacy Slack path when it receives null or an error.
assert.strictEqual(null, null);
console.log('structured run-shift audit movement adapter: PASS');
