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
  pool ||= new Pool({ connectionString: process.env.SCRATCH_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
  const { rows } = await pool.query(`SELECT tx.scratch_id, tx.branch, tx.transaction_type, tx.official_timestamp,
    tx.status, tx.total_value, tx.cash_received,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('ticket_id', t.ticket_id, 'serial_code', t.serial_code,
      'product_id', t.product_id, 'branch', t.branch)), '[]'::jsonb)
      FROM public.scratch_tickets t WHERE t.sold_scratch_id = tx.scratch_id) AS tickets,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'quantity', i.quantity,
      'face_value', i.face_value, 'line_total', i.line_total)), '[]'::jsonb)
      FROM public.scratch_transaction_items i WHERE i.scratch_id = tx.scratch_id) AS items,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('ticket_id', c.ticket_id, 'payout_amount', c.payout_amount,
      'sale_scratch_id', c.sale_scratch_id, 'ticket_sale_id', t.sold_scratch_id,
      'branch', t.branch, 'sale_status', s.status)), '[]'::jsonb)
      FROM public.scratch_payout_claims c
      LEFT JOIN public.scratch_tickets t ON t.ticket_id = c.ticket_id
      LEFT JOIN public.scratch_transactions s ON s.scratch_id = c.sale_scratch_id
      WHERE c.payout_scratch_id = tx.scratch_id) AS claims,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('status', d.status,
      'message_id', d.telegram_message_id)), '[]'::jsonb)
      FROM public.scratch_telegram_deliveries d
      WHERE d.scratch_id = tx.scratch_id AND d.event_type = tx.transaction_type) AS telegram
    FROM public.scratch_transactions tx WHERE tx.branch = $1 AND tx.official_timestamp > $2 AND tx.official_timestamp <= $3
    ORDER BY tx.official_timestamp, tx.scratch_id`, [branch, new Date(oldest * 1000), new Date(latest * 1000)]);
  return rows;
}
function reconcileScratch({ opening, closing, transactions, movements, branch, oldest, latest }) {
  try {
    const initial = cents(opening), actual = cents(closing);
    if (!Array.isArray(transactions) || !Array.isArray(movements)) throw new Error('Transaction or cash movement feed unavailable');
    const evidence = [], excluded = [], telegramMissing = [], seen = new Map(), soldTickets = new Set(), paidTickets = new Set();
    let sales = 0, payouts = 0, cashMovements = 0;
    let expected = initial;
    for (const tx of transactions) {
      if (tx.branch !== branch) throw new Error('Scratch branch mismatch');
      const ts = Date.parse(tx.official_timestamp) / 1000;
      if (!Number.isFinite(ts)) throw new Error('Invalid Scratch timestamp');
      if (ts <= oldest || ts > latest || ['Voided', 'Corrected'].includes(tx.status)) continue;
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
        if (!Array.isArray(tx.tickets) || !Array.isArray(tx.items)) throw new Error('Sale ticket evidence unavailable');
        if (!tx.tickets.length) {
          excluded.push({ reference: tx.scratch_id, amount: value / 100, reason: 'No allocated tickets; possible test or incomplete posting' });
          continue;
        }
        const quantities = new Map();
        let supportedValue = 0;
        for (const item of tx.items) {
          const qty = Number(item.quantity), price = cents(item.face_value);
          if (!item.product_id || !Number.isInteger(qty) || qty <= 0 || price <= 0 || cents(item.line_total) !== qty * price) throw new Error('Invalid Scratch sale line');
          quantities.set(String(item.product_id), (quantities.get(String(item.product_id)) || 0) + qty);
          supportedValue += qty * price;
        }
        for (const ticket of tx.tickets) {
          if (!ticket.ticket_id || !ticket.serial_code || ticket.branch !== branch || soldTickets.has(ticket.ticket_id)) throw new Error('Missing, duplicate or wrong-branch sale ticket');
          soldTickets.add(ticket.ticket_id);
          const product = String(ticket.product_id);
          quantities.set(product, (quantities.get(product) || 0) - 1);
        }
        if (supportedValue !== value || [...quantities.values()].some(qty => qty !== 0)) throw new Error('Allocated tickets differ from sale value or quantity');
        effect = cents(tx.cash_received);
        if (effect !== value) throw new Error('Sale cash differs from sale value; review required');
        sales += effect;
      } else if (tx.transaction_type === 'PAYOUT') {
        if (!Array.isArray(tx.claims) || tx.claims.length !== 1) throw new Error('Payout ticket claim missing or ambiguous');
        const claim = tx.claims[0];
        if (!claim.ticket_id || paidTickets.has(claim.ticket_id) || claim.branch !== branch || claim.sale_status !== 'Posted' || !claim.sale_scratch_id || claim.sale_scratch_id !== claim.ticket_sale_id || cents(claim.payout_amount) !== value) throw new Error('Payout does not match a unique sold-ticket claim');
        paidTickets.add(claim.ticket_id);
        effect = -value;
        payouts += value;
      }
      else if (tx.transaction_type === 'REPLENISHMENT') throw new Error('Replenishment cash funding requires review');
      else throw new Error('Unrecognized Scratch transaction type');
      expected += effect;
      if (!Array.isArray(tx.telegram) || !tx.telegram.some(d => d.status === 'sent' && /^\d+$/.test(String(d.message_id)))) telegramMissing.push(tx.scratch_id);
      evidence.push({ reference: tx.scratch_id, amount: effect / 100 });
    }
    const movementIds = new Set();
    for (const movement of movements) {
      if (!movement.reference || movementIds.has(movement.reference)) throw new Error('Missing or duplicate cash movement reference');
      movementIds.add(movement.reference);
      if (seen.has(movement.reference)) throw new Error('Scratch transaction also appears in cash logs; review duplicate');
      const effect = cents(movement.amount);
      expected += effect;
      cashMovements += effect;
      evidence.push({ reference: movement.reference, amount: effect / 100 });
    }
    return { status: excluded.length ? 'REVIEW' : actual === expected ? 'MATCH' : 'DISCREPANCY', opening: initial / 100, actual: actual / 100, expected: expected / 100, difference: (actual - expected) / 100, sales: sales / 100, payouts: payouts / 100, cashMovements: cashMovements / 100, evidence, excluded, telegramMissing };
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: error.message };
  }
}
function scratchSummary(result) {
  if (result.status === 'UNAVAILABLE') return `⚠️ Scratch cash audit unavailable — ${result.reason}.`;
  const money = n => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${result.status === 'REVIEW' ? '⚠️' : result.status === 'MATCH' ? '✅' : '❌'} Scratch cash${result.status === 'REVIEW' ? ' — provisional; review required' : ''}:\n${money(result.opening)} opening + ${money(result.sales)} ticket-supported sales − ${money(result.payouts)} claimed payouts + ${money(result.cashMovements)} net cash movements = ${money(result.expected)} expected.\n${money(result.actual)} actual − ${money(result.expected)} expected = ${money(result.difference)} difference.\nSource: Scratch ticket allocations, payout claims and cash logs. Voided/corrected entries excluded. Physical ticket inventory is not verified by this cash check.\nTelegram: ${result.telegramMissing.length ? `delivery not confirmed for ${result.telegramMissing.join(', ')}; cash remains included when ticket-supported` : 'delivery receipts recorded for included transactions'}. This is not an independent read of Telegram history.\n${result.excluded.length ? `Excluded pending review (not confirmed test entries): ${result.excluded.map(row => `${row.reference} ${money(row.amount)} — ${row.reason}`).join('; ')}. No confirmed shortage or clearance until reviewed.\n` : ''}${result.evidence.map(row => `${row.reference}: ${money(row.amount)}`).join('\n')}`;
}
module.exports = { readScratchTransactions, reconcileScratch, scratchSummary };
