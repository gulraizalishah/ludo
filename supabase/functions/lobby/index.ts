// Join / leave a money table. Stake locking and colour dealing happen inside the database (quick_match).
import { admin, cors, json, userFrom } from '../_shared/util.ts';
import { createGame } from '../_shared/engine.js';

const ORDER = ['red', 'green', 'yellow', 'blue'];
const TURN_MS = 30000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: 'Please log in first.' }, 401);
    const { action, stake, players, match_id } = await req.json();
    const db = admin();

    if (action === 'leave') {
      const { error } = await db.rpc('leave_match', { p_user: user.id, p_match: match_id });
      return error ? json({ error: error.message }, 400) : json({ ok: true });
    }
    if (action !== 'join') return json({ error: 'bad action' }, 400);
    if (![2, 4].includes(players) || !(Number(stake) > 0)) return json({ error: 'bad request' }, 400);

    const { data, error } = await db.rpc('quick_match', { p_user: user.id, p_stake: stake, p_players: players });
    if (error) return json({ error: error.message }, 400);
    const m = Array.isArray(data) ? data[0] : data;           // depending on the API version this is a row or a 1-row list
    if (!m?.id) return json({ error: 'Could not join a table, please try again.' }, 500);
    if (m.status === 'active' && !m.state) await startMatch(db, m.id);
    return json({ match_id: m.id });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// Table is full: build the starting game state from the colours the database dealt.
async function startMatch(db: ReturnType<typeof admin>, id: string) {
  const { data: pl } = await db.from('match_players').select('color').eq('match_id', id);
  const have = new Set((pl ?? []).map((p: { color: string }) => p.color));
  const state = { ...createGame(ORDER.filter((c) => have.has(c))), ev: { n: 0 } };
  await db.from('matches').update({
    state, version: 1, turn_deadline: new Date(Date.now() + TURN_MS).toISOString(),
  }).eq('id', id).is('state', null);
}
