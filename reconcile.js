/**
 * Computes expected closing totals from an opening cash count + a list of transactions,
 * then compares against the actual closing cash count.
 *
 * Company perspective:
 *  - Client "BUY"  => client buys FCY from company, pays PHP => company FCY down, PHP up
 *  - Client "SELL" => counterparty sells FCY to company, company pays PHP => company FCY up, PHP down
 *
 * transactions: array from parse.parseTransaction (nulls filtered out)
 * opening / actual: totals objects from parse.parseCashCount, e.g. { USD: 123, PHP: 456.78, ... }
 */
function reconcile(opening, actual, transactions, adjustments = {}) {
  const expected = { ...opening };
  let phpDelta = 0;

  for (const tx of transactions) {
    if (!tx || !tx.movements || !tx.movements.length) continue;

    // Client tickets: BUY/SELL describes the CLIENT's action (client BUY = client
    // buys FCY from Psulit => company FCY down, PHP up).
    // Wholesale/corporate tickets: BUY/SELL describes what PSULIT itself did
    // (Psulit SELL = Psulit sells FCY to the counterparty => company FCY down,
    // PHP up) — the opposite mapping from client tickets for the same verb.
    const effectiveAction = mv => (tx.isWholesale
      ? (mv.action === 'SELL' ? 'BUY' : 'SELL')
      : mv.action);

    for (const mv of tx.movements) {
      const sign = effectiveAction(mv) === 'BUY' ? -1 : 1; // company FCY change
      expected[mv.ccy] = (expected[mv.ccy] || 0) + sign * mv.fcyAmount;
    }
    if (tx.phpAmount != null) {
      const phpSign = effectiveAction(tx.movements[0]) === 'BUY' ? 1 : -1;
      phpDelta += phpSign * tx.phpAmount;
    }
  }
  expected.PHP = (expected.PHP || 0) + phpDelta;

  // Flat adjustments (e.g. Hive top-ups/withdrawals) apply directly, no buy/sell logic.
  for (const [key, delta] of Object.entries(adjustments)) {
    expected[key] = (expected[key] || 0) + delta;
  }

  const allCcy = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const results = [];
  for (const ccy of allCcy) {
    const exp = round(expected[ccy] || 0, ccy);
    const act = round(actual[ccy] || 0, ccy);
    const diff = round(act - exp, ccy);
    const tolerance = ccy === 'PHP' ? 1 : 0.01;
    results.push({
      ccy,
      expected: exp,
      actual: act,
      diff,
      match: Math.abs(diff) <= tolerance
    });
  }
  return results.sort((a, b) => a.ccy.localeCompare(b.ccy));
}

function round(n, ccy) {
  return Math.round(n * 100) / 100;
}

module.exports = { reconcile };
