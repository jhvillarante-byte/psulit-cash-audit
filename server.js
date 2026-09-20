const { registerTestRoutes } = require('./test-routes');
const { registerDebugRoutes } = require('./debug-routes');
const {
  runShiftAudit,
  runCloseVsOpenCheck,
  isScheduledOpening,
  isScheduledClosing,
  previewPostTransactionBalance
} = require('./audit');

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const {
  parseCashCount,
  parseTransaction,
  parseHiveEntry,
  parseExpenseEntry
} = require('./parse');

const { reconcile } = require('./reconcile');

const {
  history,
  postMessage,
  threadReplies,
  downloadSlackFile,
  slackFileInfo,
  uploadThreadImage,
  openView,
  updateView,
  postEphemeral,
  postResolution,
  recoverFromReceiptImage,
  deepCheckMismatches
} = require('./slack');
const { executeApprovedAdminAction } = require('./admin-actions');
const { CALLBACK_ID, createResolutionWorkflow } = require('./discrepancy-resolutions');

const { broadcast } = require('./telegram');
const { sendMessage } = require('./telegram');
const { formatBalanceTelegramMessage, BalanceNotificationTracker } = require('./balance-telegram');
const { checkpointType, analyzeHiveWindow, formatDiagnosticReport } = require('./hive-diagnostic');
const { createLottomatikRouter } = require('./lottomatik-routes');
const { PostgresDeliveryState } = require('./lottomatik-postgres-state');

const app = express();

const SIGNING_SECRET =
  process.env.SLACK_SIGNING_SECRET;

const BALANCE_PREVIEW_SECRET =
  process.env.BALANCE_PREVIEW_SECRET || '';

const EXPENSE_MOVEMENTS_URL =
  process.env.EXPENSE_MOVEMENTS_URL || '';

const EXPENSE_MOVEMENTS_SECRET =
  process.env.EXPENSE_MOVEMENTS_SECRET || '';

const RECIPIENT_CHAT_IDS =
  (
    process.env.TELEGRAM_CHAT_IDS ||
    ''
  )
    .split(',')
    .map(
      s =>
        s.trim()
    )
    .filter(Boolean);

const BALANCE_TELEGRAM_CHAT_ID = String(process.env.BALANCE_TELEGRAM_CHAT_ID || '').trim();

const BRANCHES =
  (
    process.env.BRANCHES ||
    ''
  )
    .split(',')
    .filter(Boolean)
    .map(
      entry => {
        const [
          name,
          cashCountChannelId,
          transactionsChannelId,
          hiveChannelId,
          expensesChannelId
        ] =
          entry
            .split(':')
            .map(
              s =>
                (
                  s ||
                  ''
                ).trim()
            );

        return {
          name,
          cashCountChannelId,
          transactionsChannelId,
          hiveChannelId:
            hiveChannelId ||
            null,
          expensesChannelId:
            expensesChannelId ||
            null,
          expenseMovementsUrl: EXPENSE_MOVEMENTS_URL || null,
          expenseMovementsSecret: EXPENSE_MOVEMENTS_SECRET || null
        };
      }
    );

const BY_CASH_COUNT_CHANNEL =
  new Map(
    BRANCHES.map(
      b => [
        b.cashCountChannelId,
        b
      ]
    )
  );

const BY_TRANSACTION_CHANNEL =
  new Map(
    BRANCHES.map(
      b => [b.transactionsChannelId, b]
    )
  );

registerTestRoutes(
  app,
  BRANCHES
);

registerDebugRoutes(
  app,
  BRANCHES
);

const PROCESSED =
  new Set();

function authorizedManager(userId) {
  return new Set(String(process.env.SLACK_MANAGER_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean)).has(userId);
}

async function collectChannelHistory(channelId) {
  const messages = [];
  let latest;
  for (let page = 0; page < 10; page++) {
    const batch = await history(channelId, { latest, limit: 200 });
    if (!batch.length) break;
    messages.push(...batch);
    if (batch.length < 200) break;
    latest = (Number(batch[batch.length - 1].ts) - 0.000001).toFixed(6);
  }
  return messages;
}

async function runHiveDiagnostic() {
  const reports = [];
  for (const branchConfig of BRANCHES) {
    if (!branchConfig.hiveChannelId || !branchConfig.cashCountChannelId) continue;
    const [cashMessages, hiveMessages] = await Promise.all([
      collectChannelHistory(branchConfig.cashCountChannelId),
      collectChannelHistory(branchConfig.hiveChannelId)
    ]);
    const counts = cashMessages
      .map(message => ({ message, parsed: parseCashCount(message.text || '') }))
      .filter(item => item.parsed && item.parsed.branch === branchConfig.name && item.parsed.refCode && checkpointType(item.parsed))
      .sort((a, b) => Number(a.message.ts) - Number(b.message.ts));
    for (let i = 1; i < counts.length; i++) {
      const previous = counts[i - 1];
      const current = counts[i];
      const validWindow = (checkpointType(previous.parsed) === 'Opening' && checkpointType(current.parsed) === 'Midshift') ||
        (checkpointType(previous.parsed) === 'Midshift' && checkpointType(current.parsed) === 'Closing');
      if (!validWindow) continue;
      const windowHiveMessages = hiveMessages.filter(message => Number(message.ts) > Number(previous.message.ts) && Number(message.ts) <= Number(current.message.ts));
      reports.push({ branch: branchConfig.name, ...analyzeHiveWindow(previous, current, windowHiveMessages) });
    }
  }
  const reliable = reports.length > 0 && reports.every(report => report.status === 'MATCH' && report.parseFailures === 0 && report.suspectedDuplicates.length === 0);
  return `${reports.length ? reports.map(report => formatDiagnosticReport(report.branch, [report])).join('\n\n') : 'No completed Hive checkpoint windows found.'}\n\nData reliable for permanent automation: ${reliable ? 'YES' : 'NO'}`;
}

