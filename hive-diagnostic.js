const { parseHiveEntry } = require('./parse');

function checkpointType(parsed) {
  const shift = String(parsed?.shift || '').toLowerCase();
  const phase = String(parsed?.phase || '').toLowerCase();
  if (shift.includes('mid')) return 'Midshift';
  if (phase === 'closing' || shift.includes('closing')) return 'Closing';
  if (phase === 'opening' || shift.includes('opening') || shift.includes('morning')) return 'Opening';
  return null;
}

function hiveBalance(parsed, rawText = '') {
  const others = parsed?.others || {};
  const key = Object.keys(others).find(name => /^hive(?: commission)?(?: receivable)?$/i.test(name));
  if (key) return Number(others[key]);
  const match = String(rawText).match(/Hive(?:\s+Commission)?(?:\s+Receivable)?\s*:\s*(?:₱|PHP\s*)?([\d,]+(?:\.\d+)?)/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function analyzeHiveWindow(previous, current, hiveMessages) {
  const movements = [];
  let parseFailures = 0;
  for (const message of hiveMessages || []) {
    const parsed = parseHiveEntry(message.text || '');
    if (!parsed) {
      parseFailures += 1;
      continue;
    }
    movements.push({ timestamp: message.ts, amount: parsed.amount });
  }
  const duplicateKeys = new Set();
  const seen = new Set();
  for (const movement of movements) {
    const key = `${movement.timestamp}|${movement.amount}`;
    if (seen.has(key)) duplicateKeys.add(key);
    seen.add(key);
  }
  const netMovement = movements.reduce((sum, movement) => sum + movement.amount, 0);
  const openingHive = hiveBalance(previous.parsed, previous.message?.text || '');
  const actualHive = hiveBalance(current.parsed, current.message?.text || '');
  const expectedHive = openingHive == null ? null : openingHive + netMovement;
  const difference = expectedHive == null || actualHive == null ? null : actualHive - expectedHive;
  return {
    previousType: checkpointType(previous.parsed),
    currentType: checkpointType(current.parsed),
    previousTs: previous.message.ts,
    currentTs: current.message.ts,
    openingHive,
    movements,
    netMovement,
    expectedHive,
    actualHive,
    difference,
    status: difference == null ? 'INSUFFICIENT_DATA' : Math.abs(difference) < 0.01 ? 'MATCH' : 'DISCREPANCY',
    parseFailures,
    suspectedDuplicates: [...duplicateKeys]
  };
}

function formatDiagnosticReport(branch, windows) {
  const lines = [`*Hive Commission Audit — ${branch}*`, ''];
  if (!windows.length) return lines.concat('No completed Opening → Midshift or Midshift → Closing windows found.').join('\n');
  for (const window of windows) {
    lines.push(`${window.previousType} → ${window.currentType}`);
    lines.push(`Previous checkpoint: ${window.previousType} — ${new Date(Number(window.previousTs) * 1000).toISOString()}`);
    lines.push(`Current checkpoint: ${window.currentType} — ${new Date(Number(window.currentTs) * 1000).toISOString()}`);
    const previousLabel = window.previousType === 'Opening' ? 'Opening Hive' : 'Previous Hive';
    lines.push(`${previousLabel}: ${window.openingHive == null ? 'unavailable' : `₱${window.openingHive.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`}`);
    lines.push('Hive movements:');
    if (!window.movements.length) lines.push('  none');
    for (const movement of window.movements) lines.push(`  ${movement.amount >= 0 ? '+' : '−'}₱${Math.abs(movement.amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })} (${new Date(Number(movement.timestamp) * 1000).toISOString()})`);
    lines.push(`Net movement: ₱${window.netMovement.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);
    lines.push(`Expected Hive: ${window.expectedHive == null ? 'unavailable' : `₱${window.expectedHive.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`}`);
    lines.push(`Actual ${window.currentType}: ${window.actualHive == null ? 'unavailable' : `₱${window.actualHive.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`}`);
    lines.push(`Difference: ${window.difference == null ? 'unavailable' : `₱${window.difference.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`} — ${window.status}`);
    lines.push(`Messages inspected: ${window.movements.length + window.parseFailures}; parse failures: ${window.parseFailures}; suspected duplicates: ${window.suspectedDuplicates.length}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

module.exports = { checkpointType, hiveBalance, analyzeHiveWindow, formatDiagnosticReport };
