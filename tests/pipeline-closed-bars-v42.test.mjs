import assert from 'node:assert/strict';
import {
  aggregate,
  closedBars,
  sourcePackFromM1,
} from '../update-data.mjs';

const MINUTE = 60_000;
const start = Date.UTC(2026, 7, 9, 10, 0, 0);

function candle(ts, close = 4300) {
  return { ts, open: close, high: close + 1, low: close - 1, close };
}

function minuteSeries(count) {
  return Array.from({ length: count }, (_, i) => candle(start + i * MINUTE, 4300 + i * 0.1));
}

{
  const through1010 = start + 10 * MINUTE;
  const rows = minuteSeries(11); // 10:10 is still open at the watermark.
  const closed = closedBars(rows, MINUTE, through1010);
  assert.equal(closed.length, 10);
  assert.equal(closed.at(-1).ts, start + 9 * MINUTE);
  assert.equal(aggregate(closed, 15 * MINUTE, through1010).length, 0,
    '10:00 M15 must not exist before its 10:15 close');
}

{
  const through1015 = start + 15 * MINUTE;
  const closed = closedBars(minuteSeries(15), MINUTE, through1015);
  const m15 = aggregate(closed, 15 * MINUTE, through1015);
  assert.equal(m15.length, 1);
  assert.equal(m15[0].ts, start);
  assert.equal(m15[0].close, closed.at(-1).close);
}

{
  const previousPartial = {
    timeframes: {
      M1: minuteSeries(10),
      M5: [],
      M15: [candle(start, 9999)], // old repainting partial must be removed
      H1: [],
    },
  };
  const pack = sourcePackFromM1(
    previousPartial,
    minuteSeries(10),
    'fixture',
    { active: 'TWELVE_DATA', switching: { mergeFeeds: false } },
    { M1: 30, M5: 90, M15: 180, H1: 365 },
  );
  assert.equal(pack.closedBarWatermark, start + 10 * MINUTE);
  assert.equal(pack.timeframes.M15.length, 0,
    'previous unclosed higher-timeframe rows must not survive a rebuild');
}

console.log('pipeline closed-bar V42: all tests passed');
