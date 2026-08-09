import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const TWELVE_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const FALLBACK_URL = (process.env.TV_FALLBACK_URL || '').replace(/\/$/, '');
const FALLBACK_TOKEN = process.env.TV_FALLBACK_TOKEN || '';

const SYMBOL = 'XAU/USD';
const DAY = 86_400_000;
const MINUTE = 60_000;
const RETENTION = { M1: 5, M5: 30, M15: 90, H1: 180 };
const PRIMARY_STALE_OPEN_MS = 20 * MINUTE;
const FALLBACK_STALE_OPEN_MS = 4 * MINUTE;
const CLOSED_SESSION_MAX_MS = 72 * 60 * MINUTE;
const PRIMARY_RECOVERY_REQUIRED = 2;

function nowIso() { return new Date().toISOString(); }
function safeMsg(err) { return String(err?.message || err || 'unknown error').slice(0, 240); }
function latestTs(rows = []) { return rows.length ? Number(rows.at(-1)?.ts) || 0 : 0; }
function ageMs(ts) { return ts ? Math.max(0, Date.now() - ts) : Infinity; }

function normalizeCandle(v) {
  const rawTime = String(v?.datetime || v?.time || '');
  const parsedTime = rawTime
    ? Date.parse(rawTime.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(rawTime) ? '' : 'Z'))
    : 0;
  const tsRaw = Number(v?.ts) || parsedTime || 0;
  const ts = tsRaw > 0 && tsRaw < 10_000_000_000 ? tsRaw * 1000 : tsRaw;
  const open = Number(v?.open);
  const high = Number(v?.high);
  const low = Number(v?.low);
  const close = Number(v?.close);
  if (!ts || ![open, high, low, close].every(Number.isFinite)) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return null;
  const minuteTs = Math.trunc(ts / MINUTE) * MINUTE;
  return {
    ts: minuteTs,
    datetime: new Date(minuteTs).toISOString().replace('T', ' ').slice(0, 19),
    open, high, low, close,
  };
}

