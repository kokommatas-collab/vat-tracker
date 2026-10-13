import assert from "node:assert/strict";
import { currentQuarter, formatEur, quarterLabel, quarterOf, vatPosition } from "../../../docs/calc.js";
import { previousQuarterStart, syncWindow, toMyDataDate } from "./dates.ts";

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
  assert.deepEqual(syncWindow(new Date("2026-12-31T22:30:00Z")), { from: "2026-10-01", to: "2027-01-01" });
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
