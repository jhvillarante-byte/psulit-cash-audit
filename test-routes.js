/**
 * test-routes.js
 *
 * Manual test endpoints for triggering the audit against real, already-posted
 * Slack data — no need to wait for the next real 5AM/9AM/9PM/10AM boundary.
 *
 * Usage (after deploy):
 *   GET /test/shift-audit?branch=Solaire
 *   GET /test/shift-audit?branch=Alphaland
 *     -> finds the most recent scheduled CLOSING count for that branch and
 *        the opening count before it, and runs runShiftAudit() on that pair.
 *
 *   GET /test/handover?branch=Solaire
 *   GET /test/handover?branch=Alphaland
 *     -> finds the most recent scheduled OPENING count for that branch and
 *        the closing count before it, and runs runCloseVsOpenCheck().
 *
 * Add &dry=1 to either route to get the report text back in the browser
 * WITHOUT posting to Slack and WITHOUT touching the OPEN_FLAGS tracker
 * (so testing never corrupts what the next real report considers "already
 * flagged" or "newly resolved"). Drop &dry=1 to actually post for real.
 *
 * Both routes page through Slack's history rather than a single fixed-size
 * call — a busy channel can easily have 100+ messages (cash count
 * confirmations, CCTV notices, etc.) between two real counts, and a single
 * capped lookback would silently miss counts that genuinely exist further
 * back than one page.
 */

const { parseCashCount } = require('./parse');
const { history } = require('./slack');
const { runShiftAudit, runCloseVsOpenCheck, isScheduledOpening, isScheduledClosing } = require('./audit');

const PAGE_SIZE = 200;
const MAX_PAGES = 10; // 2,000 messages back — well past any realistic search; stops runaway loops

/**
 * Pages backward through a channel's history looking for the newest message
 * (for the given branch) that satisfies `predicate`. Returns { msg, parsed }
 * or null.
 */
async function findMostRecent(channelId, branchName, predicate) {
  let latest = undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const msgs = await history(channelId, { latest, limit: PAGE_SIZE });
    if (msgs.length === 0) break;

    for (const msg of msgs) {
      const parsed = parseCashCount(msg.text || '');
      if (parsed && parsed.branch === branchName && predicate(parsed)) {
        return { msg, parsed };
      }
    }

    if (msgs.length < PAGE_SIZE) break; // reached the start of the channel
    latest = (parseFloat(msgs[msgs.length - 1].ts) - 0.000001).toFixed(6);
  }
  return null;
}

function registerTestRoutes(app, BRANCHES) {
  const byName = new Map(BRANCHES.map(b => [b.name.toLowerCase(), b]));

  app.get('/test/shift-audit', async (req, res) => {
    try {
      const branchConfig = byName.get((req.query.branch || '').toLowerCase());
      if (!branchConfig) {
        return res.status(400).send(`Unknown branch. Known: ${[...byName.keys()].join(', ')}`);
      }

      const found = await findMostRecent(branchConfig.cashCountChannelId, branchConfig.name, isScheduledClosing);
      if (!found) {
        return res.status(404).send(
          `No scheduled closing count found (searched up to ${PAGE_SIZE * MAX_PAGES} messages back) for ${branchConfig.name}.`
        );
      }
      const { msg: closingMsg, parsed: closingCount } = found;

      const dryRun = req.query.dry === '1';
      const result = await runShiftAudit({ ts: closingMsg.ts }, closingCount, branchConfig, { dryRun });

      if (dryRun) {
        return res.type('text/plain').send(
          `Using closing count at ${closingCount.timestamp}\n` +
          `Would post to: ${branchConfig.cashCountChannelId}\n\n` +
          `${result}`
        );
      }

      res.send(
        `Posted shift audit for ${branchConfig.name} using closing count at ${closingCount.timestamp}. ` +
        `Check the branch's cash count channel in Slack.`
      );
    } catch (err) {
      console.error('test/shift-audit error:', err);
      res.status(500).type('text/plain').send(`Error: ${err.message}\n\n${err.stack || ''}`);
    }
  });

  app.get('/test/handover', async (req, res) => {
    try {
      const branchConfig = byName.get((req.query.branch || '').toLowerCase());
      if (!branchConfig) {
        return res.status(400).send(`Unknown branch. Known: ${[...byName.keys()].join(', ')}`);
      }

      const found = await findMostRecent(branchConfig.cashCountChannelId, branchConfig.name, isScheduledOpening);
      if (!found) {
        return res.status(404).send(
          `No scheduled opening count found (searched up to ${PAGE_SIZE * MAX_PAGES} messages back) for ${branchConfig.name}.`
        );
      }
      const { msg: openingMsg, parsed: openingCount } = found;

      const dryRun = req.query.dry === '1';
      const result = await runCloseVsOpenCheck({ ts: openingMsg.ts }, openingCount, branchConfig, { dryRun });

      if (dryRun) {
        return res.type('text/plain').send(
          `Using opening count at ${openingCount.timestamp}\n` +
          `Would post to: ${branchConfig.cashCountChannelId}\n\n` +
          `${result}`
        );
      }

      res.send(
        `Posted handover check for ${branchConfig.name} using opening count at ${openingCount.timestamp}. ` +
        `Check the branch's cash count channel in Slack.`
      );
    } catch (err) {
      console.error('test/handover error:', err);
      res.status(500).type('text/plain').send(`Error: ${err.message}\n\n${err.stack || ''}`);
    }
  });
}

module.exports = { registerTestRoutes };
