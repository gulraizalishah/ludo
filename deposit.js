// "Add funds": shows the player's own USDT (TRC20) deposit address and credits confirmed deposits.
import { sb } from './account.js';
import { call } from './online.js';
import { ASSET } from './asset.js';

const $ = (id) => document.getElementById(id);
let info = null;
const say = (t) => { $('depMsg').textContent = t; };

$('addFunds').onclick = async () => {
  $('depDlg').showModal(); $('depAddr').textContent = '…'; say('Getting your address…');
  try { info = await call('wallet', { action: 'address' }); show(); } catch (e) { say(e.message); }
};
function show() {
  $('depAddr').textContent = info.address;
  $('depNet').textContent = info.network === 'mainnet'
    ? `Network: TRON. Send ${ASSET} only.`
    : `TEST NETWORK (${info.network}): test ${ASSET} only, it has no real value.`;
  $('depNet').className = info.network === 'mainnet' ? '' : 'testnet';
  $('depMin').textContent = `Minimum ${info.min} ${ASSET}. Send only ${ASSET} on the TRON network to this address${ASSET === 'USDT' ? ' (TRC20)' : ''}; anything else is lost.`;
  say('Waiting for your deposit. This window checks by itself every few seconds.'); history();
  stopAuto(); timer = setInterval(() => check(true), EVERY);   // no button needed: it is found, credited and collected automatically
}
$('depCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(info.address); say('Address copied.'); }
  catch { const r = document.createRange(); r.selectNodeContents($('depAddr')); getSelection().removeAllRanges(); getSelection().addRange(r); say('Press copy on your keyboard or menu.'); }
};
let timer = null;
const EVERY = window.__checkEveryMs ?? 15000;
const stopAuto = () => { clearInterval(timer); timer = null; };
async function check(quiet) {
  if (!quiet) say('Checking the blockchain…');
  try {
    const r = await call('wallet', { action: 'check' });
    if (r.credited.length) say(`Added ${r.credited.map((d) => Number(d.amount)).join(' + ')} ${ASSET} to your balance.`);
    else if (!quiet) say('Nothing new yet. A deposit shows up a minute or two after the network confirms it.');
    else say('Waiting for your deposit. This window checks by itself every few seconds.');
    history();
  } catch (e) { if (!quiet) say(e.message); }
}
$('depCheck').onclick = () => check(false);
$('depDlg').addEventListener('close', stopAuto);
$('depClose').onclick = () => { stopAuto(); $('depDlg').close(); };
async function history() {
  const { data } = await sb.from('deposits').select('amount,created_at').order('created_at', { ascending: false }).limit(5);
  $('depList').replaceChildren(...(data ?? []).map((d) => { const li = document.createElement('li'); li.textContent = `${Number(d.amount)} ${ASSET} · ${new Date(d.created_at).toLocaleString()}`; return li; }));
}
