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
async function userFrom(req) {
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  return error || !data.user ? null : data.user;
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/engine.js
var createGame = (colors) => ({
  colors,
  tokens: Object.fromEntries(colors.map((c) => [c, [-1, -1, -1, -1]])),
  captured: Object.fromEntries(colors.map((c) => [c, false])),
  // has this player captured yet? (unlocks the home lane)
  out: [],
  // players who left the game (forfeited)
  turn: 0,
  dice: null,
  sixes: 0,
  winners: []
});

// ../../mnt/user-data/outputs/ludo/supabase/functions/lobby/index.ts
var ORDER = ["red", "green", "yellow", "blue"];
var TURN_MS = 3e4;
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: "Please log in first." }, 401);
    const { action, stake, players, match_id } = await req.json();
    const db = admin();
    if (action === "leave") {
      const { error: error2 } = await db.rpc("leave_match", { p_user: user.id, p_match: match_id });
      return error2 ? json({ error: error2.message }, 400) : json({ ok: true });
    }
    if (action !== "join") return json({ error: "bad action" }, 400);
    if (![2, 4].includes(players) || !(Number(stake) > 0)) return json({ error: "bad request" }, 400);
    const { data, error } = await db.rpc("quick_match", { p_user: user.id, p_stake: stake, p_players: players });
    if (error) return json({ error: error.message }, 400);
    const m = Array.isArray(data) ? data[0] : data;
    if (!m?.id) return json({ error: "Could not join a table, please try again." }, 500);
    if (m.status === "active" && !m.state) await startMatch(db, m.id);
    return json({ match_id: m.id });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
async function startMatch(db, id) {
  const { data: pl } = await db.from("match_players").select("color").eq("match_id", id);
  const have = new Set((pl ?? []).map((p) => p.color));
  const state = { ...createGame(ORDER.filter((c) => have.has(c))), ev: { n: 0 } };
  await db.from("matches").update({
    state,
    version: 1,
    turn_deadline: new Date(Date.now() + TURN_MS).toISOString()
  }).eq("id", id).is("state", null);
}
