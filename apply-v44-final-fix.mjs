#!/usr/bin/env node
import fs from 'node:fs';

const file = 'index.html';
if (!fs.existsSync(file)) {
  throw new Error('index.html not found');
}

let s = fs.readFileSync(file, 'utf8');
let changed = 0;

function replaceOnce(oldText, newText, label) {
  if (!s.includes(oldText)) {
    throw new Error(`PATCH TARGET NOT FOUND: ${label}`);
  }
  s = s.replace(oldText, newText);
  changed++;
  console.log(`PATCHED: ${label}`);
}

// 1) Invalidate old AI/browser caches after the MT5 training-source handoff.
replaceOnce(
  "const HISTORY_CACHE_KEY='onemonth_os_history_cache_v32';\nconst LEARNING_PACK_CACHE_KEY='onemonth_os_learning_pack_cache_v32';\nconst MODEL_GOV_CACHE_KEY='onemonth_os_model_governance_cache_v342';\nconst ML_BRAIN_CACHE_KEY='onemonth_os_ml_brain_cache_v361';",
  "const HISTORY_CACHE_KEY='onemonth_os_history_cache_v44final';\nconst LEARNING_PACK_CACHE_KEY='onemonth_os_learning_pack_cache_v44final';\nconst MODEL_GOV_CACHE_KEY='onemonth_os_model_governance_cache_v44final';\nconst ML_BRAIN_CACHE_KEY='onemonth_os_ml_brain_cache_v44final';",
  'AI cache namespace V44 final'
);

// 2) Direct MT5 view should request enough M1 history to rebuild M15/H1 context.
replaceOnce(
  "url.searchParams.set('limit','6000');",
  "url.searchParams.set('limit','10000');",
  'MT5 direct M1 limit 10000'
);

// 3) Normal session/weekend gaps are not corruption. Do not throw away all older clean history.
// Keep the full cleaned/deduped set for MTF rebuild; retain segment length only as diagnostics.
replaceOnce(
`function cleanSingleTf(raw,tf){
  const normalized=(raw||[]).map(normalizeCandle).filter(Boolean).sort((a,b)=>a.ts-b.ts);
  const before=normalized.length;
  const deduped=dedupeCandles(normalized);
  const dupes=before-deduped.length;
  const q=quarantineOutliers(deduped,tf);
  const fillers=removeRepeatedFillers(q.clean);
  const continuous=latestContinuousSegment(fillers.clean,tf);
  return{raw:before,clean:continuous,duplicates:dupes+fillers.removed,outliers:q.outliers,segment:continuous.length};
}`,
`function cleanSingleTf(raw,tf){
  const normalized=(raw||[]).map(normalizeCandle).filter(Boolean).sort((a,b)=>a.ts-b.ts);
  const before=normalized.length;
  const deduped=dedupeCandles(normalized);
  const dupes=before-deduped.length;
  const q=quarantineOutliers(deduped,tf);
  const fillers=removeRepeatedFillers(q.clean);
  const clean=fillers.clean;
  const latestSegment=latestContinuousSegment(clean,tf);
  return{raw:before,clean,duplicates:dupes+fillers.removed,outliers:q.outliers,segment:latestSegment.length};
}`,
  'keep full clean market history across normal session gaps'
);

// 4) Explicit cache clear must include Python ML brain cache too.
replaceOnce(
  "storeRemove(MARKET_CACHE_KEY);storeRemove(NEWS_CACHE_KEY);storeRemove(HISTORY_CACHE_KEY);storeRemove(LEARNING_PACK_CACHE_KEY);storeRemove(MODEL_GOV_CACHE_KEY);",
  "storeRemove(MARKET_CACHE_KEY);storeRemove(NEWS_CACHE_KEY);storeRemove(HISTORY_CACHE_KEY);storeRemove(LEARNING_PACK_CACHE_KEY);storeRemove(MODEL_GOV_CACHE_KEY);storeRemove(ML_BRAIN_CACHE_KEY);",
  'clear ML brain cache'
);

// 5) Bump SW registration query so iOS/PWA asks for the repaired worker immediately.
replaceOnce(
  "navigator.serviceWorker.register('./sw.js?v=431',{updateViaCache:'none'})",
  "navigator.serviceWorker.register('./sw.js?v=4402',{updateViaCache:'none'})",
  'service worker revision V44.2'
);

fs.writeFileSync(file, s);
console.log(`V44 FINAL UI PATCH COMPLETE (${changed} edits)`);
