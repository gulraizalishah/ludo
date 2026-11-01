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
    const first = !verified;
    await overview();                                            // first: it tells us the currency
    await Promise.all([lists(), history()]);
    verified = true; $('panel').hidden = false; if (first) msg('');   // keep the result message of the button you just pressed
  } catch (e) {
    if (e.message === 'Admins only.') { $('panel').hidden = true; $('denied').hidden = false; msg(''); }
    else { msg(e.message); if (verified) window.scrollTo(0, 0); }
  }
}
async function overview() {
  const { overview: o, hot: hotRaw, network: net, sweeps, swept_total, asset: a } = await api({ action: 'overview' }), hot = hotRaw ?? {};
  network = net || network; asset = a || asset;
  document.querySelectorAll('.asset').forEach((e) => { e.textContent = asset; }); $('feeNote').hidden = asset === 'TRX';
  const f = (n) => Number(n).toFixed(2), rows = [
    ['Total deposited', f(o.deposits_total)], ['Players: available', f(o.players_available)], ['Players: locked in matches', f(o.players_locked)],
    ['Platform fees earned', f(o.platform_fees)], ['Withdrawals waiting', `${o.pending_count} (${f(o.pending_amount)})`],
    ['Paid out so far', f(o.paid_out_total)], ['Matches being played', o.active_matches],
  ];
  const t = $('ov'); t.replaceChildren(...rows.map(([k, v]) => { const tr = el('tr'); tr.append(el('td', k), el('td', String(v))); return tr; }));
  const ok = Number(o.unaccounted) === 0 && Number(o.wallet_mismatches) === 0, tr = el('tr');
  tr.append(el('td', 'Books balance?'), el('td', ok ? 'Yes, everything adds up' : `NO: unaccounted ${f(o.unaccounted)}, wallet mismatches ${o.wallet_mismatches}`, ok ? 'good' : 'bad'));
  t.append(tr);
  const h = $('hot'), hrows = !hot.address ? [['Payout wallet', hot.error || 'not set up yet (add the HD_SEED secret)']] : asset === 'TRX' ? [['Address', hot.address], ['TRX balance', hot.trx == null ? 'unknown' : f(hot.trx)]] : [['Address', hot.address], ['USDT', hot.usdt == null ? 'unknown' : f(hot.usdt)], ['TRX for fees', hot.trx == null ? 'unknown' : f(hot.trx)]];
  h.replaceChildren(...hrows.map(([k, v]) => { const r = el('tr'); r.append(el('td', k), el('td', String(v))); return r; }));
  if (hot && hot.usdt != null && (asset === 'TRX' ? hot.trx < Number(o.pending_amount) + 1 : hot.usdt < Number(o.pending_amount) || hot.trx < 30)) { const r = el('tr'); r.append(el('td', 'Warning'), el('td', 'Payout wallet is low: top it up so withdrawals keep being sent automatically.', 'bad')); h.append(r); }
  $('swept').textContent = `Collected into the payout wallet so far: ${f(swept_total ?? 0)} ${asset}`;
  const sh = el('tr'); ['Time', 'What', 'Amount', 'Status', ''].forEach((t) => sh.append(el('th', t)));
  const WHAT = { topup: 'TRX for fees', sweep: `${asset} collected` }, srows = (sweeps ?? []).map((s) => {
    const tr = el('tr'), l = el('td'); if (s.tx_hash) { const x = el('a', 'view'); x.href = explorer(s.tx_hash); x.target = '_blank'; x.rel = 'noopener'; x.style.color = '#6be28f'; l.append(x); }
    tr.append(el('td', new Date(s.created_at).toLocaleString()), el('td', WHAT[s.kind] || s.kind), el('td', Number(s.amount).toFixed(2)), el('td', s.status, s.status === 'failed' ? 'bad' : ''), l); return tr; });
  $('sw').replaceChildren(sh, ...(srows.length ? srows : [(() => { const tr = el('tr'); tr.append(el('td', 'Nothing collected yet.')); return tr; })()]));
  $('earn').textContent = `Available: ${f(o.platform_fees)} ${asset}`;
  earnings = Number(o.platform_fees);
}
$('sweepBtn').onclick = async () => {
  try { const r = await api({ action: 'sweep_now' }); const s = Object.entries(r.summary).map(([k, v]) => `${k}: ${v}`).join(', '); msg(s ? `Collecting: ${s}` : 'Nothing to collect right now.'); show(); } catch (e) { msg(e.message); }
};
let earnings = 0, network = 'nile', asset = 'USDT';
const explorer = (tx) => `https://${network === 'mainnet' ? '' : network + '.'}tronscan.org/#/transaction/${tx}`;
const KIND = { deposit: 'Deposit', stake_lock: 'Stake locked', stake_refund: 'Stake refunded', match_win: 'Match won', match_loss: 'Match lost', platform_fee: 'Platform fee', withdrawal_request: 'Withdrawal', withdrawal_refund: 'Withdrawal refunded', platform_payout: 'Earnings moved' };
$('takeBtn').onclick = async () => {
  const a = prompt(`How much to move to your balance? (up to ${earnings.toFixed(2)})`, earnings.toFixed(2));
  if (!a) return;
  try { await api({ action: 'move_earnings', amount: Number(a) }); msg('Moved. Now press Withdraw in the game.'); show(); } catch (e) { msg(e.message); }
};
async function lists() {
  const [{ rows: p }, { rows: r }] = await Promise.all([api({ action: 'pending' }), api({ action: 'recent' })]);
  $('pending').replaceChildren(...(p.length ? p.map(pendingRow) : [el('p', 'Nothing waiting.')]));
  $('recent').replaceChildren(...(r.length ? r.map((w) => el('p', `${Number(w.amount).toFixed(2)} ${asset} to ${w.to_address} · ${w.status}${w.tx_hash ? ' · ' + w.tx_hash.slice(0, 12) + '…' : ''} · ${w.email}`)) : [el('p', 'Nothing yet.')]));
}
function pendingRow(w) {
  const box = el('div'); box.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--line)';
  const head = el('div', `${Number(w.amount).toFixed(2)} ${asset} · ${w.username || w.email} · ${new Date(w.created_at).toLocaleString()}`); head.style.fontWeight = '700';
  const to = el('code', w.to_address);
  const why = w.note ? el('div', w.note, 'bad') : null;
  const actions = el('div', undefined, 'actions'); actions.style.marginTop = '8px';
  if (w.status === 'processing') { actions.append(el('span', `Being sent automatically${w.tx_hash ? ' · ' + w.tx_hash.slice(0, 12) + '…' : ''}`)); box.append(head, to, actions); return box; }
  const retry = el('button', 'Try automatic payout again', 'ok'), ok = el('button', 'I sent it myself', 'ok'), no = el('button', 'Reject and refund', 'no');
  retry.onclick = async () => { try { const r = await api({ action: 'retry', id: w.id }); msg(r.status === 'processing' ? 'Sent to the network.' : 'Still waiting: check the payout wallet balance.'); show(); } catch (e) { msg(e.message); } };
  ok.onclick = async () => {
    const tx = prompt(`Send ${Number(w.amount).toFixed(2)} ${asset} to:\n${w.to_address}\n\nWhen you have really sent it, paste the TRANSACTION ID your wallet shows (a 64-character code). Not the wallet address. Leave this empty if you have not sent the money.`);
    if (!tx) return;
    try { await api({ action: 'sent', id: w.id, tx }); show(); } catch (e) { msg(e.message); }
  };
  no.onclick = async () => { if (!confirm('Reject this withdrawal and return the money to the player?')) return; try { await api({ action: 'reject', id: w.id }); show(); } catch (e) { msg(e.message); } };
  actions.append(retry, ok, no); box.append(head, to, ...(why ? [why] : []), actions); return box;
}

