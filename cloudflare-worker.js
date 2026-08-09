const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const VERSION = 'V37';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function getToken(request) {
  const url = new URL(request.url);
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return url.searchParams.get('token') || '';
}

function authorized(request, env) {
  const expected = String(env.WEBHOOK_TOKEN || '');
  return Boolean(expected) && getToken(request) === expected;
}

async function assertDatabaseReady(env) {
  if (!env.DB) throw new Error('D1 binding DB is missing');
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='bars' LIMIT 1"
  ).first();
  if (!table) throw new Error('D1 table bars is missing');
}

function normalizeTimestamp(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw < 10_000_000_000 ? raw * 1000 : raw;
  return Math.trunc(ms / 60_000) * 60_000;
}

function validateBar(body) {
  const ts = normalizeTimestamp(body?.ts ?? body?.time ?? body?.timestamp);
  const open = Number(body?.open), high = Number(body?.high), low = Number(body?.low), close = Number(body?.close);
  const symbol = String(body?.symbol ?? body?.ticker ?? '').trim();
  const timeframe = String(body?.timeframe ?? body?.interval ?? '1').toUpperCase();
  if (!ts) return { ok: false, error: 'invalid timestamp' };
  if (![open, high, low, close].every(Number.isFinite)) return { ok: false, error: 'invalid OHLC' };
  if ([open, high, low, close].some(v => v <= 0)) return { ok: false, error: 'OHLC must be positive' };
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return { ok: false, error: 'malformed OHLC' };
  const normalizedSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalizedSymbol.includes('XAUUSD')) return { ok: false, error: 'only XAUUSD is accepted' };
  if (!new Set(['1', '1M', '1MIN', '1MINUTE']).has(timeframe)) return { ok: false, error: 'timeframe must be 1 minute' };
  return { ok: true, bar: { ts, symbol, timeframe: '1', open, high, low, close } };
}

function insertStatement(env, bar, receivedAt) {
  return env.DB.prepare(`
    INSERT INTO bars (ts, symbol, timeframe, open, high, low, close, received_at)
    VALUES (?, ?, '1', ?, ?, ?, ?, ?)
    ON CONFLICT(ts) DO UPDATE SET
      symbol=excluded.symbol,
      timeframe=excluded.timeframe,
      open=excluded.open,
      high=excluded.high,
      low=excluded.low,
      close=excluded.close,
      received_at=excluded.received_at
  `).bind(bar.ts, bar.symbol, bar.open, bar.high, bar.low, bar.close, receivedAt);
}

async function cleanupOld(env, newestTs) {
  const cutoff = newestTs - 21 * 24 * 60 * 60 * 1000;
  await env.DB.prepare('DELETE FROM bars WHERE ts < ?').bind(cutoff).run();
}

async function handleSingle(request, env, ctx) {
  if (!authorized(request, env)) return json({ status: 'error', message: 'unauthorized' }, 401);
  await assertDatabaseReady(env);
  let body;
  try { body = await request.json(); } catch { return json({ status: 'error', message: 'body must be valid JSON' }, 400); }
  const parsed = validateBar(body);
  if (!parsed.ok) return json({ status: 'error', message: parsed.error }, 400);
  const receivedAt = Date.now();
  await insertStatement(env, parsed.bar, receivedAt).run();
  if (parsed.bar.ts % 3_600_000 < 60_000) ctx.waitUntil(cleanupOld(env, parsed.bar.ts).catch(console.error));
  return json({
    status: 'ok', version: VERSION, accepted: true, provider: 'MT5', source: 'MT5 -> Cloudflare Worker -> D1', receivedAt,
    bar: { ...parsed.bar, timeframe: 'M1', datetime: new Date(parsed.bar.ts).toISOString() },
  });
}

