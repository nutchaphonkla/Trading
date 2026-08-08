# ONE MONTH V12.1 Stable

Runtime ของหน้าเว็บใช้ `app.js` ไฟล์เดียวแบบ non-module เพื่อลดปัญหา import/cache บน GitHub Pages/iPhone Safari.

อัปไฟล์ root เหล่านี้ทับของเดิม: `index.html`, `app.css`, `app.js`, `xauusd.json`, `news.json`, `update-data.mjs`.

GitHub Action ต้องอยู่ `.github/workflows/update-data.yml`.

หลัง Commit ให้เปิด Pages URL แล้วรีเฟรชใหม่ หรือปิดแท็บเดิมแล้วเปิดใหม่. `index.html` ใช้ `?v=12.1.3` เพื่อบังคับโหลด CSS/JS ใหม่.
