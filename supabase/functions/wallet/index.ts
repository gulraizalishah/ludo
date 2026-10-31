// Deposits: gives each player their own USDT (TRC20) deposit address and credits confirmed deposits.
// Secrets (Edge Functions > Secrets): HD_SEED (required), CRON_SECRET (for the timer), TRONGRID_API_KEY (needed on mainnet),
// TRON_API and USDT_CONTRACT (optional: default to the Nile TEST network and its test USDT).
import { admin, cors, json, userFrom } from '../_shared/util.ts';
import { deriveAddress, parseDeposits, isValidTronAddress } from '../_shared/tron.js';
import { setting, tryPayout, confirmProcessing, setNote } from '../_shared/payout.ts';
import type { PayoutResult } from '../_shared/payout.ts';

const env = (k: string, d = '') => Deno.env.get(k) || d;
const API = () => env('TRON_API', 'https://nile.trongrid.io');
const USDT = () => env('USDT_CONTRACT', 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf');   // Nile test USDT
const NETWORK = () => (API().includes('nile') ? 'nile' : API().includes('shasta') ? 'shasta' : 'mainnet');
const MIN_DEPOSIT = 1;   // USDT; smaller transfers are ignored (dust / address-poisoning spam)
type DB = ReturnType<typeof admin>;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body;
    const db = admin();

    if (action === 'scan_all') {                                   // called by the timer, never by browsers
      const secret = env('CRON_SECRET');
      if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);
      const { data } = await db.from('deposit_addresses').select('user_id,address').not('address', 'like', 'pending-%').limit(100);
      let credited = 0;
      for (const r of data ?? []) {
        try { credited += (await scan(db, r.user_id, r.address)).length; } catch (e) { console.error(r.user_id, String(e)); }
        await new Promise((ok) => setTimeout(ok, 400));            // stay under TronGrid's rate limit
      }
      const confirmed = await confirmProcessing(db);               // also settles withdrawals that were being sent
      return json({ ok: true, scanned: data?.length ?? 0, credited, confirmed });
    }

    const user = await userFrom(req);
    if (!user) return json({ error: 'Please log in first.' }, 401);
    if (action === 'withdraw') {                                   // a player cashes out
      const amount = Number(body.amount), to = String(body.to ?? '').trim();
      if (!(amount > 0)) return json({ error: 'Enter an amount.' }, 400);
      if (!isValidTronAddress(to)) return json({ error: 'That is not a valid TRON (TRC20) address. Check it and try again.' }, 400);
      const { count } = await db.from('withdrawals').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'pending');
      if ((count ?? 0) >= 3) return json({ error: 'You already have 3 withdrawals waiting. Please wait for them to be processed.' }, 400);
      const { data, error } = await db.rpc('request_withdrawal', { p_user: user.id, p_amount: amount.toFixed(6), p_address: to });
      if (error) return json({ error: /violates check|wallets/i.test(error.message) ? 'Not enough available balance.' : error.message }, 400);
      // Normal withdrawals are paid out automatically. Very large ones (or when the hot wallet is empty) wait for the admin.
      const max = await setting(db, 'auto_withdraw_max'), dailyMax = await setting(db, 'auto_withdraw_daily_max');
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data: recent } = await db.from('withdrawals').select('amount').eq('user_id', user.id).neq('status', 'rejected').gte('created_at', since);
      const day = (recent ?? []).reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);   // includes this one
      let result: PayoutResult & { reason?: string } = { status: 'queued', reason: 'limit' };
      if (amount <= max && day <= dailyMax && env('HD_SEED')) result = await tryPayout(db, { id: data, amount: amount.toFixed(6), to_address: to });
      else await setNote(db, data, !env('HD_SEED') ? 'Automatic payouts are not set up (the HD_SEED secret is missing).' : amount > max ? `Over the automatic limit of ${max} USDT per withdrawal.` : `This player passed the automatic limit of ${dailyMax} USDT in 24 hours.`);
      return json({ ok: true, id: data, status: result.status, reason: result.reason });
    }
    if (action === 'check') await confirmProcessing(db);          // settle payouts first, whatever else happens
    const address = await addressFor(db, user.id);
    if (action === 'address') return json({ address, network: NETWORK(), contract: USDT(), min: MIN_DEPOSIT });
    if (action === 'check') return json({ credited: await scan(db, user.id, address), network: NETWORK() });
    return json({ error: 'bad action' }, 400);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

async function addressFor(db: DB, uid: string): Promise<string> {
  const { data } = await db.from('deposit_addresses').select('address,derivation_index').eq('user_id', uid).maybeSingle();
  let index = data?.derivation_index;
  if (data && !String(data.address).startsWith('pending-')) return data.address;
  if (!data) {
    const ins = await db.from('deposit_addresses').insert({ user_id: uid, address: 'pending-' + crypto.randomUUID() }).select('derivation_index').single();
    if (ins.error) {                                               // two requests at once: use the other one's row
      const again = await db.from('deposit_addresses').select('address,derivation_index').eq('user_id', uid).maybeSingle();
      if (!again.data) throw new Error(ins.error.message);
      if (!String(again.data.address).startsWith('pending-')) return again.data.address;
      index = again.data.derivation_index;
    } else index = ins.data.derivation_index;
  }
  const address = deriveAddress(env('HD_SEED'), index);
  await db.from('deposit_addresses').update({ address }).eq('user_id', uid);
  return address;
}

// Read the confirmed USDT transfers into this address and credit each one once (the database refuses repeats).
async function scan(db: DB, uid: string, address: string) {
  const url = `${API()}/v1/accounts/${address}/transactions/trc20?only_confirmed=true&only_to=true&limit=200&contract_address=${USDT()}`;
  const headers: Record<string, string> = {};
  if (env('TRONGRID_API_KEY')) headers['TRON-PRO-API-KEY'] = env('TRONGRID_API_KEY');
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TronGrid answered ${res.status}`);
  const credited: { tx: string; amount: string }[] = [];
  for (const d of parseDeposits(await res.json(), address, USDT(), MIN_DEPOSIT)) {
    const { data, error } = await db.rpc('credit_deposit', { p_user: uid, p_tx: d.tx, p_amount: d.amount });
    if (error) throw new Error(error.message);
    if (data === true) credited.push(d);
  }
  return credited;
}
