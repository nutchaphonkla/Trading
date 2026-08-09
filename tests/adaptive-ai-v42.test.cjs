'use strict';

const assert = require('node:assert/strict');
const AI = require('../adaptive-ai-v42.js');

function records(count, rawScore, outcomeAt) {
  return Array.from({ length: count }, (_, index) => ({
    sig: `sig-${index}`,
    createdAt: 1_700_000_000_000 + index * 60_000,
    marketTs: 1_700_000_000_000 + index * 60_000,
    fillAt: 1_700_000_060_000 + index * 60_000,
    terminalAt: 1_700_000_120_000 + index * 60_000,
    creationFeed: 'TWELVE_DATA_PRIMARY',
    outcomeFeed: 'TWELVE_DATA_PRIMARY',
    rawScore: typeof rawScore === 'function' ? rawScore(index) : rawScore,
    outcome: outcomeAt(index),
    setup: index % 2 ? 'EMA Pullback' : 'BOS Retest',
    regime: index % 3 ? 'TREND' : 'VOLATILE',
    session: index % 2 ? 'NY' : 'LONDON',
    tf: index % 2 ? 'M5' : 'M15'
  }));
}

{
  const mixed = records(30, 70, index => index % 2 ? 'WIN' : 'LOSS');
  mixed[0].outcomeFeed = 'MT5_FALLBACK';
  mixed[1].creationFeed = '';
  mixed[2].fillAt = mixed[2].marketTs;
  mixed[3].terminalAt = mixed[3].fillAt;
  const normalized = AI.normalizeRecords(mixed);
  assert.equal(normalized.length, 26, 'mixed feed or same-candle labels must be rejected');
}

{
  const start = Math.floor(1_700_000_000_000 / 900_000) * 900_000;
  const bars = [
    { ts: start, open: 100, high: 110, low: 90, close: 100 },
    { ts: start + 60_000, open: 100, high: 101.2, low: 99.8, close: 100.5 },
    { ts: start + 120_000, open: 100.5, high: 103, low: 99.5, close: 102 }
  ];
  const result = AI.resolveOutcome({
    marketTs: start, creationFeed: 'TWELVE_DATA_PRIMARY', side: 'BUY',
    entry: 100, entryLow: 99.9, entryHigh: 100.1, sl: 98, tp1: 102
  }, bars, 'TWELVE_DATA_PRIMARY');
  assert.equal(result.fillAt, start + 60_000, 'entry must fill on a strictly future candle');
  assert.equal(result.terminalAt, start + 120_000, 'fill candle must not be used for the outcome label');
  assert.equal(result.outcome, 'WIN');

  const ambiguous = AI.resolveOutcome({
    marketTs: start, creationFeed: 'TWELVE_DATA_PRIMARY', side: 'BUY',
    entry: 100, sl: 98, tp1: 102
  }, [bars[0], { ts: start + 60_000, open: 100.5, high: 102.5, low: 99.8, close: 101.5 }], 'TWELVE_DATA_PRIMARY');
  assert.equal(ambiguous.resolved, false, 'same fill candle terminal touch must not be relabeled from a later candle');
  assert.equal(ambiguous.reason, 'AMBIGUOUS_FILL_CANDLE');

  const mixedFeed = AI.resolveOutcome({
    marketTs: start, creationFeed: 'TWELVE_DATA_PRIMARY', side: 'BUY', entry: 100, sl: 98, tp1: 102
  }, bars, 'MT5_FALLBACK');
  assert.equal(mixedFeed.replayed, false, 'a different outcome feed must be rejected');

  const zoneOnly = AI.resolveOutcome({
    marketTs: start, creationFeed: 'TWELVE_DATA_PRIMARY', side: 'BUY', orderType: 'BUY_LIMIT',
    entry: 100, entryLow: 99.9, entryHigh: 100.1, sl: 98, tp1: 102
  }, [bars[0], { ts: start + 60_000, open: 100.2, high: 100.4, low: 100.05, close: 100.2 }], 'TWELVE_DATA_PRIMARY');
  assert.equal(zoneOnly.fillAt, null, 'display-zone overlap must not replace an exact order-price fill');
}

{
  const start = Math.floor(1_700_000_000_000 / 900_000) * 900_000;
  const m1 = Array.from({ length: 16 }, (_, index) => ({
    ts: start + index * 60_000, open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index
  }));
  const watermark = start + 15 * 60_000;
  const m15 = AI.aggregateClosedBars(m1, 15 * 60_000, watermark);
  assert.equal(m15.length, 1, 'only the fully closed 15-minute bucket may be emitted');
  assert.equal(m15[0].ts, start);
}

