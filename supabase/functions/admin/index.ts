// Admin actions: look at the money, handle withdrawals that need a human, move your earnings to your balance.
// Only accounts with profiles.is_admin = true are allowed.
import { admin, cors, json, userFrom, aalOf, tokenOf } from '../_shared/util.ts';
import { notify } from '../_shared/alerts.ts';
import { tryPayout, confirmProcessing, hotStatus, chainCfg, assetOf } from '../_shared/payout.ts';
import { txStatus } from '../_shared/tron.js';
import { sweepAll, confirmSweeps } from '../_shared/sweep.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: 'Please log in first.' }, 401);
    const db = admin();
    const { data: me } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle();
    if (!me?.is_admin) return json({ error: 'Admins only.' }, 403);
    // Two-step login: the token must carry "aal2" (the authenticator code was entered). Emergency switch-off: secret ADMIN_REQUIRE_MFA=false.
    if (Deno.env.get('ADMIN_REQUIRE_MFA') !== 'false' && aalOf(tokenOf(req)) !== 'aal2') return json({ error: 'Two-step login required.', code: 'mfa' }, 403);
    const body = await req.json().catch(() => ({}));

    if (body.action === 'overview') {
      await confirmProcessing(db).catch(() => 0);                  // settle payouts that were on their way
      const { data, error } = await db.from('admin_overview').select('*').single();
      if (error) return json({ error: error.message }, 500);
      let hot = null; try { hot = await hotStatus(); } catch (e) { hot = { error: String(e instanceof Error ? e.message : e) }; }
      const api = chainCfg().api, network = api.includes('nile') ? 'nile' : api.includes('shasta') ? 'shasta' : 'mainnet';
      await confirmSweeps(db).catch(() => null);
      const { data: recentSweeps } = await db.from('sweeps').select('id,address,kind,status,amount,tx_hash,created_at').neq('kind', 'check').order('created_at', { ascending: false }).limit(8);
      const { data: done } = await db.from('sweeps').select('amount').eq('kind', 'sweep').eq('status', 'confirmed').limit(5000);
      const swept_total = (done ?? []).reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);
      const { data: ls } = await db.from('app_settings').select('value').eq('key', 'last_scan_at').maybeSingle();
      return json({ overview: data, hot, network, asset: await assetOf(db), sweeps: recentSweeps ?? [], swept_total, last_scan_at: ls?.value ?? null });
    }
    if (body.action === 'pending' || body.action === 'recent') {
      const pending = body.action === 'pending';
      let q = db.from('withdrawals').select('id,user_id,amount,to_address,status,tx_hash,note,created_at,processed_at');
      q = pending ? q.in('status', ['pending', 'processing']).order('created_at', { ascending: true }) : q.in('status', ['sent', 'rejected']).order('processed_at', { ascending: false });
      const { data } = await q.limit(pending ? 50 : 15);
      const rows = [];
      for (const w of data ?? []) {
        const { data: u } = await db.auth.admin.getUserById(w.user_id);
        const { data: p } = await db.from('profiles').select('username').eq('id', w.user_id).maybeSingle();
        rows.push({ ...w, email: u?.user?.email ?? '?', username: p?.username ?? null });
      }
      return json({ rows });
    }
    if (body.action === 'transactions') {                          // everything that moved money, newest first
      const groups: Record<string, string[]> = {
        deposits: ['deposit'], withdrawals: ['withdrawal_request', 'withdrawal_refund'],
        matches: ['stake_lock', 'stake_refund', 'match_win', 'match_loss', 'platform_fee'], earnings: ['platform_payout'],
      };
      let q = db.from('ledger').select('id,user_id,kind,d_available,d_locked,created_at,ref').order('created_at', { ascending: false });
      if (groups[body.filter]) q = q.in('kind', groups[body.filter]);
      const { data } = await q.limit(100);
      const names: Record<string, string> = {};
      for (const r of data ?? []) {
        if (!r.user_id || names[r.user_id]) continue;
        const { data: u } = await db.auth.admin.getUserById(r.user_id);
        const { data: p } = await db.from('profiles').select('username').eq('id', r.user_id).maybeSingle();
        names[r.user_id] = p?.username || u?.user?.email || '?';
      }
      const ids = (data ?? []).filter((r: { kind: string; ref: string | null }) => r.kind === 'withdrawal_request' && r.ref).map((r: { ref: string }) => r.ref);
      const wd: Record<string, unknown> = {};
      if (ids.length) { const { data: ws } = await db.from('withdrawals').select('id,status,to_address,tx_hash,note').in('id', ids); for (const x of ws ?? []) wd[x.id] = x; }
      return json({ rows: (data ?? []).map((r: { user_id: string | null; ref: string | null }) => ({ ...r, who: r.user_id ? names[r.user_id] : 'Platform', withdrawal: r.ref ? wd[r.ref] ?? null : null })) });
    }
    if (['sent', 'reject', 'retry'].includes(body.action)) {
      const { data: w } = await db.from('withdrawals').select('id,amount,to_address,status').eq('id', body.id).maybeSingle();
      if (!w) return json({ error: 'Withdrawal not found.' }, 404);
      if (w.status !== 'pending') return json({ error: w.status === 'processing' ? 'This one is already being sent automatically. Wait for the network to confirm it.' : 'This withdrawal is already finished.' }, 400);
      if (body.action === 'retry') return json({ ok: true, ...(await tryPayout(db, w)) });
      if (body.action === 'reject') { const { error } = await db.rpc('reject_withdrawal', { p_id: w.id }); return error ? json({ error: error.message }, 400) : json({ ok: true }); }
      const tx = String(body.tx ?? '').trim();                     // 'sent': you paid it yourself, record the transaction id
      if (!/^[0-9a-fA-F]{64}$/.test(tx)) return json({ error: 'That does not look like a transaction id (64 letters and numbers).' }, 400);
      const seen = await txStatus(chainCfg(), tx).catch(() => 'unknown');   // a made-up id can never mark a withdrawal as paid
      if (seen !== 'success') return json({ error: 'The network does not show this transaction as successful. Check the id (it is not the wallet address), or wait a minute after sending.' }, 400);
      const { error } = await db.rpc('mark_withdrawal_sent', { p_id: w.id, p_tx: tx });
      return error ? json({ error: error.message }, 400) : json({ ok: true });
    }
    if (body.action === 'test_alert') return json({ ok: await notify('Test alert from your Ludo admin page. If you can read this, alerts work.') });
    if (body.action === 'risk') {                                  // accounts that look connected to each other
      const name = async (id: string) => { const { data: u } = await db.auth.admin.getUserById(id); const { data: p } = await db.from('profiles').select('username').eq('id', id).maybeSingle(); return p?.username || u?.user?.email || '?'; };
      const { data: addr } = await db.from('admin_risk_addresses').select('*').limit(20);
      const addresses = [];
      for (const a of addr ?? []) {
        const { data: ws } = await db.from('withdrawals').select('user_id').eq('to_address', a.to_address);
        const ids = [...new Set((ws ?? []).map((w: { user_id: string }) => w.user_id))];
        addresses.push({ ...a, users: await Promise.all(ids.map(name)) });
      }
      const { data: prs } = await db.from('admin_risk_pairs').select('*').limit(50);
      const pairs = [];
      for (const p of prs ?? []) {
        const lopsided = Math.max(Number(p.wins_a), Number(p.wins_b)) / Number(p.matches) >= 0.8;
        pairs.push({ ...p, a: await name(p.user_a), b: await name(p.user_b), lopsided });
      }
      return json({ addresses, pairs: pairs.sort((x, y) => Number(y.lopsided) - Number(x.lopsided) || Number(y.matches) - Number(x.matches)) });
    }
    if (body.action === 'readiness') {                             // a pre-launch checklist the server can verify
      const checks: { name: string; status: 'ok' | 'warn' | 'info'; hint: string }[] = [];
      const add = (name: string, ok: boolean, okHint: string, badHint: string, bad: 'warn' | 'info' = 'warn') => checks.push({ name, status: ok ? 'ok' : bad, hint: ok ? okHint : badHint });
      const set = async (k: string) => (await db.from('app_settings').select('value').eq('key', k).maybeSingle()).data?.value;
      add('Real TRON network', !/nile|shasta/.test(chainCfg().api), 'Using the real TRON network.', 'Still on the TRON test network. Fine for testing, switch for launch.', 'info');
      const tm = await set('testing_mode'); add('Testing mode off', !(tm === true || tm === 'true'), 'The wipe script is locked.', 'testing_mode is still on, so the wipe script could delete money records. Set it to false before launch.');
      add('Secret seed set', /^[0-9a-f]{64}$/i.test(Deno.env.get('HD_SEED') ?? ''), 'HD_SEED is set.', 'The HD_SEED secret is missing.');
      const ls = await set('last_scan_at'), age = ls ? (Date.now() - new Date(String(ls)).getTime()) / 1000 : null;
      add('Deposit timer running', age !== null && age < 180, 'The timer ran in the last 3 minutes.', 'The deposit timer is not running. Run schedule_deposit_scan.sql.');
      const { data: ov } = await db.from('admin_overview').select('unaccounted,wallet_mismatches,pending_amount').maybeSingle();
      add('Books balance', !!ov && Number(ov.unaccounted) === 0 && Number(ov.wallet_mismatches) === 0, 'Every coin is accounted for.', 'The books do not balance. Investigate before anything else.');
      const hot = await hotStatus().catch(() => null); const asset = await assetOf(db);
      const have = hot ? (asset === 'TRX' ? hot.trx : hot.usdt) : null;
      add('Payout wallet funded', have != null && have > Number(ov?.pending_amount ?? 0), `Payout wallet holds ${have} ${asset}.`, 'The payout wallet is empty or too low for the waiting withdrawals.');
      try { const s = await (await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/settings`, { headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' } })).json();
        add('Email confirmation required', s.mailer_autoconfirm === false, 'New accounts must confirm their email.', 'Email confirmation is OFF. Turn it on in Authentication > Sign In / Providers > Email.'); }
      catch { checks.push({ name: 'Email confirmation required', status: 'info', hint: 'Could not check. Look in Authentication > Sign In / Providers > Email.' }); }
      checks.push({ name: 'Bot check (CAPTCHA)', status: 'info', hint: 'Cannot be checked from here. Enable it in Authentication > Attack Protection and add the site key to config.js.' });
      const [a, m, r] = [Number(await set('withdraw_min_age_hours')), Number(await set('withdraw_min_matches')), Number(await set('withdraw_wager_ratio'))];
      add('Withdrawal safeguards on', a > 0 || m > 0 || r > 0, 'At least one safeguard is active.', 'All withdrawal safeguards are off (new-account wait, matches played, play-through). See LAUNCH_CHECKLIST.md.');
      add('First withdrawal reviewed', (await set('first_withdrawal_manual')) === true, 'The first withdrawal of each account waits for you.', 'Not enabled. Recommended at launch.', 'info');
      add('Alerts connected', !!(Deno.env.get('TELEGRAM_BOT_TOKEN') && Deno.env.get('TELEGRAM_CHAT_ID')), 'Telegram is connected (use "Send test alert").', 'Telegram is not set up, so you will not hear about problems.');
      const bc = await set('blocked_countries'); add('Blocked countries', Array.isArray(bc) && bc.length > 0, `Blocking: ${(bc as string[] | undefined)?.join(', ')}.`, 'No countries are blocked.', 'info');
      checks.push({ name: 'Admin two-step login', status: 'ok', hint: 'You are logged in with a code, and the server insists on it.' });
      return json({ checks });
    }
    if (body.action === 'sweep_now') {                             // collect deposits into the payout wallet right now
      return json({ ok: true, summary: await sweepAll(db, 20) });
    }
    if (body.action === 'move_earnings') {                         // platform fees -> your own player balance; then use Withdraw
      const amount = Number(body.amount);
      if (!(amount > 0)) return json({ error: 'Enter an amount.' }, 400);
      const { error } = await db.rpc('platform_payout', { p_admin: user.id, p_amount: amount.toFixed(6) });
      return error ? json({ error: error.message }, 400) : json({ ok: true });
    }
    return json({ error: 'bad action' }, 400);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
