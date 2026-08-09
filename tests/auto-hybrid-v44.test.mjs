import assert from 'node:assert/strict';
import {
  chooseAutoSource,
  chooseTrainingSource,
  sourcePackFromM1,
  trainingView,
} from '../update-data.mjs';
import { buildHistory } from '../build-ai-history.mjs';
import {
  ARTIFACT_SCHEMA,
  FEATURE_SCHEMA_HASH,
  LABEL_SCHEMA,
  LABEL_SCHEMA_HASH,
  artifactCompatibility,
} from '../build-ai-governance.mjs';
import { compatibleBrain } from '../build-ai-shadow.mjs';

const MINUTE = 60_000;
const start = Math.floor(Date.UTC(2026, 6, 1, 0, 0, 0) / 3_600_000) * 3_600_000;

function candle(i) {
  const wave = Math.sin(i / 23) * 1.7 + Math.sin(i / 71) * 3.4;
  const trend = i * 0.002;
  const open = 2300 + trend + wave;
  const close = open + Math.sin(i / 7) * 0.18;
  const high = Math.max(open, close) + 0.22;
  const low = Math.min(open, close) - 0.22;
  return { ts: start + i * MINUTE, open, high, low, close };
}

const rows = Array.from({ length: 2501 }, (_, i) => candle(i));

// Router policy: healthy MT5 wins and API is ECO fallback only.
assert.deepEqual(
  chooseAutoSource({ marketOpen: true, mt5Connected: true, mt5Fresh: true, mt5Usable: true, twelveFresh: true, twelveUsable: true }),
  { kind: 'MT5', mode: 'MT5_HEAVY' },
);
assert.deepEqual(
  chooseAutoSource({ marketOpen: true, mt5Connected: false, mt5Fresh: false, mt5Usable: false, twelveFresh: true, twelveUsable: true }),
  { kind: 'TWELVE', mode: 'API_ECO' },
);
assert.deepEqual(
  chooseAutoSource({ marketOpen: true, mt5Connected: true, mt5Fresh: false, mt5Usable: true, twelveFresh: true, twelveUsable: true }),
  { kind: 'TWELVE', mode: 'API_ECO' },
  'a connected but stale MT5 price stream must not freeze the app when API data is fresh',
);

// V44.1 regression: live and training routers are independent.
assert.deepEqual(
  chooseTrainingSource({
    mt5Connected: true,
    mt5ArchiveAvailable: true,
    twelveArchiveAvailable: true,
    previousTrainingFeed: 'TWELVE_DATA_PRIMARY',
  }),
  { kind: 'MT5', trainingFeed: 'MT5_ACADEMY', mode: 'HEAVY' },
  'connected MT5 with an isolated archive must stay the HEAVY training source even when live routing uses Twelve ECO',
);
assert.deepEqual(
  chooseTrainingSource({
    mt5Connected: false,
    mt5ArchiveAvailable: true,
    twelveArchiveAvailable: true,
    previousTrainingFeed: 'MT5_ACADEMY',
  }),
  { kind: 'TWELVE', trainingFeed: 'TWELVE_DATA_PRIMARY', mode: 'ECO' },
  'when MT5/computer is offline, training must return to the Twelve Data primary archive instead of using stale MT5 training',
);
assert.deepEqual(
  chooseTrainingSource({
    mt5Connected: true,
    mt5ArchiveAvailable: false,
    twelveArchiveAvailable: true,
  }),
  { kind: 'TWELVE', trainingFeed: 'TWELVE_DATA_PRIMARY', mode: 'ECO' },
  'MT5 heartbeat without a usable isolated archive must not block API ECO training',
);

const mt5Source = sourcePackFromM1(
  { timeframes: {} },
  rows,
  'MT5 isolated academy history',
  {
    active: 'MT5_FALLBACK',
    mode: 'MT5_HISTORY',
    trainingFeed: 'MT5_ACADEMY',
    switching: { mergeFeeds: false },
  },
  { M1: 180, M5: 240, M15: 365, H1: 730 },
);
const mt5Training = trainingView(mt5Source, 'MT5_ACADEMY');
assert.equal(mt5Training.feed.trainingSource, 'xauusd-training.json');
assert.equal(mt5Training.feed.trainingFeed, 'MT5_ACADEMY');
assert.equal(mt5Training.feed.switching.mergeFeeds, false);
assert.match(mt5Training.source, /MT5 ACADEMY/i);