const OPEN_FLAGS =
  new Map();

app.use(
  express.json({
    verify:
      (
        req,
        res,
        buf
      ) => {
        req.rawBody =
          buf;
      }
  })
);

function hasValidBalancePreviewSecret(req) {
  const supplied = String(req.get('x-balance-preview-secret') || '');
  if (!BALANCE_PREVIEW_SECRET || supplied.length !== BALANCE_PREVIEW_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(BALANCE_PREVIEW_SECRET));
}

async function notifyTransactionBalance(event, branchConfig) {
  if (!BALANCE_TELEGRAM_CHAT_ID) {
    console.warn('Running balance Telegram notification omitted: BALANCE_TELEGRAM_CHAT_ID is not configured.', { branch: branchConfig.name, eventTs: event.ts });
    return;
  }
  const parsed = parseTransaction(event.text || '');
  if (!parsed || !parsed.movements?.length || !Number.isFinite(Number(parsed.phpAmount))) {
    console.warn('Running balance Telegram notification omitted: transaction could not be parsed.', { branch: branchConfig.name, eventTs: event.ts });
    return;
  }
  const key = `${branchConfig.name}|${event.ts}|${parsed.ref}`;
  if (!BALANCE_NOTIFICATIONS.begin(key)) {
    console.info('Running balance Telegram notification duplicate skipped.', { branch: branchConfig.name, ar: parsed.ref });
    return;
  }
  try {
    const result = await previewPostTransactionBalance({
      branchConfig,
      lines: parsed.movements.map(movement => ({ deal: movement.action, currency: movement.ccy, fxAmount: movement.fcyAmount, phpAmount: movement.phpAmount })),
      totalPhpAmount: parsed.phpAmount,
      arNumber: parsed.ref,
      asOfTs: event.ts
    });
    if (!result?.authoritative) {
      BALANCE_NOTIFICATIONS.failed(key);
      console.warn('Running balance Telegram notification omitted: authoritative calculation unavailable.', { branch: branchConfig.name, ar: parsed.ref, reason: result?.reason || 'unknown' });
      return;
    }
    const message = formatBalanceTelegramMessage({ branch: branchConfig.name, arNumber: parsed.ref, lines: parsed.movements, balances: result.balances });
    if (!message) {
      BALANCE_NOTIFICATIONS.failed(key);
      console.warn('Running balance Telegram notification omitted: no affected balances returned.', { branch: branchConfig.name, ar: parsed.ref });
      return;
    }
    await sendMessage(BALANCE_TELEGRAM_CHAT_ID, message);
    BALANCE_NOTIFICATIONS.succeeded(key);
    console.info('Running balance Telegram notification sent.', { branch: branchConfig.name, ar: parsed.ref });
  } catch (error) {
    BALANCE_NOTIFICATIONS.failed(key);
    console.error('Running balance Telegram notification failed.', { branch: branchConfig.name, ar: parsed.ref, message: error?.message || String(error) });
  }
}

// Internal, read-only endpoint for Transaction Entry. It never posts to
// Slack/Telegram and is intentionally protected by a server-only secret.
app.post('/internal/balance-preview', async (req, res) => {
  const requestContext = {
    branch: req.body && req.body.branch,
    proposedAr: req.body && req.body.arNumber
  };
  const authenticated = hasValidBalancePreviewSecret(req);
  console.info('Balance preview request received', { ...requestContext, authenticated });
  if (!authenticated) {
    console.warn('Balance preview authentication failed', requestContext);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { branch, lines, totalPhpAmount, arNumber } = req.body || {};
    const branchConfig = BRANCHES.find(item => item.name.toLowerCase() === String(branch || '').toLowerCase());
    if (!branchConfig) return res.status(400).json({ error: 'Invalid branch' });
    const result = await previewPostTransactionBalance({ branchConfig, lines, totalPhpAmount, arNumber });
    if (!result.authoritative) {
      console.warn('Balance preview Cash Count/calculation unavailable', { ...requestContext, reason: result.reason });
      return res.status(503).json(result);
    }
    console.info('Balance preview succeeded', {
      ...requestContext,
      cashCount: result.sourceCashCount,
      currencies: result.balances.map(item => item.ccy)
    });
    return res.json(result);
  } catch (err) {
    console.error('Balance preview failed', { ...requestContext, message: err.message });
    return res.status(503).json({ authoritative: false, reason: 'Balance preview unavailable.' });
  }
});

app.use(
  express.urlencoded({
    extended: false,
    verify: (req, res, buf) => { req.rawBody = buf; }
  })
);

