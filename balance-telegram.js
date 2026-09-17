const SYMBOLS = Object.freeze({
  PHP: '₱', USD: '$', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩',
  CNY: '¥', HKD: 'HK$', SGD: 'S$', TWD: 'NT$', AUD: 'A$', CAD: 'C$'
});

function affectedCurrencies(lines) {
  const currencies = [];
  for (const line of lines || []) {
    const ccy = String(line.ccy || line.currency || '').toUpperCase();
    if (ccy && !currencies.includes(ccy)) currencies.push(ccy);
  }
  if (!currencies.includes('PHP')) currencies.push('PHP');
  return currencies;
}

function formatBalanceTelegramMessage({ branch, arNumber, lines, balances }) {
  const byCurrency = new Map((balances || []).map(item => [String(item.ccy).toUpperCase(), Number(item.balance)]));
  const rows = affectedCurrencies(lines)
    .filter(ccy => byCurrency.has(ccy))
    .map(ccy => {
      const value = byCurrency.get(ccy);
      const symbol = SYMBOLS[ccy] || '';
      const decimals = ccy === 'PHP' ? 2 : 0;
      return `${ccy}: ${symbol}${value.toLocaleString('en-PH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
    });
  if (!rows.length) return '';
  return `*${String(branch).toUpperCase()} — Updated Balance*\nAR ${String(arNumber).padStart(7, '0')}\n\n${rows.join('\n')}`;
}

class BalanceNotificationTracker {
  constructor() {
    this.processing = new Set();
    this.sent = new Set();
  }

  begin(key) {
    if (this.sent.has(key) || this.processing.has(key)) return false;
    this.processing.add(key);
    return true;
  }

  succeeded(key) {
    this.processing.delete(key);
    this.sent.add(key);
  }

  failed(key) {
    this.processing.delete(key);
  }
}

module.exports = { SYMBOLS, affectedCurrencies, formatBalanceTelegramMessage, BalanceNotificationTracker };
