// sync-mydata: pulls RequestVatInfo for the previous + current quarter and
// upserts into vat_entries. Called by pg_cron (x-cron-secret) or the logged-in
// user ("Ανανέωση" button, Supabase JWT). Deployed with verify_jwt = false
// because auth is checked here for both callers.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchReceivedDocs, fetchVatInfo, PROD_BASE_URL } from "./mydata.ts";
import { syncWindow } from "./dates.ts";
import { summarize } from "./summary.ts";
import { cronNotifications, notifyAll, vapidKeys } from "./notify.ts";

const env = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function authorize(req: Request): Promise<"cron" | "manual" | null> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    // The secret lives only in Supabase Vault (see setup.sql).
    const { data, error } = await db.rpc("check_cron_secret", { secret: cronSecret });
    return !error && data === true ? "cron" : null;
  }

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const allowed = Deno.env.get("ALLOWED_EMAIL");
  if (allowed && data.user.email?.toLowerCase() !== allowed.toLowerCase()) return null;
  return "manual";
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch (_) {
    return {};
  }
}

/** Push-notification actions from the app (logged-in user only). */
async function pushAction(action: string, body: Record<string, unknown>) {
  if (action === "vapid-public-key") {
    return json({ publicKey: (await vapidKeys(db)).publicKey });
  }
  if (action === "subscribe") {
    const sub = body.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "Bad subscription" }, 400);
    const { error } = await db.from("push_subscriptions").upsert({
      endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
      user_agent: String(body.userAgent ?? "").slice(0, 300),
    }, { onConflict: "endpoint" });
    return error ? json({ error: error.message }, 500) : json({ status: "ok" });
  }
  if (action === "unsubscribe") {
    await db.from("push_subscriptions").delete().eq("endpoint", String(body.endpoint ?? ""));
    return json({ status: "ok" });
  }
  if (action === "test-push") {
    const r = await notifyAll(db, {
      title: "Ισοζύγιο ΦΠΑ",
      body: "Οι ειδοποιήσεις λειτουργούν. Θα ενημερώνεσαι για νέα παραστατικά και για την προθεσμία της δήλωσης.",
      tag: "test",
    });
    return json({ status: "ok", ...r });
  }
  return json({ error: `Unknown action ${action}` }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const trigger = await authorize(req);
  if (!trigger) return json({ error: "Unauthorized" }, 401);

  const body = await readBody(req);
  const action = typeof body.action === "string" ? body.action : "sync";
  if (action !== "sync") {
    if (trigger !== "manual") return json({ error: "Unauthorized" }, 401);
    try {
      return await pushAction(action, body);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  const { from, to } = syncWindow();
  const { data: log, error: logErr } = await db
    .from("sync_log")
    .insert({ trigger, date_from: from, date_to: to })
    .select("id")
    .single();
  if (logErr) return json({ error: logErr.message }, 500);

  const cfg = {
    baseUrl: Deno.env.get("MYDATA_BASE_URL") ?? PROD_BASE_URL,
    userId: env("MYDATA_USER_ID"),
    subscriptionKey: env("MYDATA_SUBSCRIPTION_KEY"),
  };

  try {
    const entries = await fetchVatInfo(cfg, from, to);
    // Credit-note sign warning: only until it has been raised (or negatives seen) once.
    const { count: checked } = await db.from("sync_log").select("id", { count: "exact", head: true })
      .or("warning.not.is.null,negative_docs.gt.0");
    const { rows, negativeDocs, warning } = summarize(entries, (checked ?? 0) > 0);
    const now = new Date().toISOString();

    // Which documents are new (for the "new document" notification).
    const { data: known } = await db.from("vat_entries").select("mark").gte("issue_date", from).range(0, 49999);
    const knownMarks = new Set((known ?? []).map((r: { mark: string }) => r.mark));
    const newRows = rows.filter((r) => !knownMarks.has(r.mark) && !r.is_cancelled);

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, synced_at: now }));
      const { error } = await db.from("vat_entries").upsert(chunk, { onConflict: "mark" });
      if (error) throw new Error(`DB: ${error.message}`);
    }

    // Expense documents (supplier, invoice number) — optional, never fails the sync.
    let docsError: string | null = null;
    try {
      const docs = await fetchReceivedDocs(cfg, from, to);
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500).map((d) => ({ ...d, synced_at: now }));
        const { error } = await db.from("received_docs").upsert(chunk, { onConflict: "mark" });
        if (error) throw new Error(`DB: ${error.message}`);
      }
    } catch (e) {
      docsError = (e as Error).message;
    }

    const notified = trigger === "cron" ? await cronNotifications(db, newRows, knownMarks.size > 0) : [];

    await db.from("sync_log").update({
      status: "ok",
      finished_at: new Date().toISOString(),
      rows: rows.length,
      negative_docs: negativeDocs,
      warning,
      docs_error: docsError,
    }).eq("id", log.id);

    return json({ status: "ok", rows: rows.length, newRows: newRows.length, negativeDocs, warning, docsError, notified });
  } catch (e) {
    const message = (e as Error).message;
    await db.from("sync_log").update({
      status: "error",
      finished_at: new Date().toISOString(),
      error: message,
    }).eq("id", log.id);
    return json({ status: "error", error: message }, 502);
  }
});
