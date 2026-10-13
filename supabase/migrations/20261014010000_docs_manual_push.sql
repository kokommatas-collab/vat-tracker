-- v3: expense documents (RequestDocs), supplier nicknames, manual VAT entries,
-- push notifications. Safe to re-run.

alter table public.sync_log add column if not exists docs_error text;

-- Documents issued to me (expenses), for the "unclassified" list.
create table if not exists public.received_docs (
  mark         text primary key,
  issuer_vat   text,
  issuer_name  text,
  series       text,
  aa           text,
  issue_date   date,
  inv_type     text,
  net          numeric(14,2) not null default 0,
  vat          numeric(14,2) not null default 0,
  gross        numeric(14,2) not null default 0,
  synced_at    timestamptz not null default now()
);

-- My own names for suppliers (myDATA usually has no name for Greek issuers).
create table if not exists public.supplier_names (
  vat_number text primary key,
  name       text not null,
  updated_at timestamptz not null default now()
);

-- VAT that does not come from myDATA documents (e.g. customs).
create table if not exists public.manual_vat (
  id          bigint generated always as identity primary key,
  entry_date  date not null,
  kind        text not null check (kind in ('out', 'in')),
  vat         numeric(14,2) not null check (vat >= 0),
  net         numeric(14,2) not null default 0 check (net >= 0),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists manual_vat_entry_date_idx on public.manual_vat (entry_date);

-- Push notifications: written only by the Edge Function (service role).
create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create table if not exists public.app_secret (
  key   text primary key,
  value jsonb not null
);
create table if not exists public.notify_log (
  key     text primary key,
  sent_at timestamptz not null default now()
);

alter table public.received_docs      enable row level security;
alter table public.supplier_names     enable row level security;
alter table public.manual_vat         enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_secret         enable row level security;
alter table public.notify_log         enable row level security;

revoke all on public.received_docs, public.supplier_names, public.manual_vat,
  public.push_subscriptions, public.app_secret, public.notify_log from anon, authenticated;
grant select on public.received_docs to authenticated;
grant select, insert, update, delete on public.supplier_names, public.manual_vat to authenticated;

drop policy if exists "read docs"        on public.received_docs;
drop policy if exists "manage suppliers" on public.supplier_names;
drop policy if exists "manage manual"    on public.manual_vat;
create policy "read docs"        on public.received_docs  for select to authenticated using (true);
create policy "manage suppliers" on public.supplier_names for all    to authenticated using (true) with check (true);
create policy "manage manual"    on public.manual_vat     for all    to authenticated using (true) with check (true);
-- push_subscriptions, app_secret, notify_log: no policies → only the service role.

-- Sync every 3 hours, 06:00–21:00 Athens summer time (05:00–20:00 in winter).
select cron.schedule(
  'sync-mydata-daily',
  '0 3-18/3 * * *',
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

select 'OK — v3' as result;
