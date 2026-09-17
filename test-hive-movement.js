const assert = require('assert');
const { buildStructuredHiveMovements, buildLegacyHiveMovements, reconcileHiveCash, structuredMovementEffect } = require('./audit');

const movements = buildStructuredHiveMovements([
  { expenseId: 'H1', category: 'Hive In', hiveTransactionReference: ' DMBR93PMDPR ', submittedAtUtc: '2026-09-17T10:00:01Z', actualAmount: 11000, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', assetType: 'Physical Cash' },
  { expenseId: 'H2', category: 'Hive Out', hiveTransactionReference: 'OUT-1', submittedAtUtc: '2026-09-17T11:00:00Z', actualAmount: 1500, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', assetType: 'Physical Cash' },
  { expenseId: 'H1', category: 'Hive In', hiveTransactionReference: 'DUP', submittedAtUtc: '2026-09-17T11:00:01Z', actualAmount: 999, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', assetType: 'Physical Cash' },
  { expenseId: 'OUTSIDE', category: 'Hive In', hiveTransactionReference: 'OUTSIDE', submittedAtUtc: '2026-09-17T09:00:00Z', actualAmount: 500, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', assetType: 'Physical Cash' },
  { expenseId: 'SOL-20260917-003', category: 'Internal Transfer', transferReference: '8XB6N3YKQNY', submittedAtUtc: '2026-09-17T12:00:02Z', actualAmount: 20000, actualCurrency: 'PHP', fundDrawerUsed: 'External / No PSulit Fund', destinationFund: 'Hive', assetType: 'Physical Cash', receivedAssetType: 'Physical Cash' },
  { expenseId: 'SOL-20260917-002', category: 'Internal Transfer', transferReference: 'AR 2501', submittedAtUtc: '2026-09-17T12:00:03Z', actualAmount: 14967.60, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', destinationFund: 'Forex Drawer', assetType: 'Physical Cash', receivedAssetType: 'Physical Cash' }
], Date.parse('2026-09-17T10:00:00Z') / 1000, Date.parse('2026-09-17T13:00:00Z') / 1000);
assert.strictEqual(movements.length, 4);
assert.strictEqual(movements[0].amount, 11000);
assert.strictEqual(movements[1].amount, -1500);
assert.strictEqual(movements[0].reference, 'DMBR93PMDPR');
assert.strictEqual(movements[2].amount, 20000);
assert.strictEqual(movements[2].category, 'Internal Transfer');
assert.strictEqual(movements[2].reference, 'SOL-20260917-003');
assert.strictEqual(movements[2].sourceFund, 'External / No PSulit Fund');
assert.strictEqual(movements[2].destinationFund, 'Hive');
assert.strictEqual(movements[3].amount, -14967.60);
assert.strictEqual(movements[3].reference, 'SOL-20260917-002');
const match = reconcileHiveCash({ previous: 91240.42, actual: 105772.82, movements, feedAvailable: true });
assert.strictEqual(match.status, 'MATCH');
assert.ok(Math.abs(match.expected - 105772.82) < 0.005);
const transferMovements = movements.filter(movement => movement.expenseId.startsWith('SOL-'));
const transferMatch = reconcileHiveCash({ previous: 91240.42, actual: 96272.82, movements: transferMovements, feedAvailable: true });
assert.strictEqual(transferMatch.status, 'MATCH');
assert.ok(Math.abs(transferMatch.expected - 96272.82) < 0.005);
const solaire = reconcileHiveCash({ previous: 91240.42, actual: 96272.10, movements: transferMovements, feedAvailable: true });
assert.strictEqual(solaire.status, 'DISCREPANCY');
assert.ok(Math.abs(solaire.difference + 0.72) < 0.005);
assert.deepStrictEqual(structuredMovementEffect({ category: 'Hive In', actualCurrency: 'PHP', actualAmount: 11000, fundDrawerUsed: 'Hive', assetType: 'Physical Cash' }), []);
assert.deepStrictEqual(structuredMovementEffect({ category: 'Internal Transfer', actualCurrency: 'PHP', actualAmount: 14967.60, fundDrawerUsed: 'Hive', destinationFund: 'Forex Drawer', assetType: 'Physical Cash', receivedAssetType: 'Physical Cash' }), [{ ccy: 'PHP', amount: 14967.60 }]);
assert.deepStrictEqual(structuredMovementEffect({ category: 'Internal Fund Transfer', actualCurrency: 'PHP', actualAmount: 20000, fundDrawerUsed: 'External / No PSulit Fund', destinationFund: 'Hive', assetType: 'Physical Cash', receivedAssetType: 'Physical Cash' }), []);
const legacy = buildLegacyHiveMovements([
  { ts: '1789648501.079779', text: '*INTERNAL FUND TRANSFER*\nRecord ID: SOL-20260917-003\n*Amount Given: 20,000.00 PHP*\nFrom: External / No PSulit Fund\nTo: Hive\nTransfer Reference: 8XB6N3YKQNY' },
  { ts: '1789648036.405499', text: '*INTERNAL FUND TRANSFER*\nRecord ID: SOL-20260917-002\n*Amount Given: 14,967.60 PHP*\nFrom: Hive\nTo: Forex Drawer\nTransfer Reference: AR 2501' }
], [{ expenseId: 'SOL-20260917-002', reference: 'AR 2501' }], 1789640000, 1789650000);
assert.strictEqual(legacy.length, 1);
assert.strictEqual(legacy[0].expenseId, 'SOL-20260917-003');
assert.strictEqual(legacy[0].reference, 'SOL-20260917-003');
assert.strictEqual(legacy[0].amount, 20000);
assert.strictEqual(legacy[0].legacy, true);
assert.strictEqual(legacy[0].sourceFund, 'External / No PSulit Fund');
assert.strictEqual(legacy[0].destinationFund, 'Hive');
assert.strictEqual(reconcileHiveCash({ previous: 1, actual: 1, movements: [], feedAvailable: false }).status, 'UNAVAILABLE');
console.log('Hive structured movement reconciliation: PASS');
