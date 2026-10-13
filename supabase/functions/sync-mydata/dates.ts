// Date helpers for the sync window. Dates are plain "YYYY-MM-DD" strings in
// Europe/Athens local time, so no timezone drift at quarter boundaries.

export function athensToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(now);
}

/** First day of the quarter before the one containing `isoDate`. */
export function previousQuarterStart(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  const q = Math.floor((m - 1) / 3); // 0..3
  const prevQ = (q + 3) % 4;
  const year = q === 0 ? y - 1 : y;
  return `${year}-${String(prevQ * 3 + 1).padStart(2, "0")}-01`;
}

/** "YYYY-MM-DD" → "dd/MM/yyyy" as required by RequestVatInfo. */
export function toMyDataDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Sync window: 1 January of the year the previous quarter belongs to, through
 * today. Covers late transmissions for the previous quarter and keeps the
 * whole year's history (all quarters of the year) up to date.
 */
export function syncWindow(now: Date = new Date()): { from: string; to: string } {
  const to = athensToday(now);
  return { from: `${previousQuarterStart(to).slice(0, 4)}-01-01`, to };
}

/** "YYYY-MM-DD" → "YYYY-Qn" */
export function quarterOfDate(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Quarter before "YYYY-Qn". */
export function previousQuarter(quarter: string): string {
  const [y, q] = quarter.split("-Q").map(Number);
  return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
}

/**
 * Filing/payment deadline of the quarterly VAT return (Φ2) for "YYYY-Qn":
 * last working day (Mon–Fri) of the month after the quarter. Public holidays
 * are not taken into account. Must match deadlineOf() in docs/calc.js.
 */
export function vatDeadline(quarter: string): string {
  const [y, q] = quarter.split("-Q").map(Number);
  const month = q * 3 + 1; // 1-based month after the quarter (13 → January next year)
  const year = month > 12 ? y + 1 : y;
  const m = month > 12 ? 1 : month;
  const d = new Date(Date.UTC(year, m, 0)); // last day of month m
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` ("YYYY-MM-DD"). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
