/**
 * debug-routes.js
 *
 * TEMPORARY diagnostic route — shows exactly what the bot sees when it reads
 * a channel's recent cash count messages: the raw parsed branch/shift/phase/
 * timestamp fields, and whether isScheduledOpening/isScheduledClosing accept
 * each one. Use this to find parsing mismatches without guessing.
 *
 * GET /debug/counts?branch=Alphaland&limit=15
 *
 * Remove this file (and its require/registerDebugRoutes call in server.js)
 * once the underlying issue is found — it's a diagnostic aid, not meant to
 * stay in production long-term.
 */

const { parseCashCount } = require('./parse');
const { history } = require('./slack');
const { isScheduledOpening, isScheduledClosing, windowLabel } = require('./schedule');

function registerDebugRoutes(app, BRANCHES) {
  const byName = new Map(BRANCHES.map(b => [b.name.toLowerCase(), b]));

  app.get('/debug/counts', async (req, res) => {
    try {
      const branchConfig = byName.get((req.query.branch || '').toLowerCase());
      if (!branchConfig) {
        return res.status(400).send(`Unknown branch. Known: ${[...byName.keys()].join(', ')}`);
      }
      const limit = Math.min(parseInt(req.query.limit, 10) || 15, 100);

      const msgs = await history(branchConfig.cashCountChannelId, { limit });

      const lines = [];
      lines.push(`Channel: ${branchConfig.cashCountChannelId}  (${branchConfig.name})`);
      lines.push(`Fetched ${msgs.length} most recent messages (any type).`);
      lines.push('='.repeat(90));

      let cashCountCount = 0;

      for (const msg of msgs) {
        const preview = (msg.text || '').replace(/\n/g, ' \\n ').slice(0, 50);
        const parsed = parseCashCount(msg.text || '');

        if (!parsed) {
          lines.push(`[ts=${msg.ts}] NOT a cash count message — "${preview}..."`);
          continue;
        }

        cashCountCount++;
        const opening = isScheduledOpening(parsed);
        const closing = isScheduledClosing(parsed);

        lines.push('');
        lines.push(`[ts=${msg.ts}] CASH COUNT MESSAGE #${cashCountCount}`);
        lines.push(`  Branch:    "${parsed.branch}"  (expected "${branchConfig.name}", match=${parsed.branch === branchConfig.name})`);
        lines.push(`  Shift:     "${parsed.shift}"`);
        lines.push(`  Phase:     "${parsed.phase}"`);
        lines.push(`  Timestamp: "${parsed.timestamp}"`);
        lines.push(`  Teller:    "${parsed.teller}"`);
        lines.push(`  isScheduledOpening() -> ${opening}`);
        lines.push(`  isScheduledClosing() -> ${closing}`);
        if (opening || closing) {
          lines.push(`  windowLabel() -> "${windowLabel(parsed)}"`);
        }
      }

      lines.push('');
      lines.push('='.repeat(90));
      lines.push(`Total cash count messages found: ${cashCountCount} of ${msgs.length} fetched.`);

      res.type('text/plain').send(lines.join('\n'));
    } catch (err) {
      console.error('debug/counts error:', err);
      res.status(500).type('text/plain').send(`Error: ${err.message}\n\n${err.stack || ''}`);
    }
  });
}

module.exports = { registerDebugRoutes };
