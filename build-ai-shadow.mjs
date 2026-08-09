import fs from 'node:fs';

const PACK = 'xauusd.json';
const BRAIN = 'ai-ml-brain.json';
const OUTPUT = 'ai-shadow-journal.json';
const VERSION = 'V38.0';
const ENGINE = 'ONEMONTH-SHADOW-SELFPLAY-FIRST-HIT';
const FILL_HORIZON_MIN = 90;
const OUTCOME_HORIZON_MIN = 180;
const MAX_ENTRIES = 30000;

const n = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const finite = v => Number.isFinite(Number(v));
const iso = ts => new Date(Number(ts)).toISOString();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function normalizeTs(v) {
  let ts = Number(v);
  if (!Number.isFinite(ts)) return NaN;
  if (ts < 10_000_000_000) ts *= 1000;
  return Math.trunc(ts / 60000) * 60000;
}
function normalizeBar(v) {
  const ts = normalizeTs(v?.ts ?? Date.parse(v?.datetime || v?.date || ''));
  const open = Number(v?.open), high = Number(v?.high), low = Number(v?.low), close = Number(v?.close);
  if (![ts, open, high, low, close].every(Number.isFinite)) return null;
  if ([open, high, low, close].some(x => x <= 0)) return null;
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return null;
  return { ts, open, high, low, close };
}
function cleanBars(rows) {
  const map = new Map();
  for (const raw of rows || []) {
    const b = normalizeBar(raw);
    if (b) map.set(b.ts, b);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
function load(path, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}
function save(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2));
}
function findAtOrAfter(rows, ts) {
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].ts >= ts) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}
function orderKind(type) { return String(type || '').toUpperCase().includes('STOP') ? 'STOP' : 'LIMIT'; }
function sideOf(c) { return String(c?.side || c?.direction || '').toUpperCase(); }
function touchedEntry(bar, p) {
  const side = p.side, kind = p.kind;
  if (kind === 'STOP') return side === 'BUY' ? bar.high >= p.entry : bar.low <= p.entry;
  const lo = finite(p.entryLow) ? p.entryLow : p.entry;
  const hi = finite(p.entryHigh) ? p.entryHigh : p.entry;
  return bar.low <= Math.max(lo, hi) && bar.high >= Math.min(lo, hi);
}
function touchFlags(bar, p) {
  if (p.side === 'BUY') return {
    sl: bar.low <= p.sl,
    tp1: bar.high >= p.tp1,
    tp2: finite(p.tp2) ? bar.high >= p.tp2 : false,
  };
  return {
    sl: bar.high >= p.sl,
    tp1: bar.low <= p.tp1,
    tp2: finite(p.tp2) ? bar.low <= p.tp2 : false,
  };
}
function signedExcursion(bar, p) {
  const risk = Math.max(1e-9, Math.abs(p.entry - p.sl));
  if (p.side === 'BUY') return {
    mfeR: Math.max(0, (bar.high - p.entry) / risk),
    maeR: Math.max(0, (p.entry - bar.low) / risk),
  };
  return {
    mfeR: Math.max(0, (p.entry - bar.low) / risk),
    maeR: Math.max(0, (bar.high - p.entry) / risk),
  };
}
function markR(bar, p) {
  const risk = Math.max(1e-9, Math.abs(p.entry - p.sl));
  return p.side === 'BUY' ? (bar.close - p.entry) / risk : (p.entry - bar.close) / risk;
}
function emptyJournal() {
  return {
    version: VERSION,
    engine: ENGINE,
    updatedAt: null,
    entries: [],
    summary: {},
  };
}

