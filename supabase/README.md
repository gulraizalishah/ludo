# Supabase database

Run the files in `migrations/` in order (Dashboard > SQL Editor, or `supabase db push`).
Money logic lives in SQL functions callable only by `service_role` (Edge Functions). Never put the service-role key in the browser or in git.
Check regularly: `select * from ledger_mismatches;` must return no rows.
