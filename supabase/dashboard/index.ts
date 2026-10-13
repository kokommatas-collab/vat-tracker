// GENERATED FILE — do not edit. Source: supabase/functions/sync-mydata/*.ts
// Regenerate: cd supabase/functions/sync-mydata && deno run --allow-read --allow-write build_single_file.ts
// Paste this whole file into Supabase → Edge Functions → sync-mydata (Verify JWT: OFF).

import { createClient } from "jsr:@supabase/supabase-js@2";

// ---- dates.ts --------------------------------------------------------------

// Date helpers for the sync window. Dates are plain "YYYY-MM-DD" strings in
// Europe/Athens local time, so no timezone drift at quarter boundaries.

function athensToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(now);
}

/** First day of the quarter before the one containing `isoDate`. */
function previousQuarterStart(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  const q = Math.floor((m - 1) / 3); // 0..3
  const prevQ = (q + 3) % 4;
  const year = q === 0 ? y - 1 : y;
  return `${year}-${String(prevQ * 3 + 1).padStart(2, "0")}-01`;
}

/** "YYYY-MM-DD" → "dd/MM/yyyy" as required by RequestVatInfo. */
function toMyDataDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

/** Sync window: previous quarter start (late transmissions) through today. */
function syncWindow(now: Date = new Date()): { from: string; to: string } {
  const to = athensToday(now);
  return { from: previousQuarterStart(to), to };
}

// ---- parse.ts --------------------------------------------------------------

// Parser for the RequestVatInfo response (myDATA API v2.0.2, §6.4).
// The structure is flat (RequestedVatInfo > VatInfo* > scalar fields), so a
// small namespace-tolerant tag reader is enough; no XML dependency needed.

const OUTPUT_FIELDS = ["Vat331", "Vat332", "Vat333", "Vat334", "Vat335", "Vat336"];
const INPUT_FIELDS = ["Vat381", "Vat382", "Vat383", "Vat384", "Vat385", "Vat386"];
const UNCLASSIFIED_FIELD = "VatUnclassified381";

interface VatEntry {
  mark: string;
  issue_date: string; // YYYY-MM-DD
  is_cancelled: boolean;
  out_vat: number;
  in_vat: number;
  unclassified_vat: number;
  has_negative: boolean; // any Vat* amount < 0 (credit note sign check)
}

interface VatInfoPage {
  entries: VatEntry[];
  next: { partitionKey: string; rowKey: string } | null;
}

class MyDataError extends Error {}

// Matches <tag>, <ns:tag> and <tag attr="..."> forms.
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]);
}

