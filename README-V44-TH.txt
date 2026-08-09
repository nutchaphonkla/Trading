KAGE CORE V44 — AUTO HYBRID / MT5 HEAVY + TWELVE DATA ECO
=========================================================

ZIP นี้เป็น DELTA ONLY: มีเฉพาะไฟล์ใหม่/ไฟล์ที่ต้องแทนของเดิมเท่านั้น
ไฟล์เดิมที่ไม่เปลี่ยน เช่น build-ai-journal.mjs, requirements-ml.txt, sw.js,
manifest.webmanifest, CSS, icon/assets และ tests V42/V43 เดิม ให้ใช้ของเดิมต่อ ห้ามลบ

พฤติกรรม V44
-------------
1) MT5 ต่ออยู่ + heartbeat สด
   - MODE = MT5_HEAVY
   - MT5 ส่ง M1 ปัจจุบัน + backfill กราฟเก่าย้อนหลังเข้า Cloudflare D1
   - GitHub ดึง history เพิ่มแบบ progressive
   - Twelve Data ไม่ถูกเรียกใน run ปกติของ MT5_HEAVY (0 credit สำหรับ price feed run นั้น)
   - Training source = MT5_ACADEMY

2) MT5/คอมปิด หรือ heartbeat หาย
   - MODE = API_ECO
   - กลับไปใช้ Twelve Data แบบเดิมอัตโนมัติ
   - ดึงแบบประหยัด request ไม่ทำ heavy historical backfill ผ่าน Twelve
   - Training source = TWELVE_DATA_PRIMARY

3) NO FEED MERGE
   - xauusd-primary.json = Twelve Data history แยก
   - xauusd-fallback.json = MT5 history แยก
   - xauusd-training.json = view ของ source เดียวที่ router เลือก
   - xauusd.json = active source เดียว
   - ห้ามเอาแท่งราคา MT5 + Twelve มาผสม/เฉลี่ยกัน

4) Self-play เดิมยังอยู่
   - Current-market Shadow Self-Play ยังทายจากกราฟปัจจุบัน แล้วรออนาคตจริงมาตรวจผล
   - Historical training/replay เพิ่มเข้ามา แต่ไม่ถูกนับปลอมเป็น live verified outcome
   - Self-play outcome ต้อง provenance/source ตรงกับ model source เท่านั้น

5) ML HEAVY แต่มี runtime guard
   - เก็บ history ได้เยอะ (MT5 default backfill 60,000 M1, Worker retention 180 วัน)
   - Node historical/replay ใช้ archive ที่เก็บได้
   - Python model tournament จำกัด training anchors สูงสุด 720 จุดแบบ deterministic:
     กระจายครอบคลุมอดีตทั้งช่วง + เก็บ 240 anchors ล่าสุดติดกัน
   - ป้องกัน GitHub Actions ค้าง/หมดเวลาเมื่อ archive โตมาก โดยยังรักษาหลาย market regimes
   - Candidate geometry = 12 แบบเสมอ (4 order types x 3 variants) และมี bounded risk geometry

ไฟล์ที่ต้องลง
-------------
ROOT GitHub:
  index.html
  adaptive-ai-v42.js
  update-data.mjs
  ai_provenance_v42.py
  build-ai-history.mjs
  build-ai-learning.mjs
  build-ai-governance.mjs
  build-ai-shadow.mjs
  selfplay-lab.py
  ml-train.py

WORKFLOWS:
  .github/workflows/update-data.yml
  .github/workflows/build-ai-history.yml

TESTS:
  tests/auto-hybrid-v44.test.mjs
  tests/test_auto_hybrid_v44.py

EXTERNAL / DEPLOY SEPARATELY:
  cloudflare-worker.js
  OneMonth_Feed_Bridge.mq5

ลำดับติดตั้ง — ทำตามนี้
----------------------
A) CLOUDFLARE WORKER ก่อน
   1. เปิด Worker ตัวเดิมที่ MT5 ใช้อยู่
   2. แทนโค้ดด้วย cloudflare-worker.js
   3. Deploy
   4. ใช้ D1 binding DB และ secret WEBHOOK_TOKEN ตัวเดิม
   5. ไม่ต้องแก้ D1 schema

B) MT5
   1. เปิด OneMonth_Feed_Bridge.mq5 ใน MetaEditor แล้ว Compile
   2. ใส่ EA บนกราฟ XAUUSD
   3. InpWorkerBaseURL = Worker URL เดิม
   4. InpWebhookToken = token เดิม
   5. MT5 > Tools > Options > Expert Advisors > Allow WebRequest for listed URL
      เพิ่ม base URL ของ Worker
   6. เปิด Algo Trading
   7. EA นี้ DATA ONLY ไม่มี OrderSend/Buy/Sell และไม่แก้ position/account
   8. Default backfill 60,000 M1 แบบ progressive; ปิด MT5 ได้ ระบบ API ECO ยังทำงานต่อ

C) GITHUB
   1. เอาไฟล์ ROOT / .github/workflows / tests จาก ZIP ไปทับตำแหน่งเดิมตาม path
   2. อย่าลบไฟล์เก่าที่ ZIP นี้ไม่ได้ให้มา
   3. Commit ครั้งเดียวบน main
   4. Actions > Update XAUUSD data pack > Run workflow (run ใหม่จาก commit ใหม่)
   5. รอเขียว แล้ว Actions > AI Background Learning > Run workflow
   6. อย่ากด Re-run failed jobs ของ commit เก่า

SECRETS เดิม ใช้ต่อทั้งหมด
--------------------------
GitHub:
  TWELVE_DATA_API_KEY
  TV_FALLBACK_URL
  TV_FALLBACK_TOKEN
Cloudflare:
  DB
  WEBHOOK_TOKEN

สถานะที่ควรเห็น
---------------
MT5 เปิดและสด:
  active = MT5_FALLBACK
  mode = MT5_HEAVY
  training.feed = MT5_ACADEMY
  efficiency.twelveRequestsThisRun = 0

MT5 ปิด/heartbeat หาย:
  active = TWELVE_DATA
  mode = API_ECO
  training.feed = TWELVE_DATA_PRIMARY

หมายเหตุสำคัญ
-------------
- WAIT_DATA ไม่ใช่ workflow error; ถ้า source ปัจจุบันยังมี history ต่ำกว่า minimum ระบบจะ fail-safe รอข้อมูล
- เมื่อสลับ source Governance จะไม่เอา champion คนละ source มาใช้อัตโนมัติโดยไม่ตรวจ source compatibility
- MT5 EA ถูก static-check ในชุดทดสอบ แต่ environment นี้ไม่มี MetaEditor compiler; ขั้น Compile ใน MetaEditor จึงเป็น validation สุดท้ายของไฟล์ .mq5
