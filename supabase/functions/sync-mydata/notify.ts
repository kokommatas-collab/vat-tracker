// Push notifications: VAPID keys (generated once, kept in the app_secret table that
// only the service role can read), sending to all saved subscriptions, and the
// messages for new documents and the VAT return deadline.

import { generateVapidKeys, sendPush, type VapidKeys } from "./webpush.ts";
import { athensToday, daysBetween, previousQuarter, quarterOfDate, vatDeadline } from "./dates.ts";
import type { VatEntry } from "./parse.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

const eur = new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" });
const money = (x: number) => eur.format(x);
const cents = (x: unknown) => Math.round(Number(x || 0) * 100);

export async function vapidKeys(db: Db): Promise<VapidKeys> {
  const read = async () => (await db.from("app_secret").select("value").eq("key", "vapid").maybeSingle()).data?.value;
  const existing = await read();
  if (existing) return existing as VapidKeys;
  const keys = await generateVapidKeys();
  const { error } = await db.from("app_secret").insert({ key: "vapid", value: keys });
  return error ? (await read()) as VapidKeys : keys; // lost a race → use the stored one
}

export interface Message {
  title: string;
  body: string;
  tag?: string;
}

export async function notifyAll(db: Db, message: Message): Promise<{ sent: number; removed: number }> {
  const { data: subs } = await db.from("push_subscriptions").select("endpoint, p256dh, auth");
  if (!subs?.length) return { sent: 0, removed: 0 };
  const keys = await vapidKeys(db);
  const subject = `mailto:${Deno.env.get("ALLOWED_EMAIL") ?? "noreply@example.com"}`;
  let sent = 0, removed = 0;
  for (const s of subs) {
    try {
      const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message, keys, subject);
      if (r.ok) sent++;
      else if (r.gone) {
        await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        removed++;
      }
    } catch (_) {
      // one broken subscription must not stop the others
    }
  }
  return { sent, removed };
}

function quarterBounds(quarter: string) {
  const [y, q] = quarter.split("-Q").map(Number);
  const start = `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** Same rule as the app: output − (input + unclassified) ± manual − carried credit. */
export async function quarterPosition(db: Db, quarter: string): Promise<{ kind: "debit" | "credit"; amount: number }> {
  const { start, end } = quarterBounds(quarter);
  const [vat, manual, credit] = await Promise.all([
    db.from("vat_entries").select("out_vat, in_vat, unclassified_vat").eq("is_cancelled", false)
      .gte("issue_date", start).lte("issue_date", end).range(0, 9999),
    db.from("manual_vat").select("kind, vat").gte("entry_date", start).lte("entry_date", end),
    db.from("quarter_credit").select("amount").eq("quarter", quarter).maybeSingle(),
  ]);
  let c = 0;
  for (const r of vat.data ?? []) c += cents(r.out_vat) - cents(r.in_vat) - cents(r.unclassified_vat);
  for (const r of manual.data ?? []) c += r.kind === "out" ? cents(r.vat) : -cents(r.vat);
  c -= cents(credit.data?.amount);
  return { kind: c > 0 ? "debit" : "credit", amount: Math.abs(c) / 100 };
}

const positionText = (p: { kind: string; amount: number }) =>
  `${p.kind === "debit" ? "Πληρωτέο" : "Πιστωτικό"} ${money(p.amount)}`;

export function quarterName(quarter: string): string {
  const [y, q] = quarter.split("-Q").map(Number);
  return `${q}ου τριμήνου ${y}`;
}

export function newDocsMessage(newRows: Omit<VatEntry, "has_negative">[], position: { kind: string; amount: number }): Message {
  const out = newRows.reduce((a, r) => a + cents(r.out_vat), 0) / 100;
  const inp = newRows.reduce((a, r) => a + cents(r.in_vat) + cents(r.unclassified_vat), 0) / 100;
  const parts = [];
  if (out) parts.push(`ΦΠΑ εσόδων ${money(out)}`);
  if (inp) parts.push(`ΦΠΑ εξόδων ${money(inp)}`);
  const n = newRows.length;
  return {
    title: n === 1 ? "Νέο παραστατικό στο myDATA" : `${n} νέα παραστατικά στο myDATA`,
    body: `${parts.length ? parts.join(", ") + ". " : ""}Θέση τριμήνου: ${positionText(position)}.`,
    tag: "new-docs",
  };
}

/** Deadline reminder for the previous quarter, 5 days before, 1 day before and on the day. */
export function deadlineReminder(today: string): { key: string; quarter: string; deadline: string; daysLeft: number } | null {
  const quarter = previousQuarter(quarterOfDate(today));
  const deadline = vatDeadline(quarter);
  const daysLeft = daysBetween(today, deadline);
  if (![5, 1, 0].includes(daysLeft)) return null;
  return { key: `deadline-${quarter}-${daysLeft}`, quarter, deadline, daysLeft };
}

export function deadlineMessage(r: { quarter: string; deadline: string; daysLeft: number }, position: { kind: string; amount: number }): Message {
  const [y, m, d] = r.deadline.split("-");
  const when = r.daysLeft === 0 ? "σήμερα" : r.daysLeft === 1 ? "αύριο" : `σε ${r.daysLeft} μέρες`;
  return {
    title: `Δήλωση ΦΠΑ ${quarterName(r.quarter)}: ${when}`,
    body: `Προθεσμία ${d}/${m}/${y}. Εκτίμηση: ${positionText(position)}.` +
      (position.kind === "credit" ? " Η δήλωση υποβάλλεται κανονικά." : ""),
    tag: `deadline-${r.quarter}`,
  };
}

/** Runs after a cron sync. Never throws. */
export async function cronNotifications(db: Db, newRows: Omit<VatEntry, "has_negative">[], hadPrevious: boolean) {
  const result: string[] = [];
  try {
    const today = athensToday();
    if (hadPrevious && newRows.length > 0) {
      const pos = await quarterPosition(db, quarterOfDate(today));
      const r = await notifyAll(db, newDocsMessage(newRows, pos));
      result.push(`new-docs sent=${r.sent}`);
    }
    const reminder = deadlineReminder(today);
    if (reminder) {
      const { error } = await db.from("notify_log").insert({ key: reminder.key }); // unique: once per reminder
      if (!error) {
        const pos = await quarterPosition(db, reminder.quarter);
        const r = await notifyAll(db, deadlineMessage(reminder, pos));
        result.push(`${reminder.key} sent=${r.sent}`);
      }
    }
  } catch (e) {
    result.push(`notify error: ${(e as Error).message}`);
  }
  return result;
}
