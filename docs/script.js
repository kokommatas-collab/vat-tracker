import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import {
  aggregate, currentQuarter, formatEur, monthLabel, quarterLabel, quarterMonths, quarterRange,
  quarterShort, vatPosition,
} from "./calc.js?v=3";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const dateTime = new Intl.DateTimeFormat("el-GR", {
  dateStyle: "short", timeStyle: "short", timeZone: "Europe/Athens",
});

let byQuarter = new Map(); // "2026-Q4" → totals
let byMonth = new Map();   // "2026-10" → totals
let credits = new Map();   // quarter → carried-forward credit
let selected = currentQuarter();
let lastSyncAt = null;

function show(loggedIn) {
  $("login").hidden = loggedIn;
  $("app").hidden = !loggedIn;
}

function setText(id, text, visible = true) {
  $(id).textContent = text;
  $(id).hidden = !visible;
}

function ago(date) {
  if (!date) return "χωρίς ενημέρωση";
  const min = Math.round((Date.now() - date.getTime()) / 60000);
  if (min < 1) return "μόλις τώρα";
  if (min < 60) return `πριν ${min}′`;
  const h = Math.round(min / 60);
  if (h < 24) return `πριν ${h} ώρ${h === 1 ? "α" : "ες"}`;
  const d = Math.round(h / 24);
  return `πριν ${d} μέρ${d === 1 ? "α" : "ες"}`;
}

const COLS = "issue_date, is_cancelled, out_vat, in_vat, unclassified_vat, out_net, in_net, unclassified_net";

