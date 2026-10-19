import assert from "node:assert/strict";
import {
  aggregate, currentQuarter, formatEur, monthLabel, quarterLabel, quarterMonths, quarterOf, quarterRange, vatPosition,
} from "../../../docs/calc.js";
import { previousQuarterStart, syncWindow, toMyDataDate, vatDeadline } from "./dates.ts";
import { deadlineOf, manualAsEntry, previousQuarterOf } from "../../../docs/calc.js";

Deno.test("quarter boundaries", () => {
  assert.equal(quarterOf("2026-03-31"), "2026-Q1");
  assert.equal(quarterOf("2026-04-01"), "2026-Q2");
  assert.equal(quarterOf("2026-09-30"), "2026-Q3");
  assert.equal(quarterOf("2026-10-01"), "2026-Q4");
  assert.equal(quarterOf("2026-12-31"), "2026-Q4");
});

Deno.test("current quarter uses Athens time (UTC 31/12 22:30 is already 1/1)", () => {
  assert.equal(currentQuarter(new Date("2026-12-31T22:30:00Z")), "2027-Q1");
  assert.equal(currentQuarter(new Date("2026-03-31T20:00:00Z")), "2026-Q1"); // 23:00 EEST
});

Deno.test("sync window: previous quarter start → today, incl. year rollover", () => {
  assert.equal(previousQuarterStart("2026-10-13"), "2026-07-01");
  assert.equal(previousQuarterStart("2026-04-01"), "2026-01-01");
  assert.equal(previousQuarterStart("2026-02-15"), "2025-10-01");
  assert.deepEqual(syncWindow(new Date("2026-12-31T22:30:00Z")), { from: "2026-01-01", to: "2027-01-01" });
  assert.deepEqual(syncWindow(new Date("2026-10-14T09:00:00Z")), { from: "2026-01-01", to: "2026-10-14" });
  assert.deepEqual(syncWindow(new Date("2027-02-10T09:00:00Z")), { from: "2026-01-01", to: "2027-02-10" });
  assert.equal(toMyDataDate("2026-01-05"), "05/01/2026");
});

Deno.test("debit: output > input + credit", () => {
  assert.deepEqual(vatPosition({ outVat: 2400, inVat: 900.5, credit: 100 }), { kind: "debit", amount: 1399.5 });
});

Deno.test("credit: input + carried credit exceed output", () => {
  assert.deepEqual(vatPosition({ outVat: 500, inVat: 400, credit: 300 }), { kind: "credit", amount: 200 });
});

Deno.test("exactly zero is shown as credit 0", () => {
  assert.deepEqual(vatPosition({ outVat: 100, inVat: 100, credit: 0 }), { kind: "credit", amount: 0 });
});

Deno.test("no float drift on cents; nulls from DB treated as 0", () => {
  assert.deepEqual(vatPosition({ outVat: 0.3, inVat: 0.1, credit: 0.1 }), { kind: "debit", amount: 0.1 });
  assert.deepEqual(vatPosition({ outVat: null, inVat: undefined, credit: null }), { kind: "credit", amount: 0 });
});

Deno.test("credit notes with negative output VAT reduce the total", () => {
  // invoice 24.00 + credit note -2.40 summed in quarter_summary → 21.60
  assert.deepEqual(vatPosition({ outVat: 24 - 2.4, inVat: 0, credit: 0 }), { kind: "debit", amount: 21.6 });
});

Deno.test("labels and € formatting", () => {
  assert.equal(quarterLabel("2026-Q4"), "4ο τρίμηνο 2026 (Οκτ–Δεκ)");
  assert.match(formatEur(1234.5), /1\.234,50\s€/);
});

Deno.test("unclassified input VAT is deductible (matches myDATA estimate)", () => {
  // Real Q4 2026 figures: 1848.00 output, 138.88 unclassified input → 1709.12 debit
  assert.deepEqual(vatPosition({ outVat: 1848, inVat: 0, unclassifiedVat: 138.88 }), { kind: "debit", amount: 1709.12 });
  // Real Q3 2026: 3810.57 − 293.33 − 491.02 = 3026.22
  assert.deepEqual(vatPosition({ outVat: 3810.57, inVat: 293.33, unclassifiedVat: 491.02 }), { kind: "debit", amount: 3026.22 });
});

