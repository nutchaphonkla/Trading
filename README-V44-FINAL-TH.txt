KAGE V44 FINAL REPAIR

แก้ 4 ปัญหาหลัก:
1) Frontend MT5 direct เคยตัด history เหลือ continuous segment หลัง session gap ทำให้ M15/H1 หาย
2) MT5 direct ขอ M1 แค่ 6000 แท่ง เพิ่มเป็น 10000 เพื่อ rebuild MTF ได้พอ
3) iOS/PWA เก็บ ai-ml-brain cache รุ่น API ECO เก่า และปุ่ม Clear Cache ไม่ได้ลบ ML cache
4) AI workflow เคยถูกเรียกซ้ำจาก Update workflow และ train คนละ snapshot
   ตัวใหม่รัน hourly/manual เท่านั้น และ refresh update-data ใน job เดียวก่อน train

วิธีใช้:
A) อัปโหลด 4 ไฟล์ตาม path ใน ZIP
B) Actions > Apply V44 Final UI Repair > Run workflow (ครั้งเดียว)
C) รอเขียว
D) Actions > AI Background Learning > Run workflow (ครั้งเดียว)
E) รอเขียว แล้วเปิด PWA > Settings > Clear Cache & Reload 1 ครั้ง
