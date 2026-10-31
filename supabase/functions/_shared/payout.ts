// Automatic USDT payouts: send, then confirm on the chain. Shared by the wallet and admin functions.
import { admin } from './util.ts';
import { hotWallet, buildSignedTransfer, broadcast, txStatus, balancesOf, toMicro } from './tron.js';

type DB = ReturnType<typeof admin>;
const env = (k: string, d = '') => Deno.env.get(k) || d;
export const chainCfg = () => ({
  api: env('TRON_API', 'https://nile.trongrid.io'), apiKey: env('TRONGRID_API_KEY'),
  contract: env('USDT_CONTRACT', 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'), feeLimit: Number(env('FEE_LIMIT_SUN', '100000000')),
});
export const hot = () => hotWallet(env('HD_SEED'));
const MIN_TRX_FOR_FEES = 30;           // the hot wallet pays the network fee in TRX

export async function setting(db: DB, key: string): Promise<number> {
  const { data } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  return Number(data?.value ?? 0);
}

// Try to pay one pending withdrawal automatically. Returns 'processing' (sent to the network), 'queued' (left for you).
export async function tryPayout(db: DB, w: { id: string; amount: string; to_address: string }): Promise<'processing' | 'queued'> {
  const { data: claimed } = await db.rpc('claim_withdrawal', { p_id: w.id });   // only one caller can win
  if (!claimed) return 'queued';
  let stored = false;
  try {
    const cfg = chainCfg(), h = hot(), amount = Number(w.amount);
    const bal = await balancesOf(cfg, h.address);
    if (bal.usdt < amount || bal.trx < MIN_TRX_FOR_FEES) { await db.rpc('release_withdrawal', { p_id: w.id }); return 'queued'; }
    const { txid, signed } = await buildSignedTransfer(cfg, { fromPriv: h.priv, fromAddress: h.address, to: w.to_address, amountMicro: toMicro(w.amount) });
    await db.rpc('set_withdrawal_tx', { p_id: w.id, p_tx: txid });                // saved BEFORE broadcasting
    stored = true;
    await broadcast(cfg, signed);                                                  // if this reply is lost, confirmProcessing finds the transaction by its id
    return 'processing';
  } catch (e) {
    console.error('payout', w.id, String(e));
    if (!stored) await db.rpc('release_withdrawal', { p_id: w.id });              // nothing was sent: back to the queue
    return stored ? 'processing' : 'queued';
  }
}

// Look at withdrawals being sent: confirmed -> sent; failed or never appeared (expired) -> refund the player.
export async function confirmProcessing(db: DB) {
  const { data } = await db.from('withdrawals').select('id,tx_hash,processing_at').eq('status', 'processing').limit(50);
  const cfg = chainCfg(); let done = 0;
  for (const w of data ?? []) {
    const age = Date.now() - new Date(w.processing_at).getTime();
    try {
      if (!w.tx_hash) { if (age > 5 * 60_000) await db.rpc('release_withdrawal', { p_id: w.id }); continue; }   // nothing was ever broadcast
      const s = await txStatus(cfg, w.tx_hash);
      if (s === 'success') { await db.rpc('mark_withdrawal_sent', { p_id: w.id, p_tx: w.tx_hash }); done++; }
      else if (s === 'failed') { await db.rpc('reject_withdrawal', { p_id: w.id }); done++; }
      else if (age > 15 * 60_000) { await db.rpc('reject_withdrawal', { p_id: w.id }); done++; }   // transactions expire after about a minute: it can never arrive now
    } catch (e) { console.error('confirm', w.id, String(e)); }
  }
  return done;
}

export async function hotStatus() {
  const cfg = chainCfg(), h = hot();
  try { return { address: h.address, ...(await balancesOf(cfg, h.address)) }; } catch (e) { return { address: h.address, trx: null, usdt: null, error: String(e) }; }
}