function resolveEntry(p, bars) {
  if (['COMPLETE', 'EXPIRED'].includes(p.status)) return;
  const createTs = normalizeTs(p.marketTs || p.createdMarketTs || p.ts);
  if (!finite(createTs)) return;
  let start = findAtOrAfter(bars, createTs + 60000);
  if (start < 0) return;

  const fillDeadline = createTs + FILL_HORIZON_MIN * 60000;
  if (!p.filledTs) {
    let fillIndex = -1;
    for (let i = start; i < bars.length && bars[i].ts <= fillDeadline; i++) {
      if (touchedEntry(bars[i], p)) { fillIndex = i; break; }
    }
    if (fillIndex < 0) {
      if (bars.at(-1).ts > fillDeadline) {
        p.status = 'EXPIRED';
        p.resolvedAt = iso(fillDeadline);
        p.result = 'NO_FILL';
        p.resultR = 0;
        p.fillMinutes = null;
      }
      return;
    }
    p.filledTs = bars[fillIndex].ts;
    p.filledAt = iso(p.filledTs);
    p.fillMinutes = Math.round((p.filledTs - createTs) / 60000);
    p.status = 'FILLED';
    start = fillIndex;
  } else {
    start = findAtOrAfter(bars, p.filledTs);
    if (start < 0) return;
  }

  const deadline = p.filledTs + OUTCOME_HORIZON_MIN * 60000;
  let maxMfe = n(p.mfeR), maxMae = n(p.maeR), tp1Ts = p.tp1Ts || null, tp2Ts = p.tp2Ts || null, slTs = p.slTs || null;
  let firstHit = p.firstHit || null, firstHitTs = p.firstHitTs || null;
  let last = bars[start];

  for (let i = start; i < bars.length && bars[i].ts <= deadline; i++) {
    const bar = bars[i]; last = bar;
    const ex = signedExcursion(bar, p);
    maxMfe = Math.max(maxMfe, ex.mfeR); maxMae = Math.max(maxMae, ex.maeR);
    const f = touchFlags(bar, p);
    if (!tp1Ts && f.tp1) tp1Ts = bar.ts;
    if (!tp2Ts && f.tp2) tp2Ts = bar.ts;
    if (!slTs && f.sl) slTs = bar.ts;

    // Conservative M1 ordering: if TP and SL appear in the same bar and tick order
    // is unknowable, count SL first. This intentionally avoids optimistic labels.
    if (!firstHit) {
      if (f.sl) { firstHit = 'SL'; firstHitTs = bar.ts; }
      else if (f.tp1) { firstHit = 'TP1'; firstHitTs = bar.ts; }
    }
  }

  p.mfeR = Number(maxMfe.toFixed(4));
  p.maeR = Number(maxMae.toFixed(4));
  p.tp1Ts = tp1Ts; p.tp2Ts = tp2Ts; p.slTs = slTs;
  p.tp1Hit = !!tp1Ts; p.tp2Hit = !!tp2Ts; p.slHit = !!slTs;
  p.firstHit = firstHit; p.firstHitTs = firstHitTs;

  if (firstHit) {
    const risk = Math.max(1e-9, Math.abs(p.entry - p.sl));
    const rr1 = Math.max(0.05, Math.abs(p.tp1 - p.entry) / risk);
    p.status = 'COMPLETE';
    p.result = firstHit;
    p.resultR = Number((firstHit === 'TP1' ? rr1 : -1).toFixed(4));
    p.outcomeMinutes = Math.round((firstHitTs - p.filledTs) / 60000);
    p.resolvedAt = iso(firstHitTs);
  } else if (bars.at(-1).ts > deadline) {
    p.status = 'COMPLETE';
    p.result = 'TIMEOUT';
    p.resultR = Number(markR(last, p).toFixed(4));
    p.outcomeMinutes = OUTCOME_HORIZON_MIN;
    p.resolvedAt = iso(deadline);
  }
}

function summarize(entries) {
  const total = entries.length;
  const resolved = entries.filter(x => ['COMPLETE', 'EXPIRED'].includes(x.status));
  const filled = entries.filter(x => !!x.filledTs);
  const complete = entries.filter(x => x.status === 'COMPLETE');
  const wins = complete.filter(x => x.result === 'TP1');
  const losses = complete.filter(x => x.result === 'SL');
  const rejected = entries.filter(x => x.qualified === false);
  const rejectedResolved = rejected.filter(x => x.status === 'COMPLETE');
  const rejectedWins = rejectedResolved.filter(x => x.result === 'TP1');
  const avg = arr => arr.length ? arr.reduce((s, x) => s + n(x), 0) / arr.length : null;
  const by = (key) => {
    const out = {};
    for (const e of complete) {
      const k = String(e[key] || 'UNKNOWN');
      const g = out[k] || { samples: 0, wins: 0, losses: 0, sumR: 0 };
      g.samples++; g.wins += e.result === 'TP1' ? 1 : 0; g.losses += e.result === 'SL' ? 1 : 0; g.sumR += n(e.resultR);
      out[k] = g;
    }
    return Object.fromEntries(Object.entries(out).map(([k, g]) => [k, {
      samples: g.samples,
      winRate: g.samples ? Number((100 * g.wins / g.samples).toFixed(1)) : null,
      avgR: g.samples ? Number((g.sumR / g.samples).toFixed(3)) : null,
    }]));
  };
  return {
    total,
    open: entries.filter(x => !['COMPLETE', 'EXPIRED'].includes(x.status)).length,
    resolved: resolved.length,
    filled: filled.length,
    completed: complete.length,
    expired: entries.filter(x => x.status === 'EXPIRED').length,
    fillRate: total ? Number((100 * filled.length / total).toFixed(1)) : null,
    winRate: complete.length ? Number((100 * wins.length / complete.length).toFixed(1)) : null,
    lossRate: complete.length ? Number((100 * losses.length / complete.length).toFixed(1)) : null,
    avgR: complete.length ? Number(avg(complete.map(x => x.resultR)).toFixed(3)) : null,
    avgMfeR: complete.length ? Number(avg(complete.map(x => x.mfeR)).toFixed(3)) : null,
    avgMaeR: complete.length ? Number(avg(complete.map(x => x.maeR)).toFixed(3)) : null,
    rejectedTested: rejectedResolved.length,
    rejectedWouldWinRate: rejectedResolved.length ? Number((100 * rejectedWins.length / rejectedResolved.length).toFixed(1)) : null,
    byType: by('type'),
    byVariant: by('variant'),
    byRegime: by('regime'),
    bySession: by('session'),
  };
}