Deno.test("aggregate by quarter and month, cancelled excluded, cents-exact", () => {
  const rows = [
    { issue_date: "2026-10-02", is_cancelled: false, out_vat: 0.1, in_vat: 0, unclassified_vat: 0, out_net: 0.42, in_net: 0, unclassified_net: 0 },
    { issue_date: "2026-10-30", is_cancelled: false, out_vat: 0.2, in_vat: 0, unclassified_vat: 1, out_net: 0.83, in_net: 0, unclassified_net: 4.17 },
    { issue_date: "2026-11-01", is_cancelled: true, out_vat: 100, in_vat: 0, unclassified_vat: 0, out_net: 0, in_net: 0, unclassified_net: 0 },
    { issue_date: "2026-09-30", is_cancelled: false, out_vat: 24, in_vat: 5, unclassified_vat: 0, out_net: 100, in_net: 20.83, unclassified_net: null },
  ];
  const q = aggregate(rows);
  assert.equal(q.get("2026-Q4").out_vat, 0.3);
  assert.equal(q.get("2026-Q4").out_net, 1.25);
  assert.equal(q.get("2026-Q4").docs, 2);
  assert.equal(q.get("2026-Q3").in_net, 20.83);
  const m = aggregate(rows, "month");
  assert.deepEqual([...m.keys()].sort(), ["2026-09", "2026-10"]);
});

Deno.test("month and quarter labels/ranges", () => {
  assert.equal(monthLabel("2026-10"), "Οκτώβριος 2026");
  assert.deepEqual(quarterMonths("2026-Q4"), ["2026-10", "2026-11", "2026-12"]);
  assert.deepEqual(quarterRange("2026-Q3"), { from: "01/07/2026", to: "30/09/2026" });
  assert.deepEqual(quarterRange("2024-Q1"), { from: "01/01/2024", to: "31/03/2024" });
});

Deno.test("frontend deadline matches the function's deadline for every quarter 2024–2032", () => {
  for (let y = 2024; y <= 2032; y++) {
    for (let q = 1; q <= 4; q++) assert.equal(deadlineOf(`${y}-Q${q}`), vatDeadline(`${y}-Q${q}`));
  }
  assert.equal(previousQuarterOf("2027-Q1"), "2026-Q4");
});

Deno.test("manual VAT entries are summed with myDATA documents", () => {
  const rows = [
    { issue_date: "2026-10-02", is_cancelled: false, out_vat: 100, in_vat: 0, unclassified_vat: 0, out_net: 416.67, in_net: 0, unclassified_net: 0 },
    manualAsEntry({ entry_date: "2026-10-20", kind: "in", vat: 40, net: 166.67 }),
    manualAsEntry({ entry_date: "2026-11-02", kind: "out", vat: 5, net: 0 }),
  ];
  const t = aggregate(rows).get("2026-Q4");
  assert.equal(t.out_vat, 105);
  assert.equal(t.in_vat, 40);
  assert.deepEqual(vatPosition({ outVat: t.out_vat, inVat: t.in_vat, unclassifiedVat: t.unclassified_vat }), { kind: "debit", amount: 65 });
});

Deno.test("groupByMonth: newest month first, sorted rows, cents-exact totals", async () => {
  const { groupByMonth } = await import("../../../docs/calc.js");
  const rows = [
    { issue_date: "2026-10-11", unclassified_vat: 0.1 },
    { issue_date: "2026-11-02", unclassified_vat: 52.08 },
    { issue_date: "2026-10-30", unclassified_vat: 0.2 },
  ];
  const g = groupByMonth(rows, "issue_date", "unclassified_vat");
  assert.deepEqual(g.map((x) => x.month), ["2026-11", "2026-10"]);
  assert.equal(g[1].total, 0.3);
  assert.deepEqual(g[1].items.map((r: { issue_date: string }) => r.issue_date), ["2026-10-30", "2026-10-11"]);
  assert.deepEqual(groupByMonth([], "issue_date", "unclassified_vat"), []);
});
