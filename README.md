# KAGE CORE V42.0 · Adaptive Shadow Intelligence

`index.html` keeps the production planning, execution, feed, risk and PWA runtime while adding a bounded adaptive champion/candidate loop. V42 learns only from feed-matched, completed local outcomes; it validates chronologically, caps live influence, keeps weaker candidates in shadow mode and can roll back a degraded champion.

## Preserved production features

- Standalone/PWA install gate and the full KAGE CORE intro loader
- Home mission, 30-day capital plan, session close and adaptive risk guardian
- AI execution desk, pending-order command center, Entry Zone, SL, TP1, TP2 and RR/EV
- H1/M15/M5/M1 market analysis, signal lifecycle and confirmation gates
- News radar, plan/history/stats views, outcome memory, backtest and learning controls
- Governed background brain, ML brain, champion/challenger governance and self-play artifacts
- Twelve Data primary feed with isolated MT5 → Cloudflare Worker/D1 failover
- Local storage compatibility for all existing V39 plan/settings/signal/history keys
- V42 cache boundary and network-first service worker so installed apps do not receive mixed-version files

## V42.0 interface

- Graphite, black, white and silver anime visual system with sparse cyan, green, amber and coral status accents
- New generated shadow-warden app icon across browser, install, intro and header surfaces
- Warden command banner, compact intelligence cards and circular AI core
- Six production tabs: Overview, AI Market, Positions, Intel, Plan and History
- Capital and target-profit controls remain editable and visible
- Entry Zone, Stop Loss, TP1 and TP2 remain explicit in the execution view
- Market and equity graph visuals are removed; feed freshness, source failover, data quality and pipeline diagnostics stay visible
- Mobile-first PWA layout with desktop centering and safe-area navigation

## V42 adaptive safety

- Verified-outcome provenance: creation feed must equal outcome feed
- Closed M1 exact-order-price fill, then conservative first-hit replay from the following candle; later candles cannot mutate a finished outcome
- Time-ordered train/validation split with Bayesian shrinkage
- Candidate → champion promotion gate, unchanged-evidence fingerprint and automatic rollback
- Live probability influence capped at ±8 points and reduced further by model trust
- Exact V42 schema/hash/source/watermark plus explicit trusted governance is required; legacy or unverified models remain references with zero Entry/SL/TP authority
- Full-history bias is rebuilt only from closed, isolated Twelve Data primary bars under its own V42 provenance contract; legacy history cannot veto a live decision
- Empty or stale news data is `UNKNOWN` and blocks execution instead of silently becoming `CLEAR`

These controls improve validation and failure behavior; they do not guarantee profit or win rate.

## Runtime files

- Main app: `index.html` with `kage-v40-full.css`, `kage-v41-monochrome.css` and `kage-v42-adaptive.css`
- Adaptive module and tests: `adaptive-ai-v42.js`, `tests/adaptive-ai-v42.test.cjs`
- V42 icon master: `assets/kage-app-icon-v42.png`; V41 anime hero artwork remains in the content UI
- Exact pre-redesign production backup: `legacy-v39.html`
- Older isolated experiment: `v40-preview.html` with `kage-v40.css` and `kage-v40.js`
- Market/news packs: `xauusd.json`, `news.json`
- AI packs: `ai-history.json`, `ai-learning.json`, `ai-model-governance.json`, `ai-ml-brain.json` and outcome/self-play journals
- Cloudflare/MT5 bridge: `cloudflare-worker.js`, `OneMonth_Feed_Bridge.mq5`

The older isolated preview does not register a service worker and cannot replace the production PWA runtime.
