KAGE V49 PERSISTENT BRAIN

เป้าหมาย
- ปิด / Reload / เปิด KAGE ใหม่ แล้ว local learning ไม่ย้อนกลับเป็นศูนย์เพราะ browser state หาย
- ไม่เพิ่ม Cloudflare storage และไม่เอา dataset ใหญ่ขึ้น cloud
- ไม่กอง training dataset เพิ่มใน RAM
- ไม่แก้ Python ML / GitHub model artifacts / Telegram / MT5

สิ่งที่มีอยู่แล้วและไม่หาย
- ai-ml-brain.json / ai-history.json / ai-learning.json / ai-selfplay.json / ai-outcome-journal.json อยู่ใน GitHub อยู่แล้ว
- V49 เพิ่ม backup ให้เฉพาะ runtime intelligence ที่เดิมอยู่ใน localStorage

V49 เก็บซ้ำใน IndexedDB
- outcomeMemory (สูงสุด 180 ตามระบบเดิม)
- adaptive champion/candidate state
- local learning counters/state
- shadow mode
- AI scan memory สูงสุด 40

Safety
- เก็บ checkpoint 6 รุ่นล่าสุด
- restore เฉพาะเมื่อ checkpoint มี evidence มากกว่า local state
- merge outcomes ไม่เขียน state ว่างทับ state ที่ดีกว่า
- checkpoint จำกัด 2 MB; ถ้าใหญ่จะ trim ก่อน
- RESET APP DATA จะลบ checkpoint ด้วย (reset ยังทำงานตามเจตนา)
- CLEAR CACHE & RELOAD ไม่ลบ learned checkpoint

ไฟล์ที่ต้องอัป GitHub
1) index.html (replace)
2) sw.js (replace)
3) kage-persistence-v49.js (new)

ไม่ต้องแก้ YML / Cloudflare Worker / Telegram / MT5
