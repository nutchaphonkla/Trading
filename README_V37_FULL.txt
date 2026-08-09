ONEMONTH OS V37 AUTONOMOUS PRECISION BRAIN
Release date: 2026-08-09

CORE DATA POLICY
- Twelve Data is PRIMARY.
- MT5 -> Cloudflare Worker/D1 is FALLBACK ONLY.
- No live price averaging. No simultaneous feed merge.
- V37 Python training uses xauusd-primary.json only.
- xauusd-fallback.json never trains the PRIMARY Python brain.
- xauusd.json is the selected ACTIVE feed used for live scoring/UI.
- Twelve recovery requires 2 consecutive healthy checks after failover.
- If both feeds are stale/unavailable: FEED HOLD / no new live pending plan.

V37 ML ARCHITECTURE
- M1 first-hit pending-order labels with completed-bar availability shifts.
- Conservative same-M1 tie handling: SL wins when tick order is unknowable.
- 12 dynamic candidates: BUY/SELL LIMIT/STOP x TIGHT/BALANCED/DEEP.
- Calibrated heads: P(fill), P(TP1), P(TP2), P(SL).
- Clean-win meta score from calibrated TP1 + predicted MFE/MAE + context.
- AutoML tournament: XGBoost + HistGradientBoosting + ExtraTrees.
- 3-fold expanding chronological walk-forward with horizon purge/embargo.
- Recency weighting.
- Automatic Identity/Platt/Isotonic probability calibration.
- Regime layer: TREND_UP/TREND_DOWN/RANGE/BREAKOUT/HIGH_VOL/COMPRESSION.
- Session context: ASIA/LONDON/NEW_YORK/OFF_HOURS.
- Empirical-Bayes context experts to avoid tiny-sample overconfidence.
- OOD guard: robust current drift + population PSI.
- MFE/MAE point regressors and 10/50/90-style quantile uncertainty bands.
- Block-bootstrap outcome stress and low-weight M1 price-path stress.
- Current high-impact news lock/caution context.
- No-Trade hard quality gate.
- Relative risk throttle from plan quality/model health/OOD/news/loss streak.
- Shadow/promote/quarantine governance. Weak challengers are quarantined.

WHY NO LARGE LSTM/TRANSFORMER IN V37
V37 intentionally prioritizes leakage-safe labels, chronological validation,
probability calibration, uncertainty and OOD controls. A larger neural network
is not automatically more accurate for the amount/type of data available and
would add overfitting risk without proving better out-of-sample performance.

REQUIRED GITHUB ROOT FILES
index.html
update-data.mjs
ml-train.py
requirements-ml.txt
build-ai-history.mjs
build-ai-learning.mjs
build-ai-journal.mjs
build-ai-governance.mjs
reset.html
app-v290.html
sw.js
manifest.webmanifest
version.json
icon-180.png
icon-192.png
icon-512.png

GITHUB ACTIONS
.github/workflows/update-data.yml
.github/workflows/build-ai-history.yml

EXISTING GITHUB SECRETS (KEEP)
TWELVE_DATA_API_KEY
TV_FALLBACK_URL
TV_FALLBACK_TOKEN

CLOUDFLARE
Replace current Worker code with cloudflare-worker.js.
Keep D1 binding name: DB.
Keep Cloudflare Secret: WEBHOOK_TOKEN.
No new D1 table is required if bars already exists.
V37 Worker adds /mt5-batch for automatic MT5 M1 history backfill.
Do NOT put WEBHOOK_TOKEN in the public GitHub frontend.

MT5
Compile OneMonth_Feed_Bridge.mq5 in MetaEditor.
Attach it to XAUUSD/XAUUSDm chart.
Use the same WEBHOOK_TOKEN only in EA Inputs.
Allow WebRequest for:
https://onemonth-tv-feed.nutchaphonsit.workers.dev
V37 EA sends no orders and modifies no positions/account settings.
Default startup backfill: 5000 closed M1 bars.

UPLOAD ORDER
1. Upload/replace GitHub root files and the 2 workflow files.
2. Deploy cloudflare-worker.js to the existing Worker.
3. Compile/replace the MT5 V37 EA and attach it.
4. Run GitHub Action: Update XAUUSD data pack.
5. Confirm feed-health.json: mergeFeeds=false and normal ACTIVE=TWELVE_DATA.
6. Run AI Background Learning manually once (ML_FORCE=1 on manual run).
7. Open the PWA and verify V37 + ACTIVE FEED + ML Health.

IMPORTANT
- Do not delete existing real ai-*.json journals/brains merely to install V37.
  The workflows will refresh/migrate them.
- Do not upload __pycache__ or legacy TradingView Pine fallback files.
- Model health/validation can improve decision discipline but cannot guarantee profit.
