KAGE CORE V39 — SHADOW INTELLIGENCE UI REFORGE

WHAT CHANGED
- App brand: OneMonth OS -> KAGE CORE
- Full dark anime/tactical visual system across CORE/BRAIN/MARKET/NEWS/PLAN/STATS
- New original KAGE CORE app icon and in-app Shadow Warden artwork
- New install screen, intro, top bar, cards, buttons, modal and navigation theme
- HOME renamed CORE; AI navigation label renamed BRAIN
- AI OFF label corrected to ASSIST OFF so it does not imply the Python ML brain is disabled
- Added dynamic Shadow Command hero on CORE page synced to real decision/feed/core status
- Market AI Core preserved and visually re-skinned
- Existing V38 Self-Play / ML / feed / outcome / governance architecture is preserved

WHAT DID NOT CHANGE
- update-data.mjs logic
- Python V38 ML/self-play logic
- build-ai-*.mjs learning pipelines
- GitHub Actions workflows
- Cloudflare Worker
- MT5 Feed Bridge
- localStorage keys (preserves user plan/settings/history)

UPLOAD
For a minimal update replace:
- index.html
- manifest.webmanifest
- icon-180.png
- icon-192.png
- icon-512.png
- kage-warden.webp
- app-v290.html
- reset.html
- sw.js
- version.json

The full package also contains all unchanged V38 backend files for convenience.

IMPORTANT
The app icon may remain visually cached by iOS after updating GitHub. If an already-installed PWA keeps the old home-screen icon, remove that installed PWA and add it to Home Screen again. This does not mean the web app code failed to update.