async function history() {
  const { rows } = await api({ action: 'transactions', filter: $('filter').value });
  const f = (n) => (Number(n) > 0 ? '+' : '') + Number(n).toFixed(2);
  const head = el('tr'); ['Time', 'Who', 'What', 'Available', 'Locked', 'Details'].forEach((t) => head.append(el('th', t)));
  const body = rows.map((r) => {
    const tr = el('tr'), det = el('td');
    if (r.withdrawal) {
      det.append(document.createTextNode(`${r.withdrawal.status} · ${r.withdrawal.to_address} `));
      if (r.withdrawal.tx_hash) { const l = el('a', 'view transaction'); l.href = explorer(r.withdrawal.tx_hash); l.target = '_blank'; l.rel = 'noopener'; l.style.color = '#6be28f'; det.append(l); }
      if (r.withdrawal.note) det.append(el('div', r.withdrawal.note, 'bad'));
    }
    tr.append(el('td', new Date(r.created_at).toLocaleString()), el('td', r.who), el('td', KIND[r.kind] || r.kind), el('td', f(r.d_available)), el('td', f(r.d_locked)), det);
    return tr;
  });
  $('tx').replaceChildren(head, ...(body.length ? body : [(() => { const tr = el('tr'); tr.append(el('td', 'Nothing yet.')); return tr; })()]));
}
$('filter').onchange = () => history().catch((e) => msg(e.message));
