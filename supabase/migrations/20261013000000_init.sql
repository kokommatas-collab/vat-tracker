-- VAT Tracker schema: myDATA VAT entries, manual carried-forward credit, sync log.
-- All tables use RLS. Only logged-in users can read; only the Edge Function
-- (service role, bypasses RLS) writes vat_entries and sync_log.

create table public.vat_entries (
  mark             text primary key,
  issue_date       date not null,
  is_cancelled     boolean not null default false,
  out_vat          numeric(14,2) not null default 0,  -- Σ Vat331..Vat336
  in_vat           numeric(14,2) not null default 0,  -- Σ Vat381..Vat386
  unclassified_vat numeric(14,2) not null default 0,  -- VatUnclassified381
  synced_at        timestamptz not null default now()
);
create index vat_entries_issue_date_idx on public.vat_entries (issue_date);

create table public.quarter_credit (
  quarter    text primary key check (quarter ~ '^\d{4}-Q[1-4]$'),
  amount     numeric(14,2) not null default 0 check (amount >= 0),
  updated_at timestamptz not null default now()
);

create table public.sync_log (
  id             bigint generated always as identity primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  trigger        text not null check (trigger in ('cron', 'manual')),
  status         text not null default 'running' check (status in ('running', 'ok', 'error')),
  date_from      date,
  date_to        date,
  rows           integer,
  negative_docs  integer,
  warning        text,
  error          text
);
create index sync_log_started_at_idx on public.sync_log (started_at desc);

-- Per-quarter totals (cancelled documents excluded).
create view public.quarter_summary with (security_invoker = true) as
select
  to_char(issue_date, 'YYYY') || '-Q' || to_char(issue_date, 'Q') as quarter,
  sum(out_vat)          as out_vat,
  sum(in_vat)           as in_vat,
  sum(unclassified_vat) as unclassified_vat,
  count(*)              as docs
from public.vat_entries
where not is_cancelled
group by 1;

-- Row level security ---------------------------------------------------------
alter table public.vat_entries    enable row level security;
alter table public.quarter_credit enable row level security;
alter table public.sync_log       enable row level security;

revoke all on public.vat_entries, public.quarter_credit, public.sync_log, public.quarter_summary from anon;
revoke all on public.vat_entries, public.quarter_credit, public.sync_log, public.quarter_summary from authenticated;
grant select on public.vat_entries, public.sync_log, public.quarter_summary to authenticated;
grant select, insert, update on public.quarter_credit to authenticated;

create policy "read entries" on public.vat_entries
  for select to authenticated using (true);
create policy "read sync log" on public.sync_log
  for select to authenticated using (true);
create policy "read credit" on public.quarter_credit
  for select to authenticated using (true);
create policy "insert credit" on public.quarter_credit
  for insert to authenticated with check (true);
create policy "update credit" on public.quarter_credit
  for update to authenticated using (true) with check (true);

-- Daily sync via pg_cron + pg_net ---------------------------------------------
-- Reads the function URL and shared secret from Supabase Vault (created
-- manually, see README) so no secret lives in this file.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sync-mydata-daily',
  '0 4 * * *', -- 04:00 UTC ≈ 06:00/07:00 Athens
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'sync_mydata_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_mydata_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
