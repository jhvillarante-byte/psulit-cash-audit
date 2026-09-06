/**
 * test-routes.js
 *
 * Manual audit test routes.
 *
 * Normal audit:
 *   /test/shift-audit?branch=Solaire&dry=1
 *
 * Corrected audit:
 *   /test/corrected-shift-audit?branch=Solaire&opening=HKD:100&dry=1
 *
 * Remove &dry=1 only when you want the PSulit Cash Audit bot
 * to actually post the corrected report to Slack.
 */

const {
  parseCashCount,
  parseTransaction,
  parseExpenseEntry
} = require('./parse');

const {
  history,
  postMessage
} = require('./slack');

const {
  runShiftAudit,
  runCloseVsOpenCheck,
  isScheduledOpening,
  isScheduledClosing
} = require('./audit');

const { reconcile } = require('./reconcile');
const { windowLabel } = require('./schedule');

const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const TICKET_RE = /(?:VN|ARN|AR)\s*#?\s*0*\d+/i;

const UNTRACKED_BUCKETS = [
  'Hive',
  'Opex',
  'Scratch',
  'Receivables (PHP)',
  'Receivables (USD)'
];

function stripUntracked(totals) {
  const copy = { ...totals };

  for (const key of UNTRACKED_BUCKETS) {
    delete copy[key];
  }

  return copy;
}

