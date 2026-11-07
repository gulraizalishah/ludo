// "My limits": a daily stake limit, a break (self-exclusion), and the 18+/terms confirmation.
import { call } from './online.js';
import { ASSET } from './asset.js';

const $ = (id) => document.getElementById(id);
const say = (t) => { $('limMsg').textContent = t; };
let info = null;

async function act(op, body = {}) {
  try { info = await call('wallet', { action: op, ...body }); render(); return true; } catch (e) { say(e.message); return false; }
}
function render() {
  $('limAccept').hidden = info.accepted;
  const when = (t) => new Date(t).toLocaleString();
  const parts = [info.limit == null ? 'No daily limit is set.' : `Your daily stake limit: ${info.limit} ${ASSET}.`];
  if (info.pending_at) parts.push(`A change to ${info.pending == null ? 'no limit' : info.pending + ' ' + ASSET} starts on ${when(info.pending_at)}.`);
  if (info.excluded_until && new Date(info.excluded_until) > new Date()) parts.push(`Your account is paused until ${when(info.excluded_until)}.`);
  $('limCur').textContent = parts.join(' ');
  $('limUsed').textContent = `Staked in the last 24 hours: ${Number(info.staked_24h).toFixed(2)} ${ASSET}.`;
}
$('limitsBtn').onclick = async () => { $('limDlg').showModal(); say(''); await act('limits_get'); };
$('limClose').onclick = () => $('limDlg').close();
$('limSet').onclick = async () => {
  const v = Number($('limVal').value.replace(',', '.'));
  if (!(v > 0)) return say('Enter an amount above zero.');
  if (await act('limits_set', { limit: v })) { say('Saved.'); $('limVal').value = ''; }
};
$('limRemove').onclick = async () => { if (await act('limits_set', { limit: null })) say('Removal requested. It starts in 24 hours.'); };
document.querySelectorAll('#limDlg .ex').forEach((b) => {
  b.onclick = async () => {
    if (!confirm(`Pause your account for ${b.dataset.d} day(s)? You will not be able to start matches until then.`)) return;
    if (await act('exclude', { days: Number(b.dataset.d) })) say('Your account is paused.');
  };
});
$('limAcceptBtn').onclick = async () => {
  if (!$('limAge').checked || !$('limTerms').checked) return say('Please tick both boxes.');
  if (await act('accept_terms')) say('Thank you. You can play now.');
};
