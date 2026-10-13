-- =============================================================================
-- VAT Tracker — πλήρης ρύθμιση βάσης (Supabase → SQL Editor → New query → Run)
--
-- ΣΥΜΠΛΗΡΩΣΕ ΜΟΝΟ ΕΝΑ ΠΡΑΓΜΑ: στη γραμμή με το  ΒΑΛΕ_ΤΟ_PROJECT_REF  πιο κάτω,
-- βάλε το Project ID σου (Project Settings → General → Project ID,
-- π.χ. abcdefghijklmnopqrst).
--
-- Μπορεί να ξανατρέξει με ασφάλεια (δεν σβήνει δεδομένα).
-- =============================================================================

-- Tables ----------------------------------------------------------------------
create table if not exists public.vat_entries (
  mark             text primary key,
  issue_date       date not null,
  is_cancelled     boolean not null default false,
  out_vat          numeric(14,2) not null default 0,  -- Σ Vat331..Vat336
  in_vat           numeric(14,2) not null default 0,  -- Σ Vat381..Vat386
  unclassified_vat numeric(14,2) not null default 0,  -- VatUnclassified381
  synced_at        timestamptz not null default now()
);
create index if not exists vat_entries_issue_date_idx on public.vat_entries (issue_date);

create table if not exists public.quarter_credit (
  quarter    text primary key check (quarter ~ '^\d{4}-Q[1-4]$'),
  amount     numeric(14,2) not null default 0 check (amount >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_log (
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
create index if not exists sync_log_started_at_idx on public.sync_log (started_at desc);

-- Per-quarter totals (cancelled documents excluded).
create or replace view public.quarter_summary with (security_invoker = true) as
select
  to_char(issue_date, 'YYYY') || '-Q' || to_char(issue_date, 'Q') as quarter,
  sum(out_vat)          as out_vat,
  sum(in_vat)           as in_vat,
  sum(unclassified_vat) as unclassified_vat,
  count(*)              as docs
from public.vat_entries
where not is_cancelled
group by 1;

-- Row level security: logged-in user reads everything and edits only the
-- carried-forward credit; anon gets nothing. The Edge Function writes with the
-- service role (bypasses RLS).
alter table public.vat_entries    enable row level security;
alter table public.quarter_credit enable row level security;
alter table public.sync_log       enable row level security;

revoke all on public.vat_entries, public.quarter_credit, public.sync_log, public.quarter_summary from anon, authenticated;
grant select on public.vat_entries, public.sync_log, public.quarter_summary to authenticated;
grant select, insert, update on public.quarter_credit to authenticated;

drop policy if exists "read entries"  on public.vat_entries;
drop policy if exists "read sync log" on public.sync_log;
drop policy if exists "read credit"   on public.quarter_credit;
drop policy if exists "insert credit" on public.quarter_credit;
drop policy if exists "update credit" on public.quarter_credit;
create policy "read entries"  on public.vat_entries    for select to authenticated using (true);
create policy "read sync log" on public.sync_log       for select to authenticated using (true);
create policy "read credit"   on public.quarter_credit for select to authenticated using (true);
create policy "insert credit" on public.quarter_credit for insert to authenticated with check (true);
create policy "update credit" on public.quarter_credit for update to authenticated using (true) with check (true);

-- Vault: function URL + auto-generated cron secret ------------------------------
do $$
declare
  project_ref text := 'ΒΑΛΕ_ΤΟ_PROJECT_REF';   -- <<< ΣΥΜΠΛΗΡΩΣΕ ΕΔΩ
  fn_url text;
  existing uuid;
begin
  if project_ref = 'ΒΑΛΕ_ΤΟ_PROJECT_REF' or project_ref !~ '^[a-z0-9]{10,40}$' then
    raise exception 'Συμπλήρωσε το project_ref (Project Settings → General → Project ID)';
  end if;
  fn_url := 'https://' || project_ref || '.supabase.co/functions/v1/sync-mydata';

  select id into existing from vault.secrets where name = 'sync_mydata_url';
  if existing is null then
    perform vault.create_secret(fn_url, 'sync_mydata_url');
  else
    perform vault.update_secret(existing, fn_url);
  end if;

  -- Random secret, created once; nobody needs to copy it anywhere.
  if not exists (select 1 from vault.secrets where name = 'sync_mydata_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'sync_mydata_cron_secret');
  end if;
end $$;

-- Lets the Edge Function verify the cron call against Vault. Callable only by
-- the service role (the function), never by anon/authenticated users.
create or replace function public.check_cron_secret(secret text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'sync_mydata_cron_secret' and decrypted_secret = secret
  );
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- Daily sync (pg_cron + pg_net) -------------------------------------------------
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

select 'OK — η βάση είναι έτοιμη' as result;
