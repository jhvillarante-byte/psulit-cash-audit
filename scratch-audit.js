// Read the same transaction ledger used by PSulit Scratch Bot. No Telegram
// history scraping, financial writes, or Render service requests are required.
const { Pool } = require('pg');
let pool;
const cents = value => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) throw new Error('Missing or invalid amount');
  return Math.round(Number(value) * 100);
};
async function readScratchTransactions(branch, oldest, latest) {
  if (!process.env.SCRATCH_DATABASE_URL) throw new Error('Scratch ledger connection is not configured');
  pool ||= new Pool({ connectionString: process.env.SCRATCH_DATABASE_URL, max: 2, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
  const { rows } = await pool.query(`SELECT scratch_id, branch, transaction_type, official_timestamp, status, total_value, cash_received
    FROM public.scratch_transactions WHERE branch = $1 AND official_timestamp > $2 AND official_timestamp <= $3
    ORDER BY official_timestamp, scratch_id`, [branch, new Date(oldest * 1000), new Date(latest * 1000)]);
  return rows;
}
function reconcileScratch({ opening, closing, transactions, movements, branch, oldest, latest }) {
  try {
    const initial = cents(opening), actual = cents(closing);
    if (!Array.isArray(transactions) || !Array.isArray(movements)) throw new Error('Transaction or cash movement feed unavailable');
    const evidence = [], seen = new Map();
    let expected = initial;
    for (const tx of transactions) {
      if (tx.branch !== branch) throw new Error('Scratch branch mismatch');
      const ts = Date.parse(tx.official_timestamp) / 1000;
      if (!Number.isFinite(ts)) throw new Error('Invalid Scratch timestamp');
      if (ts <= oldest || ts > latest || tx.status === 'Voided') continue;
      if (tx.status !== 'Posted') throw new Error('Unrecognized Scratch status');
      if (!tx.scratch_id) throw new Error('Scratch reference missing');
      const fingerprint = JSON.stringify(tx);
      if (seen.has(tx.scratch_id)) {
        if (seen.get(tx.scratch_id) !== fingerprint) throw new Error('Conflicting Scratch reference');
        continue;
      }
      seen.set(tx.scratch_id, fingerprint);
      const value = cents(tx.total_value);
      if (value < 0) throw new Error('Invalid Scratch value');
      let effect;
      if (tx.transaction_type === 'SALE') {
        effect = cents(tx.cash_received);
        if (effect !== value) throw new Error('Sale cash differs from sale value; review required');
      } else if (tx.transaction_type === 'PAYOUT') effect = -value;
      else if (tx.transaction_type === 'REPLENISHMENT') throw new Error('Replenishment cash funding requires review');
      else throw new Error('Unrecognized Scratch transaction type');
      expected += effect;
      evidence.push({ reference: tx.scratch_id, amount: effect / 100 });
    }
    const movementIds = new Set();
    for (const movement of movements) {
      if (!movement.reference || movementIds.has(movement.reference)) throw new Error('Missing or duplicate cash movement reference');
      movementIds.add(movement.reference);
      if (seen.has(movement.reference)) throw new Error('Scratch transaction also appears in cash logs; review duplicate');
      const effect = cents(movement.amount);
      expected += effect;
      evidence.push({ reference: movement.reference, amount: effect / 100 });
    }
    return { status: actual === expected ? 'MATCH' : 'DISCREPANCY', opening: initial / 100, actual: actual / 100, expected: expected / 100, difference: (actual - expected) / 100, evidence };
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: error.message };
  }
}
function scratchSummary(result) {
  if (result.status === 'UNAVAILABLE') return `⚠️ Scratch cash audit unavailable — ${result.reason}.`;
  const money = n => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${result.status === 'MATCH' ? '✅' : '❌'} Scratch cash: Expected ${money(result.expected)} | Actual ${money(result.actual)} | Difference ${money(result.difference)}\nSource: Scratch app ledger used by PSulit Scratch Bot + cash logs. Voided entries excluded. Physical ticket inventory is not verified by this cash check.\n${result.evidence.map(row => `${row.reference}: ${money(row.amount)}`).join('\n')}`;
}
module.exports = { readScratchTransactions, reconcileScratch, scratchSummary };