function firstName(fullName) {
  if (!fullName) return '?';
  return fullName.trim().split(/\s+/)[0];
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

const CCY_SYMBOL = {
  PHP: '₱',
  USD: '$',
  GBP: '£',
  EUR: '€',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  HKD: 'HK$'
};

function moneyLabel(ccy, amount) {
  const symbol = CCY_SYMBOL[ccy];

  return symbol
    ? `${symbol}${fmt(amount)}`
    : `${fmt(amount)} ${ccy}`;
}

async function findMostRecent(
  channelId,
  branchName,
  predicate
) {
  let latest;

  for (let page = 0; page < MAX_PAGES; page++) {
    const msgs = await history(channelId, {
      latest,
      limit: PAGE_SIZE
    });

    if (msgs.length === 0) break;

    for (const msg of msgs) {
      const parsed = parseCashCount(msg.text || '');

      if (
        parsed &&
        parsed.branch === branchName &&
        predicate(parsed)
      ) {
        return { msg, parsed };
      }
    }

    if (msgs.length < PAGE_SIZE) break;

    latest = (
      parseFloat(msgs[msgs.length - 1].ts) - 0.000001
    ).toFixed(6);
  }

  return null;
}

async function findPriorCount(
  channelId,
  beforeTs,
  branchName,
  predicate
) {
  let latest = beforeTs;

  for (let page = 0; page < MAX_PAGES; page++) {
    const msgs = await history(channelId, {
      latest,
      limit: PAGE_SIZE
    });

    if (msgs.length === 0) break;

    for (const msg of msgs) {
      if (parseFloat(msg.ts) >= parseFloat(beforeTs)) continue;

      const parsed = parseCashCount(msg.text || '');

      if (
        parsed &&
        parsed.branch === branchName &&
        predicate(parsed)
      ) {
        return {
          msg,
          parsed: {
            ...parsed,
            _ts: msg.ts
          }
        };
      }
    }

    if (msgs.length < PAGE_SIZE) break;

    latest = (
      parseFloat(msgs[msgs.length - 1].ts) - 0.000001
    ).toFixed(6);
  }

  return null;
}

function parseOpeningOverrides(raw) {
  const overrides = {};

  if (!raw) return overrides;

  const parts = raw.split(/[;,]/);

  for (const part of parts) {
    const m = part.trim().match(
      /^([A-Za-z]{3}):\s*(-?[\d,]+(?:\.\d+)?)$/
    );

    if (!m) continue;

    const ccy = m[1].toUpperCase();

    const amount = parseFloat(
      m[2].replace(/,/g, '')
    );

    if (!Number.isNaN(amount)) {
      overrides[ccy] = amount;
    }
  }

  return overrides;
}

/**
 * Detects documented PHP cash movement into/out of Forex fund.
 *
 * Examples it should catch:
 *
 * Petty Cash returned to Forex fund — ₱1,459.16
 * Cash returned to Forex Fund ₱5,000
 * Added to forex fund: PHP 10,000
 * ₱3,000 transferred from Forex Fund
 */
function parseForexFundMovement(text) {
  if (!text) return null;

  const normalized = text
    .replace(/\u00A0/g, ' ')
    .replace(/[–—]/g, '-')
    .trim();

  if (!/forex/i.test(normalized)) return null;

  // Do not accidentally count reports as actual cash movements.
  if (
    /SHIFT AUDIT|HANDOVER CHECK|PSULIT CASH COUNT REPORT|full math/i.test(
      normalized
    )
  ) {
    return null;
  }

  const amountMatch = normalized.match(
    /(?:₱|PHP\s*)\s*([\d,]+(?:\.\d+)?)/i
  );

  if (!amountMatch) return null;

  const amount = parseFloat(
    amountMatch[1].replace(/,/g, '')
  );

  if (Number.isNaN(amount)) return null;

  // Money goes INTO the Forex drawer/fund.
  const moneyIntoForex =
    /return(?:ed)?[\s\S]{0,50}forex/i.test(normalized) ||
    /added?[\s\S]{0,50}forex/i.test(normalized) ||
    /deposit(?:ed)?[\s\S]{0,50}forex/i.test(normalized) ||
    /replenish(?:ed|ment)?[\s\S]{0,50}forex/i.test(normalized) ||
    /transfer(?:red)?[\s\S]{0,50}(?:to|into)[\s\S]{0,30}forex/i.test(
      normalized
    ) ||
    /forex[\s\S]{0,30}(?:cash\s*)?in/i.test(normalized);

  // Money leaves the Forex drawer/fund.
  const moneyOutOfForex =
    /(?:taken|take)[\s\S]{0,50}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||
    /withdraw(?:n)?[\s\S]{0,50}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||
    /paid[\s\S]{0,50}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||
    /transfer(?:red)?[\s\S]{0,50}from[\s\S]{0,30}forex/i.test(
      normalized
    ) ||
    /forex[\s\S]{0,30}(?:cash\s*)?out/i.test(normalized);

  if (moneyIntoForex) {
    return {
      amount,
      direction: 'IN',
      raw: text
    };
  }

  if (moneyOutOfForex) {
    return {
      amount: -amount,
      direction: 'OUT',
      raw: text
    };
  }

  return null;
}

function registerTestRoutes(app, BRANCHES) {
  const byName = new Map(
    BRANCHES.map(b => [
      b.name.toLowerCase(),
      b
    ])
  );

  app.get('/test/shift-audit', async (req, res) => {
    try {
      const branchConfig = byName.get(
        (req.query.branch || '').toLowerCase()
      );

      if (!branchConfig) {
        return res.status(400).send(
          `Unknown branch. Known: ${[
            ...byName.keys()
          ].join(', ')}`
        );
      }

      const found = await findMostRecent(
        branchConfig.cashCountChannelId,
        branchConfig.name,
        isScheduledClosing
      );

      if (!found) {
        return res.status(404).send(
          `No scheduled closing count found for ${branchConfig.name}.`
        );
      }

      const {
        msg: closingMsg,
        parsed: closingCount
      } = found;

      const dryRun = req.query.dry === '1';

      const result = await runShiftAudit(
        { ts: closingMsg.ts },
        closingCount,
        branchConfig,
        { dryRun }
      );

      if (dryRun) {
        return res
          .type('text/plain')
          .send(
            `Using closing count at ${closingCount.timestamp}\n` +
            `Would post to: ${branchConfig.cashCountChannelId}\n\n` +
            result
          );
      }

      return res.send(
        `Posted shift audit for ${branchConfig.name}.`
      );

    } catch (err) {
      console.error(
        'test/shift-audit error:',
        err
      );

      return res
        .status(500)
        .type('text/plain')
        .send(
          `Error: ${err.message}\n\n${err.stack || ''}`
        );
    }
  });

  app.get(
    '/test/corrected-shift-audit',
    async (req, res) => {
      try {
        const branchConfig = byName.get(
          (req.query.branch || '').toLowerCase()
        );

        if (!branchConfig) {
          return res.status(400).send(
            `Unknown branch. Known: ${[
              ...byName.keys()
            ].join(', ')}`
          );
        }

        // 1. Find most recent scheduled closing.
        const foundClosing =
          await findMostRecent(
            branchConfig.cashCountChannelId,
            branchConfig.name,
            isScheduledClosing
          );

        if (!foundClosing) {
          return res.status(404).send(
            `No scheduled closing found for ${branchConfig.name}.`
          );
        }

        const closingMsg = foundClosing.msg;
        const closingCount = foundClosing.parsed;

        // 2. Find scheduled opening before it.
        const foundOpening =
          await findPriorCount(
            branchConfig.cashCountChannelId,
            closingMsg.ts,
            branchConfig.name,
            isScheduledOpening
          );

        if (!foundOpening) {
          return res.status(404).send(
            `No opening count found before ${closingCount.timestamp}.`
          );
        }

        const openingCount =
          foundOpening.parsed;

        // 3. Read all FX transactions.
        const txMessages = await history(
          branchConfig.transactionsChannelId,
          {
            oldest: openingCount._ts,
            latest: closingMsg.ts,
            limit: 500
          }
        );

        const tickets = txMessages
          .filter(
            m =>
              m.text &&
              TICKET_RE.test(m.text)
          )
          .map(m => ({
            parsed: parseTransaction(
              m.text || ''
            ),
            raw: m.text || '',
            ts: m.ts
          }))
          .filter(t => t.parsed);

        // 4. Read expense/replenishment entries.
        let expenseTotal = 0;
        const expenseEntries = [];

        if (branchConfig.expensesChannelId) {
          const expenseMessages =
            await history(
              branchConfig.expensesChannelId,
              {
                oldest: openingCount._ts,
                latest: closingMsg.ts,
                limit: 300
              }
            );

          for (const m of expenseMessages) {
            const parsed =
              parseExpenseEntry(
                m.text || ''
              );

            if (!parsed) continue;

            expenseTotal += parsed.amount;

            expenseEntries.push({
              ...parsed,
              raw: m.text || '',
              ts: m.ts
            });
          }
        }

        // 5. Read documented cash movements in branch/general channel.
        const generalMessages =
          await history(
            branchConfig.cashCountChannelId,
            {
              oldest: openingCount._ts,
              latest: closingMsg.ts,
              limit: 500
            }
          );

        const forexMovements = [];

        for (const m of generalMessages) {
          const parsed =
            parseForexFundMovement(
              m.text || ''
            );

          if (!parsed) continue;

          forexMovements.push({
            ...parsed,
            ts: m.ts
          });
        }

        const forexMovementTotal =
          forexMovements.reduce(
            (sum, m) =>
              sum + m.amount,
            0
          );

        // 6. Build opening/closing balances.
        const openingTotals =
          stripUntracked({
            ...openingCount.totals,
            ...openingCount.others
          });

        const closingTotals =
          stripUntracked({
            ...closingCount.totals,
            ...closingCount.others
          });

        // 7. Apply confirmed corrected opening values.
        const openingOverrides =
          parseOpeningOverrides(
            req.query.opening || ''
          );

        const correctionLines = [];

        for (
          const [ccy, correctedAmount]
          of Object.entries(openingOverrides)
        ) {
          const oldAmount =
            openingTotals[ccy] || 0;

          openingTotals[ccy] =
            correctedAmount;

          correctionLines.push(
            `✏️ ${ccy} opening corrected: ` +
            `${moneyLabel(ccy, oldAmount)} → ` +
            `${moneyLabel(ccy, correctedAmount)}`
          );
        }

        // 8. Combine all PHP movements outside FX tickets.
        const phpAdjustment =
          expenseTotal +
          forexMovementTotal;

        const adjustments = {};

        if (phpAdjustment !== 0) {
          adjustments.PHP =
            phpAdjustment;
        }

        // 9. Reconcile.
        const results = reconcile(
          openingTotals,
          closingTotals,
          tickets.map(t => t.parsed),
          adjustments
        );

        const mismatches =
          results.filter(
            r => !r.match
          );

        // 10. Build report.
        const dateLabel =
          (
            closingCount.timestamp || ''
          )
            .split(',')[0]
            .trim();

        const lines = [];

        lines.push(
          `🔍 *CORRECTED SHIFT AUDIT — ${branchConfig.name}*`
        );

        lines.push(
          `📅 ${dateLabel} | ${windowLabel(closingCount)}`
        );

        lines.push(
          `${firstName(openingCount.teller)} (opened) → ` +
          `${firstName(closingCount.teller)} (closed)`
        );

        lines.push('');

        if (correctionLines.length) {
          lines.push(
            '*Confirmed cash-count correction:*'
          );

          lines.push(
            ...correctionLines
          );

          lines.push('');
        }

        if (forexMovements.length) {
          lines.push(
            '*Forex Fund cash movement included:*'
          );

          for (const movement of forexMovements) {
            lines.push(
              `💵 ${movement.direction}: ` +
              `${moneyLabel(
                'PHP',
                Math.abs(
                  movement.amount
                )
              )}`
            );
          }

          lines.push(
            `Net Forex Fund movement: ` +
            `${moneyLabel(
              'PHP',
              forexMovementTotal
            )}`
          );

          lines.push('');
        }

        if (expenseEntries.length) {
          lines.push(
            `💼 ${expenseEntries.length} ` +
            `expense/replenishment ` +
            `entr${expenseEntries.length === 1 ? 'y' : 'ies'} included ` +
            `(net ${moneyLabel(
              'PHP',
              expenseTotal
            )}).`
          );

          lines.push('');
        }

        if (mismatches.length === 0) {
          lines.push(
            `✅ *ALL GOOD — SHIFT RECONCILED.*`
          );

          lines.push(
            `${tickets.length} transactions checked. ` +
            `Corrected opening count, transactions, expenses, ` +
            `and documented cash movements all reconcile with the closing count.`
          );
        } else {
          lines.push(
            `⚠️ *${mismatches.length} discrepancy` +
            `${mismatches.length === 1 ? '' : 'ies'} still open:*`
          );

          for (const r of mismatches) {
            const direction =
              r.diff < 0
                ? 'short'
                : 'extra';

            lines.push(
              `❗ ${r.ccy}: ${direction} ` +
              `${moneyLabel(
                r.ccy,
                Math.abs(r.diff)
              )}`
            );
          }
        }

        const report =
          lines.join('\n');

        const dryRun =
          req.query.dry === '1';

        if (dryRun) {
          return res
            .type('text/plain')
            .send(
              `Using closing count at ${closingCount.timestamp}\n` +
              `Using opening count at ${openingCount.timestamp}\n` +
              `Would post via PSulit Cash Audit bot to: ` +
              `${branchConfig.cashCountChannelId}\n\n` +
              report
            );
        }

        const posted =
          await postMessage(
            branchConfig.cashCountChannelId,
            report
          );

        return res
          .type('text/plain')
          .send(
            `✅ Corrected shift audit posted by PSulit Cash Audit bot.\n` +
            `Slack message ts: ${posted.ts}`
          );

      } catch (err) {
        console.error(
          'corrected-shift-audit error:',
          err
        );

        return res
          .status(500)
          .type('text/plain')
          .send(
            `Error: ${err.message}\n\n${err.stack || ''}`
          );
      }
    }
  );

  app.get('/test/handover', async (req, res) => {
    try {
      const branchConfig = byName.get(
        (req.query.branch || '').toLowerCase()
      );

      if (!branchConfig) {
        return res.status(400).send(
          `Unknown branch. Known: ${[
            ...byName.keys()
          ].join(', ')}`
        );
      }

      const found = await findMostRecent(
        branchConfig.cashCountChannelId,
        branchConfig.name,
        isScheduledOpening
      );

      if (!found) {
        return res.status(404).send(
          `No scheduled opening count found for ${branchConfig.name}.`
        );
      }

      const {
        msg: openingMsg,
        parsed: openingCount
      } = found;

      const dryRun =
        req.query.dry === '1';

      const result =
        await runCloseVsOpenCheck(
          { ts: openingMsg.ts },
          openingCount,
          branchConfig,
          { dryRun }
        );

      if (dryRun) {
        return res
          .type('text/plain')
          .send(
            `Using opening count at ${openingCount.timestamp}\n` +
            `Would post to: ${branchConfig.cashCountChannelId}\n\n` +
            result
          );
      }

      return res.send(
        `Posted handover check for ${branchConfig.name}.`
      );

    } catch (err) {
      console.error(
        'test/handover error:',
        err
      );

      return res
        .status(500)
        .type('text/plain')
        .send(
          `Error: ${err.message}\n\n${err.stack || ''}`
        );
    }
  });
}

module.exports = {
  registerTestRoutes
};
