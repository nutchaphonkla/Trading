import assert from 'node:assert/strict';
import {
  compatibleBrain,
  resolveEntry,
  resolutionSourceFromPack,
  selectResolutionSource,
} from '../build-ai-shadow.mjs';

const MINUTE = 60_000;
const created = Date.UTC(2026, 7, 10, 8, 0, 0);

function entry() {
  return {
    id: 'fixture-primary',
    creationFeedKind: 'PRIMARY',
    feedSource: 'TWELVE_DATA',
    marketTs: created,
    status: 'WAIT_FILL',
    type: 'BUY_LIMIT',
    kind: 'LIMIT',
    side: 'BUY',
    entry: 100,
    entryLow: 99,
    entryHigh: 102,
    sl: 95,
    tp1: 105,
    tp2: 110,
    filledTs: null,
    firstHit: null,
    mfeR: 0,
    maeR: 0,
  };
}

const primary = {
  kind: 'PRIMARY',
  fingerprint: 'primary-fp',
  watermark: created + 4 * MINUTE,
  bars: [
    { ts: created + MINUTE, open: 101, high: 102, low: 99, close: 101 },
    { ts: created + 2 * MINUTE, open: 101, high: 106, low: 99, close: 105 },
  ],
};
const fallback = {
  kind: 'FALLBACK',
  fingerprint: 'fallback-fp',
  watermark: created + 4 * MINUTE,
  bars: [
    { ts: created + MINUTE, open: 100, high: 101, low: 94, close: 95 },
  ],
};

{
  assert.equal(resolutionSourceFromPack({
    source: 'Twelve Data PRIMARY isolated history',
    feed: { active: 'TWELVE_DATA' },
    timeframes: { M1: primary.bars },
  }, 'PRIMARY'), null, 'a source pack without an explicit closed-bar watermark must fail closed');

  const source = resolutionSourceFromPack({
    source: 'Twelve Data PRIMARY isolated history',
    closedBarWatermark: created + 2 * MINUTE,
    feed: { active: 'TWELVE_DATA' },
    timeframes: { M1: primary.bars },
  }, 'PRIMARY');
  assert.equal(source.bars.length, 1, 'bars beyond the source watermark must not resolve outcomes');
}

{
  const e = entry();
  const selected = selectResolutionSource(e, { PRIMARY: primary, FALLBACK: fallback });
  assert.equal(selected, primary, 'creation feed must choose the isolated PRIMARY pack');
  resolveEntry(e, selected.bars, selected);
  assert.equal(e.result, 'TP1');
  assert.equal(e.outcomeFeedKind, 'PRIMARY');
  assert.equal(e.outcomeDataFingerprint, 'primary-fp');
  assert.equal(e.provenanceStatus, 'VERIFIED');
}

{
  const e = entry();
  const selected = selectResolutionSource(e, { FALLBACK: fallback });
  assert.equal(selected, null, 'missing PRIMARY history must not silently use active fallback');
  resolveEntry(e, fallback.bars, fallback);
  assert.equal(e.status, 'WAIT_FILL');
  assert.equal(e.result, undefined);
  assert.equal(e.provenanceStatus, 'SOURCE_MISMATCH');
}

{
  const e = entry();
  e.entry = 100;
  const zoneOnly = [{ ts: created + MINUTE, open: 102, high: 103, low: 101, close: 102 }];
  resolveEntry(e, zoneOnly, { ...primary, bars: zoneOnly });
  assert.equal(e.filledTs, null, 'touching only the display zone must not fill the center order');
}

{
  const brain = {
    version: 'V42 AUTONOMOUS SELF-PLAY PRECISION BRAIN',
    ready: true,
    status: 'TRUSTED',
    governance: { trusted: true },
    sourceFingerprint: 'abc',
    artifactProvenance: {
      schemaVersion: 'KAGE_AI_V42',
      trainingSource: 'xauusd-primary.json',
      trainingFeed: 'TWELVE_DATA_PRIMARY',
      mergeFeeds: false,
      labelSchema: 'M1_FIRST_HIT_V42',
      labelSchemaHash: '7c9ff5daadb124444d716c94',
      featureSchemaHash: 'feature-fixture',
      sourceFingerprint: 'abc',
      dataWatermark: 123,
      candidateSchemaCount: 12,
    },
    artifactSchema: {
      version: 'KAGE_AI_V42',
      featureSchemaHash: 'feature-fixture',
      labelSchemaHash: '7c9ff5daadb124444d716c94',
    },
  };
  assert.equal(compatibleBrain(brain), true);
  assert.equal(compatibleBrain({ ...brain, version: 'V36.1' }), false);
  assert.equal(compatibleBrain({ ...brain, artifactProvenance: { ...brain.artifactProvenance, mergeFeeds: true } }), false);
}

console.log('shadow feed isolation V42: all tests passed');
