# KAGE CORE V39 · Full Production Runtime

`index.html` is the complete V39 single-file production app restored from the last production revision before the V40 visual experiment, plus two null-safety guards that prevent Shadow Scan from crashing when a timeframe has insufficient data.

## Production features

- Standalone/PWA install gate and the full KAGE CORE intro loader
- Home mission, 30-day capital plan, session close and adaptive risk guardian
- AI execution desk, pending-order command center, Entry Zone, SL, TP1, TP2 and RR/EV
- H1/M15/M5/M1 market analysis, chart controls, signal lifecycle and confirmation gates
- News radar, plan/history/stats views, outcome memory, backtest and learning controls
- Governed background brain, ML brain, champion/challenger governance and self-play artifacts
- Twelve Data primary feed with isolated MT5 → Cloudflare Worker/D1 failover
- Local storage compatibility for all existing V39 plan/settings/signal/history keys
- Minimal no-cache service worker so installed apps do not receive mixed HTML/data builds

## Runtime files

- Main app: `index.html`
- Exact production backup: `legacy-v39.html`
- Optional visual experiment: `v40-preview.html` with `kage-v40.css` and `kage-v40.js`
- Market/news packs: `xauusd.json`, `news.json`
- AI packs: `ai-history.json`, `ai-learning.json`, `ai-model-governance.json`, `ai-ml-brain.json` and outcome/self-play journals
- Cloudflare/MT5 bridge: `cloudflare-worker.js`, `OneMonth_Feed_Bridge.mq5`

The V40 preview does not register a service worker and cannot replace the production PWA runtime.
