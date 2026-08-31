/**
 * test-routes.js
 *
 * TEMPORARY manual test endpoints — wire these into server.js, test, then
 * remove before going fully live (or leave them, but they do post real
 * messages to Slack when called, so don't leave them open to the public
 * without at least a shared-secret check).
 *
 * Usage (after deploy):
 *   GET /test/shift-audit?branch=Solaire
 *     -> finds the most recent CLOSING count for that branch already in
 *        Slack, and the opening count before it, and runs runShiftAudit()
 *        exactly as if that closing count had just been posted live.
 *
 *   GET /test/handover?branch=Solaire
 *     -> finds the most recent OPENING count for that branch already in
 *        Slack, and the closing count before it, and runs
 *        runCloseVsOpenCheck() exactly as if that opening count had just
 *        been posted live.
 *
 * Both post a REAL message to the branch's cash count channel — same as
 * production — so you can see the report land in Slack.
 *
 * Add ?dry=1 to either route to log the report instead of posting it,
 * if you want to eyeball it first without touching the channel.
 */

const { parseCashCount } = require('./parse');
const { history, postMessage } = require('./slack');
const { runShiftAudit, runCloseVsOpenCheck, isScheduledOpening, isScheduledClosing } = require('./audit');

function registerTestRoutes(app, BRANCHES) {
  const byName = new Map(BRANCHES.map(b => [b.name.toLowerCase(), b]));

  app.get('/test/shift-audit', async (req, res) => {
    try {
      const branchConfig = byName.get((req.query.branch || '').toLowerCase());
      if (!branchConfig) {
        return res.status(400).send(`Unknown branch. Known: ${[...byName.keys()].join(', ')}`);
      }

      // Walk back through the cash count channel looking for the most recent
      // count that schedule.js recognizes as a scheduled CLOSING.
      const msgs = await history(branchConfig.cashCountChannelId, { limit: 200 });
      let closingMsg = null, closingCount = null;
      for (const msg of msgs) {
        const parsed = parseCashCount(msg.text || '');
        if (parsed && parsed.branch === branchConfig.name && isScheduledClosing(parsed)) {
          closingMsg = msg;
          closingCount = parsed;
          break; // history() returns newest-first
        }
      }

      if (!closingCount) {
        return res.status(404).send(
          `No scheduled closing count found in the last 200 messages for ${branchConfig.name}.`
        );
      }

      if (req.query.dry === '1') {
        // Monkey-patch postMessage just for this call so nothing actually posts.
        const original = postMessage;
        let captured = null;
        const slackModule = require('./slack');
        slackModule.postMessage = async (channel, text) => { captured = { channel, text }; return { ok: true }; };
        await runShiftAudit({ ts: closingMsg.ts }, closingCount, branchConfig);
        slackModule.postMessage = original;
        return res.type('text/plain').send(
          `[DRY RUN — nothing posted to Slack]\n\nWould post to ${captured?.channel}:\n\n${captured?.text}`
        );
      }

      await runShiftAudit({ ts: closingMsg.ts }, closingCount, branchConfig);
      res.send(
        `Ran shift audit for ${branchConfig.name} using closing count at ${closingCount.timestamp}. ` +
        `Check #${branchConfig.name}'s cash count channel in Slack for the report.`
      );
    } catch (err) {
      console.error('test/shift-audit error:', err);
      res.status(500).send(`Error: ${err.message}`);
    }
  });

  app.get('/test/handover', async (req, res) => {
    try {
      const branchConfig = byName.get((req.query.branch || '').toLowerCase());
      if (!branchConfig) {
        return res.status(400).send(`Unknown branch. Known: ${[...byName.keys()].join(', ')}`);
      }

      const msgs = await history(branchConfig.cashCountChannelId, { limit: 200 });
      let openingMsg = null, openingCount = null;
      for (const msg of msgs) {
        const parsed = parseCashCount(msg.text || '');
        if (parsed && parsed.branch === branchConfig.name && isScheduledOpening(parsed)) {
          openingMsg = msg;
          openingCount = parsed;
          break;
        }
      }

      if (!openingCount) {
        return res.status(404).send(
          `No scheduled opening count found in the last 200 messages for ${branchConfig.name}.`
        );
      }

      if (req.query.dry === '1') {
        const slackModule = require('./slack');
        const original = slackModule.postMessage;
        let captured = null;
        slackModule.postMessage = async (channel, text) => { captured = { channel, text }; return { ok: true }; };
        await runCloseVsOpenCheck({ ts: openingMsg.ts }, openingCount, branchConfig);
        slackModule.postMessage = original;
        return res.type('text/plain').send(
          `[DRY RUN — nothing posted to Slack]\n\nWould post to ${captured?.channel}:\n\n${captured?.text}`
        );
      }

      await runCloseVsOpenCheck({ ts: openingMsg.ts }, openingCount, branchConfig);
      res.send(
        `Ran handover check for ${branchConfig.name} using opening count at ${openingCount.timestamp}. ` +
        `Check #${branchConfig.name}'s cash count channel in Slack for the report.`
      );
    } catch (err) {
      console.error('test/handover error:', err);
      res.status(500).send(`Error: ${err.message}`);
    }
  });
}

module.exports = { registerTestRoutes };
