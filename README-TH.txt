KAGE PIPELINE FINAL STABLE FIX

แก้รอบสุดท้าย:
- build-ai-journal.mjs ใช้ atomic JSON write ป้องกันไฟล์ถูก truncate/ว่าง
- journal-forward-only-v43.test.mjs เปลี่ยนเป็น synthetic fixture ไม่อิงไฟล์ live ใน repo
- ML workflow ติดตั้ง/ตรวจ numpy pandas sklearn xgboost ก่อน test
- selfplay-lab.py รองรับ advance_promotion test
- Node export contracts ที่ test ต้องใช้ครบ

ผลทดสอบบนสำเนา Trading-main จริง:
- pipeline closed-bar V42: PASS
- shadow feed isolation V42: PASS
- learning closed-bar V42: PASS
- history provenance V42: PASS
- governance provenance V42: PASS
- journal-forward-only V43: PASS
- market-hours DST V43: PASS
- self-play promotion: 5/5 PASS
- ML provenance: 3/3 PASS
- journal stress: 30/30 PASS
- YAML parse: PASS ทั้ง 2 workflows
- real builder chain: PASS
- generated JSON packs: parse PASS

หมายเหตุ:
ML WAIT_DATA: PRIMARY_TRAINING_PACK_NOT_READY เป็นสถานะปกติเมื่อ M15 ยังไม่ถึงขั้นต่ำ ไม่ใช่ workflow error.

วิธีใช้:
1) แตก ZIP
2) อัปโหลดไฟล์ทั้งหมดทับ path เดิมใน repo โดยรักษาโฟลเดอร์ .github/workflows และ tests
3) Commit ครั้งเดียว
4) Run "Update XAUUSD data pack"
5) ถ้าเขียว Run "AI Background Learning"
6) อย่ากด Re-run failed jobs ของ commit เก่า