const ALPHALAND = BRANCHES.find(branch => branch.name === 'Alphaland');
if (ALPHALAND) {
  const lottomatikPool = process.env.SUPABASE_DATABASE_URL
    ? new Pool({
        connectionString: process.env.SUPABASE_DATABASE_URL,
        max: 2,
        min: 0,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 10000,
        allowExitOnIdle: true,
        keepAlive: true
      })
    : null;
  if (lottomatikPool) {
    lottomatikPool.on('error', error =>
      console.error('LottoMatik database pool error:', error.code || error.name || 'database_error')
    );
  }
  const lottomatikState = lottomatikPool
    ? new PostgresDeliveryState(lottomatikPool)
    : {
        get: async () => null,
        ensure: async () => { throw new Error('Supabase LottoMatik delivery storage is not configured.'); }
      };
  app.use('/lottomatik', createLottomatikRouter({
    env: process.env,
    branch: ALPHALAND,
    history,
    state: lottomatikState,
    postSlack: (channelId, text) => postMessage(channelId, text),
    postTelegram: async text => {
      if (!RECIPIENT_CHAT_IDS.length) throw new Error('Telegram recipients are not configured.');
      const results = await broadcast(RECIPIENT_CHAT_IDS, text);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw new Error('Telegram delivery failed.');
      return { message_id: results.map(result => result.value && result.value.result && result.value.result.message_id).filter(Boolean).join(',') };
    }
  }));
}

const discrepancyResolutionWorkflow = createResolutionWorkflow({
  threadReplies,
  openView,
  updateView,
  postEphemeral,
  postResolution
});

app.post('/slack/interactions', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).send('invalid signature');

  // Temporary, read-only owner/manager diagnostic. Slack signs the request;
  // the manager allow-list is the second authorization check. Acknowledge
  // immediately, then deliver the sanitized result ephemerally.
  if (req.body?.command === '/hive-audit-diagnostic') {
    const userId = String(req.body.user_id || '');
    const channelId = String(req.body.channel_id || '');
    if (!authorizedManager(userId)) {
      await postEphemeral(channelId, userId, 'You are not authorized to run the Hive audit diagnostic.').catch(() => {});
      return res.status(200).send();
    }
    res.status(200).send();
    runHiveDiagnostic()
      .then(report => postEphemeral(channelId, userId, report))
      .catch(() => {
        postEphemeral(channelId, userId, 'Hive audit diagnostic failed. No data was changed.').catch(() => {});
      });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(req.body?.payload || '{}');
  } catch (err) {
    return res.status(400).send('invalid payload');
  }

  if (payload.type === 'block_actions') {
    try {
      await discrepancyResolutionWorkflow.blockAction(payload);
      return res.status(200).send();
    } catch (err) {
      console.error('Resolve discrepancy action failed:', err.message);
      await discrepancyResolutionWorkflow.notifyFailure(
        payload,
        'Unable to open the resolution form. Please try again.'
      ).catch(notifyErr =>
        console.error('Resolve discrepancy action notification failed:', notifyErr.message)
      );
      return res.status(200).send();
    }
  }

  if (payload.type === 'view_submission' && payload.view?.callback_id === CALLBACK_ID) {
    const errors = discrepancyResolutionWorkflow.validateSubmission(payload);
    if (Object.keys(errors).length) {
      return res.status(200).json({ response_action: 'errors', errors });
    }
    res.status(200).send();
    discrepancyResolutionWorkflow.viewSubmission(payload).catch(async err => {
      console.error('Resolve discrepancy submission failed:', err.message);
      await discrepancyResolutionWorkflow.notifyFailure(
        payload,
        'Unable to record the discrepancy resolution. Nothing was resolved. Please try again.'
      ).catch(notifyErr =>
        console.error('Resolve discrepancy submission notification failed:', notifyErr.message)
      );
    });
    return;
  }

  return res.status(200).send();
});

app.post(
  '/slack/events',
  async (
    req,
    res
  ) => {
    if (
      !verifySlackSignature(
        req
      )
    ) {
      return res
        .status(401)
        .send(
          'invalid signature'
        );
    }

    const body =
      req.body;

    if (
      body.type ===
      'url_verification'
    ) {
      return res.send(
        body.challenge
      );
    }

    res
      .status(200)
      .send();

    processSlackEvent(body).catch(err => console.error('Slack event failed:', err.message));
  }
);

async function processSlackEvent(body) {
    const event =
      body.event;

    if (
      !event ||
      event.type !==
        'message' ||
      !event.text
    ) {
      return;
    }

    try {
      const adminResult = await executeApprovedAdminAction(event, {
        threadReplies,
        downloadSlackFile,
        slackFileInfo,
        uploadThreadImage
      });
      if (adminResult.handled) {
        console.log(
          adminResult.duplicate
            ? 'Approved admin action already completed; duplicate skipped.'
            : 'Approved admin action completed.'
        );
        return;
      }
    } catch (err) {
      console.error('Approved admin action failed:', err.message);
      return;
    }

    if (
      event.subtype &&
      event.subtype !==
        'bot_message'
    ) {
      return;
    }

    console.log(
      `Received message in ${event.channel} (subtype: ${event.subtype || 'none'}): ${event.text.slice(0, 60)}`
    );

    const transactionBranch =
      BY_TRANSACTION_CHANNEL.get(
        event.channel
      );

    if (transactionBranch) {
      // Slack has already received the event and the HTTP 200 was sent above.
      // Balance calculation/Telegram delivery is deliberately fire-and-forget.
      await notifyTransactionBalance(event, transactionBranch).catch(err =>
        console.error('Running balance notification task failed:', err.message)
      );
      return;
    }

    const branchConfig =
      BY_CASH_COUNT_CHANNEL.get(
        event.channel
      );

    if (
      !branchConfig
    ) {
      return;
    }

    /*
     * Thread replies are intentionally ignored.
     * Full math is now posted automatically
     * by audit.js.
     */

    if (
      PROCESSED.has(
        event.ts
      )
    ) {
      return;
    }

    PROCESSED.add(
      event.ts
    );

    if (
      !event.text.includes(
        'PSULIT CASH COUNT REPORT'
      )
    ) {
      return;
    }

    try {
      await handleCashCount(
        event,
        branchConfig
      );

      await handleDailyReport(
        event,
        branchConfig
      );

    } catch (err) {
      console.error(
        'Failed to process cash count:',
        err
      );
    }
}

