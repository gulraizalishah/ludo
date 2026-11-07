// Log in, sign up, forgot password and reset password: one page, four forms.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as cfg from './config.js';          // (read by name so an older config.js without TURNSTILE_SITE_KEY still works)

const $ = (id) => document.getElementById(id);
const configured = typeof cfg.SUPABASE_URL === 'string' && cfg.SUPABASE_URL.startsWith('https://');
const sb = configured ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
const friendly = (m) => (/load failed|failed to fetch|network|fetch/i.test(m)
  ? "Can't reach the server. If the project was idle for a while it may be paused: open the Supabase dashboard and press Restore." : m);
const msg = (t, good) => { $('msg').textContent = friendly(t); $('msg').className = good ? 'good' : ''; };
const FORMS = { login: 'loginForm', signup: 'signupForm', forgot: 'forgotForm', reset: 'resetForm' };
let mode = 'login', captchaToken = null;

function setMode(m) {
  mode = m; msg('');
  for (const [k, id] of Object.entries(FORMS)) $(id).hidden = k !== m;
  $('tabLogin').setAttribute('aria-selected', m === 'login'); $('tabSignup').setAttribute('aria-selected', m === 'signup');
  document.querySelector('.tabs').hidden = m === 'reset' || m === 'forgot';
  $('captcha').hidden = m === 'reset';
}
$('tabLogin').onclick = () => setMode('login'); $('tabSignup').onclick = () => setMode('signup');
$('forgot').onclick = () => setMode('forgot'); $('fgBack').onclick = () => setMode('login');
const enter = (ids, btn) => ids.forEach((i) => $(i).addEventListener('keydown', (e) => { if (e.key === 'Enter') $(btn).click(); }));
enter(['liEmail', 'liPw'], 'liGo'); enter(['suEmail', 'suName', 'suPw', 'suPw2'], 'suGo'); enter(['fgEmail'], 'fgGo'); enter(['rsPw', 'rsPw2'], 'rsGo');

// ---- bot check (Cloudflare Turnstile). Only active when TURNSTILE_SITE_KEY is filled in config.js and switched on in Supabase.
if (cfg.TURNSTILE_SITE_KEY) {
  const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true;
  s.onload = () => window.turnstile.render('#captcha', { sitekey: cfg.TURNSTILE_SITE_KEY, theme: 'dark', callback: (t) => { captchaToken = t; }, 'expired-callback': () => { captchaToken = null; } });
  document.head.append(s);
}
const humanOk = () => { if (cfg.TURNSTILE_SITE_KEY && !captchaToken) { msg('Please tick the box to show you are human.'); return false; } return true; };
const afterTry = () => { if (window.turnstile && cfg.TURNSTILE_SITE_KEY) { window.turnstile.reset(); captchaToken = null; } };
const opts = (extra = {}) => ({ ...extra, ...(captchaToken ? { captchaToken } : {}) });
const ready = () => { if (!sb) { msg('The site is not connected yet: fill in config.js.'); return false; } return true; };
const goHome = () => { location.href = 'index.html'; };

$('liGo').onclick = async () => {
  if (!ready() || !humanOk()) return;
  const email = $('liEmail').value.trim(), password = $('liPw').value;
  if (!email || !password) return msg('Enter your email and password.');
  msg('Logging in…');
  let r; try { r = await sb.auth.signInWithPassword({ email, password, options: opts() }); } catch (e) { afterTry(); return msg(e.message); }
  afterTry();
  if (r.error) return msg(r.error.message === 'Email not confirmed' ? 'Please confirm your email first: open the link we sent you.' : r.error.message);
  goHome();
};

$('suGo').onclick = async () => {
  if (!ready()) return;
  const email = $('suEmail').value.trim(), name = $('suName').value.trim(), pw = $('suPw').value;
  if (!/^\S+@\S+\.\S+$/.test(email)) return msg('Enter a valid email address.');
  if (name && !/^[A-Za-z0-9_]{3,20}$/.test(name)) return msg('Username: 3-20 letters, numbers or underscore.');
  if (pw.length < 8) return msg('The password must have at least 8 characters.');
  if (pw !== $('suPw2').value) return msg('The two passwords are not the same.');
  if (!$('suAge').checked) return msg('You must be 18 or older to create an account.');
  if (!$('suTerms').checked) return msg('Please accept the Terms and the Privacy Policy.');
  if (!humanOk()) return;
  msg('Creating your account…');
  if (name) localStorage.setItem('pendingName', name);
  let r; try {
    r = await sb.auth.signUp({ email, password: pw, options: opts({ data: { age_confirmed: true, terms_accepted: true }, emailRedirectTo: location.origin + '/index.html' }) });
  } catch (e) { afterTry(); return msg(e.message); }
  afterTry();
  if (r.error) return msg(r.error.message);
  if (!r.data.session) return msg('Almost done: we sent you an email. Open the link in it to confirm your address, then come back and log in.', true);
  goHome();
};

$('fgGo').onclick = async () => {
  if (!ready() || !humanOk()) return;
  const email = $('fgEmail').value.trim(); if (!email) return msg('Enter your email.');
  let r; try { r = await sb.auth.resetPasswordForEmail(email, opts({ redirectTo: location.origin + '/login.html' })); } catch (e) { afterTry(); return msg(e.message); }
  afterTry();
  msg(r.error ? r.error.message : 'If that email has an account, a link is on its way. Open it on this device.', !r.error);
};

$('rsGo').onclick = async () => {
  const pw = $('rsPw').value;
  if (pw.length < 8) return msg('The password must have at least 8 characters.');
  if (pw !== $('rsPw2').value) return msg('The two passwords are not the same.');
  const r = await sb.auth.updateUser({ password: pw });
  if (r.error) return msg(r.error.message);
  msg('Password changed. Taking you to the game…', true); setTimeout(goHome, 1200);
};

if (sb) {
  const recovery = location.hash.includes('type=recovery');
  if (recovery) setMode('reset');
  sb.auth.onAuthStateChange((event, session) => setTimeout(() => {
    if (event === 'PASSWORD_RECOVERY') return setMode('reset');
    if (session && mode !== 'reset' && !recovery) goHome();     // already logged in: nothing to do here
  }, 0));
}
setMode(mode);