async function handleBatch(request, env, ctx) {
  if (!authorized(request, env)) return json({ status: 'error', message: 'unauthorized' }, 401);
  await assertDatabaseReady(env);
  let body;
  try { body = await request.json(); } catch { return json({ status: 'error', message: 'body must be valid JSON' }, 400); }
  const rawBars = Array.isArray(body) ? body : body?.bars;
  if (!Array.isArray(rawBars) || !rawBars.length) return json({ status: 'error', message: 'bars array required' }, 400);
  if (rawBars.length > 250) return json({ status: 'error', message: 'maximum 250 bars per batch' }, 413);

  const accepted = [], rejected = [];
  for (let i = 0; i < rawBars.length; i++) {
    const p = validateBar(rawBars[i]);
    if (p.ok) accepted.push(p.bar); else rejected.push({ index: i, error: p.error });
  }
  if (!accepted.length) return json({ status: 'error', message: 'no valid bars', rejected: rejected.slice(0, 20) }, 400);

  const receivedAt = Date.now();
  const statements = accepted.map(b => insertStatement(env, b, receivedAt));
  // D1 batch executes prepared statements efficiently and atomically per batch request.
  await env.DB.batch(statements);
  const newestTs = Math.max(...accepted.map(x => x.ts));
  ctx.waitUntil(cleanupOld(env, newestTs).catch(console.error));
  return json({
    status: 'ok', version: VERSION, provider: 'MT5', accepted: accepted.length, rejected: rejected.length,
    oldestTs: Math.min(...accepted.map(x => x.ts)), newestTs, receivedAt,
    message: 'MT5 M1 backfill batch stored',
  });
}

function safeLimit(v) {
  const n = Number(v);
  return Math.min(10_000, Math.max(100, Number.isFinite(n) ? Math.floor(n) : 6000));
}

async function buildFeed(request, env) {
  await assertDatabaseReady(env);
  const url = new URL(request.url), limit = safeLimit(url.searchParams.get('limit') || 6000);
  const result = await env.DB.prepare(`
    SELECT ts, symbol, timeframe, open, high, low, close, received_at
    FROM bars ORDER BY ts DESC LIMIT ?
  `).bind(limit).all();
  const rows = (result.results || []).reverse().map(row => ({
    ts: Number(row.ts),
    datetime: new Date(Number(row.ts)).toISOString().replace('T', ' ').slice(0, 19),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
  }));
  const last = rows.at(-1) || null;
  return json({
    status: 'ok', version: VERSION, provider: 'MT5 fallback bridge', source: 'MT5 -> Cloudflare Worker -> D1',
    generatedAt: new Date().toISOString(), symbol: last ? 'XAU/USD' : null, count: rows.length,
    latestTs: last?.ts ?? null, latestAgeMs: last ? Math.max(0, Date.now() - last.ts) : null,
    timeframes: { M1: rows },
  });
}

async function handleHealth(request, env) {
  if (!authorized(request, env)) return json({ status: 'error', message: 'unauthorized' }, 401);
  await assertDatabaseReady(env);
  const latest = await env.DB.prepare(`SELECT ts, symbol, open, high, low, close, received_at FROM bars ORDER BY ts DESC LIMIT 1`).first();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM bars').first();
  if (!latest) return json({ status: 'empty', version: VERSION, provider: 'MT5 fallback bridge', database: 'connected', table: 'bars', bars: 0, latest: null, message: 'Worker + D1 ready. Waiting for MT5 XAUUSD M1 bars.' });
  const ts = Number(latest.ts), receivedAt = Number(latest.received_at);
  return json({
    status: 'ok', version: VERSION, provider: 'MT5 fallback bridge', database: 'connected', table: 'bars', bars: Number(count?.n || 0),
    latest: { ts, datetime: new Date(ts).toISOString(), symbol: latest.symbol, timeframe: 'M1', open: Number(latest.open), high: Number(latest.high), low: Number(latest.low), close: Number(latest.close), receivedAt, candleAgeMs: Math.max(0, Date.now() - ts), receiveAgeMs: Math.max(0, Date.now() - receivedAt) },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/') return json({ status: 'ok', version: VERSION, service: 'OneMonth MT5 isolated fallback bridge', database: 'Cloudflare D1', endpoints: ['/mt5-webhook', '/tv-webhook', '/mt5-batch', '/feed', '/public-feed', '/health'] });
      if (request.method === 'POST' && (url.pathname === '/mt5-webhook' || url.pathname === '/tv-webhook')) return await handleSingle(request, env, ctx);
      if (request.method === 'POST' && url.pathname === '/mt5-batch') return await handleBatch(request, env, ctx);
      if (request.method === 'GET' && url.pathname === '/feed') {
        if (!authorized(request, env)) return json({ status: 'error', message: 'unauthorized' }, 401);
        return await buildFeed(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/public-feed') return await buildFeed(request, env);
      if (request.method === 'GET' && url.pathname === '/health') return await handleHealth(request, env);
      return json({ status: 'error', message: 'not found' }, 404);
    } catch (error) {
      console.error(error);
      return json({ status: 'error', message: String(error?.message || error).slice(0, 300) }, 500);
    }
  },
};
