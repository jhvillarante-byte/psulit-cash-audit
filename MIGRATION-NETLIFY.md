# Netlify migration

Target project: `psulit-cash-audit` (`301fef42-64f4-42ed-af37-41bc25abbe4b`).

The original Cash Audit Slack app and its installation must be retained. Do not substitute the Cash Count or Cash Log bot tokens.

## Runtime

- `/slack/events`: validates the original Slack signature, persists a job, dispatches background processing, then acknowledges Slack. URL verification works before audit activation.
- `/slack/interactions`: retains the resolution action, manager authorization, validation, and immutable Slack resolution replies. Valid form submissions are queued before acknowledgement.
- `audit-background`: authenticated worker, up to the platform background execution limit. Conditional writes claim jobs, so concurrent deliveries do not run the same job. Completed/failed/running jobs are never blindly replayed. Failed or interrupted jobs require review because external messages may already have been sent.
- `/health`: reports configuration readiness and activation separately.
- `/api/audits`: authenticated POST for manual shift/handover jobs; dry run defaults to true. `/api/jobs/:id` retrieves status/results using the same admin secret.
- `/internal/balance-preview`: preserves the server-only shared-secret contract for Transaction Entry.
- Original standalone server remains runnable. Existing test/debug routes are not exposed publicly by the Netlify gateway.
- Production jobs are isolated from deploy preview stores. Set AUDIT_ORIGIN to the matching deployment origin when testing preview dispatch.

## Required configuration

Copy the existing Cash Audit values securely from the old service:
`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `BRANCHES`, `SLACK_MANAGER_USER_IDS`.
Also preserve configured feed keys/URLs, Telegram credentials/recipients, feature flags, holiday schedule, balance preview secret, and optional LottoMatik database settings as applicable. Original `/lottomatik` HTTP routes are not exposed by this migration gateway and require a separate cutover if used by external callers.

Create server-only random `AUDIT_JOB_SECRET` and `AUDIT_ADMIN_SECRET` in Netlify functions environment. Set `AUDIT_ORIGIN=https://psulit-cash-audit.netlify.app`. Start with `AUDIT_ENABLED=false`.

## Deployment and cutover

1. Sign in to Netlify CLI and link the target project.
2. Configure the original bot credentials and feed settings; do not print or commit them.
3. Run `npm ci`, `npm run check`, `npm test`, `npm run test:migration`, then deploy.
4. Verify `/health`, unsigned request rejection, signed URL challenge, a manual dry run, and job storage/background dispatch.
5. Set `AUDIT_ENABLED=true` and deploy the new environment.
6. Change the existing Slack app Event Subscriptions URL to `https://psulit-cash-audit.netlify.app/slack/events` and Interactivity URL to `https://psulit-cash-audit.netlify.app/slack/interactions`. Preserve existing scopes, subscriptions, and manager IDs. Update the optional Hive diagnostic command and Transaction Entry balance-preview URL if configured.
7. Post a user-authorized audit and verify the bot identity, branch, report, computation thread, and resolution button. Do not submit a fake financial resolution for testing.
8. After successful verification and secure transfer of required configuration, remove the Cash Audit service from Render. Remove its keep-alive monitors and update every caller, webhook, scheduled trigger, and feed URL that points to that service. The completed migration must have no Cash Audit runtime dependency on Render. Do not delete unrelated services.

## Known limits carried forward

Shift audits now include a separate Scratch cash reconciliation from the same Supabase transaction ledger used by PSulit Scratch Bot, plus structured cash movements. Configure `SCRATCH_DATABASE_URL` with a TLS database connection and a read-only role allowed to SELECT public.scratch_transactions. This reads the database directly and never calls the Scratch Render service. Missing feeds or counts, ambiguous replenishments, unsupported transaction types, and inconsistent sales remain UNAVAILABLE rather than cleared. Scratch discrepancies use the existing Slack Resolve Discrepancy workflow. Cash logs must identify Scratch using the exact fund name `Scratch`.

The confirmed Telegram evidence group is PSulit - Scratch It Transactions (historical chat ID -5376772680). This integration reads its underlying application transactions; it does not claim to read Telegram history or capture manual Telegram-only entries. Physical ticket inventory reconciliation remains unimplemented. Historical date-scoped exceptions still use their reviewed snapshots. Malformed manually copied timestamps still require source-specific handling.

## Current validation

Original audit regression suite and TypeScript check pass. Migration checks cover Slack signatures, replay rejection, URL challenges, disabled readiness, protected audit endpoints, and reusable server import without a listening socket. Live delivery and cutover require deployment authentication plus the original Cash Audit bot configuration.

## Remaining verification

Securely provision the read-only Scratch database connection and original Cash Audit credentials, deploy, and compare one real branch window against the Scratch application and cash logs. Confirm Telegram-only manual entries if any. Physical inventory reconciliation needs independent opening/closing stock evidence. Do not mark migration complete until live report delivery and resolution controls have been verified and the Cash Audit Render service and its callers have been retired.
