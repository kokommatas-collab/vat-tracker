import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import {
  aggregate, athensToday, currentQuarter, daysUntil, deadlineOf, formatEur, manualAsEntry, monthLabel,
  previousQuarterOf, quarterLabel, quarterMonths, quarterOf, quarterRange, quarterShort, vatPosition,
} from "./calc.js?v=4";

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
let entries = [];          // vat_entries rows (with mark)
let manual = [];           // manual_vat rows
let docsByMark = new Map(); // received_docs by mark
let supplierNames = new Map(); // ΑΦΜ → my name for the supplier

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

const COLS = "mark, issue_date, is_cancelled, out_vat, in_vat, unclassified_vat, out_net, in_net, unclassified_net";

async function fetchAll(table, cols, order) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

/** Optional tables: an error (e.g. not migrated yet) just yields an empty list. */
async function fetchOptional(table, cols, order) {
  try {
    return await fetchAll(table, cols, order);
  } catch (_) {
    return [];
  }
}

async function load() {
  try {
    const [rows, man, docs, names, cred, lastOk, last] = await Promise.all([
      fetchAll("vat_entries", COLS, "issue_date"),
      fetchOptional("manual_vat", "id, entry_date, kind, vat, net, note", "entry_date"),
      fetchOptional("received_docs", "mark, issuer_vat, issuer_name, series, aa, issue_date, gross", "issue_date"),
      fetchOptional("supplier_names", "vat_number, name", "vat_number"),
      sb.from("quarter_credit").select("quarter, amount"),
      sb.from("sync_log").select("finished_at, warning, rows").eq("status", "ok")
        .order("started_at", { ascending: false }).limit(1).maybeSingle(),
      sb.from("sync_log").select("status, error, started_at")
        .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const failed = [cred, lastOk, last].find((r) => r.error);
    if (failed) throw failed.error;

    entries = rows;
    manual = man;
    docsByMark = new Map(docs.map((d) => [d.mark, d]));
    supplierNames = new Map(names.map((n) => [n.vat_number, n.name]));
    const all = [...rows, ...man.map(manualAsEntry)];
    byQuarter = aggregate(all, "quarter");
    byMonth = aggregate(all, "month");
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

  renderDeadline(now);
  renderMonths();
  renderHistory(now);
  renderUnclassified();
  renderManual();
}

const weekday = new Intl.DateTimeFormat("el-GR", { weekday: "long", day: "numeric", month: "numeric", timeZone: "UTC" });

function renderDeadline(now) {
  const prev = previousQuarterOf(now);
  const due = deadlineOf(prev);
  const left = daysUntil(athensToday(), due);
  const box = $("deadline");
  if (left < 0) {
    box.hidden = true;
    return;
  }
  const { kind, amount } = positionOf(prev);
  const when = left === 0 ? "σήμερα" : left === 1 ? "αύριο" : `σε ${left} μέρες`;
  box.replaceChildren(
    document.createTextNode(`Η δήλωση ΦΠΑ του ${prev.slice(-1)}ου τριμήνου ${prev.slice(0, 4)} λήγει `),
    el("strong", "", `${weekday.format(new Date(`${due}T00:00:00Z`))} (${when})`),
    document.createTextNode(`. ${kindWord(kind)} ${formatEur(amount)}.`),
  );
  box.className = `deadline${left <= 5 ? " soon" : ""}`;
  box.hidden = false;
}

const fmtDate = (iso) => (iso ? iso.split("-").reverse().join("/") : "");

function supplierLabel(doc) {
  if (!doc) return "Άγνωστος εκδότης";
  return supplierNames.get(doc.issuer_vat) || doc.issuer_name || (doc.issuer_vat ? `ΑΦΜ ${doc.issuer_vat}` : "Άγνωστος εκδότης");
}

function unclassifiedOfQuarter() {
  return entries
    .filter((e) => !e.is_cancelled && Number(e.unclassified_vat) !== 0 && quarterOf(e.issue_date) === selected)
    .sort((a, b) => b.issue_date.localeCompare(a.issue_date));
}

function renderUnclassified() {
  const box = $("unclassified-list");
  const items = unclassifiedOfQuarter();
  $("copy-unclassified").hidden = items.length === 0;
  if (items.length === 0) {
    box.replaceChildren(el("p", "empty-note", "Όλα τα έξοδα του τριμήνου είναι χαρακτηρισμένα."));
    return;
  }
  box.replaceChildren(...items.map((e) => {
    const doc = docsByMark.get(e.mark);
    const d = el("div", "row");
    const left = el("div");
    const number = doc && (doc.series || doc.aa) ? `${[doc.series, doc.aa].filter(Boolean).join(" ")}, ` : "";
    left.append(
      el("div", "row-title", supplierLabel(doc)),
      el("div", "row-sub", `${number}${fmtDate(e.issue_date)}, ΜΑΡΚ ${e.mark}`),
    );
    const right = el("div");
    right.append(el("div", "row-amt neutral", formatEur(e.unclassified_vat)));
    right.append(el("div", "row-kind muted", doc?.gross ? `σύνολο ${formatEur(doc.gross)}` : "ΦΠΑ"));
    if (doc?.issuer_vat) {
      const acts = el("div", "row-actions");
      const b = el("button", "link", supplierNames.has(doc.issuer_vat) ? "Μετονομασία" : "Όνομα");
      b.type = "button";
      b.addEventListener("click", () => nameSupplier(doc.issuer_vat));
      acts.append(b);
      right.append(acts);
    }
    d.append(left, right);
    return d;
  }));
}

async function nameSupplier(vat) {
  const name = prompt(`Όνομα για τον προμηθευτή με ΑΦΜ ${vat}:`, supplierNames.get(vat) ?? "");
  if (name === null) return;
  const clean = name.trim();
  const { error } = clean
    ? await sb.from("supplier_names").upsert({ vat_number: vat, name: clean, updated_at: new Date().toISOString() })
    : await sb.from("supplier_names").delete().eq("vat_number", vat);
  if (error) return alert(`Σφάλμα αποθήκευσης: ${error.message}`);
  clean ? supplierNames.set(vat, clean) : supplierNames.delete(vat);
  renderUnclassified();
}

$("copy-unclassified").addEventListener("click", async () => {
  const lines = unclassifiedOfQuarter().map((e) => {
    const doc = docsByMark.get(e.mark);
    const number = doc ? [doc.series, doc.aa].filter(Boolean).join(" ") : "";
    const vat = doc?.issuer_vat ? ` (ΑΦΜ ${doc.issuer_vat})` : "";
    return `${fmtDate(e.issue_date)}  ${supplierLabel(doc)}${vat}  ${number}  ΜΑΡΚ ${e.mark}  ΦΠΑ ${formatEur(e.unclassified_vat)}`;
  });
  const text = `Μη χαρακτηρισμένα έξοδα, ${quarterShort(selected)}\n\n${lines.join("\n")}`;
  try {
    await navigator.clipboard.writeText(text);
    $("copy-unclassified").textContent = "Αντιγράφηκε";
    setTimeout(() => ($("copy-unclassified").textContent = "Αντιγραφή λίστας"), 2000);
  } catch (_) {
    prompt("Αντέγραψε τη λίστα:", text);
  }
});

function renderManual() {
  const box = $("manual-list");
  const items = manual.filter((m) => quarterOf(m.entry_date) === selected)
    .sort((a, b) => b.entry_date.localeCompare(a.entry_date));
  box.replaceChildren(...items.map((m) => {
    const d = el("div", "row");
    const left = el("div");
    left.append(
      el("div", "row-title", m.note || (m.kind === "out" ? "ΦΠΑ εσόδου" : "ΦΠΑ εξόδου")),
      el("div", "row-sub", `${m.kind === "out" ? "Έσοδο" : "Έξοδο"}, ${fmtDate(m.entry_date)}${Number(m.net) ? `, καθαρά ${formatEur(m.net)}` : ""}`),
    );
    const right = el("div");
    right.append(el("div", "row-amt neutral", `${m.kind === "out" ? "+" : "−"}${formatEur(m.vat)}`));
    const acts = el("div", "row-actions");
    const del = el("button", "link", "Διαγραφή");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm(`Διαγραφή ΦΠΑ ${formatEur(m.vat)} (${fmtDate(m.entry_date)});`)) return;
      const { error } = await sb.from("manual_vat").delete().eq("id", m.id);
      if (error) return alert(`Σφάλμα διαγραφής: ${error.message}`);
      await load();
    });
    acts.append(del);
    right.append(acts);
    d.append(left, right);
    return d;
  }));
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

$("manual-form").date.value = athensToday();
$("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const vat = parseAmount(f.vat.value);
  const net = f.net.value.trim() ? parseAmount(f.net.value) : 0;
  if (vat === null || vat === 0 || net === null) {
    setText("manual-error", "Γράψε ποσό ΦΠΑ μεγαλύτερο από 0 (π.χ. 123,45).");
    return;
  }
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  const { error } = await sb.from("manual_vat").insert({
    entry_date: f.date.value, kind: f.kind.value, vat, net, note: f.note.value.trim() || null,
  });
  btn.disabled = false;
  if (error) return setText("manual-error", `Σφάλμα αποθήκευσης: ${error.message}`);
  setText("manual-error", "", false);
  f.vat.value = "";
  f.net.value = "";
  f.note.value = "";
  selected = quarterOf(f.date.value);
  await load();
});

