// Pure VAT position helpers (no DOM). Also imported by the Deno tests.

const cents = (x) => Math.round(Number(x || 0) * 100);

/** "YYYY-MM-DD" → "YYYY-Qn" */
export function quarterOf(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** "YYYY-MM-DD" → "YYYY-MM" */
export const monthOf = (isoDate) => isoDate.slice(0, 7);

/** Current quarter in Europe/Athens time. */
export function currentQuarter(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(now);
  return quarterOf(today);
}

/** "2026-Q4" → "4ο τρίμηνο 2026 (Οκτ–Δεκ)" */
export function quarterLabel(quarter) {
  const [y, q] = quarter.split("-Q").map(Number);
  const months = ["Ιαν–Μαρ", "Απρ–Ιουν", "Ιουλ–Σεπ", "Οκτ–Δεκ"];
  return `${q}ο τρίμηνο ${y} (${months[q - 1]})`;
}

/** "2026-Q4" → "4ο τρίμηνο 2026" */
export function quarterShort(quarter) {
  const [y, q] = quarter.split("-Q").map(Number);
  return `${q}ο τρίμηνο ${y}`;
}

/** "2026-Q3" → { from: "01/07/2026", to: "30/09/2026" } */
export function quarterRange(quarter) {
  const [y, q] = quarter.split("-Q").map(Number);
  const startM = (q - 1) * 3 + 1;
  const endM = startM + 2;
  const lastDay = new Date(Date.UTC(y, endM, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, "0");
  return { from: `01/${p(startM)}/${y}`, to: `${p(lastDay)}/${p(endM)}/${y}` };
}

const MONTHS = ["Ιανουάριος", "Φεβρουάριος", "Μάρτιος", "Απρίλιος", "Μάιος", "Ιούνιος",
  "Ιούλιος", "Αύγουστος", "Σεπτέμβριος", "Οκτώβριος", "Νοέμβριος", "Δεκέμβριος"];

/** "2026-10" → "Οκτώβριος 2026" */
export function monthLabel(month) {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Months of a quarter: "2026-Q4" → ["2026-10", "2026-11", "2026-12"] */
export function quarterMonths(quarter) {
  const [y, q] = quarter.split("-Q").map(Number);
  return [0, 1, 2].map((i) => `${y}-${String((q - 1) * 3 + 1 + i).padStart(2, "0")}`);
}

const FIELDS = ["out_vat", "in_vat", "unclassified_vat", "out_net", "in_net", "unclassified_net"];

function emptyTotals() {
  return Object.fromEntries([...FIELDS.map((f) => [f, 0]), ["docs", 0]]);
}

/**
 * Sums vat_entries rows (cancelled excluded) by key ("quarter" or "month").
 * Works in cents to avoid float drift. Returns Map<key, totals in €>.
 */
export function aggregate(rows, by = "quarter") {
  const keyOf = by === "month" ? monthOf : quarterOf;
  const acc = new Map();
  for (const r of rows) {
    if (r.is_cancelled) continue;
    const key = keyOf(r.issue_date);
    if (!acc.has(key)) acc.set(key, emptyTotals());
    const t = acc.get(key);
    for (const f of FIELDS) t[f] += cents(r[f]);
    t.docs += 1;
  }
  for (const t of acc.values()) for (const f of FIELDS) t[f] /= 100;
  return acc;
}

/**
 * result = Σ output VAT − (Σ classified input VAT + Σ unclassified input VAT) − carried-forward credit.
 * Unclassified expenses (VatUnclassified381) count as deductible, like myDATA's
 * own estimate: they are input VAT waiting to be characterised.
 * > 0 → debit (to pay), ≤ 0 → credit.
 * @param {{ outVat?: number|null, inVat?: number|null, unclassifiedVat?: number|null, credit?: number|null }} p
 */
export function vatPosition({ outVat, inVat, unclassifiedVat = 0, credit = 0 }) {
  const result = cents(outVat) - cents(inVat) - cents(unclassifiedVat) - cents(credit);
  return { kind: result > 0 ? "debit" : "credit", amount: Math.abs(result) / 100 };
}

const eur = new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" });
export const formatEur = (x) => eur.format(Number(x || 0));
