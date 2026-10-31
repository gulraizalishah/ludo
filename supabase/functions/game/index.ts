// Every roll and move goes through here. The server rolls the dice, checks the move with the SAME rules
// engine as the browser, saves the new state (players watch it live), and pays out when someone wins.
import { admin, cors, json, userFrom } from '../_shared/util.ts';
import { stepState, autoState } from '../_shared/play.js';

const BUILD = 'game-v2';   // shown in replies so we can tell which version is deployed
const TURN_MS = 30000;
const rng = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;   // unbiased, server-side only

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: 'Please log in first.' }, 401);
    const { match_id, action, token } = await req.json();
    const db = admin();

    for (let attempt = 0; attempt < 3; attempt++) {
      const [{ data: m }, { data: pl }] = await Promise.all([      // both lookups at the same time
        db.from('matches').select('*').eq('id', match_id).maybeSingle(),
        db.from('match_players').select('user_id,color').eq('match_id', match_id),
      ]);
      if (!m || m.status !== 'active' || !m.state) return json({ error: 'This match is not active.' }, 409);
      const me = (pl ?? []).find((p: { user_id: string }) => p.user_id === user.id);
      if (!me) return json({ error: 'You are not in this match.' }, 403);

      const s = m.state;
      if (s.winners.length >= 1) {                              // finished earlier but payout did not complete: retry it
        await settle(db, match_id, pl, s);
        return json({ ok: true, build: BUILD, note: 'already finished' });
      }
      let next;
      if (action === 'tick') {
        if (new Date(m.turn_deadline).getTime() > Date.now()) return json({ ok: true, build: BUILD, waiting: true });
        next = autoState(s, rng);                               // idle player: the server plays for them
      } else {
        if (s.colors[s.turn] !== me.color) return json({ error: 'Not your turn.' }, 409);
        next = stepState(s, action, token, rng);
      }
      if (!next) return json({ error: 'Illegal move.' }, 400);

      const { data: upd } = await db.from('matches').update({
        state: next, version: m.version + 1, turn_deadline: new Date(Date.now() + TURN_MS).toISOString(),
      }).eq('id', match_id).eq('version', m.version).select('id');   // version check: two requests can't both win
      if (!upd?.length) continue;                                     // someone else acted first: reload and retry

      if (next.winners.length >= 1) await settle(db, match_id, pl, next);
      return json({ ok: true, build: BUILD, state: next, version: m.version + 1 });   // the actor sees the result instantly
    }
    return json({ error: 'Busy, please try again.' }, 409);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// Winner takes the pool minus the platform fee: all money maths happens in the database function.
async function settle(db: ReturnType<typeof admin>, id: string, pl: { user_id: string; color: string }[], s: { winners: string[] }) {
  const winner = pl.find((p) => p.color === s.winners[0])!.user_id;
  const { error } = await db.rpc('settle_match', { p_match: id, p_winner: winner });
  if (error) throw new Error(error.message);
}
