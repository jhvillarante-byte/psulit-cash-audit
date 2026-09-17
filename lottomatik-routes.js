const crypto = require('crypto');
const express = require('express');
const { parseCashCount } = require('./parse');
const {
  parseLottomatikWallet,
  readTicketSalesWorkbook,
  summarizeTicketSales,
  buildDailySummary,
  reportKey,
  publishIdenticalSummary
} = require('./lottomatik-summary');

const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SESSION_COOKIE = 'psulit_lottomatik_owner';

function createOwnerSession(secret, now = Date.now()) {
  if (!secret) throw new Error('LOTTOMATIK_SESSION_SECRET is not configured.');
  const payload = Buffer.from(JSON.stringify({
    expiresAt: now + 8 * 60 * 60 * 1000,
    nonce: crypto.randomBytes(16).toString('hex')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyOwnerSession(token, secret, now = Date.now()) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(parsed.expiresAt) && now <= parsed.expiresAt;
  } catch (_) {
    return false;
  }
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return '';
}

function ownerAuth(env) {
  return (req, res, next) => {
    if (!env.LOTTOMATIK_OWNER_PIN || !env.LOTTOMATIK_SESSION_SECRET) {
      return res.status(503).send('Owner access is not configured.');
    }
    if (!verifyOwnerSession(cookieValue(req, SESSION_COOKIE), env.LOTTOMATIK_SESSION_SECRET)) {
      if (req.method === 'GET') {
        return res.redirect(303, '/lottomatik/login');
      }
      return res.status(401).json({ error: 'Owner authentication required.' });
    }
    next();
  };
}

function findLatestAlphalandPair(messages) {
  const counts = messages.map(message => {
    const parsed = parseCashCount(message.text || '');
    if (!parsed || parsed.branch !== 'Alphaland') return null;
    try { parseLottomatikWallet(message.text); } catch (_) { return null; }
    return { ...parsed, ts: message.ts, text: message.text };
  }).filter(Boolean).sort((a, b) => Number(a.ts) - Number(b.ts));
  for (let index = counts.length - 1; index >= 0; index -= 1) {
    const closing = counts[index];
    if (!/^closing$/i.test(closing.phase || '')) continue;
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      const opening = counts[candidate];
      if (/^opening$/i.test(opening.phase || '') && opening.shift === closing.shift) {
        return { opening, closing };
      }
    }
  }
  throw new Error('No completed Alphaland Opening/Closing pair with LottoMatik balances was found.');
}

function signPreview(payload, secret) {
  if (!secret) throw new Error('LOTTOMATIK_PREVIEW_SECRET is not configured.');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyPreview(token, secret, now = Date.now()) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature || !secret) throw new Error('Invalid preview token.');
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) throw new Error('Invalid preview token.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!payload.expiresAt || now > payload.expiresAt) throw new Error('Preview expired. Upload the export again.');
  return payload;
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LottoMatik Daily Summary</title><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 18px;color:#17352b}button,input{font:inherit}button{background:#176b4a;color:white;border:0;border-radius:8px;padding:11px 16px}button:disabled{opacity:.5}pre{white-space:pre-wrap;background:#f4f7f5;padding:18px;border-radius:10px}.error{color:#a11}</style></head><body><h1>🎰 LottoMatik Daily Summary</h1><p>Alphaland owner/admin upload. Previewing never posts.</p><input id="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><button id="preview">Preview</button><p id="status"></p><pre id="output" hidden></pre><button id="send" hidden>Send to Slack &amp; Telegram</button><script>let token='';const q=id=>document.getElementById(id);q('preview').onclick=async()=>{const file=q('file').files[0];if(!file)return q('status').textContent='Select the LottoMatik XLSX export.';q('status').textContent='Validating…';q('send').hidden=true;try{const r=await fetch('/lottomatik/preview',{method:'POST',headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','X-Filename':file.name},body:file});const d=await r.json();if(!r.ok)throw new Error(d.error);token=d.previewToken;q('output').textContent=d.report;q('output').hidden=false;q('send').hidden=false;q('status').textContent='Preview ready. Nothing has been posted.'}catch(e){q('status').textContent=e.message;q('status').className='error'}};q('send').onclick=async()=>{if(!confirm('Send this exact summary to Slack and Telegram?'))return;q('send').disabled=true;q('status').textContent='Sending…';try{const r=await fetch('/lottomatik/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({previewToken:token})});const d=await r.json();if(!r.ok)throw new Error(d.error);q('status').textContent=d.duplicate?'This report was already delivered. No duplicate was posted.':'Delivery completed.'}catch(e){q('status').textContent=e.message;q('status').className='error'}finally{q('send').disabled=false}};</script></body></html>`;
}