{
  const fingerprint = '1234567890abcdef12345678';
  const featureHash = 'abcdef1234567890abcdef12';
  const validMl = {
    version: 'V42 AUTONOMOUS', ready: true, status: 'TRUSTED', sourceFingerprint: fingerprint,
    governance: { trusted: true },
    artifactSchema: { version: 'KAGE_AI_V42', featureSchemaHash: featureHash, labelSchemaHash: '7c9ff5daadb124444d716c94' },
    artifactProvenance: {
      schemaVersion: 'KAGE_AI_V42', trainingSource: 'xauusd-primary.json', trainingFeed: 'TWELVE_DATA_PRIMARY',
      mergeFeeds: false, featureSchemaHash: featureHash, labelSchema: 'M1_FIRST_HIT_V42',
      labelSchemaHash: '7c9ff5daadb124444d716c94', sourceFingerprint: fingerprint,
      dataWatermark: 1_800_000_000_000, candidateSchemaCount: 12
    },
    current: { candidates: Array.from({ length: 12 }, (_, index) => ({ index })), candidateCount: 12 }
  };
  assert.equal(AI.validateArtifact(validMl, { ml: true }).ok, true);
  assert.equal(AI.validateArtifact({ ...validMl, governance: {} }, { ml: true }).ok, false, 'missing explicit trust must fail closed');
  assert.equal(AI.validateArtifact({ ...validMl, current: { candidates: validMl.current.candidates.slice(0, 11), candidateCount: 12 } }, { ml: true }).ok, false, 'declared count cannot hide a short candidate array');
  assert.equal(AI.validateArtifact({ ...validMl, artifactProvenance: { ...validMl.artifactProvenance, featureSchemaHash: 'ffffffffffffffffffffffff' } }, { ml: true }).ok, false, 'schema hashes must match exactly');

  const nodeFingerprint = 'fedcba0987654321fedcba09';
  const validNode = {
    version: 'V42.0', ready: true, status: 'READY', sourceFingerprint: nodeFingerprint,
    artifactSchema: { version: 'KAGE_AI_V42', featureSchemaHash: 'c3372751b985cd6c32d06e0f', labelSchemaHash: 'dd88c080f7855fdab25a56f0' },
    artifactProvenance: {
      schemaVersion: 'KAGE_AI_V42', trainingSource: 'xauusd-primary.json', trainingFeed: 'TWELVE_DATA_PRIMARY',
      mergeFeeds: false, featureSchemaHash: 'c3372751b985cd6c32d06e0f',
      labelSchema: 'NODE_M30_FIRST_TOUCH_ATR_TP0.8_SL0.6_TIE_SL_TIMEOUT_SIGNED_GT_0.12_V42',
      labelSchemaHash: 'dd88c080f7855fdab25a56f0', sourceFingerprint: nodeFingerprint, dataWatermark: 1_800_000_000_000
    }
  };
  assert.equal(AI.validateArtifact(validNode).ok, true, 'Node background artifact must use its exact independent schema contract');

  const historyFingerprint = '0123456789abcdef01234567';
  const validHistory = {
    version: 'V42.0', ready: true, status: 'READY', sourceFingerprint: historyFingerprint,
    artifactSchema: { version: 'KAGE_AI_V42', featureSchemaHash: '17e82bd347b6f345ad289df1', labelSchemaHash: 'fffe7703ec24c8cac8851daa' },
    artifactProvenance: {
      schemaVersion: 'KAGE_AI_V42', trainingSource: 'xauusd-primary.json', trainingFeed: 'TWELVE_DATA_PRIMARY',
      mergeFeeds: false, featureSchemaHash: '17e82bd347b6f345ad289df1',
      labelSchema: 'FUTURE_CLOSE_DIRECTION_BY_TF_V42', labelSchemaHash: 'fffe7703ec24c8cac8851daa',
      sourceFingerprint: historyFingerprint, dataWatermark: 1_800_000_000_000
    }
  };
  assert.equal(AI.validateArtifact(validHistory, { history: true }).ok, true, 'history brain must have its own exact V42 contract');
}

{
  const result = AI.evolve(records(10, 70, index => index % 2 ? 'WIN' : 'LOSS'), null, 1_800_000_000_000);
  assert.equal(result.state.action, 'WAIT_DATA');
  assert.equal(result.state.champion, null);
}

let promoted;
{
  const biased = records(40, index => 74 + (index % 5), index => index % 5 < 2 ? 'WIN' : 'LOSS');
  promoted = AI.evolve(biased, null, 1_800_000_000_000);
  assert.equal(promoted.promoted, true, promoted.state.reason);
  assert.equal(promoted.state.action, 'PROMOTE');
  assert.equal(promoted.state.generation, 1);
  assert(promoted.state.audit.candidate.brier < promoted.state.audit.champion.brier);
  assert(promoted.state.champion.trainedUntil < promoted.state.audit.validationFrom, 'validation must be later than training data');

  const prediction = AI.predict(promoted.state, 78, {
    setup: 'EMA Pullback', regime: 'TREND', session: 'NY', tf: 'M5'
  });
  assert(Math.abs(prediction.delta) <= AI.MAX_LIVE_DELTA * 100 + 1e-9, 'live influence must be capped');
  assert(prediction.probability < 78, 'over-confident raw score should be corrected downward');

  const unchanged = AI.evolve(biased, promoted.state, 1_800_000_001_000);
  assert.equal(unchanged.state.action, 'NO_NEW_OUTCOMES');
  assert.equal(unchanged.state.generation, 1);
}

{
  const freshLosses = records(28, 55, () => 'LOSS');
  const champion = {
    kind: 'ADAPTIVE', version: AI.VERSION, generatedAt: 1, trainedCount: 60,
    validationCount: 12, trainedUntil: freshLosses[0].createdAt - 1,
    globalBias: 0.12, bins: {}, contexts: {},
    metrics: { n: 12, brier: 0.18, logLoss: 0.55, calibrationError: 0.08 }
  };
  const previous = {
    ...champion,
    generatedAt: 0,
    globalBias: -0.12,
    metrics: { n: 12, brier: 0.20, logLoss: 0.58, calibrationError: 0.10 }
  };
  const state = { ...AI.defaultState(), champion, previous, generation: 3, fingerprint: 'old' };
  const result = AI.evolve(freshLosses, state, 1_800_000_002_000);
  assert.equal(result.rolledBack, true, result.state.reason);
  assert.equal(result.state.action, 'ROLLBACK');
  assert.equal(result.state.champion.globalBias, -0.12);
}

console.log('adaptive-ai-v42: all tests passed');