function text(xml: string, tag: string): string | null {
  const b = blocks(xml, tag)[0];
  return b === undefined ? null : decode(b.trim());
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function toCents(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new MyDataError(`Μη έγκυρο ποσό: ${raw}`);
  return Math.round(n * 100);
}

function sumCents(xml: string, fields: string[]): number {
  return fields.reduce((acc, f) => acc + toCents(text(xml, f)), 0);
}

function parseEntry(xml: string): VatEntry {
  const mark = text(xml, "Mark");
  const issue = text(xml, "IssueDate");
  if (!mark) throw new MyDataError("VatInfo χωρίς Mark (αναμενόταν GroupedPerDay=false)");
  if (!issue || !/^\d{4}-\d{2}-\d{2}/.test(issue)) {
    throw new MyDataError(`Μη έγκυρο IssueDate για MARK ${mark}: ${issue}`);
  }
  const hasNegative = [...xml.matchAll(/<(?:[\w-]+:)?Vat\w*(?:\s[^>]*)?>\s*-/g)].length > 0;
  return {
    mark,
    issue_date: issue.slice(0, 10),
    is_cancelled: text(xml, "IsCancelled") === "true",
    out_vat: sumCents(xml, OUTPUT_FIELDS) / 100,
    in_vat: sumCents(xml, INPUT_FIELDS) / 100,
    unclassified_vat: toCents(text(xml, UNCLASSIFIED_FIELD)) / 100,
    has_negative: hasNegative,
  };
}

// The prod API wraps the real XML as an escaped .NET string:
// <string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">&lt;?xml ...&gt;&lt;RequestedVatInfo ...</string>
// Unwrap it (possibly more than once) before parsing.
function unwrap(body: string): string {
  let xml = body.trim();
  for (let i = 0; i < 3; i++) {
    const m = xml.match(/^(?:<\?xml[^>]*\?>\s*)?<string(?:\s[^>]*)?>([\s\S]*)<\/string>$/);
    if (!m) break;
    xml = decode(m[1]).trim();
  }
  return xml;
}

/** Throws MyDataError if the body is an error response or an unexpected shape. */
function parseVatInfo(body: string): VatInfoPage {
  const xml = unwrap(body);
  const errors = blocks(xml, "error");
  if (errors.length > 0) {
    const msgs = errors.map((e) => `[${text(e, "code") ?? "?"}] ${text(e, "message") ?? ""}`.trim());
    throw new MyDataError(`myDATA: ${msgs.join("; ")}`);
  }
  if (!/<(?:[\w-]+:)?RequestedVatInfo[\s>/]/.test(xml)) {
    throw new MyDataError(`Απρόσμενη απάντηση myDATA: ${xml.slice(0, 200)}`);
  }

  const items = blocks(xml, "VatInfo");
  if (items.length === 0 && /<(?:[\w-]+:)?IssueDate[\s>]/.test(xml)) {
    // Data present but not under <VatInfo>: schema differs from the docs. Fail loudly.
    throw new MyDataError("Απρόσμενο σχήμα RequestedVatInfo (δεν βρέθηκαν στοιχεία VatInfo)");
  }

  const token = blocks(xml, "continuationToken")[0];
  const partitionKey = token ? text(token, "nextPartitionKey") : null;
  const rowKey = token ? text(token, "nextRowKey") : null;

  return {
    entries: items.map(parseEntry),
    next: partitionKey && rowKey ? { partitionKey, rowKey } : null,
  };
}

// ---- summary.ts ------------------------------------------------------------

interface SyncSummary {
  rows: Omit<VatEntry, "has_negative">[];
  negativeDocs: number;
  warning: string | null;
}

/**
 * De-duplicates by MARK (last one wins) and checks credit-note signs.
 * VatInfo has no invType, so credit notes can't be identified directly; we only
 * know whether any amounts came back negative. If none did, we warn instead of
 * guessing (positive credit notes would otherwise silently add to the totals).
 * The warning is emitted at most once: pass `alreadyChecked` = true when an
 * earlier sync already warned or already saw negative amounts.
 */
function summarize(entries: VatEntry[], alreadyChecked = false): SyncSummary {
  const byMark = new Map<string, VatEntry>();
  for (const e of entries) byMark.set(e.mark, e);
  const unique = [...byMark.values()];

  const negativeDocs = unique.filter((e) => e.has_negative).length;
  const warning = !alreadyChecked && unique.length > 0 && negativeDocs === 0
    ? `Κανένα από τα ${unique.length} παραστατικά δεν είχε αρνητικά ποσά ΦΠΑ. ` +
      `Αν υπάρχουν πιστωτικά (5.x) στο διάστημα, ίσως μετρώνται ως θετικά — έλεγξέ τα.`
    : null;

  return {
    rows: unique.map(({ has_negative: _, ...row }) => row),
    negativeDocs,
    warning,
  };
}

// ---- mydata.ts -------------------------------------------------------------

// RequestVatInfo client: pagination via continuationToken + retry on transient errors.
// Read-only: this module only ever calls RequestVatInfo.


const PROD_BASE_URL = "https://mydatapi.aade.gr/myDATA";
const MAX_PAGES = 200;
const MAX_ATTEMPTS = 3;

interface MyDataConfig {
  baseUrl: string;
  userId: string;
  subscriptionKey: string;
}

type Fetch = typeof fetch;

async function getWithRetry(url: string, cfg: MyDataConfig, fetchFn: Fetch, sleep: (ms: number) => Promise<void>) {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: {
          "aade-user-id": cfg.userId,
          "ocp-apim-subscription-key": cfg.subscriptionKey,
          "Accept": "application/xml",
        },
      });
      const body = await res.text();
      if (res.ok) return body;
      lastError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      // 4xx other than 429 (bad credentials, bad request) won't fix themselves.
      if (res.status !== 429 && res.status < 500) throw new MyDataError(lastError);
    } catch (e) {
      if (e instanceof MyDataError) throw e;
      lastError = `Σφάλμα δικτύου: ${(e as Error).message}`;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** attempt);
  }
  throw new MyDataError(`Αποτυχία μετά από ${MAX_ATTEMPTS} προσπάθειες: ${lastError}`);
}

