// A tiny public health check for the outside watchdog (GitHub Actions). It reveals only: is the timer alive, do the books balance.
import { admin, cors, json } from '../_shared/util.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const db = admin();
    const { data: ls } = await db.from('app_settings').select('value').eq('key', 'last_scan_at').maybeSingle();
    const age = ls?.value ? Math.round((Date.now() - new Date(String(ls.value)).getTime()) / 1000) : null;
    const { data: ov } = await db.from('admin_overview').select('unaccounted,wallet_mismatches').maybeSingle();
    const books_ok = !!ov && Number(ov.unaccounted) === 0 && Number(ov.wallet_mismatches) === 0;
    return json({ ok: age !== null && age < 300 && books_ok, timer_age_seconds: age, books_ok });
  } catch (e) {
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
