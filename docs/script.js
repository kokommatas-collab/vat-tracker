import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import { currentQuarter, formatEur, quarterLabel, vatPosition } from "./calc.js";
import { prefersReducedMotion } from "./motion.js";
import { createSheet } from "./sheet.js";
import { pullToRefresh } from "./ptr.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const dateTime = new Intl.DateTimeFormat("el-GR", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Athens",
});

let summaries = new Map(); // quarter → row of quarter_summary
let credits = new Map();   // quarter → carried-forward credit

// Lets :active styles fire on touch-down in iOS Safari (instant press feedback).
addEventListener("touchstart", () => {}, { passive: true });

function show(loggedIn) {
  $("login").hidden = loggedIn;
  $("app").hidden = !loggedIn;
}

function setNotice(id, text) {
  $(`${id}-text`).textContent = text ?? "";
  $(id).hidden = !text;
  $("notices").hidden = ["unclassified", "warning", "sync-error"].every((n) => $(n).hidden);
}

async function load() {
  const [sum, cred, lastOk, last] = await Promise.all([
    sb.from("quarter_summary").select("*"),
    sb.from("quarter_credit").select("quarter, amount"),
    sb.from("sync_log").select("finished_at, warning").eq("status", "ok")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("sync_log").select("status, error, started_at")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const failed = [sum, cred, lastOk, last].find((r) => r.error);
  if (failed) return setNotice("sync-error", `Σφάλμα φόρτωσης: ${failed.error.message}`);

  summaries = new Map(sum.data.map((r) => [r.quarter, r]));
  credits = new Map(cred.data.map((r) => [r.quarter, Number(r.amount)]));

  const quarters = new Set([currentQuarter(), ...summaries.keys()]);
  const select = $("quarter");
  const selected = select.value || currentQuarter();
  select.replaceChildren(...[...quarters].sort().reverse().map((q) => new Option(quarterLabel(q), q)));
  select.value = quarters.has(selected) ? selected : currentQuarter();

  $("last-update").textContent = lastOk.data
    ? `Τελευταία ενημέρωση: ${dateTime.format(new Date(lastOk.data.finished_at))}`
    : "Δεν έχει γίνει ακόμη συγχρονισμός.";
  setNotice("warning", lastOk.data?.warning);
  setNotice("sync-error", last.data?.status === "error" ? `Αποτυχία συγχρονισμού: ${last.data.error}` : null);

  render();
}

function render({ animate = false } = {}) {
  const q = $("quarter").value;
  const s = summaries.get(q) ?? {};
  const credit = credits.get(q) ?? 0;
  const { kind, amount } = vatPosition({ outVat: s.out_vat, inVat: s.in_vat, credit });

  $("quarter-label").textContent = quarterLabel(q);
  $("result").className = `group hero ${kind}`;
  $("kind").textContent = kind === "debit" ? "Χρεωστικός" : "Πιστωτικός";
  $("amount").textContent = formatEur(amount);
  $("out-vat").textContent = formatEur(s.out_vat);
  $("in-vat").textContent = formatEur(s.in_vat);
  $("credit").textContent = formatEur(credit);

  const unclassified = Number(s.unclassified_vat || 0);
  setNotice("unclassified", unclassified > 0
    ? `Μη χαρακτηρισμένα έξοδα: ${formatEur(unclassified)} (δεν περιλαμβάνονται)`
    : null);

  if (animate && !prefersReducedMotion()) {
    $("amount").animate(
      [{ opacity: 0, transform: "translateY(6px) scale(0.98)" }, { opacity: 1, transform: "none" }],
      { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  }
}

// Refresh (nav button + pull to refresh) --------------------------------------
let refreshing = null;
function refresh() {
  refreshing ??= (async () => {
    $("refresh").classList.add("busy");
    $("refresh").disabled = true;
    const { error } = await sb.functions.invoke("sync-mydata", { method: "POST", body: {} });
    await load(); // sync errors are recorded in sync_log and shown by load()
    if (error && $("sync-error").hidden) setNotice("sync-error", `Αποτυχία ανανέωσης: ${error.message}`);
    $("refresh").classList.remove("busy");
    $("refresh").disabled = false;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
$("refresh").addEventListener("click", refresh);
pullToRefresh({
  content: $("content"),
  indicator: $("ptr"),
  onRefresh: refresh,
  enabled: () => !$("app").hidden && !sheet.isOpen,
});

// Large title → compact translucent nav bar once it scrolls away
new IntersectionObserver(([entry]) => {
  $("navbar").classList.toggle("scrolled", !entry.isIntersecting);
}, { rootMargin: "-44px 0px 0px 0px" }).observe($("large-title"));

$("quarter").addEventListener("change", () => render({ animate: true }));

// Carried-forward credit sheet ------------------------------------------------
const sheet = createSheet({
  sheet: $("sheet"),
  scrim: $("scrim"),
  handle: $("sheet-handle"),
  onClosed: () => $("credit-input").blur(),
});

function parseAmount(input) {
  let s = input.replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

$("edit-credit").addEventListener("click", () => {
  const q = $("quarter").value;
  const current = credits.get(q) ?? 0;
  $("credit-input").value = current ? current.toFixed(2).replace(".", ",") : "";
  $("sheet-note").textContent = `Πιστωτικό υπόλοιπο που μεταφέρεται στο ${quarterLabel(q)}.`;
  $("sheet-error").hidden = true;
  sheet.show();
  $("credit-input").focus(); // inside the tap, so iOS opens the keyboard
});
$("sheet-cancel").addEventListener("click", () => sheet.hide());

$("credit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = parseAmount($("credit-input").value);
  const showError = (msg) => { $("sheet-error").textContent = msg; $("sheet-error").hidden = false; };
  if (amount === null) return showError("Μη έγκυρο ποσό. Γράψε π.χ. 1.250,00");
  const q = $("quarter").value;
  $("sheet-save").disabled = true;
  const { error } = await sb.from("quarter_credit")
    .upsert({ quarter: q, amount, updated_at: new Date().toISOString() });
  $("sheet-save").disabled = false;
  if (error) return showError(`Σφάλμα αποθήκευσης: ${error.message}`);
  credits.set(q, amount);
  sheet.hide();
  render({ animate: true });
});

// Auth ------------------------------------------------------------------------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  $("login-btn").disabled = true;
  $("login-btn").textContent = "Σύνδεση…";
  const { error } = await sb.auth.signInWithPassword({
    email: form.get("email"), password: form.get("password"),
  });
  $("login-btn").disabled = false;
  $("login-btn").textContent = "Σύνδεση";
  $("login-error").textContent = "Λάθος email ή κωδικός.";
  $("login-error").hidden = !error;
});

$("logout").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  show(Boolean(session));
  if (session) setTimeout(load, 0); // don't await Supabase calls inside the callback
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
