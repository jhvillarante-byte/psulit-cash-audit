const assert = require('assert');
const slack = require('./slack');
const { RESOLUTION_EVENT } = require('./discrepancy-resolutions');

const inWindow = (ts, options = {}) =>
  (!options.oldest || Number(ts) >= Number(options.oldest)) &&
  (!options.latest || Number(ts) <= Number(options.latest));

const openingTs = String(Date.UTC(2026, 8, 15, 3, 35, 0) / 1000);
const closingTs = '1789505454.235929'; // 09/16/2026 04:50:54 Manila
const ar1766Ts = String(Date.UTC(2026, 8, 15, 20, 39, 0) / 1000);
const afterClosingTs = String(Date.UTC(2026, 8, 15, 20, 51, 0) / 1000);
const transactionMessages = [
  {
    ts: ar1766Ts,
    text: '*AR 0001766* — 09/16/2026, 04:39 AM\n:large_green_circle: BUY 400 USD @62.65 → ₱25,060.00'
  },
  {
    ts: afterClosingTs,
    text: '*AR 0001767* — 09/16/2026, 04:51 AM\n:large_green_circle: BUY 100 USD @62.65 → ₱6,265.00'
  }
];

let scenario = 'Solaire';
slack.history = async (channel, options = {}) => {
  if (scenario === 'Solaire') {
    if (channel === 'C-SOL-TX') return transactionMessages.filter(message => inWindow(message.ts, options));
    return [];
  }
  if (channel === 'C-ALP-CASH') {
    return [{
      ts: '1789522775.903279',
      reply_count: 1,
      text: '🔄 Alphaland — Close → Open — THB discrepancy'
    }];
  }
  return [];
};
slack.threadReplies = async () => scenario === 'Alphaland' ? [{
  ts: '1789524856.422939',
  text: '✅ DISCREPANCY RESOLVED',
  metadata: { event_type: RESOLUTION_EVENT, event_payload: {
    reason: 'Cash count encoding error', affected_ref: 'PSC-MU3FEXID-YAZA',
    opening_ref: 'PSC-MU3FEXID-YAZA', closing_ref: 'PSC-MU2NUJZF-7JT3',
    currency: 'THB', corrected_value: '500', resolver: 'U0B8SV8CG9L',
    resolved_at: '2026-09-16T02:14:16.000Z'
  } }
}] : [];

delete require.cache[require.resolve('./audit')];
const { runShiftAudit } = require('./audit');

(async () => {
  const solaire = await runShiftAudit(
    { ts: closingTs },
    {
      branch: 'Solaire', shift: 'Night', phase: 'Closing', teller: 'Angelica Besid',
      timestamp: '09/16/2026, 04:16:45', refCode: 'PSC-MU344GM4-JOBQ',
      totals: { PHP: 1200196.05, USD: 740 }, others: {}
    },
    { name: 'Solaire', cashCountChannelId: 'C-SOL-CASH', transactionsChannelId: 'C-SOL-TX', expensesChannelId: null },
    { dryRun: true, openingCountOverride: {
      branch: 'Solaire', shift: 'Morning', phase: 'Opening', teller: 'Irene Maligat',
      timestamp: '09/15/2026, 11:35:00', refCode: 'PSC-MU24C7OV-QM92', _ts: openingTs,
      totals: { PHP: 1225256.05, USD: 340 }, others: {}
    } }
  );
  assert.match(solaire, /All forex currencies reconciled/);
  assert.doesNotMatch(solaire, /0001767/);
  assert.doesNotMatch(solaire, /discrepanc(?:y|ies) this shift/i);

  scenario = 'Alphaland';
  const alphaland = await runShiftAudit(
    { ts: '1789562074.124569' },
    {
      branch: 'Alphaland', shift: 'Mid-Shift', phase: 'Closing', teller: 'Cristina Mirang',
      timestamp: '09/16/2026, 20:09:54', refCode: 'PSC-MU4268AJ-QPZR',
      totals: { THB: 500 }, others: {}
    },
    { name: 'Alphaland', cashCountChannelId: 'C-ALP-CASH', transactionsChannelId: 'C-ALP-TX', expensesChannelId: null },
    { dryRun: true, openingCountOverride: {
      branch: 'Alphaland', shift: 'Morning', phase: 'Opening', teller: 'Jazelle Espiritu',
      timestamp: '09/16/2026, 09:32:49', refCode: 'PSC-MU3FEXID-YAZA', _ts: '1789522765.762969',
      totals: {}, others: {}
    } }
  );
  assert.match(alphaland, /Resolved Opening Correction: THB 0 → THB 500/);
  assert.match(alphaland, /All forex currencies reconciled/);
  assert.doesNotMatch(alphaland, /THB:.*(?:short|extra)/i);

  console.log('Solaire Slack-boundary dry run: PHP and USD reconciled; post-closing transaction excluded.');
  console.log('Alphaland Slack-boundary dry run: resolved THB opening remains reconciled.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
