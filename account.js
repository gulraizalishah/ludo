// Accounts + wallet display. Practice games work without logging in.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { ASSET, loadSettings } from './asset.js';

const $ = (id) => document.getElementById(id);
const configured = SUPABASE_URL.startsWith('https://');
export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const fmt = (n) => Number(n).toFixed(2);
let channel = null, currentId = null;

$('login').onclick = () => { location.href = 'login.html'; };       // log in / sign up now live on their own page
$('logout').onclick = () => sb.auth.signOut();

async function refresh(id) {
  const { data } = await sb.from('wallets').select('available,locked').eq('user_id', id).maybeSingle();
  if (!data) return;
  $('bal').textContent = `${fmt(data.available)} ${ASSET}`;
  $('locked').textContent = Number(data.locked) > 0 ? `+ ${fmt(data.locked)} in play` : '';
}

async function onUser(user) {
  if ((user?.id ?? null) === currentId) return;         // ignore token refreshes
  currentId = user?.id ?? null;
  if (channel) { sb.removeChannel(channel); channel = null; }
  $('login').hidden = !!user; $('user').hidden = !user;
  if (!user) return;
  $('who').textContent = user.email;
  const pending = localStorage.getItem('pendingName');
  if (pending) { await sb.from('profiles').update({ username: pending }).eq('id', user.id); localStorage.removeItem('pendingName'); }
  const { data: p } = await sb.from('profiles').select('username').eq('id', user.id).maybeSingle();
  if (p?.username) $('who').textContent = p.username;
  await loadSettings(sb);
  await refresh(user.id);
  channel = sb.channel('wallet-' + user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wallets', filter: `user_id=eq.${user.id}` }, () => refresh(user.id))
    .subscribe();
}
// (callback kept synchronous: calling Supabase inside it directly can deadlock)
if (sb) sb.auth.onAuthStateChange((_e, session) => setTimeout(() => onUser(session?.user ?? null), 0));
