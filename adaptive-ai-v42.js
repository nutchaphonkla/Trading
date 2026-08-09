(function attachAdaptiveAi(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KageAdaptiveAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAdaptiveAi() {
  'use strict';

  const VERSION = 'V42 ADAPTIVE CHAMPION';
  const MIN_TOTAL = 18;
  const MIN_PROMOTE_TOTAL = 24;
  const MIN_VALIDATION = 6;
  const MAX_LIVE_DELTA = 0.08;
  const ARTIFACT_SCHEMA = 'KAGE_AI_V42';
  const ML_LABEL_SCHEMA = 'M1_FIRST_HIT_V42';
  const ML_LABEL_HASH = '7c9ff5daadb124444d716c94';
  const NODE_FEATURE_HASH = 'c3372751b985cd6c32d06e0f';
  const NODE_LABEL_SCHEMA = 'NODE_M30_FIRST_TOUCH_ATR_TP0.8_SL0.6_TIE_SL_TIMEOUT_SIGNED_GT_0.12_V42';
  const NODE_LABEL_HASH = 'dd88c080f7855fdab25a56f0';
  const HISTORY_FEATURE_HASH = '17e82bd347b6f345ad289df1';
  const HISTORY_LABEL_SCHEMA = 'FUTURE_CLOSE_DIRECTION_BY_TF_V42';
  const HISTORY_LABEL_HASH = 'fffe7703ec24c8cac8851daa';

  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
  const probability = value => clamp(value, 0.03, 0.97);
  const cleanLabel = value => String(value || 'ANY').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').slice(0, 32) || 'ANY';

  function contextKey(row) {
    return [row.setup, row.regime, row.session, row.tf, row.feed].map(cleanLabel).join('|');
  }

  function normalizeRecord(row) {
    if (!row || !['WIN', 'LOSS'].includes(row.outcome)) return null;
    const creationFeed = String(row.creationFeed || '');
    const outcomeFeed = String(row.outcomeFeed || '');
    if (!['TWELVE_DATA_PRIMARY', 'MT5_FALLBACK'].includes(creationFeed) || creationFeed !== outcomeFeed) return null;
    const createdAt = Number(row.marketTs);
    const filledAt = Number(row.fillAt);
    const terminalAt = Number(row.terminalAt);
    const rawScore = Number(row.rawScore);
    if (!Number.isFinite(createdAt) || !Number.isFinite(filledAt) || !Number.isFinite(terminalAt)
      || filledAt <= createdAt || terminalAt <= filledAt || !Number.isFinite(rawScore)) return null;
    return {
      id: String(row.sig || `${createdAt}|${row.side || ''}|${row.tf || ''}|${rawScore}`),
      createdAt,
      filledAt,
      terminalAt,
      raw: probability(rawScore / 100),
      y: row.outcome === 'WIN' ? 1 : 0,
      setup: cleanLabel(row.setup),
      regime: cleanLabel(row.regime),
      session: cleanLabel(row.session),
      tf: cleanLabel(row.tf),
      feed: cleanLabel(creationFeed)
    };
  }

  function normalizeRecords(records) {
    const unique = new Map();
    for (const source of Array.isArray(records) ? records : []) {
      const row = normalizeRecord(source);
      if (row) unique.set(row.id, row);
    }
    return [...unique.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  function normalizeBars(rows) {
    const unique = new Map();
    for (const source of Array.isArray(rows) ? rows : []) {
      const ts = Number(source?.ts);
      const open = Number(source?.open);
      const high = Number(source?.high);
      const low = Number(source?.low);
      const close = Number(source?.close);
      if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)
        || high < Math.max(open, close) || low > Math.min(open, close) || high < low) continue;
      unique.set(ts, { ts, open, high, low, close });
    }
    return [...unique.values()].sort((a, b) => a.ts - b.ts);
  }

  function aggregateClosedBars(rows, bucketMs, watermark, sourceMs = 60_000) {
    const width = Math.max(60_000, Number(bucketMs) || 60_000);
    const sourceWidth = Math.max(60_000, Number(sourceMs) || 60_000);
    const closedThrough = Number(watermark);
    if (!Number.isFinite(closedThrough) || closedThrough <= 0) return [];
    const buckets = new Map();
    for (const candle of normalizeBars(rows)) {
      if (candle.ts + sourceWidth > closedThrough) continue;
      const ts = Math.floor(candle.ts / width) * width;
      const current = buckets.get(ts);
      if (!current) {
        buckets.set(ts, { ...candle, ts, count: 1, sourceTimestamps: new Set([candle.ts]) });
      } else {
        current.high = Math.max(current.high, candle.high);
        current.low = Math.min(current.low, candle.low);
        current.close = candle.close;
        current.sourceTimestamps.add(candle.ts);
        current.count = current.sourceTimestamps.size;
      }
    }
    const minimumCount = Math.max(1, Math.floor(width / sourceWidth));
    return [...buckets.values()]
      .filter(candle => candle.ts + width <= closedThrough && candle.count >= minimumCount)
      .sort((a, b) => a.ts - b.ts)
      .map(({ sourceTimestamps, count, ...candle }) => candle);
  }

  function resolveOutcome(record, bars, replayFeed, maxBars = 120) {
    const creationFeed = String(record?.creationFeed || '');
    const feed = String(replayFeed || '');
    const side = String(record?.side || '').toUpperCase();
    const marketTs = Number(record?.marketTs);
    const entry = Number(record?.entry);
    const sl = Number(record?.sl);
    const tp1 = Number(record?.tp1);
    if (!['TWELVE_DATA_PRIMARY', 'MT5_FALLBACK'].includes(feed) || creationFeed !== feed
      || !['BUY', 'SELL'].includes(side) || ![marketTs, entry, sl, tp1].every(Number.isFinite)) {
      return { replayed: false, resolved: false, reason: 'INVALID_PROVENANCE_OR_LEVELS' };
    }
    const orderType = String(record?.orderType || `${side}_LIMIT`).toUpperCase();
    const orderKind = orderType.includes('STOP') ? 'STOP' : 'LIMIT';
    const future = normalizeBars(bars).filter(candle => candle.ts > marketTs).slice(0, Math.max(1, Number(maxBars) || 120));
    if (!future.length) return { replayed: false, resolved: false, reason: 'NO_FUTURE_BARS' };

    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) return { replayed: false, resolved: false, reason: 'INVALID_RISK' };
    let fillAt = Number(record.fillAt);
    let filled = Number.isFinite(fillAt) && fillAt > marketTs;
    let mfe = 0;
    let mae = 0;
    let outcome = null;
    let terminalAt = null;

    for (const candle of future) {
      if (!filled) {
        const touched = orderKind === 'STOP'
          ? (side === 'BUY' ? candle.high >= entry : candle.low <= entry)
          : (side === 'BUY' ? candle.low <= entry : candle.high >= entry);
        if (touched) {
          filled = true;
          fillAt = candle.ts;
          // A fill candle that also touches SL/TP has unknown intrabar ordering.
          // Do not silently ignore that price action and label from a later candle;
          // quarantine this replay so it cannot bias adaptive training.
          const stopOnFill = side === 'BUY' ? candle.low <= sl : candle.high >= sl;
          const targetOnFill = side === 'BUY' ? candle.high >= tp1 : candle.low <= tp1;
          if (stopOnFill || targetOnFill) {
            return {
              replayed: true, resolved: false, outcome: null, outcomeFeed: null,
              fillAt, fillPrice: entry, orderType, terminalAt: null, mfe: 0, mae: 0,
              reason: 'AMBIGUOUS_FILL_CANDLE'
            };
          }
        }
        continue;
      }
      if (candle.ts <= fillAt) continue;
      if (side === 'BUY') {
        const stopHit = candle.low <= sl;
        const targetHit = candle.high >= tp1;
        mae = Math.max(mae, Math.max(0, (entry - candle.low) / risk));
        mfe = Math.max(mfe, Math.max(0, (candle.high - entry) / risk));
        if (stopHit) { outcome = 'LOSS'; terminalAt = candle.ts; break; }
        if (targetHit) { outcome = 'WIN'; terminalAt = candle.ts; break; }
      } else {
        const stopHit = candle.high >= sl;
        const targetHit = candle.low <= tp1;
        mae = Math.max(mae, Math.max(0, (candle.high - entry) / risk));
        mfe = Math.max(mfe, Math.max(0, (entry - candle.low) / risk));
        if (stopHit) { outcome = 'LOSS'; terminalAt = candle.ts; break; }
        if (targetHit) { outcome = 'WIN'; terminalAt = candle.ts; break; }
      }
    }
    return {
      replayed: true,
      resolved: ['WIN', 'LOSS'].includes(outcome),
      outcome,
      outcomeFeed: outcome ? feed : null,
      fillAt: filled ? fillAt : null,
      fillPrice: filled ? entry : null,
      orderType,
      terminalAt,
      mfe,
      mae,
      reason: outcome ? 'FIRST_HIT_AFTER_CONFIRMED_FILL' : filled ? 'FILLED_WAIT_OUTCOME' : 'WAIT_FILL'
    };
  }

  function validateArtifact(pack, { ml = false, history = false } = {}) {
    const provenance = pack?.artifactProvenance || {};
    const schema = pack?.artifactSchema || {};
    const current = pack?.current || {};
    const version = String(pack?.version || '');
    const schemaVersion = String(provenance.schemaVersion || schema.version || '');
    const trainingSource = String(provenance.trainingSource || '');
    const trainingFeed = String(provenance.trainingFeed || '').toUpperCase();
    const featureHash = String(provenance.featureSchemaHash || '');
    const labelSchema = String(provenance.labelSchema || '');
    const labelHash = String(provenance.labelSchemaHash || '');
    const sourceFingerprint = String(provenance.sourceFingerprint || '');
    const watermark = Number(provenance.dataWatermark || 0);
    const hex24 = /^[a-f0-9]{24}$/i;
    const expectedFeature = ml ? null : history ? HISTORY_FEATURE_HASH : NODE_FEATURE_HASH;
    const expectedLabelSchema = ml ? ML_LABEL_SCHEMA : history ? HISTORY_LABEL_SCHEMA : NODE_LABEL_SCHEMA;
    const expectedLabelHash = ml ? ML_LABEL_HASH : history ? HISTORY_LABEL_HASH : NODE_LABEL_HASH;
    const versionOk = version.startsWith('V42') && schemaVersion === ARTIFACT_SCHEMA;
    const feedOk = trainingSource === 'xauusd-primary.json'
      && trainingFeed === 'TWELVE_DATA_PRIMARY' && provenance.mergeFeeds === false;
    const fingerprintOk = hex24.test(sourceFingerprint)
      && sourceFingerprint === String(pack?.sourceFingerprint || '')
      && Number.isFinite(watermark) && watermark > 0;
    const featureOk = hex24.test(featureHash)
      && featureHash === String(schema.featureSchemaHash || '')
      && (!expectedFeature || featureHash === expectedFeature);
    const labelOk = labelSchema === expectedLabelSchema
      && labelHash === expectedLabelHash
      && labelHash === String(schema.labelSchemaHash || '');
    const candidatesOk = !ml || (Number(provenance.candidateSchemaCount) === 12
      && Array.isArray(current.candidates) && current.candidates.length === 12
      && Number(current.candidateCount) === 12);
    const governanceOk = !ml || (String(pack?.status || '').toUpperCase() === 'TRUSTED'
      && pack?.governance?.trusted === true);
    const reasons = [];
    if (!versionOk) reasons.push('UNSUPPORTED_SCHEMA');
    if (!feedOk) reasons.push('UNVERIFIED_FEED');
    if (!fingerprintOk) reasons.push('SOURCE_PROVENANCE');
    if (!featureOk) reasons.push('FEATURE_SCHEMA');
    if (!labelOk) reasons.push('LABEL_SCHEMA');
    if (!candidatesOk) reasons.push('CANDIDATE_SCHEMA');
    if (!governanceOk) reasons.push('GOVERNANCE_BLOCK');
    return { ok: reasons.length === 0, reasons, trainingFeed, watermark };
  }

  function binKey(raw) {
    if (raw < 0.55) return 'B0';
    if (raw < 0.65) return 'B1';
    if (raw < 0.75) return 'B2';
    return 'B3';
  }

  function weightedGroup(rows, keyFn, globalBias) {
    const groups = new Map();
    const end = Math.max(0, rows.length - 1);
    rows.forEach((row, index) => {
      const key = keyFn(row);
      const weight = Math.pow(0.5, (end - index) / 45);
      if (!groups.has(key)) groups.set(key, { n: 0, weight: 0, wins: 0, raw: 0 });
      const group = groups.get(key);
      group.n += 1;
      group.weight += weight;
      group.wins += row.y * weight;
      group.raw += row.raw * weight;
    });
    const output = {};
    for (const [key, group] of groups) {
      const observed = (group.wins + 2) / (group.weight + 4);
      const rawAverage = group.weight ? group.raw / group.weight : 0.5;
      const shrink = group.weight / (group.weight + 12);
      output[key] = {
        n: group.n,
        observed,
        rawAverage,
        offset: clamp((observed - probability(rawAverage + globalBias)) * shrink, -0.10, 0.10)
      };
    }
    return output;
  }

  function buildCandidate(trainRows, validationRows, generatedAt) {
    const end = Math.max(0, trainRows.length - 1);
    let totalWeight = 0;
    let weightedWins = 0;
    let weightedRaw = 0;
    trainRows.forEach((row, index) => {
      const weight = Math.pow(0.5, (end - index) / 45);
      totalWeight += weight;
      weightedWins += row.y * weight;
      weightedRaw += row.raw * weight;
    });
    const posterior = (weightedWins + 2) / (totalWeight + 4);
    const rawAverage = totalWeight ? weightedRaw / totalWeight : 0.5;
    const globalBias = clamp(posterior - rawAverage, -0.12, 0.12);
    const model = {
      kind: 'ADAPTIVE',
      version: VERSION,
      generatedAt,
      trainedCount: trainRows.length,
      validationCount: validationRows.length,
      trainedUntil: trainRows.at(-1)?.createdAt || 0,
      globalBias,
      bins: weightedGroup(trainRows, row => binKey(row.raw), globalBias),
      contexts: weightedGroup(trainRows, contextKey, globalBias),
      metrics: null
    };
    model.metrics = scoreModel(model, validationRows);
    return model;
  }

  function rawModelProbability(model, raw, context) {
    const base = probability(raw);
    if (!model || model.kind !== 'ADAPTIVE') return base;
    const bin = model.bins?.[binKey(base)];
    const key = contextKey({
      setup: context?.setup,
      regime: context?.regime,
      session: context?.session,
      tf: context?.tf,
      feed: context?.feed
    });
    const group = model.contexts?.[key];
    const binOffset = bin?.n >= 4 ? Number(bin.offset) || 0 : 0;
    const contextOffset = group?.n >= 5 ? Number(group.offset) || 0 : 0;
    return probability(base + (Number(model.globalBias) || 0) + binOffset + contextOffset);
  }

  function scoreModel(model, rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { n: 0, brier: null, logLoss: null, calibrationError: null };
    let brier = 0;
    let logLoss = 0;
    const buckets = new Map();
    for (const row of list) {
      const predicted = rawModelProbability(model, row.raw, row);
      brier += Math.pow(predicted - row.y, 2);
      logLoss += -(row.y * Math.log(predicted) + (1 - row.y) * Math.log(1 - predicted));
      const key = Math.min(4, Math.floor(predicted * 5));
      if (!buckets.has(key)) buckets.set(key, { n: 0, predicted: 0, actual: 0 });
      const bucket = buckets.get(key);
      bucket.n += 1;
      bucket.predicted += predicted;
      bucket.actual += row.y;
    }
    let calibrationError = 0;
    for (const bucket of buckets.values()) {
      calibrationError += (bucket.n / list.length) * Math.abs(bucket.predicted / bucket.n - bucket.actual / bucket.n);
    }
    return {
      n: list.length,
      brier: brier / list.length,
      logLoss: logLoss / list.length,
      calibrationError
    };
  }

  function modelTrust(model) {
    if (!model || model.kind !== 'ADAPTIVE' || !model.metrics || !Number.isFinite(model.metrics.brier)) return 0;
    const sampleTrust = clamp(model.trainedCount / 70, 0, 1);
    const validationTrust = clamp(model.metrics.n / 18, 0, 1);
    const qualityTrust = clamp((0.32 - model.metrics.brier) / 0.15, 0, 1);
    const calibrationTrust = clamp((0.24 - (model.metrics.calibrationError || 0.24)) / 0.18, 0, 1);
    return clamp(sampleTrust * validationTrust * (0.65 * qualityTrust + 0.35 * calibrationTrust), 0, 1);
  }

  function predict(state, rawScore, context) {
    const raw = probability(Number(rawScore) > 1 ? Number(rawScore) / 100 : Number(rawScore));
    const champion = state?.champion;
    const trust = modelTrust(champion);
    if (!champion || trust <= 0) {
      return { probability: raw * 100, raw: raw * 100, delta: 0, trust: 0, generation: state?.generation || 0, source: 'BASELINE' };
    }
    const learned = rawModelProbability(champion, raw, context);
    const delta = clamp((learned - raw) * trust, -MAX_LIVE_DELTA, MAX_LIVE_DELTA);
    return {
      probability: probability(raw + delta) * 100,
      raw: raw * 100,
      learned: learned * 100,
      delta: delta * 100,
      trust: trust * 100,
      generation: state?.generation || 0,
      source: VERSION
    };
  }

  function fingerprint(rows) {
    let hash = 2166136261;
    for (const row of rows) {
      const text = `${row.id}|${row.y}`;
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${rows.length}:${rows.at(-1)?.createdAt || 0}:${(hash >>> 0).toString(16)}`;
  }

  function defaultState() {
    return {
      version: VERSION,
      generation: 0,
      action: 'WAIT_DATA',
      reason: `ต้องมี outcome อย่างน้อย ${MIN_TOTAL} รายการ`,
      fingerprint: '',
      updatedAt: 0,
      champion: null,
      previous: null,
      candidate: null,
      audit: { total: 0, train: 0, validation: 0 }
    };
  }

  function evolve(records, priorState, now) {
    const rows = normalizeRecords(records);
    const current = priorState && priorState.version === VERSION ? priorState : defaultState();
    const next = { ...current, version: VERSION, updatedAt: Number(now) || Date.now() };
    const currentFingerprint = fingerprint(rows);
    next.audit = { total: rows.length, train: 0, validation: 0 };
    if (rows.length < MIN_TOTAL) {
      next.action = 'WAIT_DATA';
      next.reason = `outcome ${rows.length}/${MIN_TOTAL} · ยังไม่เปลี่ยน champion`;
      next.fingerprint = currentFingerprint;
      return { state: next, changed: false, promoted: false, rolledBack: false };
    }
    if (current.fingerprint === currentFingerprint) {
      next.action = 'NO_NEW_OUTCOMES';
      next.reason = 'ไม่มี outcome ใหม่ · คง champion เดิม';
      return { state: next, changed: false, promoted: false, rolledBack: false };
    }

    const validationSize = Math.max(MIN_VALIDATION, Math.floor(rows.length * 0.25));
    const split = Math.max(12, rows.length - validationSize);
    const trainRows = rows.slice(0, split);
    const validationRows = rows.slice(split);
    const candidate = buildCandidate(trainRows, validationRows, next.updatedAt);
    const championMetrics = scoreModel(current.champion, validationRows);
    const previousMetrics = scoreModel(current.previous, validationRows);
    next.audit = {
      total: rows.length,
      train: trainRows.length,
      validation: validationRows.length,
      validationFrom: validationRows[0]?.createdAt || 0,
      validationTo: validationRows.at(-1)?.createdAt || 0,
      candidate: candidate.metrics,
      champion: championMetrics
    };
    next.candidate = candidate;
    next.fingerprint = currentFingerprint;

    const freshAfterChampion = current.champion
      ? rows.filter(row => row.createdAt > Number(current.champion.trainedUntil || 0))
      : [];
    if (current.champion && current.previous && freshAfterChampion.length >= 8) {
      const liveChampion = scoreModel(current.champion, freshAfterChampion);
      const livePrevious = scoreModel(current.previous, freshAfterChampion);
      if (Number.isFinite(liveChampion.brier) && Number.isFinite(livePrevious.brier)
        && liveChampion.brier > livePrevious.brier + 0.015 && livePrevious.brier <= 0.31) {
        next.champion = current.previous;
        next.previous = current.champion;
        next.generation = Math.max(0, Number(current.generation) || 0);
        next.action = 'ROLLBACK';
        next.reason = `champion degraded ${(liveChampion.brier - livePrevious.brier).toFixed(3)} Brier · rollback อัตโนมัติ`;
        next.audit.rollback = { champion: liveChampion, previous: livePrevious, samples: freshAfterChampion.length };
        return { state: next, changed: true, promoted: false, rolledBack: true };
      }
    }

    const candidateMetrics = candidate.metrics;
    const improvement = Number.isFinite(championMetrics.brier) && Number.isFinite(candidateMetrics.brier)
      ? championMetrics.brier - candidateMetrics.brier
      : 0;
    const qualityGate = validationRows.length >= MIN_VALIDATION
      && candidateMetrics.brier <= 0.30
      && candidateMetrics.calibrationError <= 0.22;
    const beatsChampion = improvement >= 0.004
      && candidateMetrics.logLoss <= championMetrics.logLoss + 0.015;
    const decisiveWin = improvement >= 0.012;
    const canPromote = rows.length >= MIN_PROMOTE_TOTAL && qualityGate && (beatsChampion || decisiveWin);

    if (canPromote) {
      next.previous = current.champion || null;
      next.champion = candidate;
      next.candidate = null;
      next.generation = (Number(current.generation) || 0) + 1;
      next.action = 'PROMOTE';
      next.reason = `validation ดีขึ้น ${improvement.toFixed(3)} Brier · promote generation ${next.generation}`;
      return { state: next, changed: true, promoted: true, rolledBack: false };
    }

    next.action = current.champion ? 'KEEP_CHAMPION' : 'SHADOW_CANDIDATE';
    next.reason = rows.length < MIN_PROMOTE_TOTAL
      ? `candidate อยู่ Shadow Mode · outcome ${rows.length}/${MIN_PROMOTE_TOTAL}`
      : `candidate ไม่ผ่าน promotion gate · ΔBrier ${improvement.toFixed(3)}`;
    return { state: next, changed: false, promoted: false, rolledBack: false };
  }

  return {
    VERSION,
    MIN_TOTAL,
    MIN_PROMOTE_TOTAL,
    MAX_LIVE_DELTA,
    defaultState,
    normalizeRecords,
    aggregateClosedBars,
    resolveOutcome,
    validateArtifact,
    contextKey,
    scoreModel,
    modelTrust,
    predict,
    evolve
  };
});
