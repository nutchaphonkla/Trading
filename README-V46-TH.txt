KAGE V46 REALTIME LITE

เปลี่ยนเพียง 3 ไฟล์:
- index.html
- sw.js
- tests/early-signal-v45.test.mjs

ไม่ต้องแก้ YML เพิ่ม เพราะ build-ai-history.yml ปัจจุบันเรียก test path เดิมอยู่แล้ว

Optimization:
- MT5 quote foreground poll ~4s (lightweight limit=3)
- heavy market/AI rebuild ~1 ครั้งต่อนาที หรือเมื่อ M1 ใหม่มา
- current price animation 220ms แบบตัวเลขไหล ไม่ rerender ทั้งแอป
- hidden/background mode ลด polling เป็น 30s/หยุดงานหนัก
- หน้าอื่นที่ไม่ได้เปิดจะไม่ render ซ้ำทุก update
- remote AI brain sync 10 นาที, news 5 นาที
- sync lock กัน network/render ซ้อน
- scroll path ไม่มี non-passive touchmove blocker
- bottom nav/top bar ปิด permanent backdrop blur บนมือถือ
- infinite hero 1.2s interval เปลี่ยนเป็น MutationObserver
- learning countdown 1s -> 5s
- Service Worker static stale-while-revalidate; AI/data ยังคง network-first

หลังอัปโหลด:
1) Commit 3 ไฟล์
2) รอ GitHub Pages เขียว
3) เปิด PWA > Settings > Clear Cache & Reload 1 ครั้ง
4) ไม่จำเป็นต้อง Run AI Background Learning เพียงเพราะ optimize UI

หมายเหตุ:
- Realtime 4s ใช้เมื่อ MT5 LIVE HEAVY / public bridge พร้อม
- API ECO ยังขึ้นกับรอบข้อมูลฝั่ง server เพื่อไม่เปิด API key ใน browser
