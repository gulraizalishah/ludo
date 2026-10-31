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
var START = { red: 0, green: 13, yellow: 26, blue: 39 };
var SAFE = [0, 8, 13, 21, 26, 34, 39, 47];
var FINISH = 105;
var trackIndex = (c, p) => (START[c] + p) % 52;
var onTrack = (p) => p >= 0 && p <= 51;
var rollDice = (rng2 = Math.random) => 1 + Math.floor(rng2() * 6);
var advance = (p, unlocked) => p >= 100 ? p + 1 : p === 50 && unlocked ? 100 : p === 51 ? 0 : p + 1;
function groupsOf(s, c, withSafe = false) {
  const m = {};
  s.tokens[c].forEach((p, i) => {
    if (!onTrack(p)) return;
    const a = trackIndex(c, p);
    if (withSafe || !SAFE.includes(a)) (m[a] = m[a] || []).push(i);
  });
  return Object.entries(m).filter(([, ids]) => ids.length > 1).map(([a, ids]) => ({ color: c, abs: +a, ids }));
}
var stacksOf = (s, c) => groupsOf(s, c);
var blockades = (s) => s.colors.flatMap((c) => stacksOf(s, c));
var enemyBlock = (s, c, abs) => blockades(s).find((b) => b.color !== c && b.abs === abs);
function target(s, c, i, d) {
  const p = s.tokens[c][i];
  if (p === FINISH) return null;
  if (p === -1) return d === 6 ? { np: 0 } : null;
  let q = p, cap = null;
  for (let k = 1; k <= d; k++) {
    if (q === FINISH) return null;
    q = advance(q, s.captured[c]);
    if (!onTrack(q)) continue;
    const b = enemyBlock(s, c, trackIndex(c, q));
    if (!b) continue;
    if (k < d) return null;
    const mine = groupsOf(s, c, true).find((m) => m.ids.includes(i));
    if (!mine || mine.ids.length !== b.ids.length) return null;
    if (SAFE.includes(trackIndex(c, p)) && stacksOf(s, c).length) return null;
    cap = b;
  }
  if (!cap && onTrack(q)) {
    const a = trackIndex(c, q);
    const joins = s.tokens[c].some((t, j) => j !== i && onTrack(t) && trackIndex(c, t) === a);
    if (joins && !SAFE.includes(a) && stacksOf(s, c).some((m) => m.abs !== a && !(m.ids.length === 2 && m.ids.includes(i)))) return null;
  }
  return { np: q, cap };
}
function getLegalMoves(s, d) {
  const c = s.colors[s.turn];
  return s.tokens[c].map((_, i) => i).filter((i) => target(s, c, i, d));
}
function nextTurn(s) {
  let t = s.turn;
  const gone = (c) => s.winners.includes(c) || (s.out || []).includes(c);
  do {
    t = (t + 1) % s.colors.length;
  } while (gone(s.colors[t]));
  return { ...s, turn: t, dice: null, sixes: 0 };
}
function roll(s, d) {
  s = { ...s, dice: d, sixes: d === 6 ? s.sixes + 1 : 0 };
  return s.sixes === 3 || !getLegalMoves(s, d).length ? nextTurn(s) : s;
}
function applyMove(s, i, d) {
  const c = s.colors[s.turn];
  const { np, cap } = target(s, c, i, d);
  const tokens = Object.fromEntries(Object.entries(s.tokens).map(([k, v]) => [k, [...v]]));
  let captured = !!cap;
  if (cap) {
    groupsOf(s, c, true).find((m) => m.ids.includes(i)).ids.forEach((j) => {
      tokens[c][j] = np;
    });
    cap.ids.forEach((j) => {
      tokens[cap.color][j] = -1;
    });
  } else {
    tokens[c][i] = np;
    if (onTrack(np) && !SAFE.includes(trackIndex(c, np))) {
      for (const o of s.colors) {
        if (o === c) continue;
        tokens[o] = tokens[o].map((q) => onTrack(q) && trackIndex(o, q) === trackIndex(c, np) ? (captured = true, -1) : q);
      }
    }
  }
  const won = tokens[c].every((q) => q === FINISH);
  const winners = won ? [...s.winners, c] : s.winners;
  const n = { ...s, tokens, winners, dice: null, captured: { ...s.captured, [c]: s.captured[c] || captured } };
  return (d === 6 || captured) && !won ? n : nextTurn(n);
}
function botPick(s, d) {
  const c = s.colors[s.turn];
  const base = (st, col) => st.tokens[col].filter((q) => q === -1).length;
  const score = (i) => {
    const before = s.tokens[c][i], n = applyMove(s, i, d);
    const hit = s.colors.some((o) => o !== c && base(n, o) > base(s, o));
    return (hit ? 1e3 : 0) + (n.tokens[c][i] === FINISH ? 500 : 0) + (before === -1 ? 300 : 0) + (before >= 100 ? 200 : before);
  };
  return getLegalMoves(s, d).sort((a, b) => score(b) - score(a))[0];
}
function forfeit(s, color) {
  const out = [...s.out || [], color];
  const n = { ...s, out, tokens: { ...s.tokens, [color]: [-1, -1, -1, -1] } };
  const left = s.colors.filter((c) => !out.includes(c) && !s.winners.includes(c));
  if (left.length === 1 && !s.winners.length) return { ...n, winners: [left[0]], dice: null };
  return s.colors[s.turn] === color ? nextTurn(n) : n;
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/_shared/play.js
var nextN = (s) => (s.ev?.n ?? 0) + 1;
var IDLE_LIMIT = 6;
function stepState(s, action, token, rng2 = Math.random) {
  const color = s.colors[s.turn], idle = { ...s.idle || {}, [color]: 0 };
  if (action === "roll") {
    if (s.dice != null) return null;
    const d = rollDice(rng2);
    return { ...roll(s, d), idle, ev: { t: "roll", d, color, n: nextN(s) } };
  }
  if (action === "move") {
    if (s.dice == null || !getLegalMoves(s, s.dice).includes(token)) return null;
    return { ...applyMove(s, token, s.dice), idle, ev: { t: "move", i: token, d: s.dice, color, n: nextN(s) } };
  }
  return null;
}
function autoState(s, rng2) {
  const color = s.colors[s.turn], count = (s.idle?.[color] || 0) + 1;
  const n = s.dice == null ? stepState(s, "roll", 0, rng2) : stepState(s, "move", botPick(s, s.dice), rng2);
  if (count < IDLE_LIMIT) return { ...n, idle: { ...n.idle, [color]: count } };
  return { ...forfeit(n, color), idle: { ...n.idle, [color]: count }, ev: { t: "forfeit", forfeit: color, n: nextN(s) } };
}

// ../../mnt/user-data/outputs/ludo/supabase/functions/game/index.ts
var BUILD = "game-v2";
var TURN_MS = 3e4;
var rng = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: "Please log in first." }, 401);
    const { match_id, action, token } = await req.json();
    const db = admin();
    for (let attempt = 0; attempt < 3; attempt++) {
      const [{ data: m }, { data: pl }] = await Promise.all([
        // both lookups at the same time
        db.from("matches").select("*").eq("id", match_id).maybeSingle(),
        db.from("match_players").select("user_id,color").eq("match_id", match_id)
      ]);
      if (!m || m.status !== "active" || !m.state) return json({ error: "This match is not active." }, 409);
      const me = (pl ?? []).find((p) => p.user_id === user.id);
      if (!me) return json({ error: "You are not in this match." }, 403);
      const s = m.state;
      if (s.winners.length >= 1) {
        await settle(db, match_id, pl, s);
        return json({ ok: true, build: BUILD, note: "already finished" });
      }
      let next;
      if (action === "tick") {
        if (new Date(m.turn_deadline).getTime() > Date.now()) return json({ ok: true, build: BUILD, waiting: true });
        next = autoState(s, rng);
      } else {
        if (s.colors[s.turn] !== me.color) return json({ error: "Not your turn." }, 409);
        next = stepState(s, action, token, rng);
      }
      if (!next) return json({ error: "Illegal move." }, 400);
      const { data: upd } = await db.from("matches").update({
        state: next,
        version: m.version + 1,
        turn_deadline: new Date(Date.now() + TURN_MS).toISOString()
      }).eq("id", match_id).eq("version", m.version).select("id");
      if (!upd?.length) continue;
      if (next.winners.length >= 1) await settle(db, match_id, pl, next);
      return json({ ok: true, build: BUILD, state: next, version: m.version + 1 });
    }
    return json({ error: "Busy, please try again." }, 409);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
async function settle(db, id, pl, s) {
  const winner = pl.find((p) => p.color === s.winners[0]).user_id;
  const { error } = await db.rpc("settle_match", { p_match: id, p_winner: winner });
  if (error) throw new Error(error.message);
}
