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
- `supabase/functions/` - Edge Functions `lobby` and `game`; `supabase/paste-into-dashboard/` has single-file copies to paste into the dashboard
- `scripts/test-server.mjs` - plays full games through the server logic (`node scripts/test-server.mjs`)

## Setup
1. Supabase: run the SQL files in order; deploy functions `lobby` and `game`; Authentication > turn off "Confirm email" while testing.
2. Put your Project URL and anon key in `config.js`.
3. Push to GitHub; Netlify deploys on every push (publish directory `.`).

## Test money (SQL Editor)
`select credit_deposit((select id from auth.users where email='YOUR_EMAIL'), 'test-001', 20);`  (use a new tx name each time)
"# ludo" 
