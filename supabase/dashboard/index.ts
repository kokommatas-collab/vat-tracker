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

/**
 * Sync window: 1 January of the year the previous quarter belongs to, through
 * today. Covers late transmissions for the previous quarter and keeps the
 * whole year's history (all quarters of the year) up to date.
 */
function syncWindow(now: Date = new Date()): { from: string; to: string } {
  const to = athensToday(now);
  return { from: `${previousQuarterStart(to).slice(0, 4)}-01-01`, to };
}

/** "YYYY-MM-DD" → "YYYY-Qn" */
function quarterOfDate(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Quarter before "YYYY-Qn". */
function previousQuarter(quarter: string): string {
  const [y, q] = quarter.split("-Q").map(Number);
  return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
}

/**
 * Filing/payment deadline of the quarterly VAT return (Φ2) for "YYYY-Qn":
 * last working day (Mon–Fri) of the month after the quarter. Public holidays
 * are not taken into account. Must match deadlineOf() in docs/calc.js.
 */
function vatDeadline(quarter: string): string {
  const [y, q] = quarter.split("-Q").map(Number);
  const month = q * 3 + 1; // 1-based month after the quarter (13 → January next year)
  const year = month > 12 ? y + 1 : y;
  const m = month > 12 ? 1 : month;
  const d = new Date(Date.UTC(year, m, 0)); // last day of month m
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` ("YYYY-MM-DD"). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// ---- parse.ts --------------------------------------------------------------

// Parser for the RequestVatInfo response (myDATA API v2.0.2, §6.4).
// The structure is flat (RequestedVatInfo > VatInfo* > scalar fields), so a
// small namespace-tolerant tag reader is enough; no XML dependency needed.

const OUTPUT_FIELDS = ["Vat331", "Vat332", "Vat333", "Vat334", "Vat335", "Vat336"];
const INPUT_FIELDS = ["Vat381", "Vat382", "Vat383", "Vat384", "Vat385", "Vat386"];
const UNCLASSIFIED_FIELD = "VatUnclassified381";
const OUTPUT_NET_FIELDS = ["Vat301", "Vat302", "Vat303", "Vat304", "Vat305", "Vat306"];
const INPUT_NET_FIELDS = ["Vat361", "Vat362", "Vat363", "Vat364", "Vat365", "Vat366"];
const UNCLASSIFIED_NET_FIELD = "VatUnclassified361";

interface VatEntry {
  mark: string;
  issue_date: string; // YYYY-MM-DD
  is_cancelled: boolean;
  out_vat: number;
  in_vat: number;
  unclassified_vat: number;
  out_net: number; // Σ Vat301..306 (net bases)
  in_net: number; // Σ Vat361..366
  unclassified_net: number; // VatUnclassified361
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
    out_net: sumCents(xml, OUTPUT_NET_FIELDS) / 100,
    in_net: sumCents(xml, INPUT_NET_FIELDS) / 100,
    unclassified_net: toCents(text(xml, UNCLASSIFIED_NET_FIELD)) / 100,
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

// ---- docs.ts ---------------------------------------------------------------

// Parser for RequestDocs (documents other entities issued to me = my expenses).
// Used only to describe unclassified expense documents (who, which invoice, how much);
// the VAT figures themselves come from RequestVatInfo.


interface ReceivedDoc {
  mark: string;
  issuer_vat: string | null;
  issuer_name: string | null; // usually absent for Greek issuers
  series: string | null;
  aa: string | null;
  issue_date: string | null; // YYYY-MM-DD
  inv_type: string | null;
  net: number;
  vat: number;
  gross: number;
}

interface DocsPage {
  docs: ReceivedDoc[];
  next: { partitionKey: string; rowKey: string } | null;
}

function parseInvoice(xml: string): ReceivedDoc | null {
  const mark = text(xml, "mark");
  if (!mark) return null;
  const issuer = blocks(xml, "issuer")[0] ?? "";
  const header = blocks(xml, "invoiceHeader")[0] ?? "";
  const summary = blocks(xml, "invoiceSummary")[0] ?? "";
  const date = text(header, "issueDate");
  return {
    mark,
    issuer_vat: text(issuer, "vatNumber"),
    issuer_name: text(issuer, "name"),
    series: text(header, "series"),
    aa: text(header, "aa"),
    issue_date: date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
    inv_type: text(header, "invoiceType"),
    net: toCents(text(summary, "totalNetValue")) / 100,
    vat: toCents(text(summary, "totalVatAmount")) / 100,
    gross: toCents(text(summary, "totalGrossValue")) / 100,
  };
}

/** Throws MyDataError on an error response or an unexpected shape. */
function parseDocs(body: string): DocsPage {
  const xml = unwrap(body);
  const errors = blocks(xml, "error");
  if (errors.length > 0) {
    const msgs = errors.map((e) => `[${text(e, "code") ?? "?"}] ${text(e, "message") ?? ""}`.trim());
    throw new MyDataError(`myDATA RequestDocs: ${msgs.join("; ")}`);
  }
  if (!/<(?:[\w-]+:)?RequestedDoc[\s>/]/.test(xml)) {
    throw new MyDataError(`Απρόσμενη απάντηση RequestDocs: ${xml.slice(0, 200)}`);
  }
  const docs = blocks(xml, "invoice").map(parseInvoice).filter((d): d is ReceivedDoc => d !== null);
  const token = blocks(xml, "continuationToken")[0];
  const partitionKey = token ? text(token, "nextPartitionKey") : null;
  const rowKey = token ? text(token, "nextRowKey") : null;
  return { docs, next: partitionKey && rowKey ? { partitionKey, rowKey } : null };
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

// myDATA client: pagination via continuationToken + retry on transient errors.
// Read-only: this module only ever calls RequestVatInfo and RequestDocs.


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

/** Documents issued to me (expenses) in the window, via RequestDocs (mark > 0). */
async function fetchReceivedDocs(
  cfg: MyDataConfig,
  from: string,
  to: string,
  fetchFn: Fetch = fetch,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<ReceivedDoc[]> {
  const docs: ReceivedDoc[] = [];
  let next: { partitionKey: string; rowKey: string } | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      mark: "0",
      dateFrom: toMyDataDate(from),
      dateTo: toMyDataDate(to),
    });
    if (next) {
      params.set("nextPartitionKey", next.partitionKey);
      params.set("nextRowKey", next.rowKey);
    }
    const xml = await getWithRetry(`${cfg.baseUrl}/RequestDocs?${params}`, cfg, fetchFn, sleep);
    const result = parseDocs(xml);
    docs.push(...result.docs);
    if (!result.next) return docs;
    next = result.next;
  }
  throw new MyDataError(`Υπέρβαση ορίου σελίδων RequestDocs (${MAX_PAGES})`);
}

// ---- webpush.ts ------------------------------------------------------------

// Minimal Web Push sender with WebCrypto only (no dependencies):
// VAPID (RFC 8292, ES256 JWT) + message encryption "aes128gcm" (RFC 8291 / RFC 8188).

interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface VapidKeys {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateJwk: JsonWebKey; // ECDSA P-256 private key
}

const enc = new TextEncoder();
const B = (u: Uint8Array) => u as unknown as BufferSource; // TS 5.7 Uint8Array generics vs WebCrypto types

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

/** New VAPID key pair (stored once by the function, never handled by a person). */
async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64url(raw), privateJwk };
}

async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, B(enc.encode(`${header}.${payload}`))));
  return `vapid t=${header}.${payload}.${b64url(sig)}, k=${keys.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", B(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: B(salt), info: B(info) }, key, bytes * 8));
}

/**
 * Encrypts `plaintext` for a subscription (single aes128gcm record).
 * `ephemeral` and `salt` are injectable for tests.
 */
async function encryptPayload(
  sub: PushSubscriptionJSON,
  plaintext: Uint8Array,
  ephemeral?: CryptoKeyPair,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Uint8Array> {
  const uaPublic = unb64url(sub.keys.p256dh);
  const authSecret = unb64url(sub.keys.auth);
  const as = ephemeral ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", B(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", B(cek), "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: B(nonce) }, aes, B(concat(plaintext, new Uint8Array([2])))));

  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

interface PushResult {
  ok: boolean;
  gone: boolean; // subscription expired/unsubscribed → delete it
  status: number;
}

async function sendPush(
  sub: PushSubscriptionJSON,
  message: unknown,
  keys: VapidKeys,
  subject: string,
  fetchFn: typeof fetch = fetch,
): Promise<PushResult> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(message)));
  const res = await fetchFn(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidAuthorization(sub.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "normal",
    },
    body: B(body),
  });
  await res.body?.cancel();
  return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
}

