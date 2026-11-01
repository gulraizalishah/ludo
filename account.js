// Accounts + wallet display. Practice games work without logging in.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { ASSET, loadSettings } from './asset.js';

const $ = (id) => document.getElementById(id);
const configured = SUPABASE_URL.startsWith('https://');
export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const fmt = (n) => Number(n).toFixed(2);
const friendly = (m) => (/load failed|failed to fetch|network|fetch/i.test(m)
  ? "Can't reach the server. If your Supabase project was idle for a while it may be paused: open the Supabase dashboard and press Restore." : m);
const msg = (t) => { $('authMsg').textContent = friendly(t); };
let mode = 'login', channel = null, currentId = null;

function setMode(m) {
  mode = m;
  $('authTitle').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('authGo').textContent = m === 'login' ? 'Log in' : 'Sign up';
  $('authSwap').textContent = m === 'login' ? 'New here? Sign up' : 'Have an account? Log in';
  $('unameRow').hidden = m === 'login';
  $('pw').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  msg('');
}
$('login').onclick = () => { setMode('login'); $('authDlg').showModal(); };
$('authClose').onclick = () => $('authDlg').close();
$('authSwap').onclick = () => setMode(mode === 'login' ? 'signup' : 'login');
['em', 'pw', 'un'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('authGo').click(); }));

$('authGo').onclick = async () => {
  if (!sb) return msg('Supabase is not connected yet: fill in config.js.');
  const email = $('em').value.trim(), password = $('pw').value;
  if (!email || password.length < 8) return msg('Enter an email and a password of at least 8 characters.');
  msg('Working…');
  if (mode === 'signup') {
    const un = $('un').value.trim();
    if (un && !/^[A-Za-z0-9_]{3,20}$/.test(un)) return msg('Username: 3-20 letters, numbers or underscore.');
    if (un) localStorage.setItem('pendingName', un);
    let r; try { r = await sb.auth.signUp({ email, password }); } catch (e) { return msg(e.message); }
    const { data, error } = r;
    if (error) return msg(error.message);
    if (!data.session) return msg('Check your email to confirm your account, then log in.');
  } else {
    let r; try { r = await sb.auth.signInWithPassword({ email, password }); } catch (e) { return msg(e.message); }
    if (r.error) return msg(r.error.message);
  }
  $('pw').value = ''; $('authDlg').close();
};
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
