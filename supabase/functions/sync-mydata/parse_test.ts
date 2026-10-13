import assert from "node:assert/strict";
import { MyDataError, parseVatInfo } from "./parse.ts";
import { fetchVatInfo } from "./mydata.ts";
import { summarize } from "./summary.ts";

const doc = (inner: string, token = "") =>
  `<?xml version="1.0" encoding="utf-8"?>
<RequestedVatInfo xmlns="http://www.aade.gr/myDATA/invoice/v1.0">${token}${inner}</RequestedVatInfo>`;

const SALE = `<VatInfo><Mark>400001</Mark><IsCancelled>false</IsCancelled>
  <IssueDate>2026-10-01T00:00:00</IssueDate><Vat301>100.00</Vat301><Vat331>24.00</Vat331>
  <Vat332>1.30</Vat332></VatInfo>`;
const PURCHASE = `<VatInfo><Mark>400002</Mark><IssueDate>2026-10-02T00:00:00</IssueDate>
  <Vat361>50</Vat361><Vat381>12.00</Vat381><VatUnclassified381>3.10</VatUnclassified381></VatInfo>`;
const CREDIT_NOTE = `<VatInfo><Mark>400003</Mark><IssueDate>2026-10-03T00:00:00</IssueDate>
  <Vat301>-10.00</Vat301><Vat331>-2.40</Vat331></VatInfo>`;

Deno.test("parses output, input and unclassified VAT", () => {
  const { entries, next } = parseVatInfo(doc(SALE + PURCHASE));
  assert.equal(next, null);
  assert.deepEqual(entries[0], {
    mark: "400001", issue_date: "2026-10-01", is_cancelled: false,
    out_vat: 25.3, in_vat: 0, unclassified_vat: 0,
    out_net: 100, in_net: 0, unclassified_net: 0, has_negative: false,
  });
  assert.equal(entries[1].in_vat, 12);
  assert.equal(entries[1].unclassified_vat, 3.1);
  assert.equal(entries[1].in_net, 50);
  assert.equal(entries[1].out_vat, 0); // missing optional fields → 0
});

Deno.test("negative-amount document (credit note) keeps its sign", () => {
  const [e] = parseVatInfo(doc(CREDIT_NOTE)).entries;
  assert.equal(e.out_vat, -2.4);
  assert.equal(e.has_negative, true);
});

Deno.test("unwraps the escaped .NET <string> envelope returned by prod", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">${
    esc(doc(SALE + PURCHASE))
  }</string>`;
  const { entries } = parseVatInfo(body);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].out_vat, 25.3);
  assert.equal(entries[1].in_vat, 12);
  const empty = `<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">${esc(doc(""))}</string>`;
  assert.deepEqual(parseVatInfo(empty).entries, []);
});

Deno.test("cancelled flag", () => {
  const xml = doc(SALE.replace("<IsCancelled>false", "<IsCancelled>true"));
  assert.equal(parseVatInfo(xml).entries[0].is_cancelled, true);
});

Deno.test("namespace prefixes are tolerated", () => {
  const xml = `<ns:RequestedVatInfo xmlns:ns="x"><ns:VatInfo><ns:Mark>9</ns:Mark>
    <ns:IssueDate>2026-01-05T00:00:00</ns:IssueDate><ns:Vat381>1.5</ns:Vat381></ns:VatInfo></ns:RequestedVatInfo>`;
  assert.equal(parseVatInfo(xml).entries[0].in_vat, 1.5);
});

Deno.test("reads continuationToken", () => {
  const token = `<continuationToken><nextPartitionKey>P1</nextPartitionKey><nextRowKey>R1</nextRowKey></continuationToken>`;
  assert.deepEqual(parseVatInfo(doc(SALE, token)).next, { partitionKey: "P1", rowKey: "R1" });
});

Deno.test("empty result", () => {
  assert.deepEqual(parseVatInfo(doc("")).entries, []);
});

