import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANDIDATE = 'ai-learning-candidate.json';
const CHAMPION = 'ai-learning.json';
const PREVIOUS = 'ai-learning-previous.json';
const GOVERNANCE = 'ai-model-governance.json';
const JOURNAL = 'ai-outcome-journal.json';
const VERSION = 'V42.0';
const ENGINE = 'ONEMONTH-MODEL-GOVERNANCE-V42';
export const ARTIFACT_SCHEMA = 'KAGE_AI_V42';
export const FEATURE_SCHEMA_HASH = 'c3372751b985cd6c32d06e0f';
export const LABEL_SCHEMA = 'NODE_M30_FIRST_TOUCH_ATR_TP0.8_SL0.6_TIE_SL_TIMEOUT_SIGNED_GT_0.12_V42';
export const LABEL_SCHEMA_HASH = 'dd88c080f7855fdab25a56f0';
const ALLOWED_TRAINING_PAIRS = new Set(['xauusd-primary.json|TWELVE_DATA_PRIMARY','xauusd-training.json|TWELVE_DATA_PRIMARY','xauusd-training.json|MT5_ACADEMY']);
const HOUR = 3_600_000;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const read = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
};
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const modelId = m => m?.modelId || `${m?.engine || 'MODEL'}:${m?.sourceFingerprint || 'NOFP'}`;
const trainingPair = m => { const p=m?.artifactProvenance||{}; return `${p.trainingSource||''}|${String(p.trainingFeed||'').toUpperCase()}`; };

export function artifactCompatibility(model) {
  const reasons = [];
  if (!model || typeof model !== 'object') return { ok: false, reasons: ['MISSING_ARTIFACT'] };
  const provenance = model.artifactProvenance || {};
  const schema = model.artifactSchema || {};
  const schemaVersion = provenance.schemaVersion || schema.version || model.schemaVersion;
  const featureHash = provenance.featureSchemaHash;
  const labelHash = provenance.labelSchemaHash;

  if (!String(model.version || '').startsWith('V42')) reasons.push('VERSION_NOT_V42');
  if (schemaVersion !== ARTIFACT_SCHEMA) reasons.push('SCHEMA_VERSION_MISMATCH');
  const trainingPair = `${provenance.trainingSource || ''}|${String(provenance.trainingFeed || '').toUpperCase()}`;
  if (!ALLOWED_TRAINING_PAIRS.has(trainingPair)) reasons.push('TRAINING_SOURCE_FEED_MISMATCH');
  if (provenance.mergeFeeds !== false) reasons.push('FEED_ISOLATION_NOT_EXPLICIT');
  if (featureHash !== FEATURE_SCHEMA_HASH || schema.featureSchemaHash !== FEATURE_SCHEMA_HASH) reasons.push('FEATURE_SCHEMA_HASH_MISMATCH');
  if (provenance.labelSchema !== LABEL_SCHEMA) reasons.push('LABEL_SCHEMA_MISMATCH');
  if (labelHash !== LABEL_SCHEMA_HASH || schema.labelSchemaHash !== LABEL_SCHEMA_HASH) reasons.push('LABEL_SCHEMA_HASH_MISMATCH');
  if (!provenance.sourceFingerprint || provenance.sourceFingerprint !== model.sourceFingerprint) reasons.push('SOURCE_FINGERPRINT_MISMATCH');
  if (!(n(provenance.dataWatermark) > 0)) reasons.push('DATA_WATERMARK_MISSING');
  return { ok: reasons.length === 0, reasons };
}

export function deployableArtifact(model) {
  const compatibility = artifactCompatibility(model);
  return compatibility.ok
    && model?.ready === true
    && model?.status !== 'QUARANTINED'
    && model?.qualityGuards?.hardQuarantine !== true;
}

export function quarantineArtifact(model, reason) {
  if (!model || typeof model !== 'object') return null;
  return {
    ...model,
    ready: false,
    status: 'QUARANTINED',
    qualityGuards: {
      ...(model.qualityGuards || {}),
      hardQuarantine: true,
      backgroundUse: 'QUARANTINED',
    },
    governance: {
      ...(model.governance || {}),
      quarantinedAt: new Date().toISOString(),
      quarantineReason: reason,
    },
  };
}

