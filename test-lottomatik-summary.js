const assert = require('assert');
const ExcelJS = require('exceljs');
const express = require('express');
const { PostgresDeliveryState } = require('./lottomatik-postgres-state');
const {
  createLottomatikRouter, findLatestAlphalandPair, signPreview, verifyPreview,
  createOwnerSession, verifyOwnerSession, ownerAuth
} = require('./lottomatik-routes');
const {
  parseLottomatikWallet,
  readTicketSalesWorkbook,
  summarizeTicketSales,
  buildDailySummary,
  reportKey,
  publishIdenticalSummary
} = require('./lottomatik-summary');

function slackTs(iso) { return String(new Date(iso).getTime() / 1000); }

class FakePgPool {
  constructor() { this.rows = new Map(); }
  async query(sql, params) {
    if (/to_regclass/.test(sql)) {
      return { rowCount: 1, rows: [{ table_name: 'lottomatik_summary_deliveries' }] };
    }
    if (/INSERT INTO public\.lottomatik_summary_deliveries/.test(sql)) {
      if (!this.rows.has(params[0])) this.rows.set(params[0], {
        report_key: params[0], slack_status: 'not_started', telegram_status: 'not_started',
        opening_ref: params[1], closing_ref: params[2]
      });
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT slack_status/.test(sql)) {
      const row = this.rows.get(params[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    const destination = /slack_status/.test(sql) ? 'slack' : 'telegram';
    const row = this.rows.get(params[0]);
    if (/status = 'pending'/.test(sql)) {
      if (!row || !['not_started', 'failed'].includes(row[`${destination}_status`])) return { rowCount: 0, rows: [] };
      row[`${destination}_status`] = 'pending';
      return { rowCount: 1, rows: [{ report_key: params[0] }] };
    }
    if (/status = 'posted'/.test(sql)) {
      row[`${destination}_status`] = 'posted';
      if (destination === 'slack') row.slack_message_ts = params[1];
      else row.telegram_message_ids = params[1];
      return { rowCount: 1, rows: [] };
    }
    if (/status = 'failed'/.test(sql)) {
      row[`${destination}_status`] = 'failed';
      row.last_error = params[1];
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL in fake pool: ${sql}`);
  }
}

async function workbookBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Ticket Sales');
  sheet.addRow(['Bet Date', 'Agent ID', 'Game', 'Draw ID', 'Ticket Number', 'Combinations', 'Amount (₱)']);
  rows.forEach(row => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

(async () => {
  const opening = {
    refCode: 'PSC-OPEN', ts: slackTs('2026-09-16T10:00:00+08:00'),
    text: '*LOTTOMATIK*\nWallet Balance: ₱10,000.00'
  };
  const closing = {
    refCode: 'PSC-CLOSE', ts: slackTs('2026-09-16T21:00:00+08:00'),
    text: '*LOTTOMATIK*\nWallet Balance: ₱10,150.00'
  };
  assert.equal(parseLottomatikWallet(opening.text), 10000);
  const buffer = await workbookBuffer([
    ['2026/09/16 09:59:59', 'A', 'Mega Lotto 6/45', 'D1', 'T1', '1', '20.00'],
    ['2026/09/16 10:00:00', 'A', 'Mega Lotto 6/45', 'D2', 'T2', '1', '25.00'],
    ['2026/09/16 12:00:00', 'A', 'Grand Lotto 6/55', 'D3', 'T3', '1', '30.50'],
    ['2026/09/16 21:00:00', 'A', 'Mega Lotto 6/45', 'D4', 'T4', '1', '10.00'],
    ['2026/09/16 21:00:01', 'A', 'Mega Lotto 6/45', 'D5', 'T5', '1', '99.00']
  ]);
  const rows = await readTicketSalesWorkbook(buffer);
  const sales = summarizeTicketSales(rows, opening.ts, closing.ts);
  assert.equal(sales.transactions, 3);
  assert.equal(sales.total, 65.5);
  assert.deepEqual(sales.games, [
    { game: 'Grand Lotto 6/55', transactions: 1, amount: 30.5 },
    { game: 'Mega Lotto 6/45', transactions: 2, amount: 35 }
  ]);
  const report = buildDailySummary({ opening, closing, sales });
  assert(report.includes('DAILY SUMMARY'));
  assert(report.includes('Change: +₱150.00'));
  assert(report.includes('Total Ticket Sales: *₱65.50*'));
  assert(report.includes('Grand Lotto 6/55: 1 transaction | ₱30.50'));
  assert(report.includes('Mega Lotto 6/45: 2 transactions | ₱35.00'));
  assert(!/RECONCILED|SHORT|EXTRA|Resolve Discrepancy/i.test(report));

  const key = reportKey({ opening, closing, workbookDigest: 'digest' });
  assert.equal(key, reportKey({ opening, closing, workbookDigest: 'different-export-of-same-period' }));
  const records = new Map();
  const state = { get: async k => records.get(k), set: async (k, value) => records.set(k, value) };
  let slackCalls = 0;
  let telegramCalls = 0;
  const deps = {
    key, text: report, state,
    postSlack: async text => { slackCalls += 1; return { id: 'slack', text }; },
    postTelegram: async text => { telegramCalls += 1; return { id: 'telegram', text }; }
  };
  await publishIdenticalSummary(deps);
  const duplicate = await publishIdenticalSummary(deps);
  assert.equal(slackCalls, 1);
  assert.equal(telegramCalls, 1);
  assert.equal(duplicate.duplicate, true);

  const partialRecords = new Map([[key, { slack: { id: 'already-posted' } }]]);
  let resumedSlack = 0;
  let resumedTelegram = 0;
  await publishIdenticalSummary({
    ...deps,
    state: { get: async k => partialRecords.get(k), set: async (k, value) => partialRecords.set(k, value) },
    postSlack: async () => { resumedSlack += 1; },
    postTelegram: async () => { resumedTelegram += 1; return { id: 'resumed' }; }
  });
  assert.equal(resumedSlack, 0);
  assert.equal(resumedTelegram, 1);

  const pair = findLatestAlphalandPair([
    { ts: opening.ts, text: `*PSULIT CASH COUNT REPORT*\nBranch: Alphaland\nShift: Day (Opening)\nTeller: A\nTimestamp: x\nRef Code: PSC-OPEN\n*LOTTOMATIK*\nWallet Balance: ₱10,000.00` },
    { ts: closing.ts, text: `*PSULIT CASH COUNT REPORT*\nBranch: Alphaland\nShift: Day (Closing)\nTeller: B\nTimestamp: y\nRef Code: PSC-CLOSE\n*LOTTOMATIK*\nWallet Balance: ₱10,150.00` }
  ]);
  assert.equal(pair.opening.refCode, 'PSC-OPEN');
  assert.equal(pair.closing.refCode, 'PSC-CLOSE');

  const token = signPreview({ report, expiresAt: Date.now() + 1000 }, 'preview-secret');
  assert.equal(verifyPreview(token, 'preview-secret').report, report);
  assert.throws(() => verifyPreview(`${token}x`, 'preview-secret'), /Invalid preview token/);

  const ownerSession = createOwnerSession('strong-session-secret');
  assert.equal(verifyOwnerSession(ownerSession, 'strong-session-secret'), true);
  assert.equal(verifyOwnerSession(ownerSession, 'wrong-secret'), false);
  const unauthorized = { headers: {}, status(code) { this.code = code; return this; }, json() {} };
  ownerAuth({ LOTTOMATIK_OWNER_PIN: '9001', LOTTOMATIK_SESSION_SECRET: 'strong-session-secret' })({ method: 'POST', headers: {} }, unauthorized, () => {});
  assert.equal(unauthorized.code, 401);

  const fakeDatabase = new FakePgPool();
  const durable = new PostgresDeliveryState(fakeDatabase);
  const metadata = {
    openingRef: 'PSC-OPEN', closingRef: 'PSC-CLOSE',
    openingSlackTs: opening.ts, closingSlackTs: closing.ts,
    workbookDigest: 'workbook', reportDigest: 'report'
  };
  await durable.ensure(key, metadata);
  assert.equal(await durable.claim(key, 'slack'), true);
  await durable.complete(key, 'slack', { ts: '123.456' });
  const afterRestart = new PostgresDeliveryState(fakeDatabase);
  assert.equal((await afterRestart.get(key)).slack.status, 'posted');
  let durableSlack = 0;
  let durableTelegram = 0;
  await publishIdenticalSummary({
    key, text: report, metadata, state: afterRestart,
    postSlack: async () => { durableSlack += 1; },
    postTelegram: async () => { durableTelegram += 1; return { message_id: '789' }; }
  });
  assert.equal(durableSlack, 0);
  assert.equal(durableTelegram, 1);
  const durableRecord = await afterRestart.get(key);
  assert.equal(durableRecord.telegram.status, 'posted');

  const app = express();
  app.use(express.json());
  let uiSlack = 0;
  let uiTelegram = 0;
  app.use('/lottomatik', createLottomatikRouter({
    env: {
      LOTTOMATIK_OWNER_PIN: '9001',
      LOTTOMATIK_SESSION_SECRET: 'strong-session-secret',
      LOTTOMATIK_PREVIEW_SECRET: 'preview-secret'
    },
    branch: { name: 'Alphaland', cashCountChannelId: 'C-ALPHA' },
    history: async () => [
      { ts: closing.ts, text: `*PSULIT CASH COUNT REPORT*\nBranch: Alphaland\nShift: Day (Closing)\nTeller: B\nTimestamp: y\nRef Code: PSC-CLOSE\n*LOTTOMATIK*\nWallet Balance: ₱10,150.00` },
      { ts: opening.ts, text: `*PSULIT CASH COUNT REPORT*\nBranch: Alphaland\nShift: Day (Opening)\nTeller: A\nTimestamp: x\nRef Code: PSC-OPEN\n*LOTTOMATIK*\nWallet Balance: ₱10,000.00` }
    ],
    state: new PostgresDeliveryState(new FakePgPool()),
    postSlack: async (channel, text) => { uiSlack += 1; assert.equal(channel, 'C-ALPHA'); assert(text.includes('DAILY SUMMARY')); return { ts: '1.2' }; },
    postTelegram: async text => { uiTelegram += 1; assert(text.includes('DAILY SUMMARY')); return { message_id: '3' }; }
  }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    const unauthorizedPage = await fetch(`http://127.0.0.1:${address.port}/lottomatik`, { redirect: 'manual' });
    assert.equal(unauthorizedPage.status, 303);
    const badLogin = await fetch(`http://127.0.0.1:${address.port}/lottomatik/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'pin=1111'
    });
    assert.equal(badLogin.status, 401);
    const login = await fetch(`http://127.0.0.1:${address.port}/lottomatik/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'pin=9001'
    });
    assert.equal(login.status, 303);
    const cookie = String(login.headers.get('set-cookie')).split(';')[0];
    assert(cookie.startsWith('psulit_lottomatik_owner='));
    const previewResponse = await fetch(`http://127.0.0.1:${address.port}/lottomatik/preview`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'X-Filename': 'AgentTicketSalesDetails_20260916123456.xlsx'
      },
      body: buffer
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert(preview.report.includes('DAILY SUMMARY'));
    assert.equal(uiSlack, 0, 'Preview must not call Slack');
    assert.equal(uiTelegram, 0, 'Preview must not call Telegram');
    const statusResponse = await fetch(`http://127.0.0.1:${address.port}/lottomatik/status`, {
      headers: { Cookie: cookie }
    });
    assert.deepEqual(await statusResponse.json(), {
      database_connected: true,
      delivery_table_exists: true
    });
    const send = () => fetch(`http://127.0.0.1:${address.port}/lottomatik/send`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken: preview.previewToken })
    });
    assert.equal((await send()).status, 200);
    assert.equal(uiSlack, 1);
    assert.equal(uiTelegram, 1);
    const duplicateResponse = await send();
    assert.equal(duplicateResponse.status, 200);
    assert.equal((await duplicateResponse.json()).duplicate, true);
    assert.equal(uiSlack, 1);
    assert.equal(uiTelegram, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('LottoMatik daily summary tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