async function fetchVatInfo(
  cfg: MyDataConfig,
  from: string,
  to: string,
  fetchFn: Fetch = fetch,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<VatEntry[]> {
  const entries: VatEntry[] = [];
  let next: { partitionKey: string; rowKey: string } | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      dateFrom: toMyDataDate(from),
      dateTo: toMyDataDate(to),
      GroupedPerDay: "false",
    });
    if (next) {
      params.set("nextPartitionKey", next.partitionKey);
      params.set("nextRowKey", next.rowKey);
    }
    const xml = await getWithRetry(`${cfg.baseUrl}/RequestVatInfo?${params}`, cfg, fetchFn, sleep);
    const result = parseVatInfo(xml);
    entries.push(...result.entries);
    if (!result.next) return entries;
    next = result.next;
  }
  throw new MyDataError(`Υπέρβαση ορίου σελίδων (${MAX_PAGES})`);
}

// ---- index.ts --------------------------------------------------------------

// sync-mydata: pulls RequestVatInfo for the previous + current quarter and
// upserts into vat_entries. Called by pg_cron (x-cron-secret) or the logged-in
// user ("Ανανέωση" button, Supabase JWT). Deployed with verify_jwt = false
// because auth is checked here for both callers.


const env = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function authorize(req: Request): Promise<"cron" | "manual" | null> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    // The secret lives only in Supabase Vault (see setup.sql).
    const { data, error } = await db.rpc("check_cron_secret", { secret: cronSecret });
    return !error && data === true ? "cron" : null;
  }

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const allowed = Deno.env.get("ALLOWED_EMAIL");
  if (allowed && data.user.email?.toLowerCase() !== allowed.toLowerCase()) return null;
  return "manual";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const trigger = await authorize(req);
  if (!trigger) return json({ error: "Unauthorized" }, 401);

  const { from, to } = syncWindow();
  const { data: log, error: logErr } = await db
    .from("sync_log")
    .insert({ trigger, date_from: from, date_to: to })
    .select("id")
    .single();
  if (logErr) return json({ error: logErr.message }, 500);

  try {
    const entries = await fetchVatInfo(
      {
        baseUrl: Deno.env.get("MYDATA_BASE_URL") ?? PROD_BASE_URL,
        userId: env("MYDATA_USER_ID"),
        subscriptionKey: env("MYDATA_SUBSCRIPTION_KEY"),
      },
      from,
      to,
    );
    // Credit-note sign warning: only until it has been raised (or negatives seen) once.
    const { count: checked } = await db.from("sync_log").select("id", { count: "exact", head: true })
      .or("warning.not.is.null,negative_docs.gt.0");
    const { rows, negativeDocs, warning } = summarize(entries, (checked ?? 0) > 0);
    const now = new Date().toISOString();

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, synced_at: now }));
      const { error } = await db.from("vat_entries").upsert(chunk, { onConflict: "mark" });
      if (error) throw new Error(`DB: ${error.message}`);
    }

    await db.from("sync_log").update({
      status: "ok",
      finished_at: new Date().toISOString(),
      rows: rows.length,
      negative_docs: negativeDocs,
      warning,
    }).eq("id", log.id);

    return json({ status: "ok", rows: rows.length, negativeDocs, warning });
  } catch (e) {
    const message = (e as Error).message;
    await db.from("sync_log").update({
      status: "error",
      finished_at: new Date().toISOString(),
      error: message,
    }).eq("id", log.id);
    return json({ status: "error", error: message }, 502);
  }
});
