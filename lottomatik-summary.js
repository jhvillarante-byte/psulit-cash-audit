const crypto = require('crypto');
const ExcelJS = require('exceljs');

const REQUIRED_COLUMNS = [
  'Bet Date',
  'Agent ID',
  'Game',
  'Draw ID',
  'Ticket Number',
  'Combinations',
  'Amount (₱)'
];

function parseManilaTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  const match = String(value || '').trim().match(
    /^(\d{4})[\/-](\d{2})[\/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
  );
  if (!match) throw new Error(`Invalid LottoMatik Bet Date: ${String(value || '')}`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

function slackTsToMillis(ts) {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('A valid Cash Count Slack timestamp is required.');
  }
  return Math.floor(seconds * 1000);
}

function parseLottomatikWallet(text) {
  const match = String(text || '').match(
    /(?:🎰\s*)?\*?LOTTOMATIK\*?[\s\S]*?Wallet Balance:\s*₱?\s*([\d,]+(?:\.\d{1,2})?)/i
  );
  if (!match) throw new Error('Locked Cash Count has no LottoMatik Wallet Balance.');
  const amount = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Locked Cash Count has an invalid LottoMatik Wallet Balance.');
  }
  return amount;
}

async function readTicketSalesWorkbook(input) {
  const workbook = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input)) await workbook.xlsx.load(input);
  else await workbook.xlsx.readFile(input);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('LottoMatik export contains no worksheet.');

  const headers = sheet.getRow(1).values.slice(1).map(value => String(value || '').trim());
  const missing = REQUIRED_COLUMNS.filter(column => !headers.includes(column));
  if (missing.length) throw new Error(`LottoMatik export is missing columns: ${missing.join(', ')}`);
  const index = Object.fromEntries(headers.map((header, offset) => [header, offset + 1]));
  const rows = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const amount = Number(String(row.getCell(index['Amount (₱)']).value ?? '').replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Invalid ticket-sale amount on row ${rowNumber}.`);
    }
    rows.push({
      timestampMs: parseManilaTimestamp(row.getCell(index['Bet Date']).value),
      game: String(row.getCell(index.Game).value || '').trim() || 'Unknown Game',
      amount
    });
  }
  return rows;
}

function summarizeTicketSales(rows, openingSlackTs, closingSlackTs) {
  const openingMs = slackTsToMillis(openingSlackTs);
  const closingMs = slackTsToMillis(closingSlackTs);
  if (openingMs >= closingMs) throw new Error('Opening must precede Closing.');
  const included = rows.filter(row => row.timestampMs >= openingMs && row.timestampMs <= closingMs);
  const games = new Map();
  let total = 0;
  for (const row of included) {
    total += row.amount;
    const current = games.get(row.game) || { game: row.game, transactions: 0, amount: 0 };
    current.transactions += 1;
    current.amount += row.amount;
    games.set(row.game, current);
  }
  return {
    transactions: included.length,
    total,
    games: [...games.values()].sort((a, b) => a.game.localeCompare(b.game))
  };
}

function peso(value, { signed = false } = {}) {
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}₱${value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function manilaDateTime(slackTs) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit'
  }).format(new Date(slackTsToMillis(slackTs)));
}

function buildDailySummary({ opening, closing, sales }) {
  const openingWallet = parseLottomatikWallet(opening.text);
  const closingWallet = parseLottomatikWallet(closing.text);
  const walletChange = closingWallet - openingWallet;
  const reportDate = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', month: 'long', day: 'numeric', year: 'numeric'
  }).format(new Date(slackTsToMillis(closing.ts)));
  const breakdown = sales.games.length
    ? sales.games.map(item => `${item.game}: ${item.transactions} transaction${item.transactions === 1 ? '' : 's'} | ${peso(item.amount)}`).join('\n')
    : 'No ticket transactions in this reporting period.';

  return [
    '*🎰 PSULIT LOTTOMATIK — DAILY SUMMARY*',
    `*Alphaland | ${reportDate}*`,
    '',
    '*💰 WALLET BALANCE*',
    `Opening: ${peso(openingWallet)}`,
    `Closing: ${peso(closingWallet)}`,
    `*Change: ${peso(walletChange, { signed: true })}*`,
    '',
    '*🎟️ TICKET SALES*',
    `Transactions: ${sales.transactions}`,
    `Total Ticket Sales: *${peso(sales.total)}*`,
    '',
    '*📊 GAME BREAKDOWN*',
    breakdown,
    '',
    '*🕐 REPORTING PERIOD*',
    `Opening: ${manilaDateTime(opening.ts)}`,
    `Closing: ${manilaDateTime(closing.ts)}`,
    '',
    '_Daily summary only — LottoMatik wallet reconciliation audit is not yet enabled._'
  ].join('\n');
}

function reportKey({ opening, closing }) {
  return crypto.createHash('sha256')
    .update(['Alphaland', opening.refCode, opening.ts, closing.refCode, closing.ts].join('|'))
    .digest('hex');
}

async function publishIdenticalSummary({ key, text, metadata = {}, state, postSlack, postTelegram }) {
  if (state.ensure) await state.ensure(key, metadata);
  const current = await state.get(key) || {};
  const posted = destination => current[destination] &&
    (current[destination].status === 'posted' || !current[destination].status);
  const result = { duplicate: posted('slack') && posted('telegram'), ...current };
  for (const [destination, publish] of [['slack', postSlack], ['telegram', postTelegram]]) {
    if (posted(destination)) continue;
    const claimed = state.claim ? await state.claim(key, destination) : true;
    if (!claimed) continue;
    try {
      const receipt = await publish(text);
      result[destination] = receipt;
      if (state.complete) await state.complete(key, destination, receipt);
      else await state.set(key, { ...(await state.get(key) || {}), [destination]: receipt });
    } catch (error) {
      if (state.fail) await state.fail(key, destination, error);
      throw error;
    }
  }
  return result;
}

module.exports = {
  REQUIRED_COLUMNS,
  parseManilaTimestamp,
  parseLottomatikWallet,
  readTicketSalesWorkbook,
  summarizeTicketSales,
  buildDailySummary,
  reportKey,
  publishIdenticalSummary
};
