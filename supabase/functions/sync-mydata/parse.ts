// Parser for the RequestVatInfo response (myDATA API v2.0.2, §6.4).
// The structure is flat (RequestedVatInfo > VatInfo* > scalar fields), so a
// small namespace-tolerant tag reader is enough; no XML dependency needed.

export const OUTPUT_FIELDS = ["Vat331", "Vat332", "Vat333", "Vat334", "Vat335", "Vat336"];
export const INPUT_FIELDS = ["Vat381", "Vat382", "Vat383", "Vat384", "Vat385", "Vat386"];
export const UNCLASSIFIED_FIELD = "VatUnclassified381";
export const OUTPUT_NET_FIELDS = ["Vat301", "Vat302", "Vat303", "Vat304", "Vat305", "Vat306"];
export const INPUT_NET_FIELDS = ["Vat361", "Vat362", "Vat363", "Vat364", "Vat365", "Vat366"];
export const UNCLASSIFIED_NET_FIELD = "VatUnclassified361";

export interface VatEntry {
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

export interface VatInfoPage {
  entries: VatEntry[];
  next: { partitionKey: string; rowKey: string } | null;
}

export class MyDataError extends Error {}

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
export function parseVatInfo(body: string): VatInfoPage {
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