const mt5History = buildHistory(mt5Training);
assert.equal(mt5History.ready, true, mt5History.reason);
assert.equal(mt5History.artifactProvenance.trainingSource, 'xauusd-training.json');
assert.equal(mt5History.artifactProvenance.trainingFeed, 'MT5_ACADEMY');
assert.equal(mt5History.artifactProvenance.mergeFeeds, false);
assert.match(mt5History.sourceFingerprint, /^[a-f0-9]{24}$/);

const twelveSource = sourcePackFromM1(
  { timeframes: {} },
  rows,
  'Twelve Data PRIMARY isolated history',
  {
    active: 'TWELVE_DATA',
    mode: 'PRIMARY_HISTORY',
    trainingFeed: 'TWELVE_DATA_PRIMARY',
    switching: { mergeFeeds: false },
  },
  { M1: 30, M5: 90, M15: 180, H1: 365 },
);
const twelveTraining = trainingView(twelveSource, 'TWELVE_DATA_PRIMARY');
const twelveHistory = buildHistory(twelveTraining);
assert.equal(twelveHistory.ready, true, twelveHistory.reason);
assert.equal(twelveHistory.artifactProvenance.trainingSource, 'xauusd-training.json');
assert.equal(twelveHistory.artifactProvenance.trainingFeed, 'TWELVE_DATA_PRIMARY');

function governanceArtifact(trainingFeed = 'MT5_ACADEMY') {
  return {
    version: 'V42.0',
    ready: true,
    status: 'READY',
    sourceFingerprint: 'v44-fixture-source',
    artifactSchema: {
      version: ARTIFACT_SCHEMA,
      featureSchemaHash: FEATURE_SCHEMA_HASH,
      labelSchemaHash: LABEL_SCHEMA_HASH,
    },
    artifactProvenance: {
      schemaVersion: ARTIFACT_SCHEMA,
      trainingSource: 'xauusd-training.json',
      trainingFeed,
      mergeFeeds: false,
      featureSchemaHash: FEATURE_SCHEMA_HASH,
      labelSchema: LABEL_SCHEMA,
      labelSchemaHash: LABEL_SCHEMA_HASH,
      sourceFingerprint: 'v44-fixture-source',
      dataWatermark: 10_000,
    },
    modelHealth: { score: 80, driftPts: 4 },
    validation: { coverage: 70, brier: 0.18, calibrationError: 5 },
    current: { uncertaintyPts: 10 },
    qualityGuards: { hardQuarantine: false, backgroundUse: 'TRUSTED' },
  };
}
assert.deepEqual(artifactCompatibility(governanceArtifact()), { ok: true, reasons: [] });
assert.equal(
  artifactCompatibility({
    ...governanceArtifact(),
    artifactProvenance: { ...governanceArtifact().artifactProvenance, trainingFeed: 'TWELVE_DATA_PRIMARY', trainingSource: 'xauusd-fallback.json' },
  }).ok,
  false,
  'source/feed pairs outside the router contract must be quarantined',
);

function shadowBrain(trainingFeed = 'MT5_ACADEMY') {
  return {
    version: 'V42 AUTONOMOUS SELF-PLAY PRECISION BRAIN',
    ready: true,
    status: 'TRUSTED',
    governance: { trusted: true },
    sourceFingerprint: 'shadow-v44',
    artifactProvenance: {
      schemaVersion: 'KAGE_AI_V42',
      trainingSource: 'xauusd-training.json',
      trainingFeed,
      mergeFeeds: false,
      labelSchema: 'M1_FIRST_HIT_V42',
      labelSchemaHash: '7c9ff5daadb124444d716c94',
      featureSchemaHash: 'feature-v44',
      sourceFingerprint: 'shadow-v44',
      dataWatermark: 10_000,
      candidateSchemaCount: 12,
    },
    artifactSchema: {
      version: 'KAGE_AI_V42',
      featureSchemaHash: 'feature-v44',
      labelSchemaHash: '7c9ff5daadb124444d716c94',
    },
  };
}
assert.equal(compatibleBrain(shadowBrain('MT5_ACADEMY')), true);
assert.equal(compatibleBrain(shadowBrain('TWELVE_DATA_PRIMARY')), true);
assert.equal(compatibleBrain({
  ...shadowBrain(),
  artifactProvenance: { ...shadowBrain().artifactProvenance, trainingSource: 'xauusd-fallback.json' },
}), false);

console.log('auto hybrid V44: all tests passed');
