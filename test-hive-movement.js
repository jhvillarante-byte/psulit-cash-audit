const assert = require('assert');
const { buildStructuredHiveMovements, reconcileHiveCash, structuredMovementEffect } = require('./audit');

const movements = buildStructuredHiveMovements([
  { expenseId: 'H1', category: 'Hive In', hiveTransactionReference: ' DMBR93PMDPR ', submittedAtUtc: '2026-09-17T10:00:01Z', actualAmount: 11000, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', assetType: 'Physical Cash' },
  { expenseId: 'H2', category: 'Hive Out', hiveTransactionReference: 'OUT-1', submittedAtUtc: '2026-09-17T11:00:00Z', actualAmount: 1500, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', assetType: 'Physical Cash' },
  { expenseId: 'H1', category: 'Hive In', hiveTransactionReference: 'DUP', submittedAtUtc: '2026-09-17T11:00:01Z', actualAmount: 999, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', assetType: 'Physical Cash' },
  { expenseId: 'OUTSIDE', category: 'Hive In', hiveTransactionReference: 'OUTSIDE', submittedAtUtc: '2026-09-17T09:00:00Z', actualAmount: 500, actualCurrency: 'PHP', fundDrawerUsed: 'Hive', assetType: 'Physical Cash' }
], Date.parse('2026-09-17T10:00:00Z') / 1000, Date.parse('2026-09-17T12:00:00Z') / 1000);
assert.strictEqual(movements.length, 2);
assert.strictEqual(movements[0].amount, 11000);
assert.strictEqual(movements[1].amount, -1500);
assert.strictEqual(movements[0].reference, 'DMBR93PMDPR');
const match = reconcileHiveCash({ previous: 96272.10, actual: 105772.10, movements, feedAvailable: true });
assert.strictEqual(match.status, 'MATCH');
assert.strictEqual(match.expected, 105772.10);
assert.deepStrictEqual(structuredMovementEffect({ category: 'Hive In', actualCurrency: 'PHP', actualAmount: 11000, fundDrawerUsed: 'Hive', assetType: 'Physical Cash' }), []);
assert.strictEqual(reconcileHiveCash({ previous: 1, actual: 1, movements: [], feedAvailable: false }).status, 'UNAVAILABLE');
console.log('Hive structured movement reconciliation: PASS');
