// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/util.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
var cors = {
  // Set the ALLOWED_ORIGIN secret (e.g. https://your-site.netlify.app) to accept requests from your site only.
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
var json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
var admin = () => createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// ../../mnt/user-data/outputs/ludo/supabase/functions/health/index.ts
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const db = admin();
    const { data: ls } = await db.from("app_settings").select("value").eq("key", "last_scan_at").maybeSingle();
    const age = ls?.value ? Math.round((Date.now() - new Date(String(ls.value)).getTime()) / 1e3) : null;
    const { data: ov } = await db.from("admin_overview").select("unaccounted,wallet_mismatches").maybeSingle();
    const books_ok = !!ov && Number(ov.unaccounted) === 0 && Number(ov.wallet_mismatches) === 0;
    return json({ ok: age !== null && age < 300 && books_ok, timer_age_seconds: age, books_ok });
  } catch (e) {
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
