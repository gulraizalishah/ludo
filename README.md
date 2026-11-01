# Ludo

Browser Ludo with house rules (blockades, capture-to-unlock home lane, star-square attacks),
practice games vs bots, and online stake matches (USDT balance in Supabase). Plain HTML/CSS/JS, no build step.

## Files
- `index.html`, `style.css`, `app.js` - game screens, board, animations, bots
- `engine.js` - pure rules engine (also copied to `supabase/functions/_shared/engine.js`; keep both identical)
- `account.js` - sign up / log in, live wallet balance
- `online.js` - money matches: lobby card, waiting room, live play
- `config.js` - your Supabase URL + anon key (public values; NEVER the service_role key). Not in the zip: copy `config.example.js` to `config.js` and fill it in
- `netlify.toml` - deploy config (no build command, publish `.`)
- `supabase/migrations/` - run the 3 SQL files in order in the Supabase SQL Editor
- `deposit.js` / `withdraw.js` - the "Add funds" and "Withdraw" screens
- `admin.html` + `admin.js` - admin page: approve withdrawals, see the money overview (admins only)
- `supabase/functions/` - Edge Functions `lobby`, `game`, `wallet` (deposits + withdrawal requests) and `admin`; `supabase/paste-into-dashboard/` has single-file copies to paste into the dashboard
- `scripts/test-server.mjs` - plays full games through the server logic (`node scripts/test-server.mjs`)

## Setup
1. Supabase: run the SQL files in order; deploy functions `lobby` and `game`; Authentication > turn off "Confirm email" while testing.
2. Put your Project URL and anon key in `config.js`.
3. Push to GitHub; Netlify deploys on every push (publish directory `.`).

## Test money (SQL Editor)
`select credit_deposit((select id from auth.users where email='YOUR_EMAIL'), 'test-001', 20);`  (use a new tx name each time)

## Secrets (Supabase > Edge Functions > Secrets) - never put these in GitHub
- `HD_SEED` - 64 hex characters; makes every player's deposit address. Back it up offline. Losing it = losing access to funds sent to those addresses.
- `CRON_SECRET` - any long random text; lets the once-a-minute timer call the wallet function.
- `ALLOWED_ORIGIN` - your site address, e.g. https://your-site.netlify.app (no trailing slash). Optional but recommended.
- `TRONGRID_API_KEY` - optional on the Nile test network, required on mainnet. `TRON_API` / `USDT_CONTRACT` default to the Nile test network.

## Before launch
`supabase/maintenance/clear_test_data.sql` wipes all test money (refuses if a real deposit exists).
Add `?debug` to the site address to see the technical status lines.

## Money rules (edit in the `app_settings` table, no code change)
- `fee_percent_2p` = 5 and `fee_percent_4p` = 10: your share of the total pool by table size.
- `min_withdrawal` = 10, `auto_withdraw_max` = 100 (per request), `auto_withdraw_daily_max` = 500 (per player per 24 h).
  Withdrawals within these limits are sent automatically; bigger ones wait on the admin page. Every waiting withdrawal shows its reason there (the `note` column).

## Payout wallet
Withdrawals are paid from address number 0 of the `HD_SEED` wallet (players' deposit addresses start at 1). The admin page shows its address
and balances: keep some USDT in it for payouts and some TRX (about 30+) for network fees. The transaction id is saved before sending, and
payouts are confirmed on the chain; failed or expired ones are refunded automatically.

## Becoming admin and taking your earnings
Sign up normally, then run `supabase/maintenance/make_admin.sql` (with your email) in the SQL Editor. Open `/admin.html` and log in.
"Move earnings to my balance" turns platform fees into your own player balance; then press Withdraw in the game to send it to your wallet.

The admin page also has a **Transaction history** (deposits, withdrawals, match results, fees, earnings) with links to the block explorer.
Run all files in `supabase/migrations/` in order (currently 9).

## Collecting deposits (sweeps)
Deposits arrive on each player's own address. After a deposit is credited the server (1) sends that address a little TRX for the network fee,
then (2) moves all its USDT into the payout wallet. It runs on its own once a minute when the timer is on (`schedule_deposit_scan.sql`),
right after a player presses "check now", or with the admin button "Collect deposits now". Optional settings (Edge Function secrets):
`SWEEP_MIN_USDT` (default 1), `SWEEP_MIN_TRX` (15), `SWEEP_TOPUP_TRX` (25). The payout wallet needs TRX to fund these top-ups.

## Clean slate for testing
`supabase/maintenance/clear_test_data.sql` resets all money records and balances (accounts and deposit addresses stay).
It refuses to run once you set `testing_mode` to 'false' in `app_settings` (do that before launch).

## Game currency: TRX or USDT
`app_settings.asset` decides what players deposit, stake and withdraw: `"TRX"` (default after migration 9) or `"USDT"`.
TRX needs no fee top-ups when collecting deposits (a TRX transfer only uses free bandwidth); USDT needs about 7+ TRX of energy per collection.
The stake buttons come from `stake_options`. All limits (`min_stake`, `min_deposit`, `min_withdrawal`, `auto_withdraw_*`, `sweep_min`) are in that currency.
If you change `asset`, run `supabase/maintenance/clear_test_data.sql` first while testing: old balances are in the old currency.
Collected TRX deposits leave about 1 TRX at each deposit address (to cover the fee if free bandwidth is used up).