Deno.test("error response throws with code and message", () => {
  const xml = `<ResponseDoc><response><statusCode>ValidationError</statusCode><errors>
    <error><message>Vat number 123 does not belong to active corporation</message><code>102</code></error>
    </errors></response></ResponseDoc>`;
  assert.throws(() => parseVatInfo(xml), (e: Error) => e instanceof MyDataError && e.message.includes("[102]"));
});

Deno.test("unexpected shapes fail loudly instead of returning zero", () => {
  assert.throws(() => parseVatInfo("<html>Service down</html>"), MyDataError);
  assert.throws(
    () => parseVatInfo(doc("<Item><Mark>1</Mark><IssueDate>2026-01-01</IssueDate></Item>")),
    MyDataError,
  );
  assert.throws(() => parseVatInfo(doc("<VatInfo><IssueDate>2026-01-01</IssueDate></VatInfo>")), MyDataError);
});

Deno.test("summarize: dedupes by mark and warns when no negatives were seen", () => {
  const entries = parseVatInfo(doc(SALE + SALE + PURCHASE)).entries;
  const s = summarize(entries);
  assert.equal(s.rows.length, 2);
  assert.equal(s.negativeDocs, 0);
  assert.match(s.warning!, /πιστωτικά/);
  assert.equal("has_negative" in s.rows[0], false);
});

Deno.test("summarize: no warning once a negative document is seen", () => {
  const s = summarize(parseVatInfo(doc(SALE + CREDIT_NOTE)).entries);
  assert.equal(s.negativeDocs, 1);
  assert.equal(s.warning, null);
});

Deno.test("fetchVatInfo follows pagination and sends auth headers + dd/MM/yyyy dates", async () => {
  const urls: string[] = [];
  const pages = [
    doc(SALE, `<continuationToken><nextPartitionKey>P1</nextPartitionKey><nextRowKey>R1</nextRowKey></continuationToken>`),
    doc(PURCHASE),
  ];
  const fakeFetch = ((url: string, init: RequestInit) => {
    urls.push(url);
    const h = init.headers as Record<string, string>;
    assert.equal(h["aade-user-id"], "u");
    assert.equal(h["ocp-apim-subscription-key"], "k");
    return Promise.resolve(new Response(pages[urls.length - 1]));
  }) as typeof fetch;

  const entries = await fetchVatInfo({ baseUrl: "https://x", userId: "u", subscriptionKey: "k" },
    "2026-07-01", "2026-10-13", fakeFetch);
  assert.equal(entries.length, 2);
  const first = new URL(urls[0]).searchParams;
  assert.equal(first.get("dateFrom"), "01/07/2026");
  assert.equal(first.get("dateTo"), "13/10/2026");
  assert.equal(first.get("GroupedPerDay"), "false");
  assert.equal(new URL(urls[1]).searchParams.get("nextPartitionKey"), "P1");
  assert.equal(new URL(urls[1]).searchParams.get("nextRowKey"), "R1");
});

Deno.test("fetchVatInfo retries 5xx, but not 401", async () => {
  let calls = 0;
  const flaky = (() => {
    calls++;
    return Promise.resolve(calls < 3 ? new Response("busy", { status: 503 }) : new Response(doc(SALE)));
  }) as typeof fetch;
  const cfg = { baseUrl: "https://x", userId: "u", subscriptionKey: "k" };
  const noSleep = () => Promise.resolve();
  assert.equal((await fetchVatInfo(cfg, "2026-10-01", "2026-10-13", flaky, noSleep)).length, 1);
  assert.equal(calls, 3);

  calls = 0;
  const denied = (() => (calls++, Promise.resolve(new Response("no", { status: 401 })))) as typeof fetch;
  await assert.rejects(fetchVatInfo(cfg, "2026-10-01", "2026-10-13", denied, noSleep), MyDataError);
  assert.equal(calls, 1);
});

Deno.test("summarize: credit-note warning is raised at most once", () => {
  const entries = parseVatInfo(doc(SALE + PURCHASE)).entries;
  assert.notEqual(summarize(entries, false).warning, null);
  assert.equal(summarize(entries, true).warning, null);
});
