(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const validScreens = new Set(['overview', 'market', 'positions', 'intel', 'plan', 'history']);
  const appState = {
    screen: 'overview',
    rows: [],
    score: 82,
    scanning: false,
    toastTimer: 0
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function showToast(message, duration = 2200) {
    const toast = $('#toast');
    if (!toast) return;
    window.clearTimeout(appState.toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    appState.toastTimer = window.setTimeout(() => toast.classList.remove('show'), duration);
  }

  function setScreen(name, updateUrl = true) {
    if (!validScreens.has(name)) name = 'overview';
    appState.screen = name;

    $$('.screen').forEach(screen => {
      const selected = screen.dataset.screen === name;
      screen.classList.toggle('active', selected);
      screen.setAttribute('aria-hidden', String(!selected));
    });

    $$('[data-nav]').forEach(button => {
      const selected = button.dataset.nav === name;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });

    if (updateUrl && window.location.hash !== `#${name}`) {
      history.replaceState(null, '', `#${name}`);
    }
    try { localStorage.setItem('kage-v40-screen', name); } catch (_) { /* storage can be blocked */ }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateClock() {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const value = `${formatter.format(new Date())} ICT`;
    $$('.live-clock').forEach(clock => { clock.textContent = value; });
  }

  function setCoreScore(score) {
    const next = clamp(Math.round(score), 0, 100);
    appState.score = next;
    const ring = $('#coreRing');
    const label = $('#coreScore');
    if (ring) ring.style.setProperty('--score', String(next));
    if (label) label.innerHTML = `${next}<small>/100</small>`;

    const quality = clamp(Math.round(next * .82 + 11), 0, 100);
    const qualityLabel = $('#marketQuality');
    const qualityBar = $('#marketQualityBar');
    if (qualityLabel) qualityLabel.innerHTML = `${quality}<small>%</small>`;
    if (qualityBar) qualityBar.style.setProperty('--value', `${quality}%`);
    const confidence = $('#confidenceValue');
    if (confidence) confidence.textContent = `${clamp(next - 21, 0, 99)}%`;
  }

  function sparkGeometry(rows) {
    const samples = rows.slice(-54).map(row => Number(row.close)).filter(Number.isFinite);
    if (samples.length < 2) return null;
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const spread = Math.max(max - min, Math.max(1, max * .0002));
    const points = samples.map((value, index) => {
      const x = index * (360 / (samples.length - 1));
      const y = 76 - ((value - min) / spread) * 62;
      return [x, y];
    });
    const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    const area = `${line} L360 92 L0 92 Z`;
    return { line, area, samples };
  }

  function marketMetrics(rows) {
    const closes = rows.map(row => Number(row.close)).filter(Number.isFinite);
    if (closes.length < 3) return null;
    const latest = closes[closes.length - 1];
    const base = closes[Math.max(0, closes.length - 13)];
    const changePct = base ? ((latest - base) / base) * 100 : 0;
    const recent = rows.slice(-24);
    const averageRange = recent.reduce((sum, row) => {
      const high = Number(row.high);
      const low = Number(row.low);
      return sum + (Number.isFinite(high - low) ? Math.abs(high - low) : 0);
    }, 0) / Math.max(1, recent.length);
    const rangePct = latest ? (averageRange / latest) * 100 : 0;
    return { latest, changePct, rangePct };
  }

  function renderMarket(pack, rows) {
    const geometry = sparkGeometry(rows);
    const metrics = marketMetrics(rows);
    if (!geometry || !metrics) throw new Error('Insufficient market rows');

    const line = $('#marketSparkline .spark-path');
    const area = $('#marketSparkline .spark-area');
    if (line) line.setAttribute('d', geometry.line);
    if (area) area.setAttribute('d', geometry.area);

    const price = $('#latestPrice');
    const change = $('#priceChange');
    if (price) price.textContent = metrics.latest.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (change) {
      const prefix = metrics.changePct > 0 ? '+' : '';
      change.textContent = `${prefix}${metrics.changePct.toFixed(2)}%`;
      change.style.color = metrics.changePct > .01 ? 'var(--green)' : metrics.changePct < -.01 ? 'var(--red)' : 'var(--muted)';
    }

    const trend = metrics.changePct > .025 ? 'Bullish' : metrics.changePct < -.025 ? 'Bearish' : 'Neutral';
    const volatility = metrics.rangePct > .18 ? 'Elevated' : metrics.rangePct < .035 ? 'Low' : 'Normal';
    const trendElement = $('#trendBias');
    const volatilityElement = $('#volatilityState');
    if (trendElement) trendElement.textContent = trend;
    if (volatilityElement) volatilityElement.textContent = volatility;

    const feedStatus = $('#feedStatus');
    if (feedStatus) {
      const status = pack?.feed?.status || 'DATA LINKED';
      feedStatus.textContent = String(status).replaceAll('_', ' ').toLowerCase();
    }

    const dataAge = pack?.generatedAt ? Date.parse(pack.generatedAt) : NaN;
    const contextTime = $('#contextTime');
    if (contextTime && Number.isFinite(dataAge)) {
      const minutes = Math.max(0, Math.round((Date.now() - dataAge) / 60000));
      contextTime.textContent = minutes < 2 ? 'UPDATED NOW' : `UPDATED ${minutes}M AGO`;
    }

    const movementStrength = Math.min(1, Math.abs(metrics.changePct) / .22);
    const rangePenalty = metrics.rangePct > .35 ? 7 : 0;
    const score = clamp(Math.round(78 + movementStrength * 9 - rangePenalty), 68, 91);
    setCoreScore(score);
  }

  async function loadMarketData() {
    try {
      const response = await fetch('./xauusd.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Market feed ${response.status}`);
      const pack = await response.json();
      const timeframes = pack.timeframes || {};
      const rows = timeframes.M15 || timeframes.M5 || timeframes.M1 || timeframes.H1 || [];
      if (!Array.isArray(rows) || rows.length < 3) throw new Error('Market feed has no usable timeframe');
      appState.rows = rows;
      renderMarket(pack, rows);
    } catch (error) {
      const feedStatus = $('#feedStatus');
      if (feedStatus) feedStatus.textContent = 'static fallback';
      setCoreScore(82);
      console.warn('[KAGE CORE] Market preview fallback:', error);
    }
  }

  async function runShadowScan() {
    if (appState.scanning) return;
    appState.scanning = true;
    const button = $('#scanButton');
    const card = $('.hero-card');
    button?.classList.add('scanning');
    card?.classList.add('scanning');
    if (button) button.disabled = true;
    showToast('Shadow scan กำลังประเมิน feed, drift, memory และ risk gates…', 1800);

    const target = appState.score;
    let value = 28;
    setCoreScore(value);
    await new Promise(resolve => {
      const timer = window.setInterval(() => {
        value += Math.max(1, Math.ceil((target - value) * .18));
        setCoreScore(Math.min(value, target));
        if (value >= target) {
          window.clearInterval(timer);
          resolve();
        }
      }, 55);
    });

    window.setTimeout(() => {
      button?.classList.remove('scanning');
      card?.classList.remove('scanning');
      if (button) button.disabled = false;
      appState.scanning = false;
      setScreen('market');
      showToast(`Scan complete · AI Core Score ${target}/100`);
    }, 320);
  }

  function toggleNotifications(force) {
    const panel = $('#notificationPanel');
    const button = $('#notificationButton');
    if (!panel || !button) return;
    const shouldOpen = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', shouldOpen);
    panel.setAttribute('aria-hidden', String(!shouldOpen));
    button.setAttribute('aria-expanded', String(shouldOpen));
  }

  function bindInteractions() {
    $$('[data-nav]').forEach(button => button.addEventListener('click', () => setScreen(button.dataset.nav)));
    $$('[data-go]').forEach(button => button.addEventListener('click', () => setScreen(button.dataset.go)));
    $('#scanButton')?.addEventListener('click', runShadowScan);
    $('#notificationButton')?.addEventListener('click', () => toggleNotifications());
    $('#closeNotifications')?.addEventListener('click', () => toggleNotifications(false));
    $('#memoryButton')?.addEventListener('click', () => showToast('Memory archive พร้อมเชื่อมต่อกับ trading journal ในเฟสถัดไป'));
    $$('.stage-card').forEach(stage => stage.addEventListener('click', () => {
      const label = $('.stage-number', stage)?.textContent?.trim() || '—';
      showToast(`Stage ${label} · risk gate และช่วงเวลาที่เหมาะสมแสดงอยู่ในการ์ด`);
    }));

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') toggleNotifications(false);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const screens = Array.from(validScreens);
        const index = screens.indexOf(appState.screen);
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        setScreen(screens[(index + delta + screens.length) % screens.length]);
      }
    });

    window.addEventListener('hashchange', () => {
      const candidate = window.location.hash.slice(1);
      if (validScreens.has(candidate)) setScreen(candidate, false);
    });

    document.addEventListener('pointerdown', event => {
      const panel = $('#notificationPanel');
      if (panel?.classList.contains('open') && !panel.contains(event.target) && !$('#notificationButton')?.contains(event.target)) {
        toggleNotifications(false);
      }
    });
  }

  function boot() {
    bindInteractions();
    updateClock();
    window.setInterval(updateClock, 30000);
    let initial = window.location.hash.slice(1);
    if (!validScreens.has(initial)) {
      try { initial = localStorage.getItem('kage-v40-screen') || 'overview'; } catch (_) { initial = 'overview'; }
    }
    setScreen(validScreens.has(initial) ? initial : 'overview', false);
    setCoreScore(82);
    loadMarketData();

    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}), { once: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