async function handleCashCount(
  event,
  branchConfig
) {
  const {
    cashCountChannelId,
    transactionsChannelId,
    hiveChannelId,
    expensesChannelId
  } =
    branchConfig;

  const current =
    parseCashCount(
      event.text
    );

  if (
    !current
  ) {
    return;
  }

  /*
   * IMPORTANT:
   *
   * New cash-count format contains:
   *
   * Shift: Morning (Closing)
   *
   * parseCashCount() turns that into:
   *
   * shift = Morning
   * phase = Closing
   *
   * So isClosingCount() MUST check
   * phase before rejecting Morning.
   */

  if (
    !isClosingCount(
      current
    )
  ) {
    return;
  }

  /*
   * Automatic shift audit.
   */

  if (
    isScheduledClosing(
      current
    )
  ) {
    await runShiftAudit(
      event,
      current,
      branchConfig
    ).catch(
      err =>
        console.error(
          'Shift audit failed:',
          err
        )
    );
  }

  /*
   * Older Telegram reconciliation
   * logic remains below.
   */

  const eventTime =
    parseReportTimestamp(
      current
    );

  if (
    !eventTime
  ) {
    return;
  }

  const anchorEpoch =
    current.shift ===
      'Night'

      ? manilaEpoch(
          eventTime.year,
          eventTime.month,
          eventTime.day - 1,
          20,
          0,
          0
        )

      : manilaEpoch(
          eventTime.year,
          eventTime.month,
          eventTime.day,
          9,
          0,
          0
        );

  const priorMessages =
    await history(
      cashCountChannelId,
      {
        latest:
          subtractSecond(
            event.ts
          ),

        limit:
          50
      }
    );

  let previous =
    null;

  let bestDiff =
    Infinity;

  for (
    const msg of
    priorMessages
  ) {
    const parsed =
      parseCashCount(
        msg.text ||
        ''
      );

    if (
      !parsed ||
      parsed.branch !==
        current.branch
    ) {
      continue;
    }

    const t =
      parseReportTimestamp(
        parsed
      );

    if (
      !t
    ) {
      continue;
    }

    const diff =
      anchorEpoch -
      t.epoch;

    if (
      diff >= 0 &&
      diff <
        bestDiff
    ) {
      bestDiff =
        diff;

      previous =
        parsed;
    }
  }

  if (
    !previous
  ) {
    await broadcast(
      RECIPIENT_CHAT_IDS,

      `⚠️ No prior cash count found for *${current.branch}* (${current.shift} shift) to reconcile against — this may be the first count on record, or the branch name doesn't match a prior entry exactly.`
    );

    return;
  }

  const windowStart =
    anchorEpoch
      .toFixed(6);

  const txMessages =
    await history(
      transactionsChannelId,
      {
        oldest:
          windowStart,

        latest:
          event.ts
      }
    );

  const rawTickets =
    txMessages
      .map(
        m => ({
          parsed:
            parseTransaction(
              m.text ||
              ''
            ),

          raw:
            m.text ||
            '',

          files:
            m.files ||
            []
        })
      )
      .filter(
        x =>
          x.raw.match(
            /(?:VN|ARN|AR)\s*#?\s*0*\d+/i
          )
      );

  const transactions =
    [];

  for (
    const t of
    rawTickets
  ) {
    if (
      t.parsed
    ) {
      transactions.push(
        t.parsed
      );

      continue;
    }

    const photo =
      t.files.find(
        f =>
          (
            f.mimetype ||
            ''
          ).startsWith(
            'image/'
          )
      );

    let recovered =
      null;

    if (
      photo &&
      photo.url_private
    ) {
      try {
        recovered =
          await recoverFromReceiptImage(
            photo.url_private,
            t.raw
          );

      } catch (err) {
        console.error(
          'Receipt image recovery failed:',
          err.message
        );
      }
    }

    transactions.push(
      recovered ||
      {
        unparseable:
          true,

        raw:
          t.raw
      }
    );
  }

  const goodTransactions =
    transactions.filter(
      t =>
        !t.unparseable
    );

  const badTransactions =
    transactions.filter(
      t =>
        t.unparseable
    );

  let adjustments =
    {};

  if (
    hiveChannelId
  ) {
    const hiveMessages =
      await history(
        hiveChannelId,
        {
          oldest:
            windowStart,

          latest:
            event.ts
        }
      );

    const hiveDelta =
      hiveMessages
        .map(
          m =>
            parseHiveEntry(
              m.text ||
              ''
            )
        )
        .filter(Boolean)
        .reduce(
          (
            sum,
            entry
          ) =>
            sum +
            entry.amount,

          0
        );

    if (
      hiveDelta !==
      0
    ) {
      adjustments.Hive =
        hiveDelta;
    }
  }

  if (
    expensesChannelId
  ) {
    const expenseMessages =
      await history(
        expensesChannelId,
        {
          oldest:
            windowStart,

          latest:
            event.ts
        }
      );

    const expenseTotal =
      expenseMessages
        .map(
          m =>
            parseExpenseEntry(
              m.text ||
              ''
            )
        )
        .filter(Boolean)
        .reduce(
          (
            sum,
            entry
          ) =>
            sum +
            entry.amount,

          0
        );

    if (
      expenseTotal !==
      0
    ) {
      adjustments.Opex =
        expenseTotal;
    }
  }

  const openingTotals = {
    ...previous.totals,
    ...previous.others
  };

  const actualTotals = {
    ...current.totals,
    ...current.others
  };

  const results =
    reconcile(
      openingTotals,
      actualTotals,
      goodTransactions,
      adjustments
    );

  const annotated =
    annotateWithFlagHistory(
      results,
      current
    );

  let morningTeller =
    null;

  if (
    current.shift ===
    'Mid-Shift'
  ) {
    for (
      const msg of
      priorMessages
    ) {
      const parsed =
        parseCashCount(
          msg.text ||
          ''
        );

      if (
        parsed &&
        parsed.branch ===
          current.branch &&
        parsed.shift ===
          'Morning'
      ) {
        morningTeller =
          parsed.teller;

        break;
      }
    }
  }

  let deepCheck =
    null;

  const stillMismatched =
    annotated.filter(
      r =>
        !r.match
    );

  if (
    stillMismatched.length
  ) {
    try {
      deepCheck =
        await deepCheckMismatches(
          stillMismatched,
          goodTransactions,
          badTransactions
        );

    } catch (err) {
      console.error(
        'Deep-check failed:',
        err.message
      );
    }
  }

  await broadcast(
    RECIPIENT_CHAT_IDS,

    formatReport(
      current,
      annotated,
      goodTransactions,
      badTransactions,
      morningTeller,
      deepCheck
    )
  );
}

