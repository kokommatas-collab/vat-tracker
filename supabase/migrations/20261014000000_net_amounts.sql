-- v2: net bases per document (for the Έσοδα / Έξοδα cards). Safe to re-run.
alter table public.vat_entries add column if not exists out_net          numeric(14,2) not null default 0;
alter table public.vat_entries add column if not exists in_net           numeric(14,2) not null default 0;
alter table public.vat_entries add column if not exists unclassified_net numeric(14,2) not null default 0;

drop view if exists public.quarter_summary;
create view public.quarter_summary with (security_invoker = true) as
select
  to_char(issue_date, 'YYYY') || '-Q' || to_char(issue_date, 'Q') as quarter,
  sum(out_vat)          as out_vat,
  sum(in_vat)           as in_vat,
  sum(unclassified_vat) as unclassified_vat,
  sum(out_net)          as out_net,
  sum(in_net)           as in_net,
  sum(unclassified_net) as unclassified_net,
  count(*)              as docs
from public.vat_entries
where not is_cancelled
group by 1;
revoke all on public.quarter_summary from anon, authenticated;
grant select on public.quarter_summary to authenticated;
select 'OK — v2' as result;