export function modelScore(model) {
  if (!deployableArtifact(model)) return 0;
  const mh = model.modelHealth || {};
  const validation = model.validation || {};
  const quality = model.qualityGuards || {};
  const current = model.current || {};
  const global = model.global || {};
  const health = clamp(n(mh.score), 0, 100);
  const brier = clamp(n(validation.brier ?? global.brier ?? 0.40), 0, 1);
  const calibration = clamp(n(validation.calibrationError ?? global.calibrationError ?? 99), 0, 100);
  const coverage = clamp(n(validation.coverage ?? mh.coverage), 0, 100);
  const uncertainty = clamp(n(current.uncertaintyPts ?? mh.uncertaintyPts ?? 90), 0, 100);
  const drift = clamp(n(mh.driftPts), 0, 100);
  const samples = n(global.samples);
  const sampleScore = clamp(Math.log10(samples + 1) / 3 * 100, 0, 100);
  const score = health * .30
    + clamp(100 - brier * 220, 0, 100) * .20
    + clamp(100 - calibration * 3, 0, 100) * .20
    + coverage * .10
    + clamp(100 - uncertainty * 2, 0, 100) * .08
    + clamp(100 - drift * 2.5, 0, 100) * .07
    + sampleScore * .05;
  const disqualified = quality.hardQuarantine || coverage < 15 || brier > .34 || calibration > 30 || samples < 55;
  return disqualified ? 0 : clamp(score, 0, 100);
}

function compact(model) {
  if (!model) return null;
  const compatibility = artifactCompatibility(model);
  return {
    modelId: modelId(model),
    engine: model.engine || null,
    sourceFingerprint: model.sourceFingerprint || null,
    dataWatermark: model.artifactProvenance?.dataWatermark || null,
    generatedAt: model.generatedAt || null,
    trainedThrough: model.trainedThrough || null,
    ready: model.ready === true,
    status: model.status || null,
    schemaCompatible: compatibility.ok,
    compatibilityReasons: compatibility.reasons,
    score: Number(modelScore(model).toFixed(2)),
    health: n(model.modelHealth?.score),
    samples: n(model.global?.samples),
    brier: n(model.validation?.brier),
    calibration: n(model.validation?.calibrationError),
    coverage: n(model.validation?.coverage),
    drift: n(model.modelHealth?.driftPts),
    uncertainty: n(model.current?.uncertaintyPts),
    guard: model.qualityGuards?.backgroundUse || 'UNKNOWN',
  };
}

function journalStatsFor(journal, id) {
  const rows = (journal?.entries || [])
    .filter(e => e.modelId === id && e.horizons?.M30?.resolved && e.horizons.M30.correct !== null)
    .slice(-40);
  if (!rows.length) return { samples: 0, hitRate: null, avgR: null, goodEntryRate: null, falseSignals: 0 };
  const hit = rows.filter(e => e.horizons.M30.correct).length;
  const avgR = rows.reduce((sum, e) => sum + n(e.horizons.M30.returnR), 0) / rows.length;
  const quality = rows.map(e => e.horizons.M30.entryQuality).filter(Boolean);
  const good = quality.filter(x => x === 'GOOD_ENTRY').length;
  return { samples: rows.length, hitRate: 100 * hit / rows.length, avgR, goodEntryRate: quality.length ? 100 * good / quality.length : null, falseSignals: rows.length - hit };
}

function planJournalStatsFor(journal, id) {
  const rows = (journal?.planEntries || [])
    .filter(e => e.modelId === id && e.horizons?.M30?.resolved && e.horizons.M30.correct !== null)
    .slice(-40);
  if (!rows.length) return { samples: 0, hitRate: null, avgR: null, goodEntryRate: null, fillCount: 0 };
  const hit = rows.filter(e => e.horizons.M30.correct).length;
  const avgR = rows.reduce((sum, e) => sum + n(e.horizons.M30.returnR), 0) / rows.length;
  const good = rows.filter(e => e.horizons.M30.entryQuality === 'GOOD_ENTRY').length;
  return { samples: rows.length, hitRate: 100 * hit / rows.length, avgR, goodEntryRate: 100 * good / rows.length, fillCount: rows.length };
}

function annotate(model, role, governance) {
  return { ...model, modelId: modelId(model), role, governance: { ...(model.governance || {}), ...governance } };
}

function sameEvidence(a, b) {
  return !!a && !!b
    && a.sourceFingerprint === b.sourceFingerprint
    && n(a.artifactProvenance?.dataWatermark) === n(b.artifactProvenance?.dataWatermark);
}