// ---------- push notifications ----------
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function b64ToBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS() && !isStandalone() ? "needs-home-screen" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

async function renderPush() {
  const state = await pushState();
  const btn = $("push-btn");
  const msgs = {
    "needs-home-screen": "Στο iPhone οι ειδοποιήσεις δουλεύουν όταν ανοίγεις το Ισοζύγιο από την οθόνη Αφετηρίας: Κοινοποίηση, Προσθήκη στην οθόνη Αφετηρίας, και μετά πάτα ξανά εδώ.",
    unsupported: "Αυτός ο browser δεν υποστηρίζει ειδοποιήσεις.",
    denied: "Οι ειδοποιήσεις είναι μπλοκαρισμένες. Επίτρεψέ τες από τις ρυθμίσεις του κινητού για το Ισοζύγιο.",
    on: "Οι ειδοποιήσεις είναι ενεργές σε αυτή τη συσκευή: νέα παραστατικά και προθεσμία δήλωσης.",
    off: "",
  };
  btn.textContent = state === "on" ? "Απενεργοποίηση ειδοποιήσεων" : "Ειδοποιήσεις στο κινητό";
  btn.disabled = state === "unsupported" || state === "denied";
  btn.dataset.state = state;
  setText("push-status", msgs[state], Boolean(msgs[state]));
}

async function callFn(body) {
  const { data, error } = await sb.functions.invoke("sync-mydata", { method: "POST", body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

$("push-btn").addEventListener("click", async () => {
  const btn = $("push-btn");
  const state = btn.dataset.state;
  if (state === "needs-home-screen") return;
  btn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (state === "on") {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await callFn({ action: "unsubscribe", endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Δεν δόθηκε άδεια για ειδοποιήσεις.");
      const { publicKey } = await callFn({ action: "vapid-public-key" });
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      await callFn({ action: "subscribe", subscription: sub.toJSON(), userAgent: navigator.userAgent });
      await callFn({ action: "test-push" });
    }
  } catch (e) {
    setText("push-status", `Δεν ολοκληρώθηκε: ${e.message}`);
    btn.disabled = false;
    return;
  }
  await renderPush();
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
  if (session) setTimeout(() => { load(); renderPush(); }, 0); // don't await Supabase calls inside the callback
});

// Keep the "πριν X′" chip fresh.
setInterval(() => { if (!$("app").hidden) $("updated-text").textContent = ago(lastSyncAt); }, 60000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