// ---- notify.ts -------------------------------------------------------------

// Push notifications: VAPID keys (generated once, kept in the app_secret table that
// only the service role can read), sending to all saved subscriptions, and the
// messages for new documents and the VAT return deadline.


// deno-lint-ignore no-explicit-any
type Db = any;

const eur = new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" });
const money = (x: number) => eur.format(x);
const cents = (x: unknown) => Math.round(Number(x || 0) * 100);

async function vapidKeys(db: Db): Promise<VapidKeys> {
  const read = async () => (await db.from("app_secret").select("value").eq("key", "vapid").maybeSingle()).data?.value;
  const existing = await read();
  if (existing) return existing as VapidKeys;
  const keys = await generateVapidKeys();
  const { error } = await db.from("app_secret").insert({ key: "vapid", value: keys });
  return error ? (await read()) as VapidKeys : keys; // lost a race → use the stored one
}

interface Message {
  title: string;
  body: string;
  tag?: string;
}

async function notifyAll(db: Db, message: Message): Promise<{ sent: number; removed: number }> {
  const { data: subs } = await db.from("push_subscriptions").select("endpoint, p256dh, auth");
  if (!subs?.length) return { sent: 0, removed: 0 };
  const keys = await vapidKeys(db);
  const subject = `mailto:${Deno.env.get("ALLOWED_EMAIL") ?? "noreply@example.com"}`;
  let sent = 0, removed = 0;
  for (const s of subs) {
    try {
      const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message, keys, subject);
      if (r.ok) sent++;
      else if (r.gone) {
        await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        removed++;
      }
    } catch (_) {
      // one broken subscription must not stop the others
    }
  }
  return { sent, removed };
}

