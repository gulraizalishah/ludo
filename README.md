# Ludo

Browser Ludo game with house rules (blockades, capture-to-unlock home lane, star-square attacks).
Plain HTML/CSS/JS, no build step. Hosted on Netlify; Supabase backend comes later.

## Files
- `engine.js` - pure rules engine (no DOM). Later reused server-side as the referee.
- `app.js` - board drawing, animations, bots, UI flow
- `index.html`, `style.css` - lobby and game screens
- `netlify.toml` - deploy config

## Run locally
    npx serve .

## Deploy
Push to `main`; Netlify deploys automatically (no build command, publish directory `.`).

## Rules
See the "House rules" section on the lobby screen.

## Secrets
Never commit `.env` files or Supabase service-role keys.
