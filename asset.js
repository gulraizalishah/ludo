// The game currency and the stake buttons come from the app_settings table, so they can be changed without touching code.
export let ASSET = 'USDT', STAKES = [1, 2, 5, 10];
export const paint = () => document.querySelectorAll('.asset').forEach((e) => { e.textContent = ASSET; });
export async function loadSettings(sb) {
  const { data } = await sb.from('app_settings').select('key,value').in('key', ['asset', 'stake_options']);
  for (const r of data ?? []) {
    if (r.key === 'asset' && typeof r.value === 'string') ASSET = r.value;
    if (r.key === 'stake_options' && Array.isArray(r.value)) { const s = r.value.map(Number).filter((n) => n > 0); if (s.length) STAKES = s; }
  }
  paint(); document.dispatchEvent(new Event('settings-loaded'));
}