function baseState(state, now, action, reason, candidate, champion, previous, decision = {}) {
  const deployedStats = champion ? journalStatsFor(read(JOURNAL, { entries: [] }), modelId(champion)) : { samples: 0 };
  const deployedPlanStats = champion ? planJournalStatsFor(read(JOURNAL, { entries: [] }), modelId(champion)) : { samples: 0 };
  return {
    ...state,
    version: VERSION,
    engine: ENGINE,
    schemaVersion: ARTIFACT_SCHEMA,
    expectedFeatureSchemaHash: FEATURE_SCHEMA_HASH,
    expectedLabelSchemaHash: LABEL_SCHEMA_HASH,
    updatedAt: now,
    action,
    reason,
    champion: compact(champion),
    challenger: compact(candidate),
    previous: compact(previous),
    deployedJournal: deployedStats,
    deployedPlanJournal: deployedPlanStats,
    decision,
  };
}

export function main() {
  const candidate = read(CANDIDATE);
  let champion = read(CHAMPION);
  let previous = read(PREVIOUS);
  const journal = read(JOURNAL, { entries: [], planEntries: [] });
  let state = read(GOVERNANCE, { version: VERSION, engine: ENGINE, promotions: [], rollbacks: [] });
  if (candidate) candidate.modelId = modelId(candidate);
  if (champion) champion.modelId = modelId(champion);
  if (previous) previous.modelId = modelId(previous);

  const now = new Date().toISOString();
  if (!candidate) {
    let action = 'WAIT_CANDIDATE';
    let reason = 'No challenger pack is available';
    if (champion && !deployableArtifact(champion)) {
      const reasons = artifactCompatibility(champion).reasons;
      champion = quarantineArtifact(champion, `INCOMPATIBLE_CHAMPION:${reasons.join('|')}`);
      write(CHAMPION, champion);
      action = 'QUARANTINE_INCOMPATIBLE_CHAMPION';
      reason = reasons.join(', ') || 'Champion is not deployable';
    } else if (champion) {
      action = 'KEEP_CHAMPION_NO_CHALLENGER';
      reason = 'Compatible champion retained; no challenger pack';
    }
    state = baseState(state, now, action, reason, null, champion, previous, { promoted: false, rolledBack: false, candidateQualified: false });
    write(GOVERNANCE, state);
    console.log(`Governance ${action}: ${reason}`);
    return state;
  }

  let action = 'KEEP_CHAMPION';
  let reason = 'Champion remains stronger or challenger not proven';
  let rolledBack = false;
  let promoted = false;

  // Rollback is allowed only between deployable V42 artifacts. Legacy score-zero
  // packs must never be swapped into service by the degradation branch.
  if (deployableArtifact(champion) && deployableArtifact(previous)) {
    const live = journalStatsFor(journal, modelId(champion));
    const planLive = planJournalStatsFor(journal, modelId(champion));
    const previousScore = modelScore(previous);
    const championScore = modelScore(champion);
    const badSignal = live.samples >= 12 && ((live.hitRate !== null && live.hitRate < 38) || (live.avgR !== null && live.avgR < -.10));
    const badPending = planLive.samples >= 10 && ((planLive.hitRate !== null && planLive.hitRate < 38) || (planLive.avgR !== null && planLive.avgR < -.12));
    if ((badSignal || badPending) && previousScore >= championScore - 3) {
      const bad = champion;
      champion = previous;
      previous = bad;
      rolledBack = true;
      write(CHAMPION, annotate(champion, 'CHAMPION', { deployedAt: now, promotionReason: 'AUTO_ROLLBACK_DEGRADED' }));
      write(PREVIOUS, annotate(previous, 'PREVIOUS', { retiredAt: now, retireReason: 'AUTO_ROLLBACK_DEGRADED' }));
      action = 'AUTO_ROLLBACK';
      reason = badPending
        ? `Pending-plan quality degraded: ${planLive.samples} fills`
        : `Champion live journal degraded: ${live.samples} samples`;
      state.rollbacks = [...(state.rollbacks || []), { at: now, from: modelId(bad), to: modelId(champion), reason, live, planLive }].slice(-30);
    }
  }

  const candidateCompatibility = artifactCompatibility(candidate);
  const candidateScore = modelScore(candidate);
  const championScore = modelScore(champion);
  const validation = candidate.validation || {};
  const global = candidate.global || {};
  const candidateQualified = deployableArtifact(candidate)
    && n(validation.coverage) >= 15
    && n(validation.brier) <= .34
    && n(validation.calibrationError) <= 30
    && n(global.samples) >= 55;
  const championDeployable = deployableArtifact(champion);
  const championAge = champion?.generatedAt ? Date.now() - Date.parse(champion.generatedAt) : Infinity;
  const identicalEvidence = sameEvidence(candidate, champion);
  const materiallyBetter = !championDeployable || candidateScore >= championScore + 1.5;
  const freshNonInferior = championDeployable && championAge > 12 * HOUR && candidateScore >= championScore - 1.5;
  const schemaMigration = !!champion && !championDeployable && candidateQualified;
  const sourceMigration = !!champion && !!candidate && trainingPair(champion) !== trainingPair(candidate);
  const rollbackProtection = rolledBack;

  if (sourceMigration && !candidateQualified && championDeployable) {
    champion = quarantineArtifact(champion, `TRAINING_SOURCE_SWITCH_WAIT:${trainingPair(champion)}->${trainingPair(candidate)}`);
    write(CHAMPION, champion);
    action = 'QUARANTINE_SOURCE_SWITCH_WAIT';
    reason = 'Training source changed; old-source champion is blocked until a qualified same-source challenger exists';
  } else if (candidateQualified && !identicalEvidence && !rollbackProtection && (materiallyBetter || freshNonInferior || schemaMigration || sourceMigration)) {
    const old = champion;
    // Never destroy a compatible rollback artifact by replacing it with legacy state.
    if (deployableArtifact(old)) write(PREVIOUS, annotate(old, 'PREVIOUS', { retiredAt: now }));
    champion = annotate(candidate, 'CHAMPION', {
      deployedAt: now,
      promotionReason: sourceMigration ? 'V44_SOURCE_MIGRATION' : schemaMigration ? 'V42_SCHEMA_MIGRATION' : materiallyBetter ? 'BETTER_VALIDATION' : 'FRESH_NON_INFERIOR',
    });
    write(CHAMPION, champion);
    promoted = true;
    action = 'PROMOTE_CHALLENGER';
    reason = sourceMigration
      ? `Switch champion to current isolated training source ${trainingPair(candidate)}`
      : schemaMigration
      ? 'Replace incompatible champion with a qualified V42 artifact'
      : materiallyBetter
        ? `Challenger score ${candidateScore.toFixed(1)} > champion ${championScore.toFixed(1)}`
        : `Champion age >12h and challenger is non-inferior (${candidateScore.toFixed(1)} vs ${championScore.toFixed(1)})`;
    state.promotions = [...(state.promotions || []), {
      at: now,
      from: old ? modelId(old) : null,
      to: modelId(champion),
      sourceFingerprint: candidate.sourceFingerprint,
      dataWatermark: candidate.artifactProvenance?.dataWatermark,
      candidateScore: Number(candidateScore.toFixed(2)),
      championScore: Number(championScore.toFixed(2)),
      reason,
    }].slice(-50);
  } else if (!championDeployable) {
    const target = champion || candidate;
    const causes = champion
      ? artifactCompatibility(champion).reasons
      : candidateCompatibility.reasons;
    champion = quarantineArtifact(target, `NO_DEPLOYABLE_V42_ARTIFACT:${causes.join('|') || 'QUALITY_GUARD'}`);
    write(CHAMPION, champion);
    action = 'QUARANTINE_NO_DEPLOYABLE_MODEL';
    reason = candidateQualified
      ? 'Qualified challenger was blocked by rollback protection or duplicate evidence'
      : `No deployable V42 artifact: ${causes.join(', ') || 'quality guard failed'}`;
  } else {
    if (identicalEvidence) {
      action = 'KEEP_IDENTICAL_EVIDENCE';
      reason = 'Challenger has the same source fingerprint and watermark as champion';
    }
    champion = annotate(champion, 'CHAMPION', {
      lastChallengedAt: now,
      lastChallengerId: modelId(candidate),
      lastChallengerScore: Number(candidateScore.toFixed(2)),
      keepReason: reason,
    });
    write(CHAMPION, champion);
  }

  const deployed = read(CHAMPION, champion);
  const storedPrevious = read(PREVIOUS, previous);
  state = baseState(state, now, action, reason, candidate, deployed, storedPrevious, {
    promoted,
    rolledBack,
    candidateQualified,
    candidateCompatibility,
    championDeployable: deployableArtifact(deployed),
    materiallyBetter,
    freshNonInferior,
    schemaMigration,
    sourceMigration,
    identicalEvidence,
  });
  write(GOVERNANCE, state);
  console.log(`Governance ${action}: ${reason}`);
  console.log('Champion', state.champion);
  console.log('Challenger', state.challenger);
  return state;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) main();