function annotateWithFlagHistory(
  results,
  current
) {
  return results.map(
    r => {
      const key =
        `${current.branch}|${r.ccy}`;

      const priorFlag =
        OPEN_FLAGS.get(
          key
        );

      if (
        r.match
      ) {
        if (
          priorFlag
        ) {
          OPEN_FLAGS.delete(
            key
          );

          return {
            ...r,

            note:
              `resolved — was off by ${priorFlag.diff >= 0 ? '+' : ''}${priorFlag.diff.toFixed(2)} as of ${priorFlag.shift}, back in balance since.`
          };
        }

        return r;
      }

      if (
        priorFlag
      ) {
        OPEN_FLAGS.set(
          key,
          {
            diff:
              r.diff,

            shift:
              current.shift,

            ts:
              Date.now()
          }
        );

        return {
          ...r,

          note:
            `outstanding since ${priorFlag.shift} — not yet corrected.`
        };
      }

      OPEN_FLAGS.set(
        key,
        {
          diff:
            r.diff,

          shift:
            current.shift,

          ts:
            Date.now()
        }
      );

      return {
        ...r,

        note:
          'newly flagged this shift.'
      };
    }
  );
}

function formatReport(
  current,
  results,
  transactions,
  badTransactions = [],
  morningTeller = null,
  deepCheck = null
) {
  const mismatches =
    results.filter(
      r =>
        !r.match
    );

  const clientTx =
    transactions.filter(
      t =>
        !t.isWholesale
    );

  const wholesaleTx =
    transactions.filter(
      t =>
        t.isWholesale
    );

  let lines =
    [];

  const shiftLabel =
    current.shift ===
      'Mid-Shift'
      ? 'Morning and Mid-Shift'
      : current.shift;

  lines.push(
    `📊 *${current.branch} — ${shiftLabel} Cash Count*`
  );

  const datePart =
    (
      current.timestamp ||
      ''
    )
      .split(',')[0]
      .trim();

  if (
    datePart
  ) {
    lines.push(
      `Date: ${datePart}`
    );
  }

  if (
    current.shift ===
      'Mid-Shift' &&
    morningTeller
  ) {
    lines.push(
      `Tellers: ${morningTeller} (Morning), ${current.teller || 'n/a'} (Mid-Shift)`
    );

  } else {
    lines.push(
      `Teller: ${current.teller || 'n/a'}`
    );
  }

  lines.push(
    `${clientTx.length} client transaction(s)${wholesaleTx.length ? `, ${wholesaleTx.length} wholesale` : ''} checked since the last count.`
  );

  const recovered =
    transactions.filter(
      t =>
        t.recoveredFromImage
    );

  if (
    recovered.length
  ) {
    lines.push(
      `(${recovered.length} of these had no caption details — recovered by reading the receipt photo.)`
    );
  }

  lines.push('');

  const needsAttention =
    results.filter(
      r =>
        !r.match ||
        r.note
    );

  if (
    needsAttention.length ===
    0
  ) {
    lines.push(
      '✅ Everything reconciles — no discrepancies to report.'
    );

  } else {
    for (
      const r of
      needsAttention
    ) {
      const icon =
        r.match
          ? '✅🔁'
          : '⚠️';

      const diffStr =
        r.match
          ? ''
          : ` — off by ${formatNum(r.diff)}`;

      lines.push(
        `${icon} *${r.ccy}*: expected ${formatNum(r.expected)}, actual ${formatNum(r.actual)}${diffStr}`
      );

      if (
        r.note
      ) {
        lines.push(
          `     _${r.note}_`
        );
      }
    }
  }

  lines.push('');

  lines.push(
    mismatches.length
      ? `*Bottom line:* ${mismatches.length} currenc${mismatches.length > 1 ? 'ies' : 'y'} need checking — ${mismatches.map(m => m.ccy).join(', ')}.`
      : '*Bottom line:* everything reconciles ✅'
  );

  if (
    badTransactions.length
  ) {
    lines.push('');

    lines.push(
      `⚠️ *${badTransactions.length} ticket(s) couldn't be read* and are EXCLUDED from the math above — check these manually:`
    );

    for (
      const bad of
      badTransactions
    ) {
      lines.push(
        `  • ${bad.raw.split('\n')[0].slice(0, 80)}`
      );
    }
  }

  if (
    deepCheck
  ) {
    lines.push('');

    lines.push(
      '🔍 *Second look at the mismatches:*'
    );

    lines.push(
      deepCheck.trim()
    );
  }

  lines.push(
    '_Auto-generated from logged tickets — please verify against physical slips before treating as final._'
  );

  return lines.join(
    '\n'
  );
}

