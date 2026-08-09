import assert from 'node:assert/strict';
import { aggregate, buildHistory, closedBars } from '../build-ai-history.mjs';

const MINUTE = 60_000;
const start = Math.floor(1_800_000_000_000 / 3_600_000) * 3_600_000;
const rows = Array.from({ length: 2501 }, (_, index) => {
  const open = 2000 + index * 0.01;
  return { ts: start + index * MINUTE, open, high: open + 0.03, low: open - 0.02, close: open + 0.01 };
});
const watermark = start + 2500 * MINUTE;

assert.equal(closedBars(rows, 'M1', watermark).length, 2500, 'the open M1 candle must be dropped');
assert.equal(aggregate(rows.slice(0, 16), 'M15', start + 15 * MINUTE).length, 1, 'only a complete M15 bucket may be emitted');

const pack = {
  generatedAt: new Date(watermark).toISOString(),
  source: 'Twelve Data PRIMARY isolated history',
  closedBarWatermark: watermark,
  feed: {
    active: 'TWELVE_DATA',
    closedBarWatermark: watermark,
    switching: { mergeFeeds: false }
  },
  timeframes: { M1: rows }
};
const history = buildHistory(pack);
assert.equal(history.ready, true, history.reason);
assert.equal(history.version, 'V42.0');
assert.equal(history.artifactProvenance.trainingSource, 'xauusd-primary.json');
assert.equal(history.artifactProvenance.trainingFeed, 'TWELVE_DATA_PRIMARY');
assert.equal(history.artifactProvenance.mergeFeeds, false);
assert.equal(history.artifactProvenance.dataWatermark, watermark);
assert.match(history.sourceFingerprint, /^[a-f0-9]{24}$/);
assert.equal(history.sourceFingerprint, history.artifactProvenance.sourceFingerprint);
assert(history.dataIntegrity.counts.M15 > 0);
assert(new Date(history.timeframes.M15.to).getTime() + 15 * MINUTE <= watermark);

const mixed = buildHistory({ ...pack, feed: { ...pack.feed, switching: { mergeFeeds: true } } });
assert.equal(mixed.ready, false);
assert.equal(mixed.status, 'QUARANTINED');

console.log('history provenance V42: all tests passed');