if (!fs.existsSync(PACK) || !fs.existsSync(BRAIN)) {
  console.log('Shadow lab skipped: xauusd.json or ai-ml-brain.json missing');
  process.exit(0);
}

const pack = load(PACK);
const brain = load(BRAIN);
const raw = pack.timeframes || pack.data || {};
const m1 = cleanBars(raw.M1 || []);
if (!m1.length || !brain?.ready) {
  console.log('Shadow lab waiting: M1/model not ready');
  process.exit(0);
}

let journal = load(OUTPUT, emptyJournal());
journal.entries = Array.isArray(journal.entries) ? journal.entries : [];
for (const e of journal.entries) resolveEntry(e, m1);

const current = brain.current || {};
const marketTs = normalizeTs(current.marketTs || m1.at(-1).ts);
const feed = String(pack?.feed?.active || pack?.source || 'UNKNOWN').toUpperCase();
const modelFp = String(brain.sourceFingerprint || brain.modelId || 'NOFP');
const rows = Array.isArray(current.candidates) ? current.candidates : [];
const known = new Set(journal.entries.map(x => x.id));
let created = 0;

for (const c of rows) {
  const side = sideOf(c), entry = n(c.entry, NaN), sl = n(c.sl, NaN), tp1 = n(c.tp1, NaN), tp2 = n(c.tp2, NaN);
  if (!['BUY', 'SELL'].includes(side) || ![entry, sl, tp1].every(Number.isFinite)) continue;
  const type = String(c.type || 'UNKNOWN').replaceAll(' ', '_').toUpperCase();
  const variant = String(c.variant || 'BALANCED').toUpperCase();
  const id = `SHADOW:${modelFp}:${marketTs}:${type}:${variant}`;
  if (known.has(id)) continue;
  const risk = Math.max(1e-9, Math.abs(entry - sl));
  const q = c.qualityGate || {};
  journal.entries.push({
    id,
    version: VERSION,
    modelFingerprint: modelFp,
    modelStatus: String(brain.status || 'UNKNOWN'),
    feedSource: feed,
    createdAt: new Date().toISOString(),
    marketTs,
    type,
    kind: orderKind(type),
    variant,
    side,
    regime: String(c.regime || current.regime || 'UNKNOWN'),
    session: String(c.session || current.session || 'UNKNOWN'),
    entry,
    entryLow: finite(c.entryLow) ? Number(c.entryLow) : entry,
    entryHigh: finite(c.entryHigh) ? Number(c.entryHigh) : entry,
    sl,
    tp1,
    tp2: finite(tp2) ? tp2 : null,
    risk,
    rr1: Number((Math.abs(tp1 - entry) / risk).toFixed(4)),
    rr2: finite(tp2) ? Number((Math.abs(tp2 - entry) / risk).toFixed(4)) : null,
    score: n(c.score),
    pFill: n(c.pFill),
    pTp1: n(c.pTp1),
    pTp2: n(c.pTp2),
    pSl: n(c.pSl),
    pCleanWin: n(c.pCleanWin),
    evR: n(c.evR),
    disagreementPts: n(c.modelDisagreementPts),
    oodScore: n(brain?.modelHealth?.driftPts),
    modelHealth: n(brain?.modelHealth?.score),
    qualified: q.passed === true,
    grade: String(q.grade || (q.passed ? 'PASS' : 'REJECT')),
    rejectReasons: Array.isArray(q.reasons) ? q.reasons : [],
    status: 'WAIT_FILL',
    filledTs: null,
    firstHit: null,
    mfeR: 0,
    maeR: 0,
  });
  known.add(id); created++;
}

for (const e of journal.entries) resolveEntry(e, m1);
journal.entries = journal.entries.slice(-MAX_ENTRIES);
journal.version = VERSION;
journal.engine = ENGINE;
journal.updatedAt = new Date().toISOString();
journal.currentFeed = feed;
journal.currentModel = modelFp;
journal.summary = summarize(journal.entries);
save(OUTPUT, journal);

console.log('V38 Shadow Self-Play', {
  created,
  total: journal.summary.total,
  resolved: journal.summary.resolved,
  completed: journal.summary.completed,
  rejectedTested: journal.summary.rejectedTested,
  rejectedWouldWinRate: journal.summary.rejectedWouldWinRate,
  feed,
});
