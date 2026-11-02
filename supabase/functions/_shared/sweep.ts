// Collecting deposits: move USDT from each player's deposit address into the payout wallet.
// Needs a little TRX on the deposit address for the network fee, so: (1) top up TRX, (2) later move the USDT.
// Every transaction id is saved BEFORE it is broadcast and confirmed on the chain afterwards.
import { admin } from './util.ts';
import { chainCfg, hot, assetOf, setting } from './payout.ts';
import { privateKeyFor, addressFromPrivateKey, buildSignedTransfer, buildSignedTrxTransfer, broadcast, txStatus, balancesOf, toMicro } from './tron.js';

type DB = ReturnType<typeof admin>;
type Cand = { user_id: string; address: string; derivation_index: number };
const env = (k: string, d: string) => Deno.env.get(k) || d;
const MIN_USDT = () => Number(env('SWEEP_MIN_USDT', '1'));          // do not bother collecting less than this
const MIN_TRX = () => Number(env('SWEEP_MIN_TRX', '15'));           // an address needs this much TRX to pay the fee
const TOPUP_TRX = () => Number(env('SWEEP_TOPUP_TRX', '25'));       // what we send when it has less
const HOT_KEEP_TRX = 30;                                             // the payout wallet always keeps this much for withdrawals

// A database answer that carries an error must stop the process BEFORE any money moves.
const must = <T>(r: { data?: T; error?: { message: string } | null }, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data as T; };

export async function confirmSweeps(db: DB, address?: string) {
  let q = db.from('sweeps').select('id,kind,tx_hash,created_at').eq('status', 'sent');
  if (address) q = q.eq('address', address);
  const { data } = await q.limit(100);
  const cfg = chainCfg();
  for (const s of data ?? []) {
    try {
      const age = Date.now() - new Date(s.created_at).getTime();
      const st = s.tx_hash ? await txStatus(cfg, s.tx_hash, fetch, true) : 'failed';
      if (st === 'success') await db.from('sweeps').update({ status: 'confirmed' }).eq('id', s.id);
      else if (st === 'failed' || age > 15 * 60_000) await db.from('sweeps').update({ status: 'failed' }).eq('id', s.id);
    } catch (e) { console.error('confirmSweeps', s.id, String(e)); }
  }
}

// One step for one address. Returns what happened: empty | waiting | paused | hot_low | funding | sweeping
export async function sweepAddress(db: DB, c: Cand): Promise<string> {
  const cfg = chainCfg(), h = hot();
  await confirmSweeps(db, c.address);
  const open = must(await db.from('sweeps').select('id').eq('address', c.address).eq('status', 'sent'), 'Cannot read the sweeps table (was migration 8 run?)');
  if ((open ?? []).length) return 'waiting';                                                    // something is already on its way
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { data: failed } = await db.from('sweeps').select('id').eq('address', c.address).eq('status', 'failed').gte('created_at', since);
  if ((failed ?? []).length >= 3) return 'paused';                                              // failing repeatedly: stop burning fees, tell the admin
  const bal = await balancesOf(cfg, c.address), asset = await assetOf(db);
  if (asset === 'TRX') {                                                                        // TRX mode: nothing to top up, a TRX transfer only uses free bandwidth
    const min = (await setting(db, 'sweep_min')) || 5, keep = 1_000_000n;                      // leave 1 TRX behind to cover the fee if free bandwidth is used up
    if (bal.trx < min) { must(await db.from('sweeps').insert({ user_id: c.user_id, address: c.address, kind: 'check', status: 'empty', amount: bal.trx }), 'Cannot record the sweep'); return 'empty'; }
    const key = privateKeyFor(Deno.env.get('HD_SEED') ?? '', c.derivation_index);
    if (addressFromPrivateKey(key) !== c.address) throw new Error('The derived key does not match this deposit address.');
    const sun = bal.trxSun - keep;
    const { txid, signed } = await buildSignedTrxTransfer(cfg, { fromPriv: key, fromAddress: c.address, to: h.address, amountSun: sun });
    must(await db.from('sweeps').insert({ user_id: c.user_id, address: c.address, kind: 'sweep', status: 'sent', amount: Number(sun) / 1e6, tx_hash: txid }), 'Cannot record the sweep');
    await broadcast(cfg, signed);
    return 'sweeping';
  }
  if (bal.usdtMicro < toMicro(String(MIN_USDT()))) {
    must(await db.from('sweeps').insert({ user_id: c.user_id, address: c.address, kind: 'check', status: 'empty', amount: bal.usdt }), 'Cannot record the sweep');
    return 'empty';
  }
  if (bal.trx < MIN_TRX()) {                                                                    // step 1: give the address TRX for the fee
    const hb = await balancesOf(cfg, h.address);
    if (hb.trx < TOPUP_TRX() + HOT_KEEP_TRX) return 'hot_low';
    const { txid, signed } = await buildSignedTrxTransfer(cfg, { fromPriv: h.priv, fromAddress: h.address, to: c.address, amountSun: BigInt(Math.round(TOPUP_TRX() * 1e6)) });
    must(await db.from('sweeps').insert({ user_id: c.user_id, address: c.address, kind: 'topup', status: 'sent', amount: TOPUP_TRX(), tx_hash: txid }), 'Cannot record the sweep');
    await broadcast(cfg, signed);
    return 'funding';
  }
  const priv = privateKeyFor(Deno.env.get('HD_SEED') ?? '', c.derivation_index);                // step 2: move all the USDT into the payout wallet
  if (addressFromPrivateKey(priv) !== c.address) throw new Error('The derived key does not match this deposit address.');
  const feeLimit = Math.min(cfg.feeLimit, Math.floor((bal.trx - 1) * 1e6));
  const { txid, signed } = await buildSignedTransfer({ ...cfg, feeLimit }, { fromPriv: priv, fromAddress: c.address, to: h.address, amountMicro: bal.usdtMicro });
  must(await db.from('sweeps').insert({ user_id: c.user_id, address: c.address, kind: 'sweep', status: 'sent', amount: bal.usdt, tx_hash: txid }), 'Cannot record the sweep');
  await broadcast(cfg, signed);
  return 'sweeping';
}

export async function sweepAll(db: DB, limit = 10) {
  await confirmSweeps(db);
  const { data } = await db.rpc('sweep_candidates', { p_limit: limit });
  const summary: Record<string, number | string[]> = {};
  for (const c of (data ?? []) as Cand[]) {
    let r = 'error';
    try { r = await sweepAddress(db, c); } catch (e) { console.error('sweep', c.address, String(e)); (summary as Record<string, unknown>).errors = [...(((summary as Record<string, unknown>).errors as string[]) ?? []), String(e instanceof Error ? e.message : e).slice(0, 160)]; }
    summary[r] = ((summary[r] as number) ?? 0) + 1;
  }
  return summary;
}
