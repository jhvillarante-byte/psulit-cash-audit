begin;

create table if not exists public.lottomatik_summary_deliveries (
  report_key text primary key,
  branch text not null check (branch = 'Alphaland'),
  opening_ref text not null,
  closing_ref text not null,
  opening_slack_ts text not null,
  closing_slack_ts text not null,
  workbook_sha256 text,
  report_sha256 text not null,
  slack_status text not null default 'not_started'
    check (slack_status in ('not_started', 'pending', 'posted', 'failed')),
  slack_message_ts text,
  slack_last_attempt_at timestamptz,
  slack_posted_at timestamptz,
  telegram_status text not null default 'not_started'
    check (telegram_status in ('not_started', 'pending', 'posted', 'failed')),
  telegram_message_ids text,
  telegram_last_attempt_at timestamptz,
  telegram_posted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lottomatik_summary_deliveries enable row level security;
revoke all on table public.lottomatik_summary_deliveries from anon, authenticated;

commit;
