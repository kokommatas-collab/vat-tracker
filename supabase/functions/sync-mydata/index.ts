// sync-mydata: pulls RequestVatInfo for the previous + current quarter and
// upserts into vat_entries. Called by pg_cron (x-cron-secret) or the logged-in
// user ("Ανανέωση" button, Supabase JWT). Deployed with verify_jwt = false
// because auth is checked here for both callers.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchVatInfo, PROD_BASE_URL } from "./mydata.ts";
import { syncWindow } from "./dates.ts";
import { summarize } from "./summary.ts";

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

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function authorize(req: Request): Promise<"cron" | "manual" | null> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) return safeEqual(cronSecret, env("CRON_SECRET")) ? "cron" : null;

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const allowed = Deno.env.get("ALLOWED_EMAIL");
  if (allowed && data.user.email?.toLowerCase() !== allowed.toLowerCase()) return null;
  return "manual";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const trigger = await authorize(req);
  if (!trigger) return json({ error: "Unauthorized" }, 401);

  const { from, to } = syncWindow();
  const { data: log, error: logErr } = await db
    .from("sync_log")
    .insert({ trigger, date_from: from, date_to: to })
    .select("id")
    .single();
  if (logErr) return json({ error: logErr.message }, 500);

  try {
    const entries = await fetchVatInfo(
      {
        baseUrl: Deno.env.get("MYDATA_BASE_URL") ?? PROD_BASE_URL,
        userId: env("MYDATA_USER_ID"),
        subscriptionKey: env("MYDATA_SUBSCRIPTION_KEY"),
      },
      from,
      to,
    );
    const { rows, negativeDocs, warning } = summarize(entries);
    const now = new Date().toISOString();

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, synced_at: now }));
      const { error } = await db.from("vat_entries").upsert(chunk, { onConflict: "mark" });
      if (error) throw new Error(`DB: ${error.message}`);
    }

    await db.from("sync_log").update({
      status: "ok",
      finished_at: new Date().toISOString(),
      rows: rows.length,
      negative_docs: negativeDocs,
      warning,
    }).eq("id", log.id);

    return json({ status: "ok", rows: rows.length, negativeDocs, warning });
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
