# Psulit Cash Audit

Listens for every "PSULIT CASH COUNT REPORT" posted in Slack, across **all branches** (Solaire and Alphaland), on every shift (Morning, Mid-Shift, Night). The moment one lands, it:
1. Finds the previous cash count for that same branch (the opening balance)
2. Pulls all transactions posted since then in that branch's transactions channel
3. Computes what each currency *should* total, compares to the actual count
4. Sends the result as a **Telegram message to you (Jen)**

This runs standalone — it does **not** touch your existing Cash Count app, and doesn't post anything back into Slack (Nikki already covers that side).

## 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g. "Psulit Cash Audit"), pick your workspace

**OAuth & Permissions** → add these Bot Token Scopes:
- `groups:history` (both channels are private)
- `groups:read`
- `chat:write`

Click **Install to Workspace**, copy the **Bot User OAuth Token** (`xoxb-...`).

**Basic Information** → copy the **Signing Secret**.

**Event Subscriptions** → turn on, set Request URL to:
`https://YOUR-RENDER-URL.onrender.com/slack/events`
(You'll only be able to save this *after* the service is deployed and running — Slack pings it to verify.)

Under **Subscribe to bot events**, add:
- `message.groups`

Save changes, then **reinstall the app** to the workspace (Slack will prompt you).

Finally, in Slack, invite the bot to all four channels (type as a message and send):
```
/invite @Psulit Cash Audit
```
— run this in `#psulit-solaire-general`, `#psulit-solaire-forex-transaction`, `#psulit-alphaland-general`, and `#psulit-alphaland-transactions`.

*(Note: use `/invite` typed in the message box — the "Add Members" screen only searches for people, not bots.)*

## 2. Get your channel IDs

In Slack: open the channel → channel name → scroll to the bottom of the details panel → copy the Channel ID. You'll need this for all four channels.

## 3. Create the Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the prompts → copy the bot token (`123456:ABC-DEF...`)
2. Send this **new** bot any message once (e.g. "hi") — Telegram bots can't message someone who hasn't started a chat with them first. Your chat ID is the same one used for `@Psulit_Payroll_bot` (`1761414251`), so you likely won't need to look it up again — but if delivery fails, double check via:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`

## 4. Deploy to Render

1. Push this folder to a new GitHub repo
2. On Render: **New +** → **Web Service** → connect that repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables (from `.env.example`):
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `BRANCHES` — e.g. `Solaire:C0B734364T0:C0XXXXXXX01,Alphaland:C0YYYYYYY00:C0YYYYYYY01`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_IDS` — comma-separated, e.g. `111111111,222222222`
6. Deploy. Once it's live, go back to Slack's Event Subscriptions page and save the Request URL — it should verify successfully.

## Notes / limitations

- Assumes cash count and transaction message formats match what's currently posted (see `parse.js` if the format ever changes).
- Flags anything outside ±₱1 (PHP) or ±0.01 (other currencies) as a mismatch — tune `reconcile.js` if you want a looser/tighter tolerance.
- "Hive" and "Opex" pettty-cash pots are tracked but not adjusted by transactions — a change there always shows as a flag, since they should stay constant.
- If a branch's *first-ever* cash count comes in with nothing to compare against, it posts a note saying so instead of a reconciliation.
