import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kage-journal-v43-'));
for (const name of ['build-ai-journal.mjs','xauusd.json','ai-learning.json','ai-ml-brain.json','ai-outcome-journal.json']) {
  fs.copyFileSync(path.join(root, name), path.join(tmp, name));
}
const before = JSON.parse(fs.readFileSync(path.join(tmp, 'ai-outcome-journal.json'), 'utf8'));
execFileSync(process.execPath, ['build-ai-journal.mjs'], { cwd: tmp, stdio: 'pipe' });
const after = JSON.parse(fs.readFileSync(path.join(tmp, 'ai-outcome-journal.json'), 'utf8'));

assert.equal(after.version, 'V43.0');
assert.equal(after.forwardOnly?.enabled, true);
if (after.forwardOnly?.recordingAllowed === false) {
  assert.equal(after.entries.length, before.entries.length, 'closed/stale observation must not create a new deployed signal');
  assert.equal(after.planEntries.length, before.planEntries.length, 'closed/stale observation must not create new deployed plans');
}

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