function formatNum(
  n
) {
  return n.toLocaleString(
    'en-US',
    {
      minimumFractionDigits:
        2,

      maximumFractionDigits:
        2
    }
  );
}

function subtractSecond(
  ts
) {
  return (
    parseFloat(
      ts
    ) -
    0.000001
  ).toFixed(6);
}

function isMorningOpening(
  current
) {
  if (
    current.shift !==
    'Morning'
  ) {
    return false;
  }

  if (
    current.phase
  ) {
    return (
      current.phase
        .toLowerCase() ===
      'opening'
    );
  }

  const timeMatch =
    (
      current.timestamp ||
      ''
    ).match(
      /(\d{1,2}):(\d{2}):(\d{2})/
    );

  if (
    !timeMatch
  ) {
    return false;
  }

  const hour =
    parseInt(
      timeMatch[1],
      10
    ) +
    parseInt(
      timeMatch[2],
      10
    ) /
      60;

  const diff =
    Math.min(
      Math.abs(
        hour -
        9
      ),

      24 -
      Math.abs(
        hour -
        9
      )
    );

  return (
    diff <=
    2
  );
}

function diagnoseDenominations(
  openingDenoms = [],
  actualDenoms = []
) {
  const values =
    new Set([
      ...openingDenoms.map(
        d =>
          d.value
      ),

      ...actualDenoms.map(
        d =>
          d.value
      )
    ]);

  const diffs =
    [];

  for (
    const v of
    values
  ) {
    const openCount =
      (
        openingDenoms.find(
          d =>
            d.value ===
            v
        ) ||
        {
          count:
            0
        }
      ).count;

    const actCount =
      (
        actualDenoms.find(
          d =>
            d.value ===
            v
        ) ||
        {
          count:
            0
        }
      ).count;

    const countDiff =
      actCount -
      openCount;

    if (
      countDiff !==
      0
    ) {
      diffs.push({
        value:
          v,

        countDiff,

        amountDiff:
          countDiff *
          v
      });
    }
  }

  diffs.sort(
    (
      a,
      b
    ) =>
      Math.abs(
        b.amountDiff
      ) -
      Math.abs(
        a.amountDiff
      )
  );

  return diffs;
}

function formatDenomLabel(
  value
) {
  if (
    value <
    1
  ) {
    return `${Math.round(value * 100)}¢`;
  }

  return `₱${value.toLocaleString()}`;
}

