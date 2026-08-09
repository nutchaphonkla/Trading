ONEMONTH OS V36.2 PRIMARY FAILOVER - FULL PACKAGE

ACTIVE DATA POLICY
1. Twelve Data = PRIMARY
2. MT5 -> Cloudflare Worker/D1 = FALLBACK ONLY
3. Never average or merge simultaneous prices from Twelve and MT5.
4. When Twelve fails (429/error/timeout/stale), switch to MT5.
5. When Twelve recovers, require 2 consecutive healthy checks before switching back.
6. If both sources are unavailable/stale, use last valid data for reference only and block new live plans.

CURRENT REQUIRED COMPONENTS
GitHub root:
- index.html
- update-data.mjs
- ml-train.py
- build-ai-history.mjs
- build-ai-learning.mjs
- build-ai-journal.mjs
- build-ai-governance.mjs
- requirements-ml.txt
- reset.html
- app-v290.html
- sw.js
- version.json
- manifest.webmanifest
- icon-180.png
- icon-192.png
- icon-512.png

GitHub workflows:
- .github/workflows/update-data.yml
- .github/workflows/build-ai-history.yml

Cloudflare:
- cloudflare-worker.js
D1 binding: DB
Secret: WEBHOOK_TOKEN

MT5:
- OneMonth_Feed_Bridge.mq5

GitHub Secrets:
- TWELVE_DATA_API_KEY
- TV_FALLBACK_URL
- TV_FALLBACK_TOKEN

DO NOT OVERWRITE/DELETE LIVE LEARNING DATA:
- xauusd.json
- news.json
- ai-history.json
- ai-learning.json
- ai-learning-candidate.json
- ai-learning-previous.json
- ai-model-governance.json
- ai-outcome-journal.json
- ai-ml-brain.json
- ai-ml-candidate.json
- ai-ml-governance.json
- feed-health.json (generated/maintained by updater)
