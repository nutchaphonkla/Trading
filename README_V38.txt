ONEMONTH OS V38 — SELF-PLAY PRECISION BRAIN

WHAT CHANGED
1) SHADOW SELF-PLAY LAB
   - Every fresh market snapshot stores all 12 ML candidates, including REJECTED ideas.
   - No real orders are sent.
   - Old virtual candidates are resolved only from FUTURE M1 bars.
   - Conservative same-M1 ambiguity: SL wins when TP1 and SL both appear in one minute.
   - Stores fill time, TP1/SL first-hit, TP2, MFE, MAE, result R.

2) COUNTERFACTUAL LAB
   - Replays alternative entry depth, risk width and RR geometry on PRIMARY Twelve M1 history.
   - Advisory only. Counterfactual geometry does NOT auto-change live plans by itself.

3) AUTO THRESHOLD OPTIMIZER
   - Uses only PRIMARY Twelve shadow outcomes.
   - Chronological 70/30 train/unseen-tail validation.
   - Requires unseen-tail improvement + drawdown guard.
   - Requires 2 consecutive promotion passes before ml-train.py is allowed to activate it.
   - Context deltas by order type / regime / session are small and bounded.

4) MODEL AUTOPSY
   - Diagnoses repeated failure patterns such as false breakout, reversion failure,
     model disagreement, regime shift, weak edge, late fill and adverse excursion.
   - Diagnostic labels are heuristics, not proof of causality.

5) FORWARD REPLAY GYM
   - Shadow outcomes are sorted chronologically.
   - The newest 30% acts as an unseen forward-test tail for threshold promotion.

6) STRICT FEED ISOLATION REMAINS
   - Twelve Data = PRIMARY training source.
   - MT5 = FALLBACK live source only.
   - MT5 shadow outcomes NEVER tune PRIMARY thresholds.
   - No Twelve/MT5 price averaging or feed merge.

7) CLEAN MARKET UI
   - Removed visible timeframe/chart controls already unused by the user.
   - Removed duplicated metric rings/cards from the main screen.
   - Main screen now focuses on System Trust, Live Decision, Shadow Self-Play,
     Model Health, Calibration, Drift and 3 real AI activity rows.
   - Advanced details are collapsed under MODEL DETAILS.

NEW GENERATED FILES
- ai-shadow-journal.json
- ai-selfplay.json
- ai-thresholds.json
- ai-counterfactual.json
- ai-autopsy.json

FILES TO ADD/REPLACE IN GITHUB ROOT
- index.html
- update-data.mjs
- ml-train.py
- build-ai-shadow.mjs        NEW
- selfplay-lab.py            NEW
- update-data.yml            copy also to .github/workflows/update-data.yml
- build-ai-history.yml       copy also to .github/workflows/build-ai-history.yml
- version.json

UNCHANGED / KEEP
- build-ai-history.mjs
- build-ai-learning.mjs
- build-ai-journal.mjs
- build-ai-governance.mjs
- requirements-ml.txt
- Cloudflare Worker V37 infrastructure (still compatible; no redeploy required for V38 learning)
- MT5 Feed Bridge V37 infrastructure (still compatible; no recompile required for V38 learning)

GITHUB SECRETS — KEEP EXISTING
- TWELVE_DATA_API_KEY
- TV_FALLBACK_URL
- TV_FALLBACK_TOKEN

RUN ORDER
1. Upload/replace V38 files.
2. Ensure workflows are under .github/workflows/.
3. Run: Update XAUUSD data pack.
4. Run: AI Background Learning manually once.
5. Next market updates will create all 12 virtual shadow ideas automatically.
6. Self-play statistics become meaningful only after future M1 bars resolve those ideas.

IMPORTANT
- AI Core Health is system/model health, NOT win probability.
- Auto threshold stays STATIC until enough real future outcomes pass the validation guards.
- No ML system can guarantee profit.
