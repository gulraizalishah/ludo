// Online (money) matches: lobby card, waiting room, live play through Supabase Realtime.
// The browser never decides anything about the game: it asks the server and shows what comes back.
import { sb } from './account.js';
import { startOnline, pushState, showResult, freeze, hooks } from './app.js';

const $ = (id) => document.getElementById(id);
const cap = (c) => c[0].toUpperCase() + c.slice(1);
const msg = (t) => { $('moneyMsg').textContent = t; };
let user = null, cur = null, chan = null, timer = null, pollTimer = null, q = Promise.resolve();
let feePct = 25, stake = 5, players = 2, lastTick = 0;

async function call(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch { /* keep default */ } throw new Error(m); }
  if (data?.error) throw new Error(data.error);
  return data;
}
const nice = (m) => (/violates check|wallets/i.test(m) ? 'Not enough balance. Add funds first.' : m);

// ---- lobby card
function preview() {
  const pool = stake * players, fee = (pool * feePct) / 100;
  $('prize').textContent = `Winner gets ${(pool - fee).toFixed(2)} USDT (pool ${pool.toFixed(2)}, ${feePct}% platform fee)`;
  document.querySelectorAll('#stakeOpts button').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.s) === stake));
  document.querySelectorAll('#plOpts button').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.p) === players));
}
document.querySelectorAll('#stakeOpts button').forEach((b) => { b.onclick = () => { stake = Number(b.dataset.s); preview(); }; });
document.querySelectorAll('#plOpts button').forEach((b) => { b.onclick = () => { players = Number(b.dataset.p); preview(); }; });

async function refreshLobby() {                  // a match left open? offer to resume it
  if (!user) return;
  const { data } = await sb.from('match_players').select('match_id, matches!inner(id,status)')
    .in('matches.status', ['waiting', 'active']).limit(1);
  const open = data?.[0]?.match_id ?? null;
  $('resumeMatch').hidden = !open; $('findMatch').hidden = !!open; $('resumeMatch').dataset.id = open ?? '';
}
$('findMatch').onclick = async () => {
  msg('Finding a table…');
  try { const r = await call('lobby', { action: 'join', stake, players });
    if (!r?.match_id) throw new Error('Could not join a table, please try again.');
    msg(''); await enter(r.match_id); }
  catch (e) { msg(nice(e.message)); }
};
$('resumeMatch').onclick = () => enter($('resumeMatch').dataset.id);

// ---- one match: subscribe, then apply every update in order
async function enter(id) {
  unsub(); cur = { id, started: false, players: [], m: null };
  chan = sb.channel('match-' + id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `id=eq.${id}` }, (p) => onMatch(p.new))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'match_players', filter: `match_id=eq.${id}` },
        () => onMatch(cur?.m))
    .subscribe(async (status) => {
      if (!pollTimer) pollTimer = setInterval(poll, 2000);
      if (status !== 'SUBSCRIBED') return;
      const { data } = await sb.from('matches').select('*').eq('id', id).maybeSingle();   // catch up on anything missed
      if (data) onMatch(data);
    });
}
// Safety net: also ask the database for the latest state every 2 seconds and right after each action,
// so the game keeps working even when live (Realtime) messages are slow or not delivered.
async function poll() {
  if (!cur) return;
  const id = cur.id, { data } = await sb.from('matches').select('*').eq('id', id).maybeSingle();
  if (!data || !cur || cur.id !== id) return;
  if (cur.m?.status === 'waiting') { await refreshPlayers(); if (cur && cur.m?.status === 'waiting') showWaiting(); }
  if (!cur.m || data.version > cur.m.version || data.status !== cur.m.status) onMatch(data);
}
function unsub() {
  clearInterval(pollTimer); pollTimer = null;
  if (chan) sb.removeChannel(chan);
  chan = null; clearInterval(timer); timer = null; cur = null; hideWaiting();
}
async function refreshPlayers() {
  const { data } = await sb.from('match_players').select('user_id,color').eq('match_id', cur.id);
  if (data) cur.players = data;
}
const onMatch = (m) => { if (m) q = q.then(() => handle(m)).catch(console.error); };

async function handle(m) {
  if (!cur || m.id !== cur.id) return;
  cur.m = m;
  if (m.status === 'cancelled') { unsub(); msg('That table was cancelled and your stake was returned.'); return refreshLobby(); }
  if (m.status === 'waiting') { await refreshPlayers(); return cur && showWaiting(); }
  if (!m.state) return showWaiting('Table full, dealing colours…');
  if (!cur.players.some((p) => p.user_id === user.id && p.color)) await refreshPlayers();   // I need to know MY colour
  if (!cur) return;
  const me = cur.players.find((p) => p.user_id === user.id)?.color;
  hideWaiting();
  if (!cur.started) { cur.started = true; startOnline(m.state.colors, me, m.state); beginTimer(); }
  else pushState(m.state);
  if (m.status === 'finished') setTimeout(() => finish(m, me), 1800);   // after the last hop has played
}

function finish(m, me) {
  clearInterval(timer); freeze();
  const winner = m.state.winners[0], won = winner === me;
  $('timer').textContent = '';
  showResult(won ? `You won ${Number(m.payout).toFixed(2)} USDT!` : `${cap(winner)} wins`,
    won ? `Pool ${Number(m.pool).toFixed(2)} minus ${m.fee_percent}% platform fee.`
        : `Your ${Number(m.stake).toFixed(2)} USDT stake went to the winner.`);
}

// ---- waiting room
function showWaiting(text) {
  const m = cur.m;
  $('waitTxt').textContent = text || `Waiting for players… ${cur.players.length}/${m.max_players}`;
  $('waitStake').textContent = `Stake ${Number(m.stake).toFixed(2)} USDT`;
  if (!$('waitDlg').open) $('waitDlg').showModal();
}
function hideWaiting() { if ($('waitDlg').open) $('waitDlg').close(); }
$('waitCancel').onclick = async () => {
  try { await call('lobby', { action: 'leave', match_id: cur.id }); unsub(); msg('Stake returned to your balance.'); refreshLobby(); }
  catch (e) { msg(e.message); }
};

// ---- turn timer: if a player goes idle, anyone's browser asks the server to play for them
function beginTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    const m = cur?.m; if (!m || m.status !== 'active') return;
    const left = Math.ceil((new Date(m.turn_deadline) - Date.now()) / 1000);
    $('timer').textContent = left > 0 ? `${left}s` : 'auto…';
    if (left < -1 && Date.now() - lastTick > 4000) {
      lastTick = Date.now(); call('game', { match_id: m.id, action: 'tick' }).catch(() => {});
    }
  }, 500);
}

hooks.roll = () => call('game', { match_id: cur.id, action: 'roll' }).then(poll);
hooks.move = (token) => call('game', { match_id: cur.id, action: 'move', token }).then(poll);
document.addEventListener('lobby-shown', () => { unsub(); refreshLobby(); });

if (sb) sb.auth.onAuthStateChange((_e, s) => setTimeout(async () => {
  const u = s?.user ?? null;
  if ((u?.id ?? null) === (user?.id ?? null)) return;
  user = u; unsub(); $('money').hidden = !u;
  if (!u) return;
  const { data } = await sb.from('app_settings').select('value').eq('key', 'platform_fee_percent').maybeSingle();
  if (data) feePct = Number(data.value);
  preview(); refreshLobby();
}, 0));
