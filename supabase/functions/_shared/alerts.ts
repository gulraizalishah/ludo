// Messages to the owner (Telegram). Secrets: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. Without them nothing is sent.
import { admin } from './util.ts';
import { hotStatus, assetOf, setting } from './payout.ts';

type DB = ReturnType<typeof admin>;
const env = (k: string) => Deno.env.get(k) || '';

export async function notify(text: string): Promise<boolean> {
  const token = env('TELEGRAM_BOT_TOKEN'), chat = env('TELEGRAM_CHAT_ID');
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) });
    return r.ok;
  } catch { return false; }
}
// Each kind of alert is sent at most once per `hours`, so a problem does not flood your phone.
async function once(db: DB, topic: string, text: string, hours: number): Promise<boolean> {
  const key = 'alert_' + topic;
  const { data } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (data?.value && Date.now() - new Date(String(data.value)).getTime() < hours * 3600_000) return false;
  if (!(await notify(text))) return false;
  await db.from('app_settings').upsert({ key, value: new Date().toISOString() }, { onConflict: 'key' });
  return true;
}

export async function runAlerts(db: DB): Promise<string[]> {
  const sent: string[] = [];
  const { data: ov } = await db.from('admin_overview').select('*').maybeSingle();
  if (ov && (Number(ov.unaccounted) !== 0 || Number(ov.wallet_mismatches) !== 0)) {
    if (await once(db, 'books', `ALERT: the books do not balance (unaccounted ${ov.unaccounted}, wallet mismatches ${ov.wallet_mismatches}). Open the admin page now.`, 3)) sent.push('books');
  }
  const asset = await assetOf(db), hot = await hotStatus(), min = (await setting(db, 'alert_hot_min')) || 0, pending = Number(ov?.pending_amount ?? 0);
  const bal = asset === 'TRX' ? hot.trx : hot.usdt;
  if (bal != null && bal < min + pending) {
    if (await once(db, 'hot', `Payout wallet is low: ${Number(bal).toFixed(2)} ${asset} (withdrawals waiting: ${pending}). Top it up so payouts keep going.`, 6)) sent.push('hot');
  }
  const { data: old } = await db.from('withdrawals').select('id').eq('status', 'pending').lt('created_at', new Date(Date.now() - 30 * 60_000).toISOString()).limit(1);
  if ((old ?? []).length && await once(db, 'waiting', 'A withdrawal has been waiting for your approval for over 30 minutes. Open the admin page.', 6)) sent.push('waiting');
  const { data: failed } = await db.from('sweeps').select('id').eq('status', 'failed').gte('created_at', new Date(Date.now() - 3600_000).toISOString()).limit(5);
  if ((failed ?? []).length >= 3 && await once(db, 'sweeps', 'Collecting deposits keeps failing (3+ failures in the last hour). Open the admin page.', 6)) sent.push('sweeps');
  if (new Date().getUTCHours() === 6 && ov) {            // one daily summary, around 06:00 UTC
    const text = `Daily summary: books ${Number(ov.unaccounted) === 0 && Number(ov.wallet_mismatches) === 0 ? 'balance' : 'DO NOT BALANCE'}. Deposited in total ${Number(ov.deposits_total).toFixed(2)} ${asset}, paid out ${Number(ov.paid_out_total).toFixed(2)}, your fees ${Number(ov.platform_fees).toFixed(2)}, matches running ${ov.active_matches}, withdrawals waiting ${ov.pending_count}.`;
    if (await once(db, 'daily', text, 20)) sent.push('daily');
  }
  return sent;
}