async function handleDailyReport(
  event,
  branchConfig
) {
  const {
    cashCountChannelId,
    transactionsChannelId,
    hiveChannelId,
    expensesChannelId
  } =
    branchConfig;

  const current =
    parseCashCount(
      event.text
    );

  if (
    !current
  ) {
    return;
  }

  if (
    isScheduledOpening(
      current
    )
  ) {
    await runCloseVsOpenCheck(
      event,
      current,
      branchConfig
    ).catch(
      err =>
        console.error(
          'Handover check failed:',
          err
        )
    );
  }

  const isSolaireStyle =
    isMorningOpening(
      current
    );

  const isAlphalandStyle =
    !isSolaireStyle &&
    (
      (
        current.shift ||
        ''
      ).toLowerCase() ===
        'opening' ||

      (
        current.phase ||
        ''
      ).toLowerCase() ===
        'opening'
    );

  if (
    !isSolaireStyle &&
    !isAlphalandStyle
  ) {
    return;
  }

  const priorMessages =
    await history(
      cashCountChannelId,
      {
        latest:
          subtractSecond(
            event.ts
          ),

        limit:
          100
      }
    );

  let previous =
    null;

  let previousMsg =
    null;

  let windowStartMsg =
    null;

  if (
    isSolaireStyle
  ) {
    for (
      const msg of
      priorMessages
    ) {
      const parsed =
        parseCashCount(
          msg.text ||
          ''
        );

      if (
        parsed &&
        parsed.branch ===
          current.branch &&
        isMorningOpening(
          parsed
        )
      ) {
        previous =
          parsed;

        previousMsg =
          msg;

        break;
      }
    }

    windowStartMsg =
      previousMsg;

  } else {
    let closingMsg =
      null;

    let closingParsed =
      null;

    for (
      const msg of
      priorMessages
    ) {
      const parsed =
        parseCashCount(
          msg.text ||
          ''
        );

      const isClose =
        parsed &&
        (
          (
            parsed.shift ||
            ''
          ).toLowerCase() ===
            'closing' ||

          (
            parsed.phase ||
            ''
          ).toLowerCase() ===
            'closing'
        );

      if (
        parsed &&
        parsed.branch ===
          current.branch &&
        isClose
      ) {
        closingMsg =
          msg;

        closingParsed =
          parsed;

        break;
      }
    }

    if (
      !closingMsg
    ) {
      return;
    }

    for (
      const msg of
      priorMessages
    ) {
      if (
        parseFloat(
          msg.ts
        ) >=
        parseFloat(
          closingMsg.ts
        )
      ) {
        continue;
      }

      const parsed =
        parseCashCount(
          msg.text ||
          ''
        );

      const isOpen =
        parsed &&
        (
          (
            parsed.shift ||
            ''
          ).toLowerCase() ===
            'opening' ||

          (
            parsed.phase ||
            ''
          ).toLowerCase() ===
            'opening'
        );

      if (
        parsed &&
        parsed.branch ===
          current.branch &&
        isOpen
      ) {
        previous =
          parsed;

        previousMsg =
          msg;

        break;
      }
    }

    if (
      !previous
    ) {
      return;
    }

    current.totals =
      closingParsed.totals;

    current.others =
      closingParsed.others;

    current.denominations =
      closingParsed.denominations;

    current.teller =
      closingParsed.teller;

    current.timestamp =
      closingParsed.timestamp;

    windowStartMsg =
      previousMsg;

    event = {
      ...event,

      ts:
        closingMsg.ts,

      user:
        closingMsg.user
    };
  }

  if (
    !previous
  ) {
    return;
  }

  const windowOldest =
    previousMsg.ts;

  const windowLatest =
    event.ts;

  const txMessages =
    await history(
      transactionsChannelId,
      {
        oldest:
          windowOldest,

        latest:
          windowLatest
      }
    );

  const txParsed =
    txMessages
      .map(
        m => ({
          parsed:
            parseTransaction(
              m.text ||
              ''
            ),

          raw:
            m.text ||
            '',

          user:
            m.user
        })
      )
      .filter(
        x =>
          x.raw.match(
            /(?:VN|ARN|AR)\s*#?\s*0*\d+/i
          )
      );

  const goodTx =
    txParsed
      .filter(
        x =>
          x.parsed
      )
      .map(
        x =>
          x.parsed
      );

  const posters =
    new Set(
      txParsed
        .map(
          x =>
            x.user
        )
        .filter(Boolean)
    );

  let adjustments =
    {};

  if (
    hiveChannelId
  ) {
    const hiveMessages =
      await history(
        hiveChannelId,
        {
          oldest:
            windowOldest,

          latest:
            windowLatest
        }
      );

    const hiveDelta =
      hiveMessages
        .map(
          m =>
            parseHiveEntry(
              m.text ||
              ''
            )
        )
        .filter(Boolean)
        .reduce(
          (
            s,
            e
          ) =>
            s +
            e.amount,

          0
        );

    if (
      hiveDelta !==
      0
    ) {
      adjustments.Hive =
        hiveDelta;
    }
  }

  if (
    expensesChannelId
  ) {
    const expenseMessages =
      await history(
        expensesChannelId,
        {
          oldest:
            windowOldest,

          latest:
            windowLatest
        }
      );

    const expenseTotal =
      expenseMessages
        .map(
          m =>
            parseExpenseEntry(
              m.text ||
              ''
            )
        )
        .filter(Boolean)
        .reduce(
          (
            s,
            e
          ) =>
            s +
            e.amount,

          0
        );

    if (
      expenseTotal !==
      0
    ) {
      adjustments.Opex =
        expenseTotal;
    }
  }

  const openingTotals = {
    ...previous.totals,
    ...previous.others
  };

  const actualTotals = {
    ...current.totals,
    ...current.others
  };

  const results =
    reconcile(
      openingTotals,
      actualTotals,
      goodTx,
      adjustments
    );

  const mismatches =
    results.filter(
      r =>
        !r.match
    );

  if (
    mismatches.length ===
    0
  ) {
    return;
  }

  if (
    previousMsg.user
  ) {
    posters.add(
      previousMsg.user
    );
  }

  if (
    event.user
  ) {
    posters.add(
      event.user
    );
  }

  const noTransactions =
    goodTx.length ===
      0 &&
    txParsed.length ===
      0;

  const dateLabel =
    (
      current.timestamp ||
      ''
    )
      .split(',')[0]
      .trim();

  const prevTimeLabel =
    (
      previous.timestamp ||
      ''
    )
      .split(',')[1]
      ?.trim() ||
    '';

  const currTimeLabel =
    (
      current.timestamp ||
      ''
    )
      .split(',')[1]
      ?.trim() ||
    '';

  let lines =
    [];

  lines.push(
    `*${current.branch} Discrepancy — ${dateLabel}, ${prevTimeLabel} → ${currTimeLabel}*`
  );

  lines.push('');

  for (
    const r of
    mismatches
  ) {
    let line =
      `• *${r.ccy}* off by ${formatNum(Math.abs(r.diff))}`;

    if (
      noTransactions
    ) {
      const openDenoms =
        previous
          .denominations
          ?.[r.ccy];

      const actDenoms =
        current
          .denominations
          ?.[r.ccy];

      const diag =
        diagnoseDenominations(
          openDenoms,
          actDenoms
        );

      if (
        diag.length
      ) {
        const top =
          diag[0];

        const direction =
          top.countDiff <
            0
            ? 'not counted'
            : 'extra, unexplained';

        line +=
          ` — mainly ${Math.abs(top.countDiff)} × ${formatDenomLabel(top.value)} ${direction} (${formatNum(Math.abs(top.amountDiff))})`;
      }
    }

    lines.push(
      line
    );
  }

  lines.push('');

  lines.push(
    noTransactions
      ? "No transactions in the gap, so this isn't explained by a sale."
      : `${goodTx.length} transaction(s) checked in this window — still doesn't fully reconcile.`
  );

  lines.push(
    'Please explain.'
  );

  if (
    posters.size
  ) {
    lines.push('');

    lines.push(
      [...posters]
        .map(
          u =>
            `<@${u}>`
        )
        .join(' ')
    );
  }

  if (
    process.env
      .ENABLE_SLACK_DAILY_REPORT ===
    'true'
  ) {
    await postMessage(
      cashCountChannelId,
      lines.join('\n')
    );

  } else {
    console.log(
      'Slack daily report paused (ENABLE_SLACK_DAILY_REPORT is not "true") — would have posted:\n' +
      lines.join('\n')
    );
  }
}

