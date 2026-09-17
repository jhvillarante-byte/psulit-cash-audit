const assert = require('node:assert/strict');
const { affectedCurrencies, formatBalanceTelegramMessage, BalanceNotificationTracker } = require('./balance-telegram');

const lines = [
  { action: 'BUY', ccy: 'USD', fcyAmount: 200, phpAmount: 12518 }
];

assert.deepEqual(affectedCurrencies(lines), ['USD', 'PHP']);
assert.equal(
  formatBalanceTelegramMessage({
    branch: 'Alphaland',
    arNumber: '5838',
    lines,
    balances: [{ ccy: 'USD', balance: 1069 }, { ccy: 'PHP', balance: 102096.68 }]
  }),
  '*ALPHALAND — Updated Balance*\nAR 0005838\n\nUSD: $1,069\nPHP: ₱102,096.68'
);

assert.deepEqual(affectedCurrencies([
  { action: 'SELL', ccy: 'EUR', fcyAmount: 10, phpAmount: 600 }
]), ['EUR', 'PHP']);

const tracker = new BalanceNotificationTracker();
assert.equal(tracker.begin('Alphaland|event-1|5838'), true);
assert.equal(tracker.begin('Alphaland|event-1|5838'), false, 'Slack retry is suppressed while processing');
tracker.succeeded('Alphaland|event-1|5838');
assert.equal(tracker.begin('Alphaland|event-1|5838'), false, 'already-sent AR is suppressed');
assert.equal(tracker.begin('Alphaland|event-2|5839'), true);
tracker.failed('Alphaland|event-2|5839');
assert.equal(tracker.begin('Alphaland|event-2|5839'), true, 'failed delivery can be retried');

console.log('Balance Telegram formatting and deduplication tests passed');