async function fetchEntries() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("vat_entries").select(COLS)
      .order("issue_date").range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function load() {
  try {
    const [rows, cred, lastOk, last] = await Promise.all([
      fetchEntries(),
      sb.from("quarter_credit").select("quarter, amount"),
      sb.from("sync_log").select("finished_at, warning, rows").eq("status", "ok")
        .order("started_at", { ascending: false }).limit(1).maybeSingle(),
      sb.from("sync_log").select("status, error, started_at")
        .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const failed = [cred, lastOk, last].find((r) => r.error);
    if (failed) throw failed.error;

    byQuarter = aggregate(rows, "quarter");
    byMonth = aggregate(rows, "month");
    credits = new Map(cred.data.map((r) => [r.quarter, Number(r.amount)]));
    lastSyncAt = lastOk.data ? new Date(lastOk.data.finished_at) : null;

    setText("last-update", lastSyncAt
      ? `Τελευταία ενημέρωση: ${dateTime.format(lastSyncAt)}`
      : "Δεν έχει γίνει ακόμη συγχρονισμός");
    setText("docs-count", `${rows.length} παραστατικά στη βάση`, rows.length > 0);
    setText("warning", lastOk.data?.warning ?? "", Boolean(lastOk.data?.warning));
    const err = last.data?.status === "error" ? last.data.error : null;
    setText("sync-error", `Αποτυχία συγχρονισμού: ${err}`, Boolean(err));
  } catch (e) {
    setText("sync-error", `Σφάλμα φόρτωσης: ${e.message}`);
  }
  render();
}

const totalsOf = (q) => byQuarter.get(q) ?? {};

function positionOf(q) {
  const t = totalsOf(q);
  return vatPosition({
    outVat: t.out_vat, inVat: t.in_vat, unclassifiedVat: t.unclassified_vat, credit: credits.get(q) ?? 0,
  });
}

const pct = (x, max) => `${max > 0 ? Math.max(0, Math.min(100, (x / max) * 100)) : 0}%`;
const kindWord = (kind) => (kind === "debit" ? "Πληρωτέο" : "Πιστωτικό");

function render() {
  const now = currentQuarter();
  const isCurrent = selected === now;
  const t = totalsOf(selected);
  const { kind, amount } = positionOf(selected);

  $("updated-text").textContent = ago(lastSyncAt);

  // Hero
  $("live").className = `hero ${kind}`;
  const r = quarterRange(selected);
  $("live-sub").textContent = isCurrent
    ? `${quarterShort(selected)}, μέχρι σήμερα`
    : `${quarterShort(selected)}, ${r.from} έως ${r.to}`;
  $("kind-line").textContent = kindWord(kind);
  $("amount").textContent = formatEur(amount);
  $("credit").textContent = formatEur(credits.get(selected) ?? 0);
  $("back-current").hidden = isCurrent;

  // Balance bars (shared scale)
  const out = Number(t.out_vat || 0);
  const inCls = Number(t.in_vat || 0);
  const unc = Number(t.unclassified_vat || 0);
  const inAll = inCls + unc;
  const max = Math.max(out, inAll);
  $("bar-out").style.width = pct(out, max);
  $("bar-in").style.width = pct(inCls, max);
  $("bar-unc").style.left = pct(inCls, max);
  $("bar-unc").style.width = pct(unc, max);
  const lo = Math.min(out, inAll);
  $("bar-diff").style.left = pct(lo, max);
  $("bar-diff").style.width = pct(Math.abs(out - inAll), max);
  $("out-vat").textContent = formatEur(out);
  $("in-vat").textContent = formatEur(inAll);
  $("diff-label").textContent = out >= inAll ? "Διαφορά" : "Υπερβάλλον";
  $("diff-val").textContent = formatEur(Math.abs(out - inAll));

  const inNet = Number(t.in_net || 0) + Number(t.unclassified_net || 0);
  $("nets").textContent = `Καθαρά έσοδα ${formatEur(t.out_net)} και καθαρά έξοδα ${formatEur(inNet)}`;
  setText("unclassified", `Από τον ΦΠΑ εξόδων, ${formatEur(unc)} αφορούν μη χαρακτηρισμένα παραστατικά (γραμμοσκιασμένο).`, unc > 0);

  renderMonths();
  renderHistory(now);
}

function row(kind, title, sub, amt) {
  const left = el("div");
  left.append(el("div", "row-title", title), el("div", "row-sub", sub));
  const right = el("div");
  right.append(el("div", "row-amt", formatEur(amt)), el("div", "row-kind", kindWord(kind)));
  return [left, right];
}

function renderMonths() {
  const box = $("months");
  const items = quarterMonths(selected).filter((m) => byMonth.has(m)).reverse();
  if (items.length === 0) {
    box.replaceChildren(el("p", "empty-note", "Δεν υπάρχουν παραστατικά για αυτό το τρίμηνο."));
    return;
  }
  box.replaceChildren(...items.map((m) => {
    const t = byMonth.get(m);
    const inAll = t.in_vat + t.unclassified_vat;
    const { kind, amount } = vatPosition({ outVat: t.out_vat, inVat: t.in_vat, unclassifiedVat: t.unclassified_vat });
    const d = el("div", `row ${kind}`);
    d.append(...row(kind, monthLabel(m),
      `Έσοδα ${formatEur(t.out_vat)}, έξοδα ${formatEur(inAll)}, ${t.docs} παραστατικά`, amount));
    return d;
  }));
}

function renderHistory(now) {
  const quarters = [...new Set([now, ...byQuarter.keys()])].sort().reverse();
  const box = $("history");
  const max = Math.max(1, ...quarters.map((q) => {
    const t = totalsOf(q);
    return Math.max(Number(t.out_vat || 0), Number(t.in_vat || 0) + Number(t.unclassified_vat || 0));
  }));
  box.replaceChildren(...quarters.map((q) => {
    const t = totalsOf(q);
    const { kind, amount } = positionOf(q);
    const r = quarterRange(q);
    const b = el("button", `row qrow ${kind}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(q === selected));
    b.append(...row(kind, quarterShort(q), q === now ? "Τρέχον τρίμηνο" : `${r.from} έως ${r.to}`, amount));
    const mini = el("div", "mini");
    const mo = el("span", "m-out"); mo.style.width = pct(Number(t.out_vat || 0), max);
    const mi = el("span", "m-in"); mi.style.width = pct(Number(t.in_vat || 0) + Number(t.unclassified_vat || 0), max);
    mini.append(mo, mi);
    b.append(mini);
    b.addEventListener("click", () => {
      selected = q;
      render();
      window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
    return b;
  }));
}

function parseAmount(input) {
  let s = input.replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

$("edit-credit").addEventListener("click", async () => {
  const q = selected;
  const input = prompt(`Πιστωτικό υπόλοιπο που μεταφέρεται στο ${quarterLabel(q)} (€):`,
    String(credits.get(q) ?? 0).replace(".", ","));
  if (input === null) return;
  const amount = parseAmount(input);
  if (amount === null) return alert("Μη έγκυρο ποσό");
  const { error } = await sb.from("quarter_credit")
    .upsert({ quarter: q, amount, updated_at: new Date().toISOString() });
  if (error) return alert(`Σφάλμα αποθήκευσης: ${error.message}`);
  credits.set(q, amount);
  render();
});

$("back-current").addEventListener("click", () => {
  selected = currentQuarter();
  render();
});

async function refresh() {
  const buttons = [$("refresh"), $("refresh-big")];
  buttons.forEach((b) => (b.disabled = true));
  $("refresh-big").textContent = "Συγχρονισμός…";
  const { error } = await sb.functions.invoke("sync-mydata", { method: "POST", body: {} });
  await load(); // sync errors are recorded in sync_log and shown by load()
  if (error && $("sync-error").hidden) setText("sync-error", `Αποτυχία ανανέωσης: ${error.message}`);
  buttons.forEach((b) => (b.disabled = false));
  $("refresh-big").textContent = "Ανανέωση από myDATA";
}
$("refresh").addEventListener("click", refresh);
$("refresh-big").addEventListener("click", refresh);

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const { error } = await sb.auth.signInWithPassword({
    email: form.get("email"), password: form.get("password"),
  });
  setText("login-error", error ? `Αποτυχία σύνδεσης: ${error.message}` : "", Boolean(error));
});

$("logout").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  show(Boolean(session));
  if (session) setTimeout(load, 0); // don't await Supabase calls inside the callback
});

// Keep the "πριν X′" chip fresh.
setInterval(() => { if (!$("app").hidden) $("updated-text").textContent = ago(lastSyncAt); }, 60000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
