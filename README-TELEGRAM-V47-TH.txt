KAGE V47 TELEGRAM — GITHUB FILES

อัปโหลด:
- index.html (ทับ V46)
- sw.js (ทับ V46 เดิม; ไม่มี Web Push code)
- telegram-config.js (ใหม่)
- kage-telegram-client.js (ใหม่)

หลัง Deploy Worker:
เปิด telegram-config.js แล้วใส่ URL Worker จริงเพียงค่าเดียว

หมายเหตุ:
- BOT TOKEN และ CHAT ID ห้ามใส่ใน GitHub
- KAGE ส่งเฉพาะ plan/state ไป Worker
- Worker เป็นผู้ส่ง Telegram และ monitor ราคา MT5 จาก D1
