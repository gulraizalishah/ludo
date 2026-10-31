// "Withdraw": the player asks to cash out; the money leaves their balance at once and an admin sends it.
import { sb } from './account.js';
import { call } from './online.js';

const $ = (id) => document.getElementById(id);
const say = (t) => { $('wdMsg').textContent = t; };
const STATUS = { pending: 'waiting for approval', processing: 'being sent', sent: 'sent', rejected: 'cancelled, money returned' };
let minWd = 10;

$('withdraw').onclick = async () => {
  $('wdDlg').showModal(); say('');
  const { data: w } = await sb.from('wallets').select('available').maybeSingle();
  $('wdBal').textContent = w ? `Available: ${Number(w.available).toFixed(2)} USDT` : '';
  const { data: s } = await sb.from('app_settings').select('value').eq('key', 'min_withdrawal').maybeSingle();
  if (s) minWd = Number(s.value);
  history();
};
$('wdGo').onclick = async () => {
  const amount = Number($('wdAmt').value.replace(',', '.')), to = $('wdTo').value.trim();
  if (!(amount > 0)) return say('Enter an amount.');
  if (amount < minWd) return say(`The minimum withdrawal is ${minWd} USDT.`);
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(to)) return say('That does not look like a TRON (TRC20) address. It starts with T and is 34 characters long.');
  if (!confirm(`Withdraw ${amount} USDT to\n${to}\n\nCheck the address carefully. This cannot be undone.`)) return;
  $('wdGo').disabled = true; say('Sending your request…');
  try {
    const r = await call('wallet', { action: 'withdraw', amount, to });
    say(r.status === 'processing' ? 'Sent to the network. It arrives in a minute or two.' : 'Request received. It is waiting for approval (large amounts are checked by hand).'); $('wdAmt').value = ''; history(); }
  catch (e) { say(e.message); }
  $('wdGo').disabled = false;
};
$('wdClose').onclick = () => $('wdDlg').close();
async function history() {
  const { data } = await sb.from('withdrawals').select('amount,status,created_at').order('created_at', { ascending: false }).limit(5);
  $('wdList').replaceChildren(...(data ?? []).map((d) => { const li = document.createElement('li'); li.textContent = `${Number(d.amount)} USDT · ${STATUS[d.status] ?? d.status} · ${new Date(d.created_at).toLocaleDateString()}`; return li; }));
}
