// Admin actions: look at the money, handle withdrawals that need a human, move your earnings to your balance.
// Only accounts with profiles.is_admin = true are allowed.
import { admin, cors, json, userFrom } from '../_shared/util.ts';
import { tryPayout, confirmProcessing, hotStatus, chainCfg } from '../_shared/payout.ts';
import { txStatus } from '../_shared/tron.js';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await userFrom(req);
    if (!user) return json({ error: 'Please log in first.' }, 401);
    const db = admin();
    const { data: me } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle();
    if (!me?.is_admin) return json({ error: 'Admins only.' }, 403);
    const body = await req.json().catch(() => ({}));

    if (body.action === 'overview') {
      await confirmProcessing(db).catch(() => 0);                  // settle payouts that were on their way
      const { data, error } = await db.from('admin_overview').select('*').single();
      if (error) return json({ error: error.message }, 500);
      let hot = null; try { hot = await hotStatus(); } catch (e) { hot = { error: String(e instanceof Error ? e.message : e) }; }
      const api = chainCfg().api, network = api.includes('nile') ? 'nile' : api.includes('shasta') ? 'shasta' : 'mainnet';
      return json({ overview: data, hot, network });
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
