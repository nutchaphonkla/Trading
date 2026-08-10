KAGE V45 EARLY SIGNAL FINAL

ไฟล์ในชุดนี้มีเฉพาะไฟล์ที่ต้องเปลี่ยน/เพิ่ม:
- index.html
- build-ai-shadow.mjs
- sw.js
- .github/workflows/build-ai-history.yml
- tests/shadow-feed-isolation-v42.test.mjs
- tests/early-signal-v45.test.mjs

สิ่งที่แก้:
1) Early Watch -> Approaching -> In Zone -> Entry Ready
2) Lead-time guard: ถ้าเพิ่งเห็นแผนตอนราคาเข้า Zone แล้ว จะ LATE DETECTED และห้ามเข้า
3) ENTRY READY จะเกิดได้เมื่อเห็นแผนล่วงหน้า + Model authority + Feed/News/Risk + MTF + M1 Trigger + Confirmation ผ่าน
4) Python ML QUARANTINED ใช้เป็น Reference/Shadow เท่านั้น ไม่ขึ้น WAITING ORDER แบบชวนเข้า
5) แยก Background Guard กับ Python ML Guard
6) ลบคำสถานะขัดกัน REJECT / QUALIFIED
7) Quarantined Python ML ยังสร้าง forward-only Shadow candidates ได้ เพื่อสะสม evidence และมีทางออกจาก quarantine
8) Auto early-signal watcher refresh ทุก 60 วินาทีเมื่อ PWA เปิด/ตลาดเปิด
9) MT5 direct initial history 10k; รอบต่อไปดึง 900 M1 แล้ว merge same-source ลด bandwidth
10) Service Worker/cache revision V45

วิธีลง:
1. Upload/replace ไฟล์ทั้งหมดตาม path
2. Commit ครั้งเดียว
3. Actions > AI Background Learning > Run workflow 1 ครั้ง
4. รอเขียว
5. เปิด PWA > Settings > Clear Cache & Reload 1 ครั้ง

ไม่ต้องแก้:
- Cloudflare Worker
- MT5 EA
- update-data.yml
- ml-train.py
- selfplay-lab.py
- build-ai-history.mjs
- build-ai-learning.mjs
- build-ai-journal.mjs
- build-ai-governance.mjs
