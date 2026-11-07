// Paste the two values from Supabase: Project Settings > API.
// The anon key is public by design (row-level security protects the data).
// NEVER put the service_role key in this file or anywhere in GitHub.
export const SUPABASE_URL = 'YOUR_PROJECT_URL';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_PUBLIC_KEY';
// Optional bot check on the sign-up page (Cloudflare Turnstile, free): paste the SITE key here, and the SECRET key in
// Supabase > Authentication > Attack Protection. Leave empty to switch the bot check off.
export const TURNSTILE_SITE_KEY = '';
