// Pure VAT position helpers (no DOM). Also imported by the Deno tests.

const cents = (x) => Math.round(Number(x || 0) * 100);

/** "YYYY-MM-DD" → "YYYY-Qn" */
export function quarterOf(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Current quarter in Europe/Athens time. */
export function currentQuarter(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(now);
  return quarterOf(today);
}

/** "2026-Q4" → "Οκτ–Δεκ 2026" */
export function quarterLabel(quarter) {
  const [y, q] = quarter.split("-Q").map(Number);
  const months = ["Ιαν–Μαρ", "Απρ–Ιουν", "Ιουλ–Σεπ", "Οκτ–Δεκ"];
  return `${q}ο τρίμηνο ${y} (${months[q - 1]})`;
}

/**
 * result = Σ output VAT − Σ input VAT − carried-forward credit.
 * > 0 → debit (to pay), ≤ 0 → credit. Unclassified VAT is NOT included.
 */
export function vatPosition({ outVat, inVat, credit }) {
  const result = cents(outVat) - cents(inVat) - cents(credit);
  return { kind: result > 0 ? "debit" : "credit", amount: Math.abs(result) / 100 };
}

const eur = new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" });
export const formatEur = (x) => eur.format(Number(x || 0));
