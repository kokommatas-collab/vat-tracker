# VAT Tracker (Θέση ΦΠΑ)

A personal one-screen PWA that shows an **estimate** of the current quarter's Greek VAT
position from AADE myDATA (`RequestVatInfo`):

```
result = Σ Vat331–336 (output) − Σ Vat381–386 (input) − carried-forward credit (manual)
result > 0 → Χρεωστικός, otherwise Πιστωτικός
```

- `VatUnclassified381` is shown separately ("Μη χαρακτηρισμένα έξοδα") and is **not** included.
- Cancelled documents (`IsCancelled=true`) are excluded.
- Only data that has been transmitted to myDATA is counted. Missing supplier documents mean missing input VAT.

## Layout

| Path | What |
|---|---|
| `docs/` | Static site (GitHub Pages): `index.html`, `styles.css`, `script.js`, `calc.js`, `config.js`, PWA files |
| `supabase/migrations/` | Tables, RLS, `quarter_summary` view, daily pg_cron job |
| `supabase/functions/sync-mydata/` | Edge Function: RequestVatInfo → XML parse → upsert, plus tests |

## Security model

- The site is public, but the data is not. Every table has RLS. The `anon` role has no grants. A logged-in user can read, and can write only `quarter_credit`.
- `vat_entries` and `sync_log` are written only by the Edge Function using the service role.
- myDATA credentials and the cron secret live **only** in Supabase secrets/Vault. `docs/config.js` contains just the project URL and anon key, which are public by design.
- Signups are disabled, so you are the only user. You can additionally set `ALLOWED_EMAIL` on the function.
- The Edge Function is **read-only** toward myDATA: it only calls `RequestVatInfo`.
- The service worker caches only static files, never API data.

## Setup

### 1. myDATA API credentials (production)
1. Go to https://www1.aade.gr/saadeapps2/bookkeeper-web and log in with Taxisnet.
2. Open «Φόρμα εγγραφής στο myDATA REST API» → «Νέα εγγραφή χρήστη».
3. Pick a username (Latin letters and digits only).
4. Copy the «Κωδικός API». That is the subscription key.

To test against the dev environment instead, register at https://mydata-dev-register.azurewebsites.net and set `MYDATA_BASE_URL=https://mydataapidev.aade.gr` (step 4). Dev only contains documents you submitted there yourself.

### 2. Supabase project
1. Create a project at https://supabase.com.
2. Under **Authentication → Sign In / Providers**, keep Email enabled and **turn off "Allow new users to sign up"**.
3. Under **Authentication → Users → Add user**, create your user with email and password. Tick "Auto confirm".

### 3. Database
```bash
npm i -g supabase            # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push             # applies supabase/migrations/*
```

### 4. Edge Function secrets and deploy
```bash
CRON_SECRET=$(openssl rand -hex 32)
supabase secrets set \
  MYDATA_USER_ID='<myDATA username>' \
  MYDATA_SUBSCRIPTION_KEY='<Κωδικός API>' \
  CRON_SECRET="$CRON_SECRET" \
  ALLOWED_EMAIL='<your login email>' \
  ALLOWED_ORIGIN='https://<github-user>.github.io'
# optional, defaults to production https://mydatapi.aade.gr/myDATA
# supabase secrets set MYDATA_BASE_URL='https://mydataapidev.aade.gr'

supabase functions deploy sync-mydata --no-verify-jwt
```
`--no-verify-jwt` is required because the cron call has no user JWT. The function checks
both callers itself: a user JWT, or the `x-cron-secret` header.

### 5. Daily sync (pg_cron)
The migration schedules `sync-mydata-daily` at 04:00 UTC. It reads two Vault secrets, which
you create once in **SQL Editor**. Use the same `CRON_SECRET` value as in step 4:
```sql
select vault.create_secret('https://<PROJECT_REF>.supabase.co/functions/v1/sync-mydata', 'sync_mydata_url');
select vault.create_secret('<CRON_SECRET>', 'sync_mydata_cron_secret');
```
Check runs with `select * from cron.job_run_details order by start_time desc limit 5;`
and `select * from sync_log order by id desc limit 5;`.

### 6. Frontend (GitHub Pages)
1. Edit `docs/config.js` with your project URL and anon key (**Project Settings → API**).
2. Under GitHub **Settings → Pages**, choose **Deploy from a branch**, then branch `main` and folder `/docs`.
3. Under Supabase **Authentication → URL Configuration**, set Site URL to `https://<github-user>.github.io/vat-tracker/`.
4. Open the URL in Safari on the iPhone, then Share → **Add to Home Screen**.

## First production sync: check the sign of credit notes

`RequestVatInfo` has no document type (`invType`), so credit notes (5.x) can't be identified
directly. The sync stores amounts exactly as myDATA returns them. It also records how many
documents had a negative `Vat*` amount (`sync_log.negative_docs`). If none did, it writes a
warning, which is shown on screen.

After the first sync covering a quarter in which you issued or received a credit note, run:
```sql
select negative_docs, warning, rows from sync_log where status = 'ok' order by id desc limit 1;
```
- `negative_docs > 0`: credit notes come back negative, and the totals are correct as-is.
- `negative_docs = 0` with a known credit note in the window: credit notes come back positive and are currently **added**. Report this so that sign handling can be added, for example by looking up `invType` via another endpoint.

## Tests

```bash
cd supabase/functions/sync-mydata
deno test --no-check   # XML parsing, pagination/retry, credit-note sign, quarter/VAT calculation
```
