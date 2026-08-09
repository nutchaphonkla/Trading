KAGE CORE - ONE SHOT PIPELINE FIX
=================================

ชุดนี้แก้ pipeline ทั้งก้อน ไม่ต้องไล่แก้ทีละ error

ไฟล์ root ที่ให้แทนของเดิม:
- update-data.mjs
- build-ai-shadow.mjs
- build-ai-learning.mjs
- build-ai-history.mjs
- build-ai-journal.mjs
- build-ai-governance.mjs
- selfplay-lab.py
- ml-train.py
- ai_provenance_v42.py
- requirements-ml.txt

โฟลเดอร์ tests/ ให้แทน/อัปโหลดทั้งหมด

Workflow ที่ให้แทน:
- .github/workflows/build-ai-history.yml
- .github/workflows/update-data.yml

จุดแก้สำคัญ:
1) export contract ของ Node test ครบ
2) selfplay promotion functions ครบ
3) selfplay-lab.py ไม่ต้อง import numpy ตอนโหลดโมดูลแล้ว จึงไม่ล้มใน promotion test เพราะ dependency ก่อนเวลา
4) workflow ใช้ python -m pip กับ Python ตัวเดียวกับที่รัน test
5) workflow ตรวจ import numpy/pandas/sklearn/xgboost ก่อนเริ่ม test และแสดง version ชัดเจน
6) V43 regression tests: forward-only journal + DST market hours
7) PRIMARY/FALLBACK isolation ยังคง fail-closed ไม่ merge feed

วิธีใช้:
1) แตก ZIP
2) อัปโหลดไฟล์ทั้งหมดไปทับ path เดิมตามโครงสร้าง
3) Commit ครั้งเดียว
4) Run "Update XAUUSD data pack" ก่อน
5) ถ้าเขียว ให้ Run "AI Background Learning"
6) ใช้ Run workflow ใหม่ ไม่ใช้ Re-run run เก่าที่ผูกกับ commit เก่า

หมายเหตุ:
- AI อาจแสดง WAIT_DATA ถ้า M15 PRIMARY ยังไม่ถึง minimum 420 แท่ง นี่ไม่ใช่ workflow error
- อย่าลด minimum data เพื่อบังคับโมเดลให้ READY
