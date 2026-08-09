import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'build-ai-learning.mjs');
const minute = 60_000;
const start = Date.UTC(2026, 7, 1, 0, 0, 0);

function run(cwd) {
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(fs.readFileSync(path.join(cwd, 'ai-learning-candidate.json'), 'utf8'));
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kage-learning-v42-'));
try {
  const missing = run(temp);
  assert.equal(missing.ready, false);
  assert.equal(missing.reason, 'MISSING_PRIMARY_PACK');
  assert.equal(missing.artifactSchema.version, 'KAGE_AI_V42');

  const bars = Array.from({ length: 320 }, (_, i) => ({
    ts: start + i * minute,
    open: 4300 + i * .01,
    high: 4301 + i * .01,
    low: 4299 + i * .01,
    close: 4300.5 + i * .01,
  }));
  const watermark = start + bars.length * minute;
  fs.writeFileSync(path.join(temp, 'xauusd-primary.json'), JSON.stringify({
    source: 'Twelve Data PRIMARY isolated history',
    closedBarWatermark: watermark,
    feed: { active: 'TWELVE_DATA', switching: { mergeFeeds: false } },
    timeframes: {
      M1: bars,
      M5: [],
      M15: [{ ts: watermark - 5 * minute, open: 1, high: 2, low: 1, close: 2 }],
      H1: [],
    },
  }));
  const built = run(temp);
  assert.equal(built.artifactProvenance.trainingFeed, 'TWELVE_DATA_PRIMARY');
  assert.equal(built.artifactProvenance.mergeFeeds, false);
  assert.equal(built.artifactProvenance.dataWatermark, watermark);
  assert.ok(built.artifactProvenance.sourceFingerprint);
  assert.equal(built.dataIntegrity.closedBarsOnly, true);
  assert.equal(built.dataIntegrity.cleanCounts.M15, 0,
    'the supplied partial M15 row must be excluded at the closed-bar watermark');
  assert.equal(built.source.timeframe, 'M1');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('learning closed-bar V42: all tests passed');
