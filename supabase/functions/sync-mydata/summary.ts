import type { VatEntry } from "./parse.ts";

export interface SyncSummary {
  rows: Omit<VatEntry, "has_negative">[];
  negativeDocs: number;
  warning: string | null;
}

/**
 * De-duplicates by MARK (last one wins) and checks credit-note signs.
 * VatInfo has no invType, so credit notes can't be identified directly; we only
 * know whether any amounts came back negative. If none did, we warn instead of
 * guessing (positive credit notes would otherwise silently add to the totals).
 */
export function summarize(entries: VatEntry[]): SyncSummary {
  const byMark = new Map<string, VatEntry>();
  for (const e of entries) byMark.set(e.mark, e);
  const unique = [...byMark.values()];

  const negativeDocs = unique.filter((e) => e.has_negative).length;
  const warning = unique.length > 0 && negativeDocs === 0
    ? `Κανένα από τα ${unique.length} παραστατικά δεν είχε αρνητικά ποσά ΦΠΑ. ` +
      `Αν υπάρχουν πιστωτικά (5.x) στο διάστημα, ίσως μετρώνται ως θετικά — έλεγξέ τα.`
    : null;

  return {
    rows: unique.map(({ has_negative: _, ...row }) => row),
    negativeDocs,
    warning,
  };
}
