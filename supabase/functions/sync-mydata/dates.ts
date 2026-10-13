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
