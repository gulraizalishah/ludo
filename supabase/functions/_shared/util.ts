import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const cors = {
  // Set the ALLOWED_ORIGIN secret (e.g. https://your-site.netlify.app) to accept requests from your site only.
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Service-role client: bypasses row-level security. These env vars are provided automatically
// inside Supabase Edge Functions; the key never reaches the browser.
export const admin = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

export async function userFrom(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  return error || !data.user ? null : data.user;
}

export const tokenOf = (req: Request) => (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
// "aal2" in the login token means the two-step code was entered. (The token itself is verified by userFrom.)
export function aalOf(token: string): string {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aal ?? ''; } catch { return ''; }
}
export const countryOf = (req: Request) => (req.headers.get('cf-ipcountry') ?? '').toUpperCase();
// Countries listed in app_settings.blocked_countries cannot start matches or deposit. (Withdrawals stay open so nobody's money is trapped.)
export async function geoBlocked(db: ReturnType<typeof admin>, req: Request): Promise<string | null> {
  const { data } = await db.from('app_settings').select('key,value').in('key', ['blocked_countries', 'geo_strict']);
  const s: Record<string, unknown> = {};
  for (const r of data ?? []) s[r.key] = r.value;
  const blocked = Array.isArray(s.blocked_countries) ? (s.blocked_countries as string[]).map((c) => String(c).toUpperCase()) : [];
  const c = countryOf(req);
  if (c && blocked.includes(c)) return 'This service is not available in your country.';
  if (!c && s.geo_strict === true) return 'We could not determine your country, so this action is not available.';
  return null;
}
