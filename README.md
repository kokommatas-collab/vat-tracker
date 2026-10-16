# VAT Tracker (Θέση ΦΠΑ)

A personal one-screen PWA that shows an **estimate** of the current quarter's Greek VAT
position from AADE myDATA (`RequestVatInfo`):

```
result = Σ Vat331–336 (output) − Σ Vat381–386 (input) − carried-forward credit (manual)
result > 0 → Χρεωστικός, otherwise Πιστωτικός
```

- `VatUnclassified381` is shown separately ("Μη χαρακτηρισμένα έξοδα") and is **not** included.
- Cancelled documents are excluded.
- Only data transmitted to myDATA is counted.

---

## Εγκατάσταση από iPhone (χωρίς υπολογιστή)

Θα χρειαστείς Safari και τους κωδικούς Taxisnet. Τα βήματα γίνονται με τη σειρά.

### ☐ 1. Κλειδί myDATA API (παραγωγή)
1. Άνοιξε https://www1.aade.gr/saadeapps2/bookkeeper-web και συνδέσου με Taxisnet.
2. Πάτα **«Φόρμα εγγραφής στο myDATA REST API»** → **«Νέα εγγραφή χρήστη»**.
3. Δώσε ένα **όνομα χρήστη**, μόνο λατινικά γράμματα και αριθμούς (π.χ. `vattracker`). Πάτα «Προσθήκη».
4. Σημείωσε στις Σημειώσεις:
   - το **όνομα χρήστη**
   - τον **«Κωδικό API»** (μακρύ κείμενο)

### ☐ 2. Project στο Supabase
1. Άνοιξε https://supabase.com/dashboard → **New project**.
2. Επίλεξε **Region: Central EU (Frankfurt)**.
3. Βάλε ένα δυνατό Database password και κράτησέ το. Πάτα **Create**.
4. Όταν ετοιμαστεί, πήγαινε **Project Settings → General**. Σημείωσε το **Project ID** (20 πεζά γράμματα, π.χ. `abcdefghijklmnopqrst`).

### ☐ 3. Κλείσιμο εγγραφών
**Authentication → Sign In / Providers**. Απενεργοποίησε το **«Allow new users to sign up»** και πάτα Save.

### ☐ 4. Δημιουργία του χρήστη σου
1. **Authentication → Users → Add user → Create new user**.
2. Βάλε email και κωδικό. Τσέκαρε το **Auto Confirm User**.
3. Πάτα **Create user**. Με αυτά θα συνδέεσαι στην εφαρμογή.

### ☐ 5. Secrets της Edge Function
1. Πήγαινε **Edge Functions → Secrets**.
2. Πρόσθεσε τα παρακάτω, ένα-ένα (Name / Value):

   | Name | Value |
   |---|---|
   | `MYDATA_USER_ID` | το όνομα χρήστη από το βήμα 1 |
   | `MYDATA_SUBSCRIPTION_KEY` | ο «Κωδικός API» από το βήμα 1 |
   | `ALLOWED_EMAIL` | το email του βήματος 4 |
   | `ALLOWED_ORIGIN` | `https://kokommatas-collab.github.io` |

3. Πάτα Save.

