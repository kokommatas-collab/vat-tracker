// Parser for RequestDocs (documents other entities issued to me = my expenses).
// Used only to describe unclassified expense documents (who, which invoice, how much);
// the VAT figures themselves come from RequestVatInfo.

import { blocks, MyDataError, text, toCents, unwrap } from "./parse.ts";

export interface ReceivedDoc {
  mark: string;
  issuer_vat: string | null;
  issuer_name: string | null; // usually absent for Greek issuers
  series: string | null;
  aa: string | null;
  issue_date: string | null; // YYYY-MM-DD
  inv_type: string | null;
  net: number;
  vat: number;
  gross: number;
}

export interface DocsPage {
  docs: ReceivedDoc[];
  next: { partitionKey: string; rowKey: string } | null;
}

function parseInvoice(xml: string): ReceivedDoc | null {
  const mark = text(xml, "mark");
  if (!mark) return null;
  const issuer = blocks(xml, "issuer")[0] ?? "";
  const header = blocks(xml, "invoiceHeader")[0] ?? "";
  const summary = blocks(xml, "invoiceSummary")[0] ?? "";
  const date = text(header, "issueDate");
  return {
    mark,
    issuer_vat: text(issuer, "vatNumber"),
    issuer_name: text(issuer, "name"),
    series: text(header, "series"),
    aa: text(header, "aa"),
    issue_date: date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
    inv_type: text(header, "invoiceType"),
    net: toCents(text(summary, "totalNetValue")) / 100,
    vat: toCents(text(summary, "totalVatAmount")) / 100,
    gross: toCents(text(summary, "totalGrossValue")) / 100,
  };
}

/** Throws MyDataError on an error response or an unexpected shape. */
export function parseDocs(body: string): DocsPage {
  const xml = unwrap(body);
  const errors = blocks(xml, "error");
  if (errors.length > 0) {
    const msgs = errors.map((e) => `[${text(e, "code") ?? "?"}] ${text(e, "message") ?? ""}`.trim());
    throw new MyDataError(`myDATA RequestDocs: ${msgs.join("; ")}`);
  }
  if (!/<(?:[\w-]+:)?RequestedDoc[\s>/]/.test(xml)) {
    throw new MyDataError(`Απρόσμενη απάντηση RequestDocs: ${xml.slice(0, 200)}`);
  }
  const docs = blocks(xml, "invoice").map(parseInvoice).filter((d): d is ReceivedDoc => d !== null);
  const token = blocks(xml, "continuationToken")[0];
  const partitionKey = token ? text(token, "nextPartitionKey") : null;
  const rowKey = token ? text(token, "nextRowKey") : null;
  return { docs, next: partitionKey && rowKey ? { partitionKey, rowKey } : null };
}
