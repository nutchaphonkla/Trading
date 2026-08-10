(() => {
  'use strict';

  const VERSION = 'KAGE_PERSISTENCE_V49';
  const SNAPSHOT_VERSION = 'KAGE_LEARNING_SNAPSHOT_V49';
  const DB_NAME = 'kage-learning-v49';
  const DB_VERSION = 1;
  const STORE = 'checkpoints';
  const KEEP = 6;
  const MAX_OUTCOMES = 180;
  const MAX_SCANS = 40;
  const MAX_BYTES = 2 * 1024 * 1024;

  function clone(v, fallback = null) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch (_) { return fallback; }
  }

  function finite(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function outcomeKey(row, index = 0) {
    if (row?.sig) return `sig:${row.sig}`;
    return [
      row?.marketTs ?? row?.createdAt ?? index,
      row?.side ?? '', row?.orderType ?? '',
      finite(row?.entry, 0).toFixed(2), finite(row?.sl, 0).toFixed(2),
      finite(row?.tp1, 0).toFixed(2)
    ].join('|');
  }

  function mergeOutcomes(a, b) {
    const map = new Map();
    [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach((row, i) => {
      if (!row || typeof row !== 'object') return;
      const key = outcomeKey(row, i);
      const old = map.get(key);
      if (!old) { map.set(key, clone(row, row)); return; }
      const oldRank = [old.outcome ? 1 : 0, finite(old.terminalAt), finite(old.lastReplay), finite(old.createdAt)];
      const newRank = [row.outcome ? 1 : 0, finite(row.terminalAt), finite(row.lastReplay), finite(row.createdAt)];
      const newer = newRank.some((v, j) => v !== oldRank[j] && v > oldRank[j] && newRank.slice(0, j).every((x, k) => x === oldRank[k]));
      if (newer) map.set(key, clone(row, row));
      else map.set(key, {...clone(row, row), ...clone(old, old)});
    });
    return [...map.values()]
      .sort((x, y) => finite(x?.createdAt ?? x?.marketTs) - finite(y?.createdAt ?? y?.marketTs))
      .slice(-MAX_OUTCOMES);
  }

  function scanKey(row, index = 0) {
    return String(row?.sig ?? row?.id ?? row?.at ?? row?.createdAt ?? index);
  }

  function mergeScans(a, b) {
    const map = new Map();
    [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach((row, i) => {
      if (!row || typeof row !== 'object') return;
      map.set(scanKey(row, i), clone(row, row));
    });
    return [...map.values()]
      .sort((x, y) => finite(x?.at ?? x?.createdAt) - finite(y?.at ?? y?.createdAt))
      .slice(-MAX_SCANS);
  }

  function adaptiveRank(model) {
    if (!model || typeof model !== 'object') return 0;
    return finite(model.generation) * 100000
      + finite(model.audit?.total) * 100
      + finite(model.champion?.trainedCount) * 10
      + finite(model.candidate?.trainedCount)
      + (model.champion ? 50000 : 0);
  }

  function learningRank(state) {
    if (!state || typeof state !== 'object') return 0;
    return finite(state.lastRun)
      + finite(state.replayed) * 1000000000000
      + finite(state.eligible) * 1000000
      + finite(state.updated) * 10000;
  }

  function normalize(snapshot) {
    const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const learning = clone(s.learningState, {}) || {};
    delete learning.timer;
    delete learning._tick;
    learning.active = false;
    learning.nextRun = 0;

    return {
      version: SNAPSHOT_VERSION,
      createdAt: finite(s.createdAt, Date.now()),
      source: String(s.source || 'KAGE_APP'),
      outcomeMemory: (Array.isArray(s.outcomeMemory) ? clone(s.outcomeMemory, []) : []).slice(-MAX_OUTCOMES),
      adaptiveModel: clone(s.adaptiveModel, null),
      learningState: learning,
      localReplayCount: Math.max(0, finite(s.localReplayCount)),
      shadowMode: !!s.shadowMode,
      scanMemory: (Array.isArray(s.scanMemory) ? clone(s.scanMemory, []) : []).slice(-MAX_SCANS)
    };
  }

  function score(snapshot) {
    const s = normalize(snapshot);
    const completed = s.outcomeMemory.filter(x => x && (x.outcome === 'WIN' || x.outcome === 'LOSS')).length;
    return s.outcomeMemory.length * 1000
      + completed * 5000
      + adaptiveRank(s.adaptiveModel)
      + finite(s.learningState?.replayed) * 100
      + finite(s.learningState?.eligible) * 10
      + s.scanMemory.length;
  }

  function chooseAdaptive(a, b) {
    return adaptiveRank(b) > adaptiveRank(a) ? clone(b, null) : clone(a, null);
  }

  function chooseLearning(a, b) {
    const newer = learningRank(b) > learningRank(a) ? b : a;
    const out = {...clone(a, {}), ...clone(b, {}), ...clone(newer, {})};
    out.replayed = Math.max(finite(a?.replayed), finite(b?.replayed));
    out.eligible = Math.max(finite(a?.eligible), finite(b?.eligible));
    out.updated = Math.max(finite(a?.updated), finite(b?.updated));
    out.lastRun = Math.max(finite(a?.lastRun), finite(b?.lastRun));
    out.active = false;
    out.nextRun = 0;
    delete out.timer;
    delete out._tick;
    return out;
  }

  function mergeSnapshots(localSnapshot, savedSnapshot) {
    const a = normalize(localSnapshot);
    const b = normalize(savedSnapshot);
    const bRicher = score(b) > score(a);
    return normalize({
      createdAt: Math.max(a.createdAt, b.createdAt, Date.now()),
      source: 'MERGED_V49',
      outcomeMemory: mergeOutcomes(a.outcomeMemory, b.outcomeMemory),
      adaptiveModel: chooseAdaptive(a.adaptiveModel, b.adaptiveModel),
      learningState: chooseLearning(a.learningState, b.learningState),
      localReplayCount: Math.max(a.localReplayCount, b.localReplayCount, finite(a.learningState?.replayed), finite(b.learningState?.replayed)),
      shadowMode: bRicher ? b.shadowMode : a.shadowMode,
      scanMemory: mergeScans(a.scanMemory, b.scanMemory)
    });
  }

  function checksumText(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in globalThis)) { reject(new Error('INDEXEDDB_UNAVAILABLE')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('INDEXEDDB_OPEN_FAILED'));
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try { result = fn(store, tx, resolve, reject); }
        catch (e) { reject(e); return; }
        tx.oncomplete = () => { if (result !== undefined) resolve(result); };
        tx.onerror = () => reject(tx.error || new Error('INDEXEDDB_TX_FAILED'));
        tx.onabort = () => reject(tx.error || new Error('INDEXEDDB_TX_ABORTED'));
      });
    } finally { db.close(); }
  }

  async function prune() {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const index = store.index('createdAt');
        let seen = 0;
        const req = index.openCursor(null, 'prev');
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          seen++;
          if (seen > KEEP) cursor.delete();
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  async function save(snapshot) {
    const normalized = normalize({...snapshot, createdAt: Date.now()});
    let text = JSON.stringify(normalized);
    if (text.length > MAX_BYTES) {
      normalized.outcomeMemory = normalized.outcomeMemory.slice(-120);
      normalized.scanMemory = normalized.scanMemory.slice(-20);
      text = JSON.stringify(normalized);
    }
    if (text.length > MAX_BYTES) throw new Error('CHECKPOINT_TOO_LARGE');

    const row = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      checksum: checksumText(text),
      bytes: text.length,
      snapshot: normalized
    };

    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(row);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
    await prune();
    return { createdAt: row.createdAt, bytes: row.bytes, score: score(normalized) };
  }

  async function latest() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const index = tx.objectStore(STORE).index('createdAt');
        const req = index.openCursor(null, 'prev');
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(null); return; }
          const row = cursor.value;
          const text = JSON.stringify(normalize(row.snapshot));
          if (row.checksum === checksumText(text)) resolve({...row, snapshot: normalize(row.snapshot)});
          else { cursor.continue(); }
        };
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }

  async function clear() {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  async function stats() {
    const row = await latest();
    return row ? { supported: true, createdAt: row.createdAt, bytes: row.bytes, score: score(row.snapshot) }
               : { supported: true, createdAt: 0, bytes: 0, score: 0 };
  }

  window.KagePersistenceV49 = {
    VERSION, SNAPSHOT_VERSION,
    supported: 'indexedDB' in globalThis,
    normalize, score, mergeSnapshots, save, latest, clear, stats
  };
})();
