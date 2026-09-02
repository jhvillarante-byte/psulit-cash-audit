/**
 * debug-routes.js
 *
 * TEMPORARY diagnostic route — shows exactly what the bot sees when it reads
 * a channel's recent cash count messages.
 *
 * GET /debug/counts?branch=Alphaland&limit=15
 * GET /debug/raw?branch=Alphaland&limit=3      <-- NEW: full raw message dump
 *
 * Remove this file (and its require/registerDebugRoutes call in server.js)
 * once the underlying issue is found.
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
        lines.push(`  Branch:    ${JSON.stringify(parsed.branch)}  (expected ${JSON.stringify(branchConfig.name)}, match=${parsed.branch === branchConfig.name})`);
        lines.push(`  Shift:     ${JSON.stringify(parsed.shift)}`);
        lines.push(`  Phase:     ${JSON.stringify(parsed.phase)}`);
        lines.push(`  Timestamp: ${JSON.stringify(parsed.timestamp)}`);
        lines.push(`  Teller:    ${JSON.stringify(parsed.teller)}`);
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

  // NEW: dumps the full, unprocessed message object(s) — text field in full,
  // plus which other keys Slack sent (blocks, attachments, etc.) — so we can
  // see EXACTLY what the bot receives, byte for byte, no truncation.
  app.get('/debug/raw', async (req, res) => {
    try {
      const branchConfig = byName.get((req.query.branch || '').toLowerCase());
      if (!branchConfig) {
        return res.status(400).send(`Unknown branch. Known: ${[...byName.keys()].join(', ')}`);
      }
      const limit = Math.min(parseInt(req.query.limit, 10) || 3, 10);

      const msgs = await history(branchConfig.cashCountChannelId, { limit });

      const lines = [];
      lines.push(`Channel: ${branchConfig.cashCountChannelId}  (${branchConfig.name})`);
      lines.push(`Showing ${msgs.length} most recent messages, FULL RAW content.`);
      lines.push('='.repeat(90));

      for (const msg of msgs) {
        lines.push('');
        lines.push(`--- Message ts=${msg.ts} ---`);
        lines.push(`Keys present on this message object: ${Object.keys(msg).join(', ')}`);
        lines.push(`typeof msg.text: ${typeof msg.text}`);
        lines.push(`msg.text.length: ${msg.text ? msg.text.length : '(no text field)'}`);
        lines.push('--- FULL msg.text (raw, unmodified) ---');
        lines.push(msg.text === undefined ? '(msg.text is undefined)' : JSON.stringify(msg.text));
        if (msg.blocks) {
          lines.push('--- msg.blocks present (Block Kit formatting) ---');
          lines.push(JSON.stringify(msg.blocks, null, 2).slice(0, 2000));
        }
        if (msg.attachments) {
          lines.push('--- msg.attachments present ---');
          lines.push(JSON.stringify(msg.attachments, null, 2).slice(0, 2000));
        }
        lines.push('-'.repeat(60));
      }

      res.type('text/plain').send(lines.join('\n'));
    } catch (err) {
      console.error('debug/raw error:', err);
      res.status(500).type('text/plain').send(`Error: ${err.message}\n\n${err.stack || ''}`);
    }
  });
}

module.exports = { registerDebugRoutes };