function manilaEpoch(
  year,
  month,
  day,
  hour,
  min,
  sec
) {
  return (
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      min,
      sec
    ) -
    8 *
      3600 *
      1000
  ) /
    1000;
}

function parseReportTimestamp(
  parsedReport
) {
  const m =
    (
      parsedReport.timestamp ||
      ''
    ).match(
      /(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/
    );

  if (
    !m
  ) {
    return null;
  }

  const [
    ,
    month,
    day,
    year,
    hour,
    min,
    sec
  ] =
    m.map(
      Number
    );

  return {
    year,
    month,
    day,
    hour,
    min,
    sec,

    epoch:
      manilaEpoch(
        year,
        month,
        day,
        hour,
        min,
        sec
      )
  };
}

const SHIFT_END_HOUR = {
  'Mid-Shift':
    20,

  Night:
    5
};

const CLOSE_WINDOW_HOURS =
  2;

/*
 * FIXED:
 *
 * Check explicit phase FIRST.
 *
 * Morning (Closing) must be treated
 * as a closing count.
 */
function isClosingCount(
  current
) {
  if (
    !current.shift
  ) {
    return false;
  }

  /*
   * New format:
   *
   * Morning (Opening)
   * Morning (Closing)
   * Mid-Shift (Opening)
   * Mid-Shift (Closing)
   *
   * Trust phase when available.
   */
  if (
    current.phase
  ) {
    return (
      current.phase
        .toLowerCase() ===
      'closing'
    );
  }

  /*
   * Old format fallback.
   */

  if (
    /close/i.test(
      current.shift
    )
  ) {
    return true;
  }

  if (
    current.shift ===
    'Morning'
  ) {
    return false;
  }

  const endHour =
    SHIFT_END_HOUR[
      current.shift
    ];

  if (
    endHour ==
    null
  ) {
    return true;
  }

  const timeMatch =
    (
      current.timestamp ||
      ''
    ).match(
      /(\d{1,2}):(\d{2}):(\d{2})/
    );

  if (
    !timeMatch
  ) {
    return true;
  }

  const hour =
    parseInt(
      timeMatch[1],
      10
    ) +
    parseInt(
      timeMatch[2],
      10
    ) /
      60;

  const diff =
    Math.min(
      Math.abs(
        hour -
        endHour
      ),

      24 -
      Math.abs(
        hour -
        endHour
      )
    );

  return (
    diff <=
    CLOSE_WINDOW_HOURS
  );
}

function verifySlackSignature(
  req
) {
  const timestamp =
    req.headers[
      'x-slack-request-timestamp'
    ];

  const sig =
    req.headers[
      'x-slack-signature'
    ];

  if (
    !timestamp ||
    !sig ||
    !req.rawBody
  ) {
    return false;
  }

  if (
    Math.abs(
      Date.now() /
      1000 -
      timestamp
    ) >
    60 *
      5
  ) {
    return false;
  }

  const base =
    `v0:${timestamp}:${req.rawBody}`;

  const hmac =
    crypto
      .createHmac(
        'sha256',
        SIGNING_SECRET
      )
      .update(
        base
      )
      .digest(
        'hex'
      );

  const expected =
    `v0=${hmac}`;

  return crypto.timingSafeEqual(
    Buffer.from(
      expected
    ),

    Buffer.from(
      sig
    )
  );
}

app.get(
  '/',
  (
    req,
    res
  ) =>
    res.send(
      'Psulit Cash Audit is running.'
    )
);

const PORT =
  process.env.PORT ||
  3000;

const BALANCE_NOTIFICATIONS = new BalanceNotificationTracker();

if (require.main === module) app.listen(
  PORT,
  () =>
    console.log(
      `Listening on port ${PORT}`
    )
);

module.exports = { app, processSlackEvent, discrepancyResolutionWorkflow, runHiveDiagnostic, BRANCHES };
