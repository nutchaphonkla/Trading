KAGE V48 CLOUD SIGNAL MIRROR

ไฟล์ GitHub:
- index.html
- sw.js
- kage-signal-engine.js
- telegram-config.js
- kage-telegram-client.js

หลักการ:
Telegram ไม่คำนวณ Signal ใหม่ แต่รับ Final Decision object ที่เดียวกับหน้า KAGE ใช้
ส่งเมื่อ:
- Plan ใหม่
- Stage เปลี่ยน
- Entry/Zone/SL/TP เปลี่ยน >= 0.05
- Confidence เปลี่ยน >= 5%
- Quality เปลี่ยน >= 5%

ข้อจำกัด:
ถ้า AI เดิมทำงานเฉพาะใน frontend แล้ว iPhone ปิดแอป จะไม่มี Decision ใหม่เกิดขึ้นเอง
V48 ทำ exact mirror + cloud state ให้ถูกต้องก่อน
การให้ AI คิดต่อขณะปิดแอป 100% ต้องย้าย computational engine และ input dependencies ไป server ด้วย
