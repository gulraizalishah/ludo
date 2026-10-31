// Admin page: approve withdrawals and watch the money. The server checks that you are an admin on every action.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let token = null;
const msg = (t) => { $('msg').textContent = t; if (t) window.scrollTo(0, 0); };
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };

async function api(body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}
$('go').onclick = async () => {
  msg('Logging in…');
  const { error } = await sb.auth.signInWithPassword({ email: $('em').value.trim(), password: $('pw').value });
  msg(error ? error.message : '');
};
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });
$('logout').onclick = () => sb.auth.signOut();
$('logout2').onclick = () => sb.auth.signOut();
let verified = false;   // the panel is only ever shown after the server has confirmed this account is an admin
sb.auth.onAuthStateChange((_e, s) => { token = s?.access_token ?? null; setTimeout(show, 0); });

async function show() {
  if (!token) { verified = false; $('panel').hidden = true; $('denied').hidden = true; $('loginBox').hidden = false; msg(''); return; }
  $('loginBox').hidden = true;
  if (!verified) { $('panel').hidden = true; $('denied').hidden = true; msg('Checking your access…'); }
  try {
    await Promise.all([overview(), lists()]);
    verified = true; $('panel').hidden = false; msg('');
  } catch (e) {
    if (e.message === 'Admins only.') { $('panel').hidden = true; $('denied').hidden = false; msg(''); }
    else { msg(e.message); if (verified) window.scrollTo(0, 0); }
  }
}
async function overview() {
  const { overview: o, hot: hotRaw } = await api({ action: 'overview' }), hot = hotRaw ?? {};
  const f = (n) => Number(n).toFixed(2), rows = [
    ['Total deposited', f(o.deposits_total)], ['Players: available', f(o.players_available)], ['Players: locked in matches', f(o.players_locked)],
    ['Platform fees earned', f(o.platform_fees)], ['Withdrawals waiting', `${o.pending_count} (${f(o.pending_amount)})`],
    ['Paid out so far', f(o.paid_out_total)], ['Matches being played', o.active_matches],
  ];
  const t = $('ov'); t.replaceChildren(...rows.map(([k, v]) => { const tr = el('tr'); tr.append(el('td', k), el('td', String(v))); return tr; }));
  const ok = Number(o.unaccounted) === 0 && Number(o.wallet_mismatches) === 0, tr = el('tr');
  tr.append(el('td', 'Books balance?'), el('td', ok ? 'Yes, everything adds up' : `NO: unaccounted ${f(o.unaccounted)}, wallet mismatches ${o.wallet_mismatches}`, ok ? 'good' : 'bad'));
  t.append(tr);
  const h = $('hot'), hrows = !hot.address ? [['Payout wallet', hot.error || 'not set up yet (add the HD_SEED secret)']] : [['Address', hot.address], ['USDT', hot.usdt == null ? 'unknown' : f(hot.usdt)], ['TRX for fees', hot.trx == null ? 'unknown' : f(hot.trx)]];
  h.replaceChildren(...hrows.map(([k, v]) => { const r = el('tr'); r.append(el('td', k), el('td', String(v))); return r; }));
  if (hot && hot.usdt != null && (hot.usdt < Number(o.pending_amount) || hot.trx < 30)) { const r = el('tr'); r.append(el('td', 'Warning'), el('td', 'Payout wallet is low: top it up so withdrawals keep being sent automatically.', 'bad')); h.append(r); }
  $('earn').textContent = `Available: ${f(o.platform_fees)} USDT`;
  earnings = Number(o.platform_fees);
}
let earnings = 0;
$('takeBtn').onclick = async () => {
  const a = prompt(`How much to move to your balance? (up to ${earnings.toFixed(2)})`, earnings.toFixed(2));
  if (!a) return;
  try { await api({ action: 'move_earnings', amount: Number(a) }); msg('Moved. Now press Withdraw in the game.'); show(); } catch (e) { msg(e.message); }
};
async function lists() {
  const [{ rows: p }, { rows: r }] = await Promise.all([api({ action: 'pending' }), api({ action: 'recent' })]);
  $('pending').replaceChildren(...(p.length ? p.map(pendingRow) : [el('p', 'Nothing waiting.')]));
  $('recent').replaceChildren(...(r.length ? r.map((w) => el('p', `${Number(w.amount).toFixed(2)} USDT to ${w.to_address} · ${w.status}${w.tx_hash ? ' · ' + w.tx_hash.slice(0, 12) + '…' : ''} · ${w.email}`)) : [el('p', 'Nothing yet.')]));
}
function pendingRow(w) {
  const box = el('div'); box.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--line)';
  const head = el('div', `${Number(w.amount).toFixed(2)} USDT · ${w.username || w.email} · ${new Date(w.created_at).toLocaleString()}`); head.style.fontWeight = '700';
  const to = el('code', w.to_address);
  const actions = el('div', undefined, 'actions'); actions.style.marginTop = '8px';
  if (w.status === 'processing') { actions.append(el('span', `Being sent automatically${w.tx_hash ? ' · ' + w.tx_hash.slice(0, 12) + '…' : ''}`)); box.append(head, to, actions); return box; }
  const retry = el('button', 'Try automatic payout again', 'ok'), ok = el('button', 'I sent it myself', 'ok'), no = el('button', 'Reject and refund', 'no');
  retry.onclick = async () => { try { const r = await api({ action: 'retry', id: w.id }); msg(r.status === 'processing' ? 'Sent to the network.' : 'Still waiting: check the payout wallet balance.'); show(); } catch (e) { msg(e.message); } };
  ok.onclick = async () => {
    const tx = prompt(`Send ${Number(w.amount).toFixed(2)} USDT (TRC20) to:\n${w.to_address}\n\nWhen you have really sent it, paste the TRANSACTION ID your wallet shows (a 64-character code). Not the wallet address. Leave this empty if you have not sent the money.`);
    if (!tx) return;
    try { await api({ action: 'sent', id: w.id, tx }); show(); } catch (e) { msg(e.message); }
  };
  no.onclick = async () => { if (!confirm('Reject this withdrawal and return the money to the player?')) return; try { await api({ action: 'reject', id: w.id }); show(); } catch (e) { msg(e.message); } };
  actions.append(retry, ok, no); box.append(head, to, actions); return box;
}