function loginHtml(error = '') {
  const message = error ? `<p class="error">${error}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LottoMatik Owner Login</title><style>body{font-family:system-ui;max-width:420px;margin:60px auto;padding:0 18px;color:#17352b}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin-top:10px}button{background:#176b4a;color:white;border:0;border-radius:8px}.error{color:#a11}</style></head><body><h1>🎰 Owner Access</h1>${message}<form method="post" action="/lottomatik/login"><label>Owner PIN<input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required></label><button type="submit">Continue</button></form></body></html>`;
}

function createLottomatikRouter({ env, branch, history, state, postSlack, postTelegram }) {
  const router = express.Router();
  const failures = new Map();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/login', (_req, res) => res.type('html').send(loginHtml()));
  router.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    if (!env.LOTTOMATIK_OWNER_PIN || !env.LOTTOMATIK_SESSION_SECRET) {
      return res.status(503).send('Owner access is not configured.');
    }
    const key = req.ip || 'unknown';
    const current = failures.get(key) || { count: 0, blockedUntil: 0 };
    if (Date.now() < current.blockedUntil) {
      return res.status(429).type('html').send(loginHtml('Too many attempts. Try again later.'));
    }
    if (!safeEqual(req.body && req.body.pin, env.LOTTOMATIK_OWNER_PIN)) {
      current.count += 1;
      if (current.count >= 5) current.blockedUntil = Date.now() + 15 * 60 * 1000;
      failures.set(key, current);
      return res.status(401).type('html').send(loginHtml('Invalid owner PIN.'));
    }
    failures.delete(key);
    const session = createOwnerSession(env.LOTTOMATIK_SESSION_SECRET);
    res.set('Set-Cookie', `${SESSION_COOKIE}=${session}; Path=/lottomatik; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
    return res.redirect(303, '/lottomatik');
  });
  router.use(ownerAuth(env));
  router.get('/', (_req, res) => res.type('html').send(pageHtml()));
  router.get('/status', async (_req, res) => {
    try {
      if (!state.health) throw new Error('Supabase LottoMatik delivery storage is not configured.');
      const status = await state.health();
      res.json({ database_connected: status.connected, delivery_table_exists: status.tableExists });
    } catch (error) {
      res.status(503).json({ database_connected: false, delivery_table_exists: false, error: 'Database verification failed.' });
    }
  });
  router.post('/preview', express.raw({
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    limit: MAX_EXPORT_BYTES
  }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('Select a valid XLSX export.');
      const filename = String(req.headers['x-filename'] || '');
      if (!/^AgentTicketSalesDetails_.*\.xlsx$/i.test(filename)) {
        throw new Error('Expected an AgentTicketSalesDetails_*.xlsx export.');
      }
      const messages = await history(branch.cashCountChannelId, { limit: 200 });
      const { opening, closing } = findLatestAlphalandPair(messages);
      const rows = await readTicketSalesWorkbook(req.body);
      const sales = summarizeTicketSales(rows, opening.ts, closing.ts);
      const report = buildDailySummary({ opening, closing, sales });
      const digest = crypto.createHash('sha256').update(req.body).digest('hex');
      const key = reportKey({ opening, closing });
      const previewToken = signPreview({
        key, report, channelId: branch.cashCountChannelId,
        workbookDigest: digest,
        openingRef: opening.refCode, closingRef: closing.refCode,
        openingSlackTs: opening.ts, closingSlackTs: closing.ts,
        expiresAt: Date.now() + 15 * 60 * 1000
      }, env.LOTTOMATIK_PREVIEW_SECRET);
      res.json({ report, previewToken, openingRef: opening.refCode, closingRef: closing.refCode });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  router.post('/send', async (req, res) => {
    try {
      const preview = verifyPreview(req.body && req.body.previewToken, env.LOTTOMATIK_PREVIEW_SECRET);
      if (preview.channelId !== branch.cashCountChannelId) throw new Error('Preview destination is invalid.');
      const result = await publishIdenticalSummary({
        key: preview.key, text: preview.report,
        metadata: {
          openingRef: preview.openingRef,
          closingRef: preview.closingRef,
          openingSlackTs: preview.openingSlackTs,
          closingSlackTs: preview.closingSlackTs,
          workbookDigest: preview.workbookDigest,
          reportDigest: crypto.createHash('sha256').update(preview.report).digest('hex')
        },
        state,
        postSlack: text => postSlack(branch.cashCountChannelId, text),
        postTelegram: text => postTelegram(text)
      });
      res.json({ ok: true, duplicate: result.duplicate });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });
  return router;
}

module.exports = {
  MAX_EXPORT_BYTES,
  SESSION_COOKIE,
  createOwnerSession,
  verifyOwnerSession,
  ownerAuth,
  findLatestAlphalandPair,
  signPreview,
  verifyPreview,
  createLottomatikRouter
};