function dedupeSort(rows = []) {
  const map = new Map();
  for (const raw of rows) {
    const c = normalizeCandle(raw);
    if (c) map.set(c.ts, c);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

// Keeps old history for context, but only the ACTIVE feed is allowed to write/replace
// bars for the current run. We never average or combine prices from two feeds.
function rollForwardHistory(oldRows = [], activeRows = [], days = 5) {
  const map = new Map();
  for (const raw of oldRows || []) {
    const c = normalizeCandle(raw);
    if (c) map.set(c.ts, c);
  }
  for (const raw of activeRows || []) {
    const c = normalizeCandle(raw);
    if (c) map.set(c.ts, c); // active source wins on overlapping timestamp
  }
  const rows = [...map.values()].sort((a, b) => a.ts - b.ts);
  if (!rows.length) return rows;
  const cut = rows.at(-1).ts - days * DAY;
  return rows.filter(c => c.ts >= cut);
}

function aggregate(rows, bucketMs) {
  const buckets = new Map();
  for (const c of dedupeSort(rows)) {
    const bucket = Math.floor(c.ts / bucketMs) * bucketMs;
    const prev = buckets.get(bucket);
    if (!prev) {
      buckets.set(bucket, {
        ts: bucket,
        datetime: new Date(bucket).toISOString().replace('T', ' ').slice(0, 19),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

function likelyFxOpen(date = new Date()) {
  const d = date.getUTCDay();
  const h = date.getUTCHours();
  if (d === 6) return false;
  if (d === 0) return h >= 21;
  if (d === 5) return h < 22;
  return true;
}

function responseRateInfo(r) {
  const names = [
    'api-credits-used', 'api-credits-left', 'x-api-credits-used',
    'x-ratelimit-remaining', 'x-ratelimit-limit',
    'ratelimit-remaining', 'ratelimit-limit'
  ];
  const out = {};
  for (const n of names) {
    const v = r.headers.get(n);
    if (v != null) out[n] = v;
  }
  return out;
}

async function fetchTwelveM1() {
  if (!TWELVE_API_KEY) throw new Error('TWELVE_DATA_API_KEY is not configured');
  const u = new URL('https://api.twelvedata.com/time_series');
  u.searchParams.set('symbol', SYMBOL);
  u.searchParams.set('interval', '1min');
  u.searchParams.set('outputsize', '5000');
  u.searchParams.set('timezone', 'UTC');
  u.searchParams.set('apikey', TWELVE_API_KEY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(u, { signal: controller.signal });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); }
    catch { throw new Error(`Twelve Data invalid JSON (${r.status})`); }

    if (!r.ok || j?.status === 'error' || !Array.isArray(j?.values)) {
      const err = new Error(j?.message || `Twelve Data HTTP ${r.status}`);
      err.httpStatus = r.status;
      err.rateInfo = responseRateInfo(r);
      throw err;
    }

    const rows = dedupeSort(j.values.slice().reverse());
    if (!rows.length) throw new Error('Twelve Data returned no usable M1 candles');
    return {
      rows,
      meta: {
        status: 'ONLINE',
        httpStatus: r.status,
        latestTs: latestTs(rows),
        ageMs: ageMs(latestTs(rows)),
        credits: responseRateInfo(r),
        fetchedAt: nowIso(),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMt5Fallback(limit = 8000) {
  if (!FALLBACK_URL) throw new Error('TV_FALLBACK_URL is not configured');
  const u = new URL(FALLBACK_URL + '/feed');
  u.searchParams.set('limit', String(Math.min(10_000, Math.max(300, limit))));
  const headers = { Accept: 'application/json' };
  if (FALLBACK_TOKEN) headers.Authorization = `Bearer ${FALLBACK_TOKEN}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const r = await fetch(u, { headers, signal: controller.signal, cache: 'no-store' });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); }
    catch { throw new Error(`MT5 fallback invalid JSON (${r.status})`); }

    if (!r.ok || j?.status === 'error') {
      throw new Error(j?.message || `MT5 fallback HTTP ${r.status}`);
    }

    const rows = dedupeSort(j?.timeframes?.M1 || j?.bars || []);
    if (!rows.length) throw new Error('MT5 fallback returned no M1 bars');

    return {
      rows,
      meta: {
        status: 'ONLINE',
        httpStatus: r.status,
        latestTs: latestTs(rows),
        ageMs: ageMs(latestTs(rows)),
        count: rows.length,
        fetchedAt: nowIso(),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, name), 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchNews() {
  const goldKeys = [
    'non farm', 'nonfarm', 'payroll', 'cpi', 'consumer price', 'pce',
    'fed', 'fomc', 'powell', 'gdp', 'jobless', 'jolts', 'ppi',
    'producer price', 'retail sales', 'ism', 'adp', 'employment',
    'unemployment', 'interest rate'
  ];
  let events = [];
  try {
    const url = 'https://api.tradingeconomics.com/calendar/country/united%20states?c=guest:guest&importance=2';
    const r = await fetch(url);
    if (r.ok) {
      const raw = await r.json();
      events = (Array.isArray(raw) ? raw : []).filter(e => {
        const s = ((e.Event || '') + ' ' + (e.Category || '')).toLowerCase();
        return goldKeys.some(k => s.includes(k));
      }).map(e => ({
        date: e.Date,
        event: e.Event || 'US Event',
        importance: Number(e.Importance || 2),
        actual: e.Actual ?? null,
        forecast: e.Forecast ?? null,
        previous: e.Previous ?? null,
      }));
    }
  } catch (err) {
    console.warn('News skipped:', safeMsg(err));
  }
  return {
    generatedAt: nowIso(),
    source: 'Trading Economics guest feed via GitHub Actions',
    events,
  };
}

const previous = await readJson('xauusd.json', { timeframes: {}, feed: {} });
const previousHealth = await readJson('feed-health.json', previous?.feed || {});
const marketOpen = likelyFxOpen();
const previousActive = String(previousHealth?.active || previous?.feed?.active || '').toUpperCase();
let recoveryStreak = Number(previousHealth?.switching?.primaryRecoveryStreak || 0);
if (!Number.isFinite(recoveryStreak) || recoveryStreak < 0) recoveryStreak = 0;

let primary = {
  checked: true,
  ok: false,
  fresh: false,
  rows: [],
  meta: { status: 'OFFLINE' },
  error: null,
};

try {
  const p = await fetchTwelveM1();
  primary.ok = true;
  primary.rows = p.rows;
  primary.meta = p.meta;
  primary.fresh = marketOpen
    ? p.meta.ageMs <= PRIMARY_STALE_OPEN_MS
    : p.meta.ageMs <= CLOSED_SESSION_MAX_MS;
  primary.meta.status = primary.fresh ? 'ONLINE' : 'STALE';
} catch (err) {
  primary.error = safeMsg(err);
  primary.meta = {
    status: 'OFFLINE',
    httpStatus: err?.httpStatus || null,
    credits: err?.rateInfo || {},
    fetchedAt: nowIso(),
  };
}

let fallback = {
  checked: false,
  ok: false,
  fresh: false,
  rows: [],
  meta: { status: FALLBACK_URL ? 'STANDBY' : 'NOT_CONFIGURED' },
  error: null,
};

async function checkFallback() {
  fallback.checked = true;
  try {
    const f = await fetchMt5Fallback();
    fallback.ok = true;
    fallback.rows = f.rows;
    fallback.meta = f.meta;
    fallback.fresh = marketOpen
      ? f.meta.ageMs <= FALLBACK_STALE_OPEN_MS
      : f.meta.ageMs <= CLOSED_SESSION_MAX_MS;
    fallback.meta.status = fallback.fresh ? 'ONLINE' : 'STALE';
  } catch (err) {
    fallback.error = safeMsg(err);
    fallback.meta = {
      status: FALLBACK_URL ? 'OFFLINE' : 'NOT_CONFIGURED',
      fetchedAt: nowIso(),
    };
  }
}

let active = 'LAST_VALID';
let mode = marketOpen ? 'HOLD' : 'LAST_SESSION';
let activeRows = [];
let activeReason = 'No live source selected; preserving last valid pack';

const wasOnFallback = previousActive.includes('MT5') || String(previousHealth?.mode || '').toUpperCase().includes('FALLBACK');

if (marketOpen) {
  if (primary.fresh) {
    if (wasOnFallback) {
      recoveryStreak += 1;
      if (recoveryStreak >= PRIMARY_RECOVERY_REQUIRED) {
        active = 'TWELVE_DATA';
        mode = 'PRIMARY';
        activeRows = primary.rows;
        activeReason = `Twelve Data recovered ${recoveryStreak}/${PRIMARY_RECOVERY_REQUIRED} checks; switched back to primary`;
        recoveryStreak = PRIMARY_RECOVERY_REQUIRED;
      } else {
        await checkFallback();
        if (fallback.fresh) {
          active = 'MT5_FALLBACK';
          mode = 'PRIMARY_RECOVERY';
          activeRows = fallback.rows;
          activeReason = `Twelve Data looks healthy but recovery guard is ${recoveryStreak}/${PRIMARY_RECOVERY_REQUIRED}; staying on MT5 until confirmed`;
        } else {
          active = 'TWELVE_DATA';
          mode = 'PRIMARY';
          activeRows = primary.rows;
          activeReason = 'Twelve Data recovered; MT5 fallback unavailable, switched back immediately';
          recoveryStreak = PRIMARY_RECOVERY_REQUIRED;
        }
      }
    } else {
      active = 'TWELVE_DATA';
      mode = 'PRIMARY';
      activeRows = primary.rows;
      activeReason = 'Twelve Data primary feed healthy; MT5 fallback remains standby';
      recoveryStreak = PRIMARY_RECOVERY_REQUIRED;
    }
  } else {
    recoveryStreak = 0;
    await checkFallback();
    if (fallback.fresh) {
      active = 'MT5_FALLBACK';
      mode = 'FALLBACK';
      activeRows = fallback.rows;
      const reason = primary.ok ? 'stale' : (primary.meta?.httpStatus === 429 ? 'rate limited' : 'unavailable');
      activeReason = `Twelve Data ${reason}; switched to MT5 fallback`;
    } else {
      active = 'LAST_VALID';
      mode = 'HOLD';
      activeRows = [];
      activeReason = 'Twelve Data unavailable/stale and MT5 fallback is not fresh; live plans are held';
    }
  }
} else {
  // Market closed: prefer Twelve's last session if available, otherwise MT5's last session.
  if (primary.ok && primary.meta.ageMs <= CLOSED_SESSION_MAX_MS) {
    active = 'TWELVE_DATA';
    mode = 'LAST_SESSION';
    activeRows = primary.rows;
    activeReason = 'Market closed; using Twelve Data last session only';
    recoveryStreak = PRIMARY_RECOVERY_REQUIRED;
  } else {
    await checkFallback();
    if (fallback.ok && fallback.meta.ageMs <= CLOSED_SESSION_MAX_MS) {
      active = 'MT5_FALLBACK';
      mode = 'LAST_SESSION';
      activeRows = fallback.rows;
      activeReason = 'Market closed; Twelve Data unavailable, using MT5 last session';
    } else {
      active = 'LAST_VALID';
      mode = 'LAST_SESSION';
      activeRows = [];
      activeReason = 'Market closed; preserving last valid GitHub session';
    }
  }
}

const prevM1 = previous?.timeframes?.M1 || [];
const m1 = rollForwardHistory(prevM1, activeRows, RETENTION.M1);
if (!m1.length) {
  throw new Error('No usable XAUUSD M1 data from active feed or previous pack');
}

const aggM5 = aggregate(m1, 5 * MINUTE);
const aggM15 = aggregate(m1, 15 * MINUTE);
const aggH1 = aggregate(m1, 60 * MINUTE);

const tf = {
  M1: m1,
  M5: rollForwardHistory(previous?.timeframes?.M5 || [], aggM5, RETENTION.M5),
  M15: rollForwardHistory(previous?.timeframes?.M15 || [], aggM15, RETENTION.M15),
  H1: rollForwardHistory(previous?.timeframes?.H1 || [], aggH1, RETENTION.H1),
};

const coverageDays = Object.fromEntries(
  Object.entries(tf).map(([k, rows]) => [
    k,
    rows.length > 1
      ? Number(((rows.at(-1).ts - rows[0].ts) / DAY).toFixed(1))
      : 0,
  ])
);

const activeLatestTs = latestTs(tf.M1);
const liveAge = ageMs(activeLatestTs);

let overallStatus;
if (!marketOpen) {
  overallStatus = liveAge <= CLOSED_SESSION_MAX_MS ? 'LAST_SESSION' : 'STALE';
} else if (mode === 'PRIMARY' && liveAge <= PRIMARY_STALE_OPEN_MS) {
  overallStatus = 'LIVE';
} else if ((mode === 'FALLBACK' || mode === 'PRIMARY_RECOVERY') && liveAge <= FALLBACK_STALE_OPEN_MS) {
  overallStatus = 'FALLBACK_ACTIVE';
} else {
  overallStatus = 'HOLD';
}

const feedHealth = {
  version: 'V36.2',
  generatedAt: nowIso(),
  symbol: SYMBOL,
  marketLikelyOpen: marketOpen,
  active,
  mode,
  status: overallStatus,
  reason: activeReason,
  latestM1Ts: activeLatestTs,
  latestM1AgeMs: liveAge,

  primary: {
    provider: 'Twelve Data',
    configured: Boolean(TWELVE_API_KEY),
    checked: true,
    ok: primary.ok,
    fresh: primary.fresh,
    ...primary.meta,
    error: primary.error,
  },

  fallback: {
    provider: 'MT5 -> Cloudflare Worker/D1',
    configured: Boolean(FALLBACK_URL),
    checked: fallback.checked,
    ok: fallback.ok,
    fresh: fallback.fresh,
    publicFeedUrl: FALLBACK_URL ? `${FALLBACK_URL}/public-feed` : null,
    ...fallback.meta,
    error: fallback.error,
  },

  switching: {
    policy: 'PRIMARY_ONLY_THEN_FAILOVER',
    mergeFeeds: false,
    primaryRecoveryStreak: recoveryStreak,
    primaryRecoveryRequired: PRIMARY_RECOVERY_REQUIRED,
    note: 'Use Twelve Data only while healthy. MT5 is queried/used only on failover or recovery confirmation. Never average or blend feed prices.',
  },

  efficiency: {
    twelveRequestsThisRun: 1,
    fallbackRequestsThisRun: fallback.checked ? 1 : 0,
    strategy: 'Twelve M1 primary -> local M5/M15/H1. MT5 fallback is standby and activates only when primary fails/stales.',
  },
};

const source = active === 'TWELVE_DATA'
  ? 'Twelve Data M1 primary · M5/M15/H1 locally aggregated'
  : active === 'MT5_FALLBACK'
    ? 'MT5 M1 fallback via Cloudflare D1 · M5/M15/H1 locally aggregated'
    : 'Last valid GitHub market pack';

const pack = {
  generatedAt: nowIso(),
  source,
  symbol: SYMBOL,
  retentionDays: RETENTION,
  coverageDays,
  feed: feedHealth,
  timeframes: tf,
};

await fs.writeFile(path.join(ROOT, 'xauusd.json'), JSON.stringify(pack));
await fs.writeFile(path.join(ROOT, 'feed-health.json'), JSON.stringify(feedHealth, null, 2));
await fs.writeFile(path.join(ROOT, 'news.json'), JSON.stringify(await fetchNews()));

console.log('V36.2 PRIMARY -> FALLBACK update', {
  active,
  mode,
  status: overallStatus,
  reason: activeReason,
  primary: {
    ok: primary.ok,
    fresh: primary.fresh,
    ageMin: Number.isFinite(primary.meta?.ageMs)
      ? +(primary.meta.ageMs / MINUTE).toFixed(1)
      : null,
    error: primary.error,
  },
  fallback: {
    checked: fallback.checked,
    ok: fallback.ok,
    fresh: fallback.fresh,
    ageMin: Number.isFinite(fallback.meta?.ageMs)
      ? +(fallback.meta.ageMs / MINUTE).toFixed(1)
      : null,
    error: fallback.error,
  },
  switching: feedHealth.switching,
  candles: Object.fromEntries(Object.entries(tf).map(([k, rows]) => [k, rows.length])),
  coverageDays,
});