### ☐ 6. Βάση δεδομένων (ένα SQL αρχείο)
1. Άνοιξε το αρχείο [supabase/setup.sql](https://raw.githubusercontent.com/kokommatas-collab/vat-tracker/main/supabase/setup.sql) και αντέγραψε **όλο** το κείμενο.
2. Στο Supabase: **SQL Editor → New query**. Κάνε επικόλληση.
3. Βρες τη γραμμή `project_ref text := 'ΒΑΛΕ_ΤΟ_PROJECT_REF';`. Αντικατέστησε το `ΒΑΛΕ_ΤΟ_PROJECT_REF` με το Project ID σου (κράτα τα μονά εισαγωγικά).
4. Πάτα **Run**. Στο τέλος πρέπει να δεις **«OK — η βάση είναι έτοιμη»**.
   - Αν δεις «Συμπλήρωσε το project_ref», δεν άλλαξες τη γραμμή του βήματος 3.

### ☐ 7. Edge Function
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Όνομα function: **`sync-mydata`**, ακριβώς έτσι.
3. Σβήσε τον κώδικα-παράδειγμα.
4. Άνοιξε το [supabase/dashboard/index.ts](https://raw.githubusercontent.com/kokommatas-collab/vat-tracker/main/supabase/dashboard/index.ts), αντέγραψε όλο το κείμενο και επικόλλησέ το.
5. Πάτα **Deploy function**.
6. Στη σελίδα της function: **Details** (ή Settings). Απενεργοποίησε το **«Verify JWT» / «Enforce JWT verification»** και πάτα Save.
   - Χρειάζεται γιατί η ημερήσια κλήση δεν έχει login. Η function ελέγχει μόνη της ποιος την καλεί.

### ☐ 8. Έλεγχος τιμών Vault (δεν πληκτρολογείς τίποτα)
Το βήμα 6 έχει ήδη φτιάξει μόνο του τα δύο μυστικά. Πήγαινε **Integrations → Vault** (ή **Project Settings → Vault**) και βεβαιώσου ότι υπάρχουν:
- `sync_mydata_url`
- `sync_mydata_cron_secret` (τυχαίο κλειδί για την ημερήσια ενημέρωση στις ~07:00)

Δεν χρειάζεται να τα αντιγράψεις πουθενά.

### ☐ 9. `docs/config.js`: δύο τιμές
1. Στο Supabase: **Project Settings → API Keys**. Βρες:
   - **Project URL**: `https://<Project ID>.supabase.co` (φαίνεται και στο **Project Settings → Data API**)
   - **anon public** key: στην καρτέλα «Legacy API keys». Αν δεν υπάρχει, πάρε το **Publishable key** (`sb_publishable_…`).
2. ⚠️ **Ποτέ** το `service_role` ή το Secret key.
3. Στο GitHub (Safari, github.com): άνοιξε το `docs/config.js` και πάτα ✏️ (Edit).
4. Άλλαξε τις δύο γραμμές:
   ```js
   export const SUPABASE_URL = "https://<Project ID>.supabase.co";
   export const SUPABASE_ANON_KEY = "<anon public ή publishable key>";
   ```
5. **Commit changes** → στο branch `main`.

### ☐ 10. GitHub Pages
1. Στο repo: **Settings → Pages**.
2. **Source: Deploy from a branch**. Branch **`main`**, φάκελος **`/docs`**. Πάτα Save.
3. Περίμενε 1–2 λεπτά. Η διεύθυνση είναι **https://kokommatas-collab.github.io/vat-tracker/**
4. Στο Supabase: **Authentication → URL Configuration → Site URL**. Βάλε την ίδια διεύθυνση και πάτα Save.

### ☐ 11. Πρώτος συγχρονισμός
1. Άνοιξε τη διεύθυνση στο Safari και συνδέσου με το email/κωδικό του βήματος 4.
2. Πάτα το **↻** πάνω δεξιά ή τράβηξε τη σελίδα προς τα κάτω. Σε λίγα δευτερόλεπτα βλέπεις «Ενημέρωση: μόλις τώρα» και το ποσό.
   - Αν βγει κόκκινο μήνυμα, στείλε μου ακριβώς το κείμενο.
3. Αν έχεις πιστωτικό υπόλοιπο από το προηγούμενο τρίμηνο, πάτα τη γραμμή **«Πιστωτικό υπόλοιπο»**, γράψε το ποσό και πάτα «Αποθήκευση».
4. **Κοινοποίηση → Προσθήκη στην οθόνη Αφετηρίας** για να το έχεις σαν εφαρμογή.

### ☐ 12. Έλεγχος πρόσημου πιστωτικών (μία φορά)
Το myDATA δεν λέει τον τύπο κάθε παραστατικού, οπότε η εφαρμογή δεν ξεχωρίζει μόνη της τα πιστωτικά.

Αν στον πρώτο συγχρονισμό δεν βρεθεί κανένα αρνητικό ποσό, εμφανίζεται **μία φορά** κίτρινο μήνυμα. Μετά από συγχρονισμό που καλύπτει τρίμηνο με πιστωτικό (5.x), τρέξε στο **SQL Editor**:
```sql
select negative_docs, warning, rows from sync_log where status = 'ok' order by id desc limit 1;
```
- **`negative_docs > 0`**: τα πιστωτικά έρχονται αρνητικά. Όλα σωστά.
- **`negative_docs = 0`** ενώ ξέρεις ότι υπάρχει πιστωτικό: έρχονται θετικά και προστίθενται λάθος. Πες μου να το διορθώσω.

---

## Repository layout

| Path | What |
|---|---|
| `docs/` | Static site for GitHub Pages: `index.html`, `styles.css`, `script.js`, `calc.js`, `config.js`, PWA files |
| `supabase/setup.sql` | The whole database setup: tables, RLS, view, Vault secrets, cron. Paste it into the SQL Editor. |
| `supabase/dashboard/index.ts` | **Generated** single-file Edge Function to paste into the dashboard editor |
| `supabase/functions/sync-mydata/` | Source modules and tests. `build_single_file.ts` regenerates the dashboard file. |

## Security model
- **RLS on every table:**
  - `anon` has no grants.
  - A logged-in user can read, and can write only `quarter_credit`.
  - `vat_entries` and `sync_log` are written only by the Edge Function, using the service role.
- **Signups are disabled.** `ALLOWED_EMAIL` additionally restricts the manual sync to you.
- **Credentials:**
  - The myDATA credentials live only in Edge Function secrets.
  - The cron secret is generated inside Vault and checked by `check_cron_secret()`, which only the service role can execute.
  - `docs/config.js` holds only the public project URL and anon key.
- **Read-only toward myDATA:** the function calls only `RequestVatInfo`.
- **No data caching:** the service worker caches static files only, never API data.

## Development
```bash
cd supabase/functions/sync-mydata
deno test --allow-read                                   # parsing, pagination/retry, credit-note sign, VAT/quarter calc
deno run --allow-read --allow-write build_single_file.ts # regenerate supabase/dashboard/index.ts after edits
```
A test fails if `supabase/dashboard/index.ts` is out of date. To test against the myDATA
dev environment, add the secret `MYDATA_BASE_URL=https://mydataapidev.aade.gr`. Dev
credentials come from https://mydata-dev-register.azurewebsites.net.
