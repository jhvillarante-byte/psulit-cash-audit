/**
 * debug-routes.js
 *
 * Temporary diagnostic routes.
 *
 * Cash counts:
 *   /debug/counts?branch=Alphaland&limit=15
 *
 * Raw cash-count messages:
 *   /debug/raw?branch=Alphaland&limit=3
 *
 * Expense debug:
 *   /debug/expenses?branch=Alphaland
 *
 * Transaction debug:
 *   /debug/transactions?branch=Alphaland
 */

const {
  parseCashCount,
  parseExpenseEntry,
  parseTransaction
} = require('./parse');

const { history } = require('./slack');

const {
  isScheduledOpening,
  isScheduledClosing,
  windowLabel
} = require('./schedule');

const PAGE_SIZE = 200;
const MAX_PAGES = 10;

function registerDebugRoutes(app, BRANCHES) {
  const byName = new Map(
    BRANCHES.map(b => [
      b.name.toLowerCase(),
      b
    ])
  );

  /*
   * Find most recent scheduled closing count.
   */
  async function findLatestClosing(branchConfig) {
    let latest;

    for (let page = 0; page < MAX_PAGES; page++) {
      const msgs = await history(
        branchConfig.cashCountChannelId,
        {
          latest,
          limit: PAGE_SIZE
        }
      );

      if (msgs.length === 0) {
        break;
      }

      for (const msg of msgs) {
        const parsed = parseCashCount(
          msg.text || ''
        );

        if (
          parsed &&
          parsed.branch === branchConfig.name &&
          isScheduledClosing(parsed)
        ) {
          return {
            msg,
            parsed
          };
        }
      }

      if (msgs.length < PAGE_SIZE) {
        break;
      }

      latest = (
        parseFloat(
          msgs[msgs.length - 1].ts
        ) - 0.000001
      ).toFixed(6);
    }

    return null;
  }

  /*
   * Find opening immediately before closing.
   */
  async function findOpeningBefore(
    branchConfig,
    closingTs
  ) {
    let latest = closingTs;

    for (let page = 0; page < MAX_PAGES; page++) {
      const msgs = await history(
        branchConfig.cashCountChannelId,
        {
          latest,
          limit: PAGE_SIZE
        }
      );

      if (msgs.length === 0) {
        break;
      }

      for (const msg of msgs) {
        if (
          parseFloat(msg.ts) >=
          parseFloat(closingTs)
        ) {
          continue;
        }

        const parsed = parseCashCount(
          msg.text || ''
        );

        if (
          parsed &&
          parsed.branch === branchConfig.name &&
          isScheduledOpening(parsed)
        ) {
          return {
            msg,
            parsed
          };
        }
      }

      if (msgs.length < PAGE_SIZE) {
        break;
      }

      latest = (
        parseFloat(
          msgs[msgs.length - 1].ts
        ) - 0.000001
      ).toFixed(6);
    }

    return null;
  }

  /*
   * CASH COUNT DEBUG
   */
  app.get(
    '/debug/counts',
    async (req, res) => {
      try {
        const branchConfig =
          byName.get(
            (
              req.query.branch || ''
            ).toLowerCase()
          );

        if (!branchConfig) {
          return res
            .status(400)
            .send(
              `Unknown branch. Known: ${[
                ...byName.keys()
              ].join(', ')}`
            );
        }

        const limit = Math.min(
          parseInt(
            req.query.limit,
            10
          ) || 15,
          100
        );

        const msgs = await history(
          branchConfig.cashCountChannelId,
          { limit }
        );

        const lines = [];

        lines.push(
          `Channel: ${branchConfig.cashCountChannelId} (${branchConfig.name})`
        );

        lines.push(
          `Fetched ${msgs.length} most recent messages.`
        );

        lines.push(
          '='.repeat(90)
        );

        let cashCountCount = 0;

        for (const msg of msgs) {
          const preview =
            (msg.text || '')
              .replace(
                /\n/g,
                ' \\n '
              )
              .slice(0, 50);

          const parsed =
            parseCashCount(
              msg.text || ''
            );

          if (!parsed) {
            lines.push(
              `[ts=${msg.ts}] NOT cash count — "${preview}..."`
            );

            continue;
          }

          cashCountCount++;

          const opening =
            isScheduledOpening(
              parsed
            );

          const closing =
            isScheduledClosing(
              parsed
            );

          lines.push('');

          lines.push(
            `[ts=${msg.ts}] CASH COUNT #${cashCountCount}`
          );

          lines.push(
            `  Branch: ${JSON.stringify(parsed.branch)}`
          );

          lines.push(
            `  Shift: ${JSON.stringify(parsed.shift)}`
          );

          lines.push(
            `  Phase: ${JSON.stringify(parsed.phase)}`
          );

          lines.push(
            `  Timestamp: ${JSON.stringify(parsed.timestamp)}`
          );

          lines.push(
            `  Teller: ${JSON.stringify(parsed.teller)}`
          );

          lines.push(
            `  Opening: ${opening}`
          );

          lines.push(
            `  Closing: ${closing}`
          );

          if (opening || closing) {
            lines.push(
              `  Window: ${windowLabel(parsed)}`
            );
          }
        }

        res
          .type('text/plain')
          .send(
            lines.join('\n')
          );

      } catch (err) {
        console.error(
          'debug/counts error:',
          err
        );

        res
          .status(500)
          .type('text/plain')
          .send(
            `Error: ${err.message}\n\n${err.stack || ''}`
          );
      }
    }
  );

  /*
   * RAW CASH COUNT DEBUG
   */
  app.get(
    '/debug/raw',
    async (req, res) => {
      try {
        const branchConfig =
          byName.get(
            (
              req.query.branch || ''
            ).toLowerCase()
          );

        if (!branchConfig) {
          return res
            .status(400)
            .send(
              `Unknown branch. Known: ${[
                ...byName.keys()
              ].join(', ')}`
            );
        }

        const limit = Math.min(
          parseInt(
            req.query.limit,
            10
          ) || 3,
          10
        );

        const msgs = await history(
          branchConfig.cashCountChannelId,
          { limit }
        );

        const lines = [];

        lines.push(
          `Channel: ${branchConfig.cashCountChannelId} (${branchConfig.name})`
        );

        lines.push(
          `Showing ${msgs.length} raw messages.`
        );

        lines.push(
          '='.repeat(90)
        );

        for (const msg of msgs) {
          lines.push('');

          lines.push(
            `--- Message ts=${msg.ts} ---`
          );

          lines.push(
            JSON.stringify(
              msg.text || ''
            )
          );
        }

        res
          .type('text/plain')
          .send(
            lines.join('\n')
          );

      } catch (err) {
        console.error(
          'debug/raw error:',
          err
        );

        res
          .status(500)
          .type('text/plain')
          .send(
            `Error: ${err.message}\n\n${err.stack || ''}`
          );
      }
    }
  );

  /*
   * EXPENSE DEBUG
   */
  app.get(
    '/debug/expenses',
    async (req, res) => {
      try {
        const branchConfig =
          byName.get(
            (
              req.query.branch || ''
            ).toLowerCase()
          );

        if (!branchConfig) {
          return res
            .status(400)
            .send(
              `Unknown branch. Known: ${[
                ...byName.keys()
              ].join(', ')}`
            );
        }

        if (!branchConfig.expensesChannelId) {
          return res
            .status(400)
            .send(
              `${branchConfig.name} has no expenses channel configured.`
            );
        }

        const closing =
          await findLatestClosing(
            branchConfig
          );

        if (!closing) {
          return res
            .status(404)
            .send(
              `No closing cash count found for ${branchConfig.name}.`
            );
        }

        const opening =
          await findOpeningBefore(
            branchConfig,
            closing.msg.ts
          );

        if (!opening) {
          return res
            .status(404)
            .send(
              'No opening cash count found before closing.'
            );
        }

        const expenseMessages =
          await history(
            branchConfig.expensesChannelId,
            {
              oldest:
                opening.msg.ts,

              latest:
                closing.msg.ts,

              limit: 300
            }
          );

        const lines = [];

        lines.push(
          `EXPENSE DEBUG — ${branchConfig.name}`
        );

        lines.push(
          `Opening: ${opening.parsed.timestamp}`
        );

        lines.push(
          `Closing: ${closing.parsed.timestamp}`
        );

        lines.push(
          `Expense channel: ${branchConfig.expensesChannelId}`
        );

        lines.push(
          `Messages fetched: ${expenseMessages.length}`
        );

        lines.push(
          '='.repeat(90)
        );

        let detectedCount = 0;
        let total = 0;

        for (const msg of expenseMessages) {
          const text =
            msg.text || '';

          const parsed =
            parseExpenseEntry(
              text
            );

          if (!parsed) {
            continue;
          }

          detectedCount++;

          total +=
            parsed.amount;

          lines.push('');

          lines.push(
            `DETECTED #${detectedCount}`
          );

          lines.push(
            `Slack ts: ${msg.ts}`
          );

          lines.push(
            `Parsed amount: ${parsed.amount >= 0 ? '+' : '-'}₱${Math.abs(parsed.amount).toLocaleString(
              'en-US',
              {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              }
            )}`
          );

          lines.push(
            'RAW MESSAGE:'
          );

          lines.push(text);

          lines.push(
            '-'.repeat(90)
          );
        }

        lines.push('');

        lines.push(
          '='.repeat(90)
        );

        lines.push(
          `Detected entries: ${detectedCount}`
        );

        lines.push(
          `NET: ${total >= 0 ? '+' : '-'}₱${Math.abs(total).toLocaleString(
            'en-US',
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }
          )}`
        );

        res
          .type('text/plain')
          .send(
            lines.join('\n')
          );

      } catch (err) {
        console.error(
          'debug/expenses error:',
          err
        );

        res
          .status(500)
          .type('text/plain')
          .send(
            `Error: ${err.message}\n\n${err.stack || ''}`
          );
      }
    }
  );

  /*
   * TRANSACTION DEBUG
   *
   * Shows every transaction message between
   * opening and closing and exactly what
   * parseTransaction() sees.
   */
  app.get(
    '/debug/transactions',
    async (req, res) => {
      try {
        const branchConfig =
          byName.get(
            (
              req.query.branch || ''
            ).toLowerCase()
          );

        if (!branchConfig) {
          return res
            .status(400)
            .send(
              `Unknown branch. Known: ${[
                ...byName.keys()
              ].join(', ')}`
            );
        }

        if (!branchConfig.transactionsChannelId) {
          return res
            .status(400)
            .send(
              `${branchConfig.name} has no transaction channel configured.`
            );
        }

        const closing =
          await findLatestClosing(
            branchConfig
          );

        if (!closing) {
          return res
            .status(404)
            .send(
              `No closing cash count found for ${branchConfig.name}.`
            );
        }

        const opening =
          await findOpeningBefore(
            branchConfig,
            closing.msg.ts
          );

        if (!opening) {
          return res
            .status(404)
            .send(
              'No opening cash count found before closing.'
            );
        }

        const txMessages =
          await history(
            branchConfig.transactionsChannelId,
            {
              oldest:
                opening.msg.ts,

              latest:
                closing.msg.ts,

              limit: 500
            }
          );

        const lines = [];

        lines.push(
          `TRANSACTION DEBUG — ${branchConfig.name}`
        );

        lines.push(
          `Opening: ${opening.parsed.timestamp}`
        );

        lines.push(
          `Closing: ${closing.parsed.timestamp}`
        );

        lines.push(
          `Transaction channel: ${branchConfig.transactionsChannelId}`
        );

        lines.push(
          `Messages fetched: ${txMessages.length}`
        );

        lines.push(
          '='.repeat(90)
        );

        let detectedCount = 0;
        let phpNet = 0;

        for (const msg of txMessages) {
          const text =
            msg.text || '';

          const parsed =
            parseTransaction(
              text
            );

          if (!parsed) {
            continue;
          }

          detectedCount++;

          let phpEffect = 0;

          if (
            parsed.phpAmount != null &&
            parsed.movements &&
            parsed.movements.length
          ) {
            const action =
              parsed.movements[0].action;

            phpEffect =
              action === 'BUY'
                ? -parsed.phpAmount
                : parsed.phpAmount;

            phpNet +=
              phpEffect;
          }

          lines.push('');

          lines.push(
            `TRANSACTION #${detectedCount}`
          );

          lines.push(
            `Slack ts: ${msg.ts}`
          );

          lines.push(
            `Parsed PHP amount: ${
              parsed.phpAmount == null
                ? 'NONE'
                : '₱' +
                  Number(
                    parsed.phpAmount
                  ).toLocaleString(
                    'en-US',
                    {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    }
                  )
            }`
          );

          lines.push(
            `PHP effect: ${
              phpEffect >= 0
                ? '+'
                : '-'
            }₱${Math.abs(
              phpEffect
            ).toLocaleString(
              'en-US',
              {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              }
            )}`
          );

          lines.push(
            'Parsed movements:'
          );

          if (
            parsed.movements &&
            parsed.movements.length
          ) {
            for (
              const mv of
              parsed.movements
            ) {
              lines.push(
                `  ${mv.action} ${Number(
                  mv.fcyAmount
                ).toLocaleString(
                  'en-US',
                  {
                    maximumFractionDigits: 2
                  }
                )} ${mv.ccy}`
              );
            }
          } else {
            lines.push(
              '  NONE'
            );
          }

          lines.push(
            'RAW MESSAGE:'
          );

          lines.push(text);

          lines.push(
            '-'.repeat(90)
          );
        }

        lines.push('');

        lines.push(
          '='.repeat(90)
        );

        lines.push(
          `Detected transactions: ${detectedCount}`
        );

        lines.push(
          `NET PHP EFFECT: ${
            phpNet >= 0
              ? '+'
              : '-'
          }₱${Math.abs(
            phpNet
          ).toLocaleString(
            'en-US',
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }
          )}`
        );

        res
          .type('text/plain')
          .send(
            lines.join('\n')
          );

      } catch (err) {
        console.error(
          'debug/transactions error:',
          err
        );

        res
          .status(500)
          .type('text/plain')
          .send(
            `Error: ${err.message}\n\n${err.stack || ''}`
          );
      }
    }
  );
}

module.exports = {
  registerDebugRoutes
};
