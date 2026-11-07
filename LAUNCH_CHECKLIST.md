# Launch checklist

Open /admin.html > "Launch readiness": it checks most of this for you. Work through it top to bottom.

## 1. Accounts and sign-up (Supabase dashboard)
- Authentication > Sign In / Providers > Email: **Confirm email ON**.
- Authentication > URL Configuration: Site URL = your site; add `https://YOUR-SITE/login.html` and `https://YOUR-SITE/index.html` to Redirect URLs (needed for confirmation and password-reset links).
- Authentication > Attack Protection: turn on the **bot check** (Cloudflare Turnstile is free). Put the SECRET key there and the SITE key in `config.js` (`TURNSTILE_SITE_KEY`).
- Authentication > Multi-Factor: **TOTP ON**. Then open /admin.html and set up your authenticator app. The admin functions refuse anyone without the code.

## 2. Money rules (app_settings table; recommended starting values for real money)
| key | value | meaning |
|---|---|---|
| `withdraw_min_age_hours` | 24 | new accounts wait before their first withdrawal |
| `withdraw_min_matches` | 3 | finished matches needed before withdrawing |
| `withdraw_wager_ratio` | 1 | every deposit must be played through once |
| `first_withdrawal_manual` | true | you approve each account's first withdrawal |
| `blocked_countries` | ["XX","YY"] | no new matches or deposits from these countries (withdrawals stay open) |
| `auto_withdraw_max` | small at first | bigger payouts wait for you |
| `min_stake` / `max_stake` / `stake_options` | small at first | |

## 3. Alerts
- Telegram: talk to @BotFather, `/newbot`, copy the token. Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat` `id`.
- Edge Function secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Press "Send test alert" on the admin page.
- Outside watcher: deploy the `health` function, then add repository secrets `HEALTH_URL` (`https://YOUR_REF.supabase.co/functions/v1/health`), `SUPABASE_ANON_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` on GitHub. The workflow in `.github/workflows/watchdog.yml` runs every 30 minutes (this fits the free GitHub Actions minutes of a private repository).

## 4. Switching to the real TRON network
1. Make a **fresh** `HD_SEED` (never reuse the test one). Back it up in two offline places. Anyone with it controls all the money.
2. Edge Function secrets: `TRON_API` = `https://api.trongrid.io`, `TRONGRID_API_KEY` (free key from trongrid.io), and for USDT mode `USDT_CONTRACT` = `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
3. Run `supabase/maintenance/clear_test_data.sql`, then `update app_settings set value = 'false' where key = 'testing_mode';` (this locks the wipe script forever).
4. Fund the payout wallet with a SMALL amount, turn the timer on, and try one tiny real deposit, match and withdrawal yourself.
5. Raise limits slowly.

## 5. Platform
- Supabase **paid plan** (free projects pause after about a week idle) and backups (point-in-time recovery).
- Keep the GitHub repo **private**. Never put the service_role key, HD_SEED or bot tokens in it.
- Fill in the [brackets] in terms.html, privacy.html and responsible.html.
