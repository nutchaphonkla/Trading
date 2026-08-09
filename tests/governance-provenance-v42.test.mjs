import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_SCHEMA,
  FEATURE_SCHEMA_HASH,
  LABEL_SCHEMA,
  LABEL_SCHEMA_HASH,
  artifactCompatibility,
  deployableArtifact,
  main,
  modelScore,
  quarantineArtifact,
} from '../build-ai-governance.mjs';

function validArtifact(fingerprint = 'fixture-source', watermark = 1_000) {
  return {
    version: 'V42.0',
    engine: 'ONEMONTH-GOVERNED-CHALLENGER-V42',
    generatedAt: '2026-08-10T00:00:00.000Z',
    ready: true,
    status: 'READY',
    sourceFingerprint: fingerprint,
    artifactSchema: {
      version: ARTIFACT_SCHEMA,
      featureSchemaHash: FEATURE_SCHEMA_HASH,
      labelSchemaHash: LABEL_SCHEMA_HASH,
    },
    artifactProvenance: {
      schemaVersion: ARTIFACT_SCHEMA,
      trainingSource: 'xauusd-primary.json',
      trainingFeed: 'TWELVE_DATA_PRIMARY',
      mergeFeeds: false,
      featureSchemaHash: FEATURE_SCHEMA_HASH,
      labelSchema: LABEL_SCHEMA,
      labelSchemaHash: LABEL_SCHEMA_HASH,
      sourceFingerprint: fingerprint,
      dataWatermark: watermark,
    },
    modelHealth: { score: 75, driftPts: 4 },
    validation: { coverage: 70, brier: 0.20, calibrationError: 8 },
    global: { samples: 300, brier: 0.20, calibrationError: 8 },
    current: { uncertaintyPts: 12 },
    qualityGuards: { hardQuarantine: false, backgroundUse: 'TRUSTED' },
  };
}

{
  const valid = validArtifact();
  assert.deepEqual(artifactCompatibility(valid), { ok: true, reasons: [] });
  assert.equal(deployableArtifact(valid), true);
  assert.ok(modelScore(valid) > 0);

  const legacy = { ...valid, version: '3.2', artifactSchema: undefined, artifactProvenance: undefined };
  assert.equal(artifactCompatibility(legacy).ok, false);
  assert.equal(modelScore(legacy), 0);

  const mismatch = validArtifact();
  mismatch.artifactProvenance = { ...mismatch.artifactProvenance, sourceFingerprint: 'different' };
  assert.equal(artifactCompatibility(mismatch).ok, false);

  const quarantined = quarantineArtifact(valid, 'TEST_GUARD');
  assert.equal(quarantined.ready, false);
  assert.equal(quarantined.status, 'QUARANTINED');
  assert.equal(quarantined.qualityGuards.hardQuarantine, true);
  assert.equal(modelScore(quarantined), 0);
}

{
  const oldCwd = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kage-governance-v42-'));
  try {
    process.chdir(temp);
    fs.writeFileSync('ai-learning-candidate.json', JSON.stringify({
      ...validArtifact(),
      version: '3.2',
      artifactSchema: undefined,
      artifactProvenance: undefined,
    }));
    const blocked = main();
    const blockedChampion = JSON.parse(fs.readFileSync('ai-learning.json', 'utf8'));
    assert.equal(blocked.action, 'QUARANTINE_NO_DEPLOYABLE_MODEL');
    assert.equal(blockedChampion.ready, false, 'an unqualified first candidate must never become READY champion');

    for (const file of fs.readdirSync(temp)) fs.unlinkSync(path.join(temp, file));
    fs.writeFileSync('ai-learning-candidate.json', JSON.stringify(validArtifact()));
    const promoted = main();
    assert.equal(promoted.action, 'PROMOTE_CHALLENGER');
    assert.equal(promoted.decision.promoted, true);

    const repeated = main();
    assert.equal(repeated.action, 'KEEP_IDENTICAL_EVIDENCE');
    assert.equal(repeated.decision.promoted, false);
    assert.equal(repeated.promotions.length, 1, 'identical source evidence must not create another promotion');
  } finally {
    process.chdir(oldCwd);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log('governance provenance V42: all tests passed');
