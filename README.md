# KAGE CORE V40.2 · Full Redesign + Production Runtime

`index.html` keeps the complete, proven V39 production engine and applies the V40 Shadow Intelligence interface across every production view. The redesign is visual and structural only: existing storage keys, AI logic, market feeds, plan math and PWA behavior remain compatible.

## Preserved production features

- Standalone/PWA install gate and the full KAGE CORE intro loader
- Home mission, 30-day capital plan, session close and adaptive risk guardian
- AI execution desk, pending-order command center, Entry Zone, SL, TP1, TP2 and RR/EV
- H1/M15/M5/M1 market analysis, chart controls, signal lifecycle and confirmation gates
- News radar, plan/history/stats views, outcome memory, backtest and learning controls
- Governed background brain, ML brain, champion/challenger governance and self-play artifacts
- Twelve Data primary feed with isolated MT5 → Cloudflare Worker/D1 failover
- Local storage compatibility for all existing V39 plan/settings/signal/history keys
- V40.2 cache boundary and network-first service worker so installed apps do not receive mixed V39/V40 files

## V40.2 interface

- Reference-matched black, cyan and gold KAGE CORE visual system
- Warden command banner, compact intelligence cards and circular AI core
- Six production tabs: Overview, AI Market, Positions, Intel, Plan and History
- Capital and target-profit controls remain editable and visible
- Entry Zone, Stop Loss, TP1 and TP2 remain explicit in the execution view
- Mobile-first PWA layout with desktop centering and safe-area navigation

## Runtime files

- Main redesigned app: `index.html` with `kage-v40-full.css`
- Exact pre-redesign production backup: `legacy-v39.html`
- Older isolated experiment: `v40-preview.html` with `kage-v40.css` and `kage-v40.js`
- Market/news packs: `xauusd.json`, `news.json`
- AI packs: `ai-history.json`, `ai-learning.json`, `ai-model-governance.json`, `ai-ml-brain.json` and outcome/self-play journals
- Cloudflare/MT5 bridge: `cloudflare-worker.js`, `OneMonth_Feed_Bridge.mq5`

The older isolated preview does not register a service worker and cannot replace the production PWA runtime.
