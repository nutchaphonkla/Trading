import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const shadow = fs.readFileSync(new URL('../build-ai-shadow.mjs', import.meta.url), 'utf8');

for (const marker of [
  "const APP_VERSION='V45 EARLY SIGNAL · KAGE CORE'",
  "const PENDING_LEAD_KEY='onemonth_os_pending_lead_v45'",
  'function pendingLeadStateV45',
  'function pendingExecutionStateV45',
  "state:'EARLY WATCH'",
  "state:'APPROACHING'",
  "state:'LATE DETECTED'",
  "state:'ENTRY READY'",
  "['Python ML Guard'",
  'ML_QUARANTINED_REFERENCE_ONLY',
  "storeRemove(PENDING_LEAD_KEY)",
  "sw.js?v=4501",
  'function earlySignalWatchTickV45',
  'function startEarlySignalWatcherV45',
  "setInterval(earlySignalWatchTickV45,60*1000)",
  "haveDirectHistory?'900':'10000'",
]) {
  assert.ok(html.includes(marker), `missing V45 UI marker: ${marker}`);
}

assert.ok(shadow.includes('export function captureCompatibleBrain'), 'shadow capture compatibility must exist');
assert.ok(shadow.includes('QUARANTINED_REFERENCE_SHADOW'), 'quarantined model must remain shadow-only');
assert.ok(shadow.includes("const canCapture = shadowCompatible"), 'capture must use shadow compatibility, not live authority');

assert.ok(!html.includes("'WAITING ORDER':'CANDIDATE REJECTED'"), 'ambiguous WAITING ORDER label must be removed');
assert.ok(!html.includes("p.qualifiedPlan?' · QUALIFIED':' · REJECT'"), 'REJECT/QUALIFIED contradictory label must be removed');

console.log('early signal V45: all tests passed');
