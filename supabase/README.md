# Supabase database

Run the files in `migrations/` in order (Dashboard > SQL Editor, or `supabase db push`).
Money logic lives in SQL functions callable only by `service_role` (Edge Functions). Never put the service-role key in the browser or in git.
Check regularly: `select * from ledger_mismatches;` must return no rows.

## Edge Functions (online matches)
`functions/lobby` joins/leaves a table. `functions/game` rolls dice, validates moves, pays out.
`functions/_shared/engine.js` must be an exact copy of the root `engine.js`.
After changing `engine.js`, run (Windows): `copy /Y engine.js supabase\functions\_shared\engine.js`
Deploy: `npx supabase login`, then
`npx supabase functions deploy lobby --project-ref YOUR_REF --use-api`
`npx supabase functions deploy game --project-ref YOUR_REF --use-api`
(YOUR_REF = the code in your project URL: https://YOUR_REF.supabase.co). No secrets to set: the service key is provided inside the functions automatically.
