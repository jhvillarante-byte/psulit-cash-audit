const assert = require('node:assert/strict');
const { parseCashCount } = require('./parse');
const {
  checkpointType,
  hiveBalance,
  analyzeHiveWindow,
  formatDiagnosticReport
} = require('./hive-diagnostic');

const openingText = `*PSULIT CASH COUNT REPORT*
Branch: Alphaland
Shift: Morning (Opening)
Ref Code: OPEN-1
*OTHERS*
Hive: ₱1,000.00`;
const midshiftText = `*PSULIT CASH COUNT REPORT*
Branch: Alphaland
Shift: Midshift (Midshift)
Ref Code: MID-1
*OTHERS*
Hive: ₱1,125.00`;
const previous = { message: { ts: '1000.000000', text: openingText }, parsed: parseCashCount(openingText) };
const current = { message: { ts: '2000.000000', text: midshiftText }, parsed: parseCashCount(midshiftText) };

assert.equal(checkpointType(previous.parsed), 'Opening');
assert.equal(checkpointType(current.parsed), 'Midshift');
assert.equal(hiveBalance(previous.parsed, openingText), 1000);

const result = analyzeHiveWindow(previous, current, [
  { ts: '1500.000000', text: 'Hive Updated Balance\n*Amount: 100*' },
  { ts: '1750.000000', text: 'Hive Updated Balance\n*Amount: 25*' }
]);
assert.equal(result.netMovement, 125);
assert.equal(result.expectedHive, 1125);
assert.equal(result.actualHive, 1125);
assert.equal(result.status, 'MATCH');
assert.equal(result.parseFailures, 0);

const duplicate = analyzeHiveWindow(previous, current, [
  { ts: '1500.000000', text: 'Hive Updated Balance\n*Amount: 100*' },
  { ts: '1500.000000', text: 'Hive Updated Balance\n*Amount: 100*' }
]);
assert.equal(duplicate.suspectedDuplicates.length, 1);

const report = formatDiagnosticReport('Alphaland', [result]);
assert.match(report, /Hive Commission Audit/);
assert.match(report, /MATCH/);
assert.match(report, /\+₱100\.00/);
assert.doesNotMatch(report, /channel|token|teller|client/i);

console.log('Hive diagnostic tests passed');
