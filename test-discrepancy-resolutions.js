const assert = require('assert');
const { ACTION_ID, RESOLUTION_EVENT, correctionFromResolution, createResolutionWorkflow, formatResolution, parseConfirmedBalance, reportBlocks, resolutionKey } = require('./discrepancy-resolutions');

const details = { channel: 'C-ALPHALAND', branch: 'Alphaland', openingRef: 'PSC-OPEN', closingRef: 'PSC-CLOSE', currency: 'PHP', amount: 5000, direction: 'EXTRA' };
const env = { BRANCHES: 'Alphaland:C-ALPHALAND:TX:HIVE:EXP', SLACK_MANAGER_USER_IDS: 'U-MANAGER' };
const actionPayload = { type: 'block_actions', user: { id: 'U-MANAGER' }, channel: { id: 'C-ALPHALAND' }, container: { message_ts: '123.456' }, trigger_id: 'trigger', actions: [{ action_id: ACTION_ID, value: JSON.stringify(details) }] };

(async () => {
  const opened = []; const ephemeral = []; const posted = []; let replies = [];
  const workflow = createResolutionWorkflow({
    env, now: () => new Date('2026-09-12T05:00:00.000Z'), threadReplies: async () => replies,
    openView: async (trigger, view) => opened.push({ trigger, view }),
    postEphemeral: async (channel, user, text) => ephemeral.push({ channel, user, text }),
    postResolution: async (channel, parentTs, text, options) => {
      const message = { channel, ts: '124.000', thread_ts: parentTs, text, metadata: options.metadata, clientMsgId: options.clientMsgId };
      posted.push(message); replies.push(message); return message;
    }
  });

  const blocks = reportBlocks('Audit report', [details]);
  assert.strictEqual(blocks[1].elements[0].text.text, '✅ Resolve Discrepancy');
  assert.strictEqual(JSON.parse(blocks[1].elements[0].value).openingRef, 'PSC-OPEN');
  await workflow.blockAction(actionPayload);
  assert.strictEqual(opened.length, 1);
  assert(opened[0].view.private_metadata.includes('123.456'));

  const submission = { type: 'view_submission', user: { id: 'U-MANAGER' }, view: { private_metadata: opened[0].view.private_metadata, state: { values: {
    reason: { value: { selected_option: { value: 'Cash count encoding error' } } },
    notes: { value: { value: 'PHP actual confirmed: ₱200,832.18.' } },
    affected_count: { value: { selected_option: { value: 'closing' } } },
    corrected_balance: { value: { value: '200,832.18' } }
  } } } };
  await workflow.viewSubmission(submission);
  assert.strictEqual(posted.length, 1);
  assert(posted[0].text.includes('✅ *DISCREPANCY RESOLVED*'));
  assert(posted[0].text.includes('No actual cash shortage/overage.'));
  assert.strictEqual(posted[0].metadata.event_type, RESOLUTION_EVENT);
  assert.strictEqual(posted[0].metadata.event_payload.opening_ref, 'PSC-OPEN');
  assert.strictEqual(posted[0].metadata.event_payload.closing_ref, 'PSC-CLOSE');
  assert.strictEqual(posted[0].metadata.event_payload.amount, '5000');
  assert.strictEqual(posted[0].metadata.event_payload.affected_ref, 'PSC-CLOSE');
  assert.strictEqual(posted[0].metadata.event_payload.corrected_value, '200832.18');
  assert.match(posted[0].clientMsgId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  await workflow.viewSubmission(submission);
  assert.strictEqual(posted.length, 1);
  assert(ephemeral.at(-1).text.includes('already been resolved'));
  assert.strictEqual((await workflow.blockAction(actionPayload)).duplicate, true);
  assert.strictEqual(opened.length, 1);

  const unauthorized = createResolutionWorkflow({ env, threadReplies: async () => [], openView: async () => { throw new Error('must not open'); }, postEphemeral: async (channel, user, text) => ephemeral.push({ channel, user, text }), postResolution: async () => {} });
  assert.strictEqual((await unauthorized.blockAction({ ...actionPayload, user: { id: 'U-TELLER' } })).authorized, false);
  await assert.rejects(workflow.blockAction({ ...actionPayload, channel: { id: 'C-WRONG' } }), /Invalid discrepancy resolution target/);

  const twd = { ...details, currency: 'TWD', amount: 500, direction: 'SHORT' };
  assert.notStrictEqual(resolutionKey({ ...details, parentTs: '123.456' }), resolutionKey({ ...twd, parentTs: '123.456' }));
  const sample = formatResolution({ reason: 'Cash count encoding error', notes: 'Previous closing was TWD 1,000; confirmed balance was TWD 500.', userId: 'U-MANAGER', resolvedAt: 'Sep 12, 2026, 1:00:00 PM' });
  assert(sample.includes('Resolved by: <@U-MANAGER>'));
  assert.strictEqual(parseConfirmedBalance('PHP actual confirmed: ₱200,832.18.'), 200832.18);
  assert.strictEqual(parseConfirmedBalance('Correct balance was TWD 500'), 500);
  const legacyCorrection = correctionFromResolution({
    ts: '124.000', text: 'Notes: PHP actual confirmed: ₱200,832.18.',
    metadata: { event_type: RESOLUTION_EVENT, event_payload: {
      reason: 'Cash count encoding error', closing_ref: 'PSC-CLOSE',
      currency: 'PHP', resolver: 'U-MANAGER', resolved_at: '2026-09-12T05:00:00.000Z'
    } }
  }, { refCode: 'PSC-CLOSE', totals: { PHP: 205832.18 } }, {
    channel: 'C-ALPHALAND', parentTs: '123.456'
  });
  assert.strictEqual(legacyCorrection.originalValue, 205832.18);
  assert.strictEqual(legacyCorrection.correctedValue, 200832.18);
  const legacyHandoverCorrection = correctionFromResolution({
    ts: '125.000', text: 'Notes: PHP actual confirmed: ₱200,832.18.',
    metadata: { event_type: RESOLUTION_EVENT, event_payload: {
      reason: 'Cash count encoding error', opening_ref: 'PSC-NEXT-OPEN',
      closing_ref: 'PSC-PRIOR-CLOSE', currency: 'PHP', resolver: 'U-MANAGER',
      resolved_at: '2026-09-12T05:00:00.000Z'
    } }
  }, { refCode: 'PSC-NEXT-OPEN', totals: { PHP: 205832.18 } }, {
    channel: 'C-ALPHALAND', parentTs: '123.457',
    parentText: '🔄 Alphaland — 09/12/2026, Close 8:38 PM → Open 10:07 AM'
  });
  assert.strictEqual(legacyHandoverCorrection.cashCountRef, 'PSC-NEXT-OPEN');
  assert.strictEqual(legacyHandoverCorrection.correctedValue, 200832.18);
  console.log('discrepancy resolution authorization: PASS');
  console.log('immutable Slack resolution event: PASS');
  console.log('duplicate resolution prevention: PASS');
  console.log('branch/thread/reference linkage: PASS');
  console.log('Alphaland PHP/TWD resolution format: PASS');
})().catch(error => { console.error(error); process.exit(1); });
