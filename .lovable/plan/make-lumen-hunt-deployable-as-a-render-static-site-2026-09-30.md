# Make Lumen Hunt deployable as a Render Static Site

## Why a change is needed
The app currently builds for a server (Cloudflare Workers), so `vite build` does not produce a plain folder with an `index.html` that a Render Static Site can serve. Leaving the Publish Directory as `dist` would deploy a blank or broken site.

The game runs entirely in the browser (canvas + realtime multiplayer), so it can be shipped as a static site.

## Changes
1. Turn on SPA / static prerender mode in `vite.config.ts` (TanStack Start `spa: { enabled: true }`, prerender the `/` shell) so the build outputs `dist/client/index.html` plus assets.
2. Keep Lovable preview and Lovable publishing working unchanged.
3. Build once locally to confirm `dist/client/index.html` exists and the game loads from it.
4. Push the update to the `lumen-hunt` GitHub repo.

## What you'll fill in on Render (Static Site)
```text
Repository:         mohammadxahid009-dotcom/lumen-hunt
Branch:             main
Build Command:      npm install && npm run build
Publish Directory:  dist/client
```
Environment variables (Render > Environment), needed for multiplayer:
```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_SUPABASE_PROJECT_ID
```
(These are public keys; I'll give you the exact values after the change.)

Rewrite rule (Render > Redirects/Rewrites): source `/*`, destination `/index.html`, action Rewrite.

## Technical details
- Only `vite.config.ts` changes; game code is untouched.
- The `.env` file stays out of GitHub; Render gets the values via its environment settings instead.
