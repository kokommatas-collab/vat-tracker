import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import { currentQuarter, formatEur, quarterLabel, vatPosition } from "./calc.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const dateTime = new Intl.DateTimeFormat("el-GR", {
  dateStyle: "short", timeStyle: "short", timeZone: "Europe/Athens",
});

let summaries = new Map(); // quarter → row of quarter_summary
let credits = new Map();   // quarter → carried-forward credit

function show(loggedIn) {
  $("login").hidden = loggedIn;
  $("app").hidden = !loggedIn;
}

function setText(id, text, visible = true) {
  $(id).textContent = text;
  $(id).hidden = !visible;
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
  if (failed) {
    setText("sync-error", `Σφάλμα φόρτωσης: ${failed.error.message}`);
    return;
  }

  summaries = new Map(sum.data.map((r) => [r.quarter, r]));
  credits = new Map(cred.data.map((r) => [r.quarter, Number(r.amount)]));

  const quarters = new Set([currentQuarter(), ...summaries.keys()]);
  const select = $("quarter");
  const selected = select.value || currentQuarter();
  select.replaceChildren(...[...quarters].sort().reverse().map((q) => new Option(quarterLabel(q), q)));
  select.value = quarters.has(selected) ? selected : currentQuarter();

  setText("last-update", lastOk.data
    ? `Τελευταία ενημέρωση: ${dateTime.format(new Date(lastOk.data.finished_at))}`
    : "Δεν έχει γίνει ακόμη συγχρονισμός");
  setText("warning", lastOk.data?.warning ?? "", Boolean(lastOk.data?.warning));
  const err = last.data?.status === "error" ? last.data.error : null;
  setText("sync-error", `Αποτυχία συγχρονισμού: ${err}`, Boolean(err));

  render();
}

function render() {
  const q = $("quarter").value;
  const s = summaries.get(q) ?? {};
  const credit = credits.get(q) ?? 0;
  const { kind, amount } = vatPosition({ outVat: s.out_vat, inVat: s.in_vat, credit });

  $("result").className = `card ${kind}`;
  $("kind").textContent = kind === "debit" ? "Χρεωστικός" : "Πιστωτικός";
  $("amount").textContent = formatEur(amount);
  $("out-vat").textContent = formatEur(s.out_vat);
  $("in-vat").textContent = formatEur(s.in_vat);
  $("credit").textContent = formatEur(credit);

  const unclassified = Number(s.unclassified_vat || 0);
  setText("unclassified", `Μη χαρακτηρισμένα έξοδα: ${formatEur(unclassified)} (δεν περιλαμβάνονται)`,
    unclassified > 0);
}

function parseAmount(input) {
  let s = input.replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

$("edit-credit").addEventListener("click", async () => {
  const q = $("quarter").value;
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

$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.disabled = true;
  btn.textContent = "Συγχρονισμός…";
  const { error } = await sb.functions.invoke("sync-mydata", { method: "POST", body: {} });
  await load(); // sync errors are recorded in sync_log and shown by load()
  if (error && $("sync-error").hidden) setText("sync-error", `Αποτυχία ανανέωσης: ${error.message}`);
  btn.disabled = false;
  btn.textContent = "Ανανέωση";
});

$("quarter").addEventListener("change", render);

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const { error } = await sb.auth.signInWithPassword({
    email: form.get("email"), password: form.get("password"),
  });
  setText("login-error", "Λάθος στοιχεία σύνδεσης", Boolean(error));
});

$("logout").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  show(Boolean(session));
  if (session) setTimeout(load, 0); // don't await Supabase calls inside the callback
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
