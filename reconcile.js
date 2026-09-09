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
function transactionPhpEffect(tx) {
  if (!tx || tx.phpAmount == null || !(tx.movements || []).length) return 0;

  const movements = tx.movements;
  const directions = new Set(movements.map(movement => movement.action));

  // Existing single-direction tickets retain their authoritative ticket total.
  if (directions.size === 1) {
    return movements[0].action === 'BUY' ? -tx.phpAmount : tx.phpAmount;
  }

  // Mixed wholesale tickets must be valued line by line. Using the first line
  // for the whole total silently assigns the wrong PHP direction.
  if (!movements.every(movement => Number.isFinite(movement.phpAmount))) {
    throw new Error(`Mixed-direction transaction AR ${tx.ref || 'unknown'} lacks line-level PHP settlement`);
  }

  return movements.reduce((sum, movement) => {
    const sign = movement.action === 'BUY' ? -1 : 1;
    return sum + sign * movement.phpAmount;
  }, 0);
}

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
    phpDelta += transactionPhpEffect(tx);
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

module.exports = { reconcile, transactionPhpEffect };
