import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kage-journal-v43-'));

fs.copyFileSync(path.join(root, 'build-ai-journal.mjs'), path.join(tmp, 'build-ai-journal.mjs'));

const TF = 15 * 60_000;
const base = Date.UTC(2026, 7, 8, 0, 0, 0);
const candles = Array.from({ length: 96 }, (_, i) => {
  const ts = base + i * TF;
  const open = 4300 + i * 0.05;
  const close = open + (i % 2 ? -0.08 : 0.12);
  return {
    ts,
    datetime: new Date(ts).toISOString().replace('T', ' ').slice(0, 19),
    open,
    high: Math.max(open, close) + 0.25,
    low: Math.min(open, close) - 0.25,
    close,
  };
});

const createdAt = new Date(base + 80 * TF).toISOString();
const badPast = new Date(base + 79 * TF).toISOString();

const pack = {
  source: 'Twelve Data PRIMARY isolated feed',
  feed: { active: 'TWELVE_DATA', marketLikelyOpen: false },
  timeframes: { M15: candles },
};

const learning = {
  version: 'V42.0',
  ready: true,
  engine: 'ONEMONTH-GOVERNED-CHALLENGER-V42',
  sourceFingerprint: 'fixture-forward-only',
  source: { timeframe: 'M15' },
  current: { direction: 'WAIT', regime: 'RANGE', session: 'CLOSED' },
  modelHealth: { score: 80 },
};

const ml = { ready: false, status: 'WAIT_DATA' };
const journal = {
  version: '2.0',
  entries: [{
    id: 'fixture-signal',
    createdAt,
    ts: base + 80 * TF,
    sourceTf: 'M15',
    direction: 'BUY',
    entry: 4304,
    atr: 1,
    status: 'PENDING',
    filledAt: badPast,
    filledTs: base + 79 * TF,
    horizons: {
      M15: { resolved: true, resolvedAt: badPast, correct: true, returnR: 0.2 },
    },
  }],
  planEntries: [{
    id: 'fixture-plan',
    createdAt,
    ts: base + 80 * TF,
    sourceTf: 'M15',
    modelId: 'fixture-model',
    type: 'BUY LIMIT',
    direction: 'BUY',
    kind: 'LIMIT',
    entry: 4304,
    entryLow: 4303.9,
    entryHigh: 4304.1,
    sl: 4303,
    tp1: 4305.5,
    tp2: 4306,
    atr: 1,
    status: 'FILLED',
    filledAt: badPast,
    filledTs: base + 79 * TF,
    maxWaitBars: 64,
    horizons: {
      M15: { resolved: true, resolvedAt: badPast, correct: true, returnR: 0.2 },
    },
  }],
};

for (const [name, value] of Object.entries({
  'xauusd.json': pack,
  'ai-learning.json': learning,
  'ai-ml-brain.json': ml,
  'ai-outcome-journal.json': journal,
})) {
  fs.writeFileSync(path.join(tmp, name), JSON.stringify(value, null, 2));
}

const before = JSON.parse(fs.readFileSync(path.join(tmp, 'ai-outcome-journal.json'), 'utf8'));
execFileSync(process.execPath, ['build-ai-journal.mjs'], { cwd: tmp, stdio: 'pipe' });

const rawAfter = fs.readFileSync(path.join(tmp, 'ai-outcome-journal.json'), 'utf8');
assert(rawAfter.trim().length > 2, 'journal output must never be empty');
const after = JSON.parse(rawAfter);

assert.equal(after.version, 'V43.0');
assert.equal(after.forwardOnly?.enabled, true);
assert.equal(after.forwardOnly?.recordingAllowed, false, 'closed market fixture must not record new evidence');
assert.equal(after.entries.length, before.entries.length, 'closed observation must not create a new deployed signal');
assert.equal(after.planEntries.length, before.planEntries.length, 'closed observation must not create new deployed plans');

const ms = value => value ? Date.parse(value) : NaN;
for (const row of [...after.entries, ...after.planEntries]) {
  const created = ms(row.createdAt);
  if (!Number.isFinite(created)) continue;
  if (row.filledAt) assert(ms(row.filledAt) >= created, `fill before creation: ${row.id}`);
  for (const [horizon, result] of Object.entries(row.horizons || {})) {
    if (result?.resolvedAt) assert(ms(result.resolvedAt) >= created, `${horizon} resolved before creation: ${row.id}`);
  }
}


console.log('journal-forward-only-v43: all tests passed');
