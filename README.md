# KAGE CORE V41.0 · Monochrome Anime Redesign + Production Runtime

`index.html` keeps the complete, proven production engine and applies the V41 monochrome Shadow Intelligence interface across every production view. The redesign is presentation-first: existing storage keys, AI logic, market feeds, plan math and PWA behavior remain compatible.

## Preserved production features

- Standalone/PWA install gate and the full KAGE CORE intro loader
- Home mission, 30-day capital plan, session close and adaptive risk guardian
- AI execution desk, pending-order command center, Entry Zone, SL, TP1, TP2 and RR/EV
- H1/M15/M5/M1 market analysis, chart controls, signal lifecycle and confirmation gates
- News radar, plan/history/stats views, outcome memory, backtest and learning controls
- Governed background brain, ML brain, champion/challenger governance and self-play artifacts
- Twelve Data primary feed with isolated MT5 → Cloudflare Worker/D1 failover
- Local storage compatibility for all existing V39 plan/settings/signal/history keys
- V41 cache boundary and network-first service worker so installed apps do not receive mixed-version files

## V41.0 interface

- Graphite, black, white and silver anime visual system
- Original generated hooded-character hero and avatar assets used consistently across launch, header and decision surfaces
- Warden command banner, compact intelligence cards and circular AI core
- Six production tabs: Overview, AI Market, Positions, Intel, Plan and History
- Capital and target-profit controls remain editable and visible
- Entry Zone, Stop Loss, TP1 and TP2 remain explicit in the execution view
- Mobile-first PWA layout with desktop centering and safe-area navigation

## Runtime files

- Main redesigned app: `index.html` with the compatibility layer `kage-v40-full.css` and V41 presentation layer `kage-v41-monochrome.css`
- V41 artwork: `assets/kage-anime-hero-v41.webp` and `assets/kage-anime-avatar-v41.webp`
- Exact pre-redesign production backup: `legacy-v39.html`
- Older isolated experiment: `v40-preview.html` with `kage-v40.css` and `kage-v40.js`
- Market/news packs: `xauusd.json`, `news.json`
- AI packs: `ai-history.json`, `ai-learning.json`, `ai-model-governance.json`, `ai-ml-brain.json` and outcome/self-play journals
- Cloudflare/MT5 bridge: `cloudflare-worker.js`, `OneMonth_Feed_Bridge.mq5`

The older isolated preview does not register a service worker and cannot replace the production PWA runtime.
