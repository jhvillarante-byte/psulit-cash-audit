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
function reconcile(opening, actual, transactions) {
  const expected = { ...opening };
  let phpDelta = 0;

  for (const tx of transactions) {
    if (!tx || tx.fcyAmount == null) continue;
    const sign = tx.action === 'BUY' ? -1 : 1; // company FCY change
    expected[tx.ccy] = (expected[tx.ccy] || 0) + sign * tx.fcyAmount;
    if (tx.phpAmount != null) {
      phpDelta += tx.action === 'BUY' ? tx.phpAmount : -tx.phpAmount;
    }
  }
  expected.PHP = (expected.PHP || 0) + phpDelta;

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