function quarterBounds(quarter: string) {
  const [y, q] = quarter.split("-Q").map(Number);
  const start = `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** Same rule as the app: output − (input + unclassified) ± manual − carried credit. */
async function quarterPosition(db: Db, quarter: string): Promise<{ kind: "debit" | "credit"; amount: number }> {
  const { start, end } = quarterBounds(quarter);
  const [vat, manual, credit] = await Promise.all([
    db.from("vat_entries").select("out_vat, in_vat, unclassified_vat").eq("is_cancelled", false)
      .gte("issue_date", start).lte("issue_date", end).range(0, 9999),
    db.from("manual_vat").select("kind, vat").gte("entry_date", start).lte("entry_date", end),
    db.from("quarter_credit").select("amount").eq("quarter", quarter).maybeSingle(),
  ]);
  let c = 0;
  for (const r of vat.data ?? []) c += cents(r.out_vat) - cents(r.in_vat) - cents(r.unclassified_vat);
  for (const r of manual.data ?? []) c += r.kind === "out" ? cents(r.vat) : -cents(r.vat);
  c -= cents(credit.data?.amount);
  return { kind: c > 0 ? "debit" : "credit", amount: Math.abs(c) / 100 };
}

const positionText = (p: { kind: string; amount: number }) =>
  `${p.kind === "debit" ? "Πληρωτέο" : "Πιστωτικό"} ${money(p.amount)}`;

function quarterName(quarter: string): string {
  const [y, q] = quarter.split("-Q").map(Number);
  return `${q}ου τριμήνου ${y}`;
}

function newDocsMessage(newRows: Omit<VatEntry, "has_negative">[], position: { kind: string; amount: number }): Message {
  const out = newRows.reduce((a, r) => a + cents(r.out_vat), 0) / 100;
  const inp = newRows.reduce((a, r) => a + cents(r.in_vat) + cents(r.unclassified_vat), 0) / 100;
  const parts = [];
  if (out) parts.push(`ΦΠΑ εσόδων ${money(out)}`);
  if (inp) parts.push(`ΦΠΑ εξόδων ${money(inp)}`);
  const n = newRows.length;
  return {
    title: n === 1 ? "Νέο παραστατικό στο myDATA" : `${n} νέα παραστατικά στο myDATA`,
    body: `${parts.length ? parts.join(", ") + ". " : ""}Θέση τριμήνου: ${positionText(position)}.`,
    tag: "new-docs",
  };
}

/** Deadline reminder for the previous quarter, 5 days before, 1 day before and on the day. */
function deadlineReminder(today: string): { key: string; quarter: string; deadline: string; daysLeft: number } | null {
  const quarter = previousQuarter(quarterOfDate(today));
  const deadline = vatDeadline(quarter);
  const daysLeft = daysBetween(today, deadline);
  if (![5, 1, 0].includes(daysLeft)) return null;
  return { key: `deadline-${quarter}-${daysLeft}`, quarter, deadline, daysLeft };
}

function deadlineMessage(r: { quarter: string; deadline: string; daysLeft: number }, position: { kind: string; amount: number }): Message {
  const [y, m, d] = r.deadline.split("-");
  const when = r.daysLeft === 0 ? "σήμερα" : r.daysLeft === 1 ? "αύριο" : `σε ${r.daysLeft} μέρες`;
  return {
    title: `Δήλωση ΦΠΑ ${quarterName(r.quarter)}: ${when}`,
    body: `Προθεσμία ${d}/${m}/${y}. Εκτίμηση: ${positionText(position)}.` +
      (position.kind === "credit" ? " Η δήλωση υποβάλλεται κανονικά." : ""),
    tag: `deadline-${r.quarter}`,
  };
}

/** Runs after a cron sync. Never throws. */
async function cronNotifications(db: Db, newRows: Omit<VatEntry, "has_negative">[], hadPrevious: boolean) {
  const result: string[] = [];
  try {
    const today = athensToday();
    if (hadPrevious && newRows.length > 0) {
      const pos = await quarterPosition(db, quarterOfDate(today));
      const r = await notifyAll(db, newDocsMessage(newRows, pos));
      result.push(`new-docs sent=${r.sent}`);
    }
    const reminder = deadlineReminder(today);
    if (reminder) {
      const { error } = await db.from("notify_log").insert({ key: reminder.key }); // unique: once per reminder
      if (!error) {
        const pos = await quarterPosition(db, reminder.quarter);
        const r = await notifyAll(db, deadlineMessage(reminder, pos));
        result.push(`${reminder.key} sent=${r.sent}`);
      }
    }
  } catch (e) {
    result.push(`notify error: ${(e as Error).message}`);
  }
  return result;
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

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch (_) {
    return {};
  }
}

/** Push-notification actions from the app (logged-in user only). */
async function pushAction(action: string, body: Record<string, unknown>) {
  if (action === "vapid-public-key") {
    return json({ publicKey: (await vapidKeys(db)).publicKey });
  }
  if (action === "subscribe") {
    const sub = body.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "Bad subscription" }, 400);
    const { error } = await db.from("push_subscriptions").upsert({
      endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
      user_agent: String(body.userAgent ?? "").slice(0, 300),
    }, { onConflict: "endpoint" });
    return error ? json({ error: error.message }, 500) : json({ status: "ok" });
  }
  if (action === "unsubscribe") {
    await db.from("push_subscriptions").delete().eq("endpoint", String(body.endpoint ?? ""));
    return json({ status: "ok" });
  }
  if (action === "test-push") {
    const r = await notifyAll(db, {
      title: "Ισοζύγιο ΦΠΑ",
      body: "Οι ειδοποιήσεις λειτουργούν. Θα ενημερώνεσαι για νέα παραστατικά και για την προθεσμία της δήλωσης.",
      tag: "test",
    });
    return json({ status: "ok", ...r });
  }
  return json({ error: `Unknown action ${action}` }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const trigger = await authorize(req);
  if (!trigger) return json({ error: "Unauthorized" }, 401);

  const body = await readBody(req);
  const action = typeof body.action === "string" ? body.action : "sync";
  if (action !== "sync") {
    if (trigger !== "manual") return json({ error: "Unauthorized" }, 401);
    try {
      return await pushAction(action, body);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  const { from, to } = syncWindow();
  const { data: log, error: logErr } = await db
    .from("sync_log")
    .insert({ trigger, date_from: from, date_to: to })
    .select("id")
    .single();
  if (logErr) return json({ error: logErr.message }, 500);

  const cfg = {
    baseUrl: Deno.env.get("MYDATA_BASE_URL") ?? PROD_BASE_URL,
    userId: env("MYDATA_USER_ID"),
    subscriptionKey: env("MYDATA_SUBSCRIPTION_KEY"),
  };

  try {
    const entries = await fetchVatInfo(cfg, from, to);
    // Credit-note sign warning: only until it has been raised (or negatives seen) once.
    const { count: checked } = await db.from("sync_log").select("id", { count: "exact", head: true })
      .or("warning.not.is.null,negative_docs.gt.0");
    const { rows, negativeDocs, warning } = summarize(entries, (checked ?? 0) > 0);
    const now = new Date().toISOString();

    // Which documents are new (for the "new document" notification).
    const { data: known } = await db.from("vat_entries").select("mark").gte("issue_date", from).range(0, 49999);
    const knownMarks = new Set((known ?? []).map((r: { mark: string }) => r.mark));
    const newRows = rows.filter((r) => !knownMarks.has(r.mark) && !r.is_cancelled);

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, synced_at: now }));
      const { error } = await db.from("vat_entries").upsert(chunk, { onConflict: "mark" });
      if (error) throw new Error(`DB: ${error.message}`);
    }

    // Expense documents (supplier, invoice number) — optional, never fails the sync.
    let docsError: string | null = null;
    try {
      const docs = await fetchReceivedDocs(cfg, from, to);
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500).map((d) => ({ ...d, synced_at: now }));
        const { error } = await db.from("received_docs").upsert(chunk, { onConflict: "mark" });
        if (error) throw new Error(`DB: ${error.message}`);
      }
    } catch (e) {
      docsError = (e as Error).message;
    }

    const notified = trigger === "cron" ? await cronNotifications(db, newRows, knownMarks.size > 0) : [];

    await db.from("sync_log").update({
      status: "ok",
      finished_at: new Date().toISOString(),
      rows: rows.length,
      negative_docs: negativeDocs,
      warning,
      docs_error: docsError,
    }).eq("id", log.id);

    return json({ status: "ok", rows: rows.length, newRows: newRows.length, negativeDocs, warning, docsError, notified });
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
