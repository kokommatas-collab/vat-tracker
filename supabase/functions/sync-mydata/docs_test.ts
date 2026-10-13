import assert from "node:assert/strict";
import { parseDocs } from "./docs.ts";
import { daysBetween, previousQuarter, vatDeadline } from "./dates.ts";
import { deadlineMessage, deadlineReminder, newDocsMessage } from "./notify.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const INVOICE = (mark: string, extra = "") => `<invoice><uid>U${mark}</uid><mark>${mark}</mark>
  <issuer><vatNumber>094014201</vatNumber><country>GR</country><branch>0</branch>${extra}</issuer>
  <counterpart><vatNumber>159091959</vatNumber><country>GR</country><branch>0</branch></counterpart>
  <invoiceHeader><series>Α</series><aa>1234</aa><issueDate>2026-10-08</issueDate><invoiceType>1.1</invoiceType><currency>EUR</currency></invoiceHeader>
  <invoiceDetails><lineNumber>1</lineNumber><netValue>583.06</netValue><vatCategory>1</vatCategory><vatAmount>138.88</vatAmount></invoiceDetails>
  <invoiceSummary><totalNetValue>583.06</totalNetValue><totalVatAmount>138.88</totalVatAmount><totalWithheldAmount>0</totalWithheldAmount><totalGrossValue>721.94</totalGrossValue></invoiceSummary>
</invoice>`;
const DOC = (inner: string, token = "") =>
  `<?xml version="1.0" encoding="utf-8"?><RequestedDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0">${token}<invoicesDoc>${inner}</invoicesDoc></RequestedDoc>`;

Deno.test("RequestDocs: parses issuer, invoice number and totals (escaped envelope)", () => {
  const body = `<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">${esc(DOC(INVOICE("400001234567") + INVOICE("400001234568", "<name>ΔΕΗ Α.Ε.</name>")))}</string>`;
  const { docs, next } = parseDocs(body);
  assert.equal(next, null);
  assert.equal(docs.length, 2);
  assert.deepEqual(docs[0], {
    mark: "400001234567", issuer_vat: "094014201", issuer_name: null, series: "Α", aa: "1234",
    issue_date: "2026-10-08", inv_type: "1.1", net: 583.06, vat: 138.88, gross: 721.94,
  });
  assert.equal(docs[1].issuer_name, "ΔΕΗ Α.Ε.");
});

Deno.test("RequestDocs: continuation token, empty result and errors", () => {
  const token = "<continuationToken><nextPartitionKey>P</nextPartitionKey><nextRowKey>R</nextRowKey></continuationToken>";
  assert.deepEqual(parseDocs(DOC(INVOICE("1"), token)).next, { partitionKey: "P", rowKey: "R" });
  assert.deepEqual(parseDocs(DOC("")).docs, []);
  assert.throws(() => parseDocs("<RequestedDoc><error><code>101</code><message>bad</message></error></RequestedDoc>"), /\[101\] bad/);
  assert.throws(() => parseDocs("<html>oops</html>"), /Απρόσμενη απάντηση RequestDocs/);
});

Deno.test("VAT deadline: last working day of the month after the quarter", () => {
  assert.equal(vatDeadline("2026-Q3"), "2026-10-30"); // 31/10/2026 is a Saturday
  assert.equal(vatDeadline("2026-Q2"), "2026-07-31");
  assert.equal(vatDeadline("2026-Q4"), "2027-01-29"); // 31/01/2027 is a Sunday
  assert.equal(vatDeadline("2027-Q1"), "2027-04-30");
  assert.equal(previousQuarter("2027-Q1"), "2026-Q4");
  assert.equal(daysBetween("2026-10-14", "2026-10-30"), 16);
});

Deno.test("deadline reminders fire 5 days before, the day before and on the day", () => {
  assert.equal(deadlineReminder("2026-10-14"), null);
  assert.deepEqual(deadlineReminder("2026-10-25"), { key: "deadline-2026-Q3-5", quarter: "2026-Q3", deadline: "2026-10-30", daysLeft: 5 });
  assert.equal(deadlineReminder("2026-10-29")?.daysLeft, 1);
  assert.equal(deadlineReminder("2026-10-30")?.daysLeft, 0);
  const m = deadlineMessage({ quarter: "2026-Q3", deadline: "2026-10-30", daysLeft: 5 }, { kind: "debit", amount: 3026.22 });
  assert.match(m.title, /3ου τριμήνου 2026: σε 5 μέρες/);
  assert.match(m.body, /30\/10\/2026.*Πληρωτέο 3\.026,22\s€/);
});

Deno.test("new documents message", () => {
  const row = (o: number, i: number, u: number) => ({
    mark: "x", issue_date: "2026-10-10", is_cancelled: false, out_vat: o, in_vat: i, unclassified_vat: u,
    out_net: 0, in_net: 0, unclassified_net: 0,
  });
  const m = newDocsMessage([row(240, 0, 0), row(0, 0, 13.8)], { kind: "debit", amount: 1935.32 });
  assert.equal(m.title, "2 νέα παραστατικά στο myDATA");
  assert.match(m.body, /ΦΠΑ εσόδων 240,00\s€, ΦΠΑ εξόδων 13,80\s€\. Θέση τριμήνου: Πληρωτέο 1\.935,32\s€\./);
});
