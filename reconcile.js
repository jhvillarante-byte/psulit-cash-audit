/**
 * Computes expected closing totals from an opening cash count + a list of transactions,
 * then compares against the actual closing cash count.
 *
 * Ticket convention (confirmed against real money-changer usage — same for
 * BOTH retail client tickets and wholesale/corporate tickets, no distinction
 * needed):
 *   "BUY <amount> <CCY>"  => the counterparty hands Psulit that FX, Psulit
 *                            hands back PHP => Psulit's FX stock goes UP,
 *                            Psulit's PHP goes DOWN.
 *   "SELL <amount> <CCY>" => Psulit hands the counterparty that FX, the
 *                            counterparty hands back PHP => Psulit's FX
 *                            stock goes DOWN, Psulit's PHP goes UP.
 *
 * transactions: array from parse.parseTransaction (nulls filtered out)
 * opening / actual: totals objects from parse.parseCashCount, e.g. { USD: 123, PHP: 456.78, ... }
 */
function reconcile(opening, actual, transactions, adjustments = {}) {
  const expected = { ...opening };
  let phpDelta = 0;

  for (const tx of transactions) {
    if (!tx || !tx.movements || !tx.movements.length) continue;

    // BUY = Psulit's FX stock increases (Psulit received the FX).
    // SELL = Psulit's FX stock decreases (Psulit gave the FX away).
    // This holds identically for retail and wholesale/corporate tickets —
    // there is no separate "counterparty perspective" to flip.
    for (const mv of tx.movements) {
      const sign = mv.action === 'BUY' ? 1 : -1;
      expected[mv.ccy] = (expected[mv.ccy] || 0) + sign * mv.fcyAmount;
    }
    if (tx.phpAmount != null) {
      // PHP moves opposite to the FX side: BUY pays PHP out (-), SELL takes PHP in (+).
      const phpSign = tx.movements[0].action === 'BUY' ? -1 : 1;
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
