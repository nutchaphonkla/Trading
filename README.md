# KAGE CORE V40.1 · Shadow Intelligence

Mobile-first six-screen UX/UI system for XAUUSD decision support, rebuilt from the KAGE CORE visual reference.

## V40 interface

- Overview / Shadow Scan
- AI Market / animated Core Score
- Positions / live decision console
- Intel / news radar and market windows
- Plan / 30-day capital campaign
- History / memory archive
- Responsive dark-glass UI, inline SVG icon system, PWA shell and local market-feed preview
- Original generated hero artwork at `assets/kage-hero-v40.png` with an optimized WebP runtime copy

## V40.1 functional bridge

- Capital + desired-profit inputs create the same 30-day plan format used by V39 (`onemonth_os_plan_v15`)
- Session closing balance updates the adaptive roadmap and risk guardian
- Positions shows AI Entry Zone, Stop Loss, TP1, TP2, RR and lot guide
- Governed ML data comes from `ai-ml-brain.json`, `ai-learning.json`, `ai-model-governance.json` and the real outcome journal
- Rejected candidates still show their price map as **REFERENCE ONLY**; only a candidate that passes model, plan, market/news and risk gates can display READY
- AI Market and History no longer use hard-coded health, sample-count or hit-rate placeholders
- Runtime JSON uses network-first service-worker handling with an offline fallback

The previous production page is preserved as `legacy-v39.html`.

## Legacy runtime notes

Runtime ของหน้าเว็บใช้ `app.js` ไฟล์เดียวแบบ non-module เพื่อลดปัญหา import/cache บน GitHub Pages/iPhone Safari.

อัปไฟล์ root เหล่านี้ทับของเดิม: `index.html`, `app.css`, `app.js`, `xauusd.json`, `news.json`, `update-data.mjs`.

GitHub Action ต้องอยู่ `.github/workflows/update-data.yml`.

หลัง Commit ให้เปิด Pages URL แล้วรีเฟรชใหม่ หรือปิดแท็บเดิมแล้วเปิดใหม่. `index.html` ใช้ `?v=12.1.3` เพื่อบังคับโหลด CSS/JS ใหม่.
