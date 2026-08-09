(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const validScreens = new Set(['overview', 'market', 'positions', 'intel', 'plan', 'history']);
  const PLAN_KEY = 'onemonth_os_plan_v15';
  const SCREEN_KEY = 'kage-v40-screen';
  const RUNTIME_FILES = {
    market: './xauusd.json',
    ml: './ai-ml-brain.json',
    learning: './ai-learning.json',
    governance: './ai-model-governance.json',
    outcomes: './ai-outcome-journal.json',
    news: './news.json'
  };

  const appState = {
    screen: 'overview',
    market: null,
    rows: [],
    ml: null,
    learning: null,
    governance: null,
    outcomes: null,
    news: null,
    plan: null,
    candidate: null,
    decision: null,
    score: 0,
    scanning: false,
    toastTimer: 0,
    loadedAt: 0
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function finite(value) {
    return Number.isFinite(Number(value));
  }

  function money(value) {
    return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function price(value) {
    return finite(value)
      ? Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—';
  }

  function compactNumber(value) {
    const number = Number(value || 0);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}m`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
    return String(Math.round(number));
  }

  function formatTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function formatAge(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
    if (minutes < 2) return 'NOW';
    if (minutes < 60) return `${minutes}M AGO`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}H AGO`;
    return `${Math.round(minutes / 1440)}D AGO`;
  }

  function safeRead(key) {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }

  function safeWrite(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = String(value ?? '—');
  }

  function showToast(message, duration = 2600) {
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

    if (updateUrl && window.location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    safeWrite(SCREEN_KEY, name);
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

  function bangkokMarketStatus() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const hour = Number(values.hour) % 24;
    const open = values.weekday !== 'Sat' && values.weekday !== 'Sun';
    const session = !open ? 'WEEKEND' : hour < 12 ? 'ASIA' : hour < 19 ? 'LONDON' : 'NEW YORK';
    return { open, session, label: open ? 'MARKET OPEN' : 'MARKET CLOSED' };
  }

  function dailyRate(start, target, days = 30) {
    return start > 0 && target > start && days > 0 ? Math.pow(target / start, 1 / days) - 1 : 0;
  }

  function buildPlan(start, target, actuals = []) {
    const rate = dailyRate(start, target, 30);
    const days = [];
    let balance = start;
    for (let index = 0; index < 30; index += 1) {
      const profit = balance * rate;
      const expected = balance + profit;
      const maxLoss = Math.min(Math.max(balance * .01, .10), Math.max(.10, profit * .85));
      const actual = actuals[index]?.actual ?? null;
      const note = actuals[index]?.note ?? '';
      const status = actual == null ? 'wait' : Number(actual) >= expected ? 'hit' : 'miss';
      days.push({ day: index + 1, start: balance, profit, expected, maxLoss, actual, note, status });
      balance = actual != null ? Number(actual) : expected;
    }
    return { version: 15, start, target, totalDays: 30, days, createdAt: Date.now() };
  }

  function validPlan(plan) {
    return Boolean(plan && Number(plan.start) > 0 && Number(plan.target) > Number(plan.start) && Array.isArray(plan.days) && plan.days.length === 30);
  }

  function loadPlan() {
    try {
      const parsed = JSON.parse(safeRead(PLAN_KEY) || 'null');
      appState.plan = validPlan(parsed) ? parsed : null;
    } catch (_) {
      appState.plan = null;
    }
    return appState.plan;
  }

  function savePlan(plan) {
    appState.plan = plan;
    return safeWrite(PLAN_KEY, JSON.stringify(plan));
  }

  function completedSessions(plan = appState.plan) {
    return validPlan(plan) ? plan.days.filter(day => day.actual != null).length : 0;
  }

  function currentBalance(plan = appState.plan) {
    if (!validPlan(plan)) return 0;
    const completed = plan.days.filter(day => day.actual != null);
    return completed.length ? Number(completed.at(-1).actual) : Number(plan.start);
  }

  function maxDrawdown(plan = appState.plan) {
    if (!validPlan(plan)) return 0;
    const values = [Number(plan.start), ...plan.days.filter(day => day.actual != null).map(day => Number(day.actual))];
    let peak = values[0] || 0;
    let drawdown = 0;
    values.forEach(value => {
      peak = Math.max(peak, value);
      if (peak > 0) drawdown = Math.max(drawdown, (peak - value) / peak);
    });
    return drawdown;
  }

  function riskGuardian(plan = appState.plan) {
    if (!validPlan(plan)) return { locked: false, multiplier: 1, missStreak: 0, drawdown: 0, reason: 'ตั้งทุนก่อน' };
    const drawdown = maxDrawdown(plan);
    const rows = plan.days.filter(day => day.actual != null).slice().reverse();
    let missStreak = 0;
    for (const row of rows) {
      if (row.status === 'miss') missStreak += 1;
      else break;
    }
    const locked = drawdown >= .10 || missStreak >= 4;
    let multiplier = 1;
    if (missStreak >= 1) multiplier = Math.min(multiplier, .85);
    if (missStreak >= 2) multiplier = Math.min(multiplier, .65);
    if (missStreak >= 3) multiplier = Math.min(multiplier, .4);
    if (drawdown >= .04) multiplier = Math.min(multiplier, .75);
    if (drawdown >= .07) multiplier = Math.min(multiplier, .5);
    if (locked) multiplier = 0;
    const reason = locked ? 'RISK LOCK' : missStreak ? `${missStreak} MISS STREAK` : drawdown >= .04 ? `DD ${(drawdown * 100).toFixed(1)}%` : 'NORMAL';
    return { locked, multiplier, missStreak, drawdown, reason };
  }

  function lotGuide(candidate = appState.candidate, plan = appState.plan) {
    if (!validPlan(plan)) return 'ตั้งทุนก่อน';
    if (!candidate || !finite(candidate.entry) || !finite(candidate.sl)) return '—';
    const index = Math.min(completedSessions(plan), 29);
    const day = plan.days[index];
    const balance = currentBalance(plan);
    const guard = riskGuardian(plan);
    const riskBudget = Math.min(Number(day.maxLoss) / 2, balance * .005) * guard.multiplier;
    const riskPerLot = Math.abs(Number(candidate.entry) - Number(candidate.sl)) * 100;
    if (!(riskBudget > 0) || !(riskPerLot > 0)) return 'RISK LOCK';
    const raw = riskBudget / riskPerLot;
    if (raw < .01) return '< 0.01 lot';
    return `${Math.max(.01, Math.floor(raw / .01) * .01).toFixed(2)} lot`;
  }

  function syncPlanInputs() {
    if (!validPlan(appState.plan)) return;
    $('#capitalInput').value = Number(appState.plan.start).toFixed(2);
    $('#profitTargetInput').value = Math.max(0, Number(appState.plan.target) - Number(appState.plan.start)).toFixed(2);
  }

  function previewPlanInputs() {
    const start = Number($('#capitalInput')?.value);
    const wantedProfit = Number($('#profitTargetInput')?.value);
    const valid = start > 0 && wantedProfit > 0;
    const target = valid ? start + wantedProfit : 0;
    setText('#targetBalancePreview', valid ? money(target) : '—');
    setText('#targetGrowthPreview', valid ? `+${((wantedProfit / start) * 100).toFixed(2)}% ภายใน 30 วัน` : 'กรอกตัวเลขมากกว่า 0');
    if (valid) {
      const preview = buildPlan(start, target);
      setText('#dailyProfitPreview', `+${money(preview.days[0].profit)}`);
      setText('#dailyRiskPreview', `-${money(preview.days[0].maxLoss)}`);
    }
  }

  function renderPlan() {
    const plan = appState.plan;
    const list = $('#planStageList');
    if (!validPlan(plan)) {
      setText('#planCompleted', '0 / 30');
      setText('#planProgressPercent', '0%');
      setText('#planStatusChip', 'SET CAPITAL');
      $('#planProgressBar')?.style.setProperty('--value', '0%');
      setText('#currentBalancePreview', 'ยังไม่ได้ตั้งทุน');
      if (list) list.innerHTML = '<article class="stage-card panel"><div class="stage-main"><b>ยังไม่มีแผน</b><small>ใส่ทุนและกำไรด้านบนเพื่อสร้าง Roadmap</small></div></article>';
      renderHistory();
      return;
    }

    const done = completedSessions(plan);
    const progress = Math.round((done / 30) * 100);
    const balance = currentBalance(plan);
    const today = plan.days[Math.min(done, 29)];
    const guard = riskGuardian(plan);
    setText('#planCompleted', `${done} / 30`);
    setText('#planProgressPercent', `${progress}%`);
    setText('#planStatusChip', done >= 30 ? 'COMPLETE' : guard.locked ? 'RISK LOCK' : 'ON PLAN');
    $('#planStatusChip')?.classList.toggle('blocked', guard.locked);
    $('#planProgressBar')?.style.setProperty('--value', `${progress}%`);
    setText('#dailyProfitPreview', today ? `+${money(today.profit)}` : 'DONE');
    setText('#dailyRiskPreview', today ? `-${money(today.maxLoss)}` : '—');
    setText('#currentBalancePreview', money(balance));
    if ($('#sessionBalanceInput') && today) $('#sessionBalanceInput').placeholder = `เป้าปิด ${money(today.expected)}`;

    const aiScore = finite(appState.candidate?.score) ? `${Math.round(appState.candidate.score)}/100` : '—';
    const suggestedLot = lotGuide();
    const session = bangkokMarketStatus().session;
    if (list) {
      list.innerHTML = plan.days.map((day, index) => {
        const isDone = day.actual != null;
        const isActive = !isDone && index === done;
        const isLocked = !isDone && index > done + 2;
        const className = isDone ? 'completed' : isActive ? 'active-stage' : isLocked ? 'locked-stage' : '';
        const actualDelta = isDone ? Number(day.actual) - Number(day.start) : null;
        const displayProfit = isDone ? `${actualDelta >= 0 ? '+' : ''}${money(actualDelta)}` : `+${money(day.profit)}`;
        const status = isDone ? day.status.toUpperCase() : isActive ? 'ACTIVE' : 'WAIT';
        return `<article class="stage-card panel ${className}" data-plan-day="${day.day}">
          <span class="stage-number">${String(day.day).padStart(2, '0')}</span>
          <div class="stage-main"><b>${money(day.start)} → ${money(day.expected)}</b><small>Target +${money(day.profit)} · Max loss ${money(day.maxLoss)}</small></div>
          <div class="stage-profit ${isDone ? '' : 'muted'}"><b>${displayProfit}</b><span>${status}</span></div>
          <div class="stage-meta"><span>Lot Guide<b>${isActive ? suggestedLot : '—'}</b></span><span>Market Window<b>${session === 'WEEKEND' ? 'รอตลาดเปิด' : `${session} · Revalidate`}</b></span><span>AI Plan<b>${isActive ? aiScore : '—'}</b></span></div>
        </article>`;
      }).join('');
    }
    renderHistory();
  }

  function saveCapitalPlan(event) {
    event.preventDefault();
    const start = Number($('#capitalInput')?.value);
    const wantedProfit = Number($('#profitTargetInput')?.value);
    if (!(start > 0) || !(wantedProfit > 0)) {
      showToast('กรุณาใส่ทุนและกำไรที่ต้องการให้มากกว่า 0');
      return;
    }
    const actuals = validPlan(appState.plan) ? appState.plan.days.map(day => ({ actual: day.actual, note: day.note })) : [];
    const plan = buildPlan(start, start + wantedProfit, actuals);
    savePlan(plan);
    syncPlanInputs();
    previewPlanInputs();
    renderPlan();
    renderAiDecision();
    showToast(`สร้างแผน ${money(start)} → ${money(start + wantedProfit)} แล้ว`);
  }

  function saveSessionResult(event) {
    event.preventDefault();
    if (!validPlan(appState.plan)) {
      showToast('ตั้งทุนและกำไรที่ต้องการก่อนบันทึก Session');
      return;
    }
    const value = Number($('#sessionBalanceInput')?.value);
    const done = completedSessions();
    if (!(value > 0) || done >= 30) {
      showToast(done >= 30 ? 'แผนครบ 30 Session แล้ว' : 'กรุณาใส่ Balance หลังจบ Session');
      return;
    }
    const actuals = appState.plan.days.map(day => ({ actual: day.actual, note: day.note }));
    actuals[done] = { actual: value, note: 'Saved from KAGE CORE V40' };
    savePlan(buildPlan(Number(appState.plan.start), Number(appState.plan.target), actuals));
    $('#sessionBalanceInput').value = '';
    syncPlanInputs();
    previewPlanInputs();
    renderPlan();
    renderAiDecision();
    showToast(`บันทึก Session ${done + 1} ที่ ${money(value)} แล้ว`);
  }

  async function fetchJson(url) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}v=401&t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url} ${response.status}`);
    return response.json();
  }

  function deriveTechnicalReference(pack) {
    const rows = pack?.timeframes?.M15 || pack?.timeframes?.M5 || [];
    if (!Array.isArray(rows) || rows.length < 30) return null;
    const recent = rows.slice(-30);
    const closes = recent.map(row => Number(row.close)).filter(Number.isFinite);
    const latest = closes.at(-1);
    const short = closes.slice(-9).reduce((sum, value) => sum + value, 0) / 9;
    const long = closes.slice(-21).reduce((sum, value) => sum + value, 0) / 21;
    const ranges = recent.slice(-14).map(row => Math.abs(Number(row.high) - Number(row.low))).filter(Number.isFinite);
    const atr = ranges.reduce((sum, value) => sum + value, 0) / Math.max(1, ranges.length);
    if (![latest, short, long, atr].every(Number.isFinite) || atr <= 0) return null;
    const side = short >= long ? 'BUY' : 'SELL';
    const entry = (short + long) / 2;
    const risk = Math.max(atr * .85, latest * .0002);
    const sl = side === 'BUY' ? entry - risk : entry + risk;
    const tp1 = side === 'BUY' ? entry + risk * 1.4 : entry - risk * 1.4;
    const tp2 = side === 'BUY' ? entry + risk * 2 : entry - risk * 2;
    return {
      type: `${side}_LIMIT`, side, entry, entryLow: entry - atr * .1, entryHigh: entry + atr * .1,
      sl, tp1, tp2, rr: 1.4, score: 0, pTp1: null, pSl: null, evR: null,
      planState: 'REFERENCE', reason: 'Technical fallback only — ML brain unavailable',
      qualityGate: { passed: false, grade: 'REFERENCE', reasons: ['ML_BRAIN_UNAVAILABLE'] },
      source: 'TECHNICAL_FALLBACK'
    };
  }

  function selectCandidate() {
    const current = appState.ml?.current || {};
    const primary = current.primary && typeof current.primary === 'object' ? current.primary : null;
    const reference = current.reference && typeof current.reference === 'object' ? current.reference : null;
    const first = Array.isArray(current.candidates) ? current.candidates[0] : null;
    appState.candidate = primary || reference || first || deriveTechnicalReference(appState.market);
    return appState.candidate;
  }

  function latestMarketTimestamp() {
    const rows = appState.market?.timeframes?.M1 || appState.market?.timeframes?.M5 || appState.rows || [];
    const last = Array.isArray(rows) ? rows.at(-1) : null;
    const raw = last?.ts ?? last?.timestamp ?? last?.time ?? appState.market?.generatedAt;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return Date.parse(raw);
  }

  function newsContext() {
    const events = Array.isArray(appState.news?.events) ? appState.news.events : [];
    const now = Date.now();
    const normalized = events.map(event => {
      const raw = event.ts ?? event.timestamp ?? event.datetime ?? event.time ?? event.date;
      const numeric = Number(raw);
      const timestamp = Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : Date.parse(raw);
      const impact = String(event.impact ?? event.importance ?? event.priority ?? '').toUpperCase();
      const high = impact.includes('HIGH') || impact.includes('RED') || impact === '3';
      return { timestamp, high, event };
    }).filter(row => Number.isFinite(row.timestamp));
    const locked = normalized.some(row => row.high && row.timestamp - now <= 30 * 60000 && row.timestamp - now >= -15 * 60000);
    const upcoming = normalized.filter(row => row.timestamp >= now).sort((a, b) => a.timestamp - b.timestamp)[0] || null;
    return { locked, upcoming, count: events.length };
  }

  function translateGateReason(reason) {
    const map = {
      LOW_PLAN_SCORE: 'คะแนนแผนต่ำกว่าเกณฑ์',
      LOW_EXPECTED_VALUE: 'Expected Value ต่ำกว่าเกณฑ์',
      LOW_TP1_PROBABILITY: 'โอกาสถึง TP1 ต่ำ',
      SL_PROBABILITY_HIGH: 'ความเสี่ยงโดน SL สูง',
      WEAK_TP1_SL_EDGE: 'ส่วนต่าง TP1 ต่อ SL ยังไม่คุ้ม',
      MODEL_DISAGREEMENT_HIGH: 'โมเดลเห็นต่างกันมาก',
      ML_BRAIN_UNAVAILABLE: 'ยังโหลด ML Brain ไม่ได้'
    };
    return map[reason] || String(reason || '').replaceAll('_', ' ').toLowerCase();
  }

  function evaluateDecision() {
    const candidate = appState.candidate;
    const market = bangkokMarketStatus();
    const news = newsContext();
    const guard = riskGuardian();
    const modelStatus = String(appState.ml?.status || appState.ml?.modelHealth?.status || '').toUpperCase();
    const modelTrusted = Boolean(appState.ml && appState.ml.ready !== false && ['TRUSTED', 'READY', 'STRONG'].some(value => modelStatus.includes(value)));
    const qualityPassed = Boolean(candidate?.qualityGate?.passed === true && String(candidate?.planState || '').toUpperCase() !== 'REJECTED');
    const latestTs = latestMarketTimestamp();
    const feedAge = Number.isFinite(latestTs) ? Date.now() - latestTs : Infinity;
    const feedFresh = !market.open || feedAge <= 20 * 60000;
    const hasRiskPlan = validPlan(appState.plan);
    const reasons = [];
    const gateReasons = Array.isArray(candidate?.qualityGate?.reasons) ? candidate.qualityGate.reasons.map(translateGateReason) : [];
    if (!candidate) reasons.push('ยังไม่มี AI Candidate');
    if (!modelTrusted) reasons.push('Model ยังไม่อยู่ในสถานะ TRUSTED');
    if (!qualityPassed) reasons.push(...(gateReasons.length ? gateReasons : ['แผนยังไม่ผ่าน Hard Quality Gate']));
    if (!market.open) reasons.push('ตลาดปิด — แสดงระดับเพื่อเตรียมแผนเท่านั้น');
    if (!feedFresh) reasons.push('ข้อมูลราคาเกิน 20 นาที');
    if (news.locked) reasons.push('News Lock ทำงาน');
    if (!hasRiskPlan) reasons.push('ยังไม่ได้ตั้งทุนและกำไรที่ต้องการ');
    if (guard.locked) reasons.push(`Risk Guardian ล็อก (${guard.reason})`);
    const actionable = Boolean(candidate && modelTrusted && qualityPassed && market.open && feedFresh && !news.locked && hasRiskPlan && !guard.locked);
    appState.decision = { actionable, candidate, market, news, guard, modelTrusted, qualityPassed, feedFresh, hasRiskPlan, reasons: [...new Set(reasons)] };
    return appState.decision;
  }

  function setCoreScore(score) {
    const next = clamp(Math.round(score), 0, 100);
    appState.score = next;
    $('#coreRing')?.style.setProperty('--score', String(next));
    if ($('#coreScore')) $('#coreScore').innerHTML = `${next}<small>/100</small>`;
    if ($('#marketQuality')) $('#marketQuality').innerHTML = `${next}<small>%</small>`;
    if ($('#overviewQuality')) $('#overviewQuality').innerHTML = `${next}<small>%</small>`;
    $('#marketQualityBar')?.style.setProperty('--value', `${next}%`);
    $('#overviewQualityBar')?.style.setProperty('--value', `${next}%`);
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
    return { line, area: `${line} L360 92 L0 92 Z`, samples };
  }

  function marketMetrics(rows) {
    const closes = rows.map(row => Number(row.close)).filter(Number.isFinite);
    if (closes.length < 3) return null;
    const latest = closes.at(-1);
    const base = closes[Math.max(0, closes.length - 13)];
    const changePct = base ? ((latest - base) / base) * 100 : 0;
    const recent = rows.slice(-24);
    const averageRange = recent.reduce((sum, row) => sum + Math.abs(Number(row.high) - Number(row.low)), 0) / Math.max(1, recent.length);
    const rangePct = latest ? (averageRange / latest) * 100 : 0;
    return { latest, changePct, rangePct };
  }

  function renderMarket() {
    const rows = appState.rows;
    const geometry = sparkGeometry(rows);
    const metrics = marketMetrics(rows);
    if (!geometry || !metrics) {
      setText('#feedStatus', 'feed unavailable');
      return;
    }
    $('#marketSparkline .spark-path')?.setAttribute('d', geometry.line);
    $('#marketSparkline .spark-area')?.setAttribute('d', geometry.area);
    setText('#latestPrice', price(metrics.latest));
    const change = $('#priceChange');
    if (change) {
      change.textContent = `${metrics.changePct > 0 ? '+' : ''}${metrics.changePct.toFixed(2)}%`;
      change.style.color = metrics.changePct > .01 ? 'var(--green)' : metrics.changePct < -.01 ? 'var(--red)' : 'var(--muted)';
    }
    setText('#trendBias', metrics.changePct > .025 ? 'Bullish' : metrics.changePct < -.025 ? 'Bearish' : 'Neutral');
    setText('#volatilityState', metrics.rangePct > .18 ? 'Elevated' : metrics.rangePct < .035 ? 'Low' : 'Normal');
    const feedState = String(appState.market?.feed?.status || appState.ml?.dataFeed?.status || 'DATA LINKED').replaceAll('_', ' ');
    setText('#feedStatus', feedState.toLowerCase());
    setText('#liquidityState', feedState);
    setText('#coreFeed', feedState);
    setText('#contextTime', `UPDATED ${formatAge(appState.market?.generatedAt)}`);
  }

  function setDecisionWord(selector, value) {
    const element = $(selector);
    if (!element) return;
    element.textContent = value;
    element.classList.remove('buy', 'sell', 'wait');
    element.classList.add(value === 'BUY' ? 'buy' : value === 'SELL' ? 'sell' : 'wait');
  }

  function setGateState(key, state) {
    const element = $(`[data-gate="${key}"]`);
    if (!element) return;
    element.classList.remove('pass', 'block', 'current');
    element.classList.add(state);
  }

  function renderAiDecision() {
    const candidate = selectCandidate();
    const decision = evaluateDecision();
    const score = finite(candidate?.score) ? Number(candidate.score) : 0;
    setCoreScore(score);

    const state = decision.actionable ? String(candidate.side || 'WAIT').toUpperCase() : 'WAIT';
    const grade = String(candidate?.qualityGate?.grade || candidate?.planState || 'NO PLAN').toUpperCase();
    const reasonText = decision.reasons.length ? decision.reasons.slice(0, 4).join(' · ') : 'ทุก Gate ผ่าน — รอราคาเข้า Entry Zone และ Revalidate ก่อนส่งคำสั่ง';
    const decisionLabel = decision.actionable ? `${String(candidate.type || candidate.side).replaceAll('_', ' ')} · READY` : candidate ? `${grade} · REFERENCE ONLY` : 'NO AI PLAN';
    setDecisionWord('#overviewDecision', state);
    setDecisionWord('#positionDecision', state);
    setText('#overviewDecisionLabel', decisionLabel);
    setText('#positionDecisionLabel', decisionLabel);
    setText('#overviewDecisionReason', reasonText);
    setText('#positionDecisionReason', reasonText);
    setText('#overviewQualityNote', decision.qualityPassed ? 'Hard Quality Gate ผ่าน' : reasonText);
    setText('#marketQualityNote', decision.qualityPassed ? 'Governed ML Candidate ผ่านเกณฑ์' : 'คะแนนจริงของแผนอ้างอิงที่ยังถูก AI ปฏิเสธ');
    setText('#coreScoreState', decision.actionable ? 'QUALIFIED PLAN' : candidate ? grade : 'NO CANDIDATE');

    setText('#signalDirection', candidate?.side || 'WAIT');
    setText('#signalStrength', candidate ? `${Math.round(score)}/100` : '—');
    setText('#signalQuality', grade);
    setText('#signalOrderType', candidate?.type ? String(candidate.type).replaceAll('_', ' ') : '—');
    const signalGate = $('#signalGateState');
    if (signalGate) {
      signalGate.textContent = decision.actionable ? 'READY · REVALIDATE ราคา / ข่าว ก่อนเข้า' : `WAIT · ${reasonText}`;
      signalGate.classList.toggle('ready', decision.actionable);
      signalGate.classList.toggle('rejected', !decision.actionable);
    }

    setText('#confidenceValue', finite(candidate?.pTp1) ? `${Number(candidate.pTp1).toFixed(1)}%` : '—');
    setText('#riskState', decision.guard.locked ? 'LOCKED' : validPlan(appState.plan) ? decision.guard.reason : 'SET PLAN');
    setText('#qualityState', grade);
    setText('#biasState', candidate?.side || '—');

    setText('#executionTitle', candidate ? `${String(candidate.type || candidate.side).replaceAll('_', ' ')} @ ${price(candidate.entry)}` : 'ยังไม่มี AI Candidate');
    setText('#executionBadge', decision.actionable ? 'READY' : candidate ? 'REFERENCE' : 'NO DATA');
    const badge = $('#executionBadge');
    if (badge) {
      badge.className = `status-chip ${decision.actionable ? 'ready' : candidate ? 'rejected' : 'reference'}`;
    }
    setText('#aiEntryZone', candidate ? `${price(candidate.entryLow)} – ${price(candidate.entryHigh)}` : '—');
    setText('#aiStopLoss', price(candidate?.sl));
    setText('#aiTakeProfit1', price(candidate?.tp1));
    setText('#aiTakeProfit2', price(candidate?.tp2));
    setText('#aiRiskReward', finite(candidate?.rr) ? `1 : ${Number(candidate.rr).toFixed(2)}` : '—');
    setText('#aiLotGuide', lotGuide(candidate));
    setText('#executionWarning', decision.actionable
      ? 'READY เป็นเพียงสถานะช่วยตัดสินใจ ต้อง Revalidate ราคา ข่าว Spread และความเสี่ยงก่อนเข้าเงินจริง'
      : `REFERENCE ONLY — AI ไม่อนุญาตให้เข้า: ${reasonText}`);
    setGateState('model', decision.modelTrusted ? 'pass' : 'block');
    setGateState('plan', decision.qualityPassed ? 'pass' : 'block');
    setGateState('market', decision.market.open && decision.feedFresh && !decision.news.locked ? 'pass' : 'block');
    setGateState('risk', decision.hasRiskPlan && !decision.guard.locked ? 'pass' : 'current');

    const ml = appState.ml || {};
    const learning = appState.learning || {};
    const health = Number(ml.modelHealth?.score ?? learning.modelHealth?.score);
    const trusted = String(ml.status || ml.modelHealth?.status || 'UNAVAILABLE').toUpperCase();
    const aucRaw = Number(ml.validation?.tp1?.auc);
    const auc = Number.isFinite(aucRaw) ? (aucRaw <= 1 ? aucRaw * 100 : aucRaw) : NaN;
    const samples = Number(ml.training?.candidateSamples ?? learning.global?.samples ?? 0);
    const modelId = appState.governance?.champion?.modelId || ml.engine || '—';
    setText('#modelTrustState', trusted);
    setText('#modelIntegrity', Number.isFinite(health) ? `${health.toFixed(1)}%` : '—');
    setText('#modelDataState', String(ml.dataFeed?.status || appState.market?.feed?.status || '—').replaceAll('_', ' '));
    setText('#modelGovernance', String(ml.governance?.action || appState.governance?.action || '—').replaceAll('_', ' '));
    setText('#modelValidation', Number.isFinite(auc) ? `${auc.toFixed(1)}%` : '—');
    setText('#modelTrainingSamples', samples ? compactNumber(samples) : '—');
    setText('#modelUpdatedAt', formatAge(ml.generatedAt));
    setText('#modelId', modelId);
    setText('#qualifiedPlans', ml.current?.qualifiedCount ?? 0);
    setText('#tp1Probability', finite(candidate?.pTp1) ? `${Number(candidate.pTp1).toFixed(1)}%` : '—');
    setText('#expectedValue', finite(candidate?.evR) ? `${Number(candidate.evR) >= 0 ? '+' : ''}${Number(candidate.evR).toFixed(3)}R` : '—');
    setText('#modelEvidenceNote', candidate?.reason || (candidate ? reasonText : 'AI Brain ยังไม่มี Candidate ที่อ่านได้'));
    setText('#coreCalibration', Number.isFinite(auc) ? `${auc.toFixed(1)}% AUC` : '—');
    setText('#coreMode', trusted);
    setText('#coreMemory', samples ? compactNumber(samples) : '—');
    setText('#calibrationStatus', Number.isFinite(auc) ? `${auc.toFixed(1)}% TP1 AUC` : 'unavailable');
    setText('#driftStatus', finite(ml.modelHealth?.driftPts) ? `${Number(ml.modelHealth.driftPts).toFixed(1)} drift pts` : '—');
    setText('#learningStatus', learning.status || (ml.ready ? 'READY' : 'WAIT'));
    setText('#modelModeStatus', trusted);
    setText('#memoryStatus', samples ? `${compactNumber(samples)} candidates` : '—');
    setText('#notificationTitle', decision.actionable ? `${state} plan ผ่าน Gate` : 'AI ยังสั่ง WAIT');
    setText('#notificationText', reasonText);
    setText('#notificationTime', `Model ${formatAge(ml.generatedAt)}`);
    setText('#newsRiskState', decision.news.locked ? 'LOCKED' : decision.news.count ? 'MONITOR' : 'CLEAR');
    renderPlan();
  }

  function renderIntel() {
    const context = newsContext();
    if (context.locked) {
      setText('#newsRadarTitle', 'พบข่าวแรงในช่วง News Lock');
      setText('#newsRadarState', 'LOCKED');
    } else if (context.upcoming) {
      setText('#newsRadarTitle', `ข่าวถัดไป ${formatTime(context.upcoming.timestamp)}`);
      setText('#newsRadarState', 'MONITOR');
    } else {
      setText('#newsRadarTitle', context.count ? `ติดตาม ${context.count} เหตุการณ์` : 'ไม่พบข่าวแรงใกล้ Feed');
      setText('#newsRadarState', 'CLEAR');
    }
  }

  function bestPlanReturn(plan = appState.plan) {
    if (!validPlan(plan)) return null;
    const rows = plan.days.filter(day => day.actual != null && Number(day.start) > 0);
    if (!rows.length) return null;
    return Math.max(...rows.map(day => (Number(day.actual) - Number(day.start)) / Number(day.start)));
  }

  function renderHistory() {
    const plan = appState.plan;
    const outcomeSummary = appState.outcomes?.summary || {};
    const done = completedSessions(plan);
    const hitRate = finite(outcomeSummary.hitRate30) ? Number(outcomeSummary.hitRate30) : finite(outcomeSummary.hitRate15) ? Number(outcomeSummary.hitRate15) : null;
    const best = bestPlanReturn(plan);
    const drawdown = validPlan(plan) ? maxDrawdown(plan) : null;
    setText('#historyCompleted', done);
    setText('#historyHitRate', hitRate == null ? '—' : `${hitRate.toFixed(1)}%`);
    setText('#historyBestDay', best == null ? '—' : `${best >= 0 ? '+' : ''}${(best * 100).toFixed(2)}%`);
    setText('#historyDrawdown', drawdown == null ? '—' : `-${(drawdown * 100).toFixed(2)}%`);

    const activities = [];
    if (validPlan(plan)) {
      plan.days.filter(day => day.actual != null).slice(-2).reverse().forEach(day => {
        activities.push({ text: `Session ${day.day} · ${day.status.toUpperCase()} · ${money(day.actual)}`, time: formatTime(plan.createdAt) });
      });
    }
    if (appState.candidate) activities.push({ text: `AI plan ${String(appState.candidate.planState || appState.candidate.qualityGate?.grade || 'REFERENCE')} · Score ${Math.round(Number(appState.candidate.score || 0))}`, time: formatTime(appState.ml?.generatedAt) });
    if (appState.ml) activities.push({ text: `Model ${String(appState.ml.status || 'READY')} · ${compactNumber(appState.ml.training?.candidateSamples || 0)} candidates`, time: formatTime(appState.ml.generatedAt) });
    if (appState.market) activities.push({ text: `Feed ${String(appState.market.feed?.status || 'UPDATED').replaceAll('_', ' ')}`, time: formatTime(appState.market.generatedAt) });
    if (appState.governance) activities.push({ text: `Governance ${String(appState.governance.action || appState.governance.decision?.action || 'CHECKED').replaceAll('_', ' ')}`, time: formatTime(appState.governance.updatedAt) });
    const list = $('#activityList');
    if (list) {
      list.replaceChildren();
      (activities.length ? activities.slice(0, 6) : [{ text: 'ยังไม่มีประวัติจริง', time: '—' }]).forEach(activity => {
        const item = document.createElement('li');
        const dot = document.createElement('i');
        const label = document.createElement('span');
        const time = document.createElement('time');
        label.textContent = activity.text;
        time.textContent = activity.time;
        item.append(dot, label, time);
        list.append(item);
      });
    }
  }

  async function loadRuntimeData({ quiet = false } = {}) {
    const entries = Object.entries(RUNTIME_FILES);
    const results = await Promise.allSettled(entries.map(([, url]) => fetchJson(url)));
    const errors = [];
    results.forEach((result, index) => {
      const key = entries[index][0];
      if (result.status === 'fulfilled') appState[key] = result.value;
      else errors.push(key);
    });
    const timeframes = appState.market?.timeframes || {};
    appState.rows = timeframes.M15 || timeframes.M5 || timeframes.M1 || timeframes.H1 || [];
    appState.loadedAt = Date.now();
    renderMarket();
    renderIntel();
    renderAiDecision();
    renderHistory();
    if (errors.length && !quiet) showToast(`โหลดไม่ได้บางส่วน: ${errors.join(', ')} · ใช้ข้อมูลที่มีอยู่`);
    return { errors, score: appState.score };
  }

  async function runShadowScan() {
    if (appState.scanning) return;
    appState.scanning = true;
    const button = $('#scanButton');
    const card = $('.hero-card');
    button?.classList.add('scanning');
    card?.classList.add('scanning');
    if (button) button.disabled = true;
    showToast('กำลังโหลด Feed, ML Brain, Governance, Outcome และ Risk Plan จริง…', 2100);
    setCoreScore(0);

    let target = 0;
    try {
      const result = await loadRuntimeData();
      target = result.score;
      setCoreScore(0);
      let value = 0;
      await new Promise(resolve => {
        const timer = window.setInterval(() => {
          value += Math.max(1, Math.ceil((target - value) * .2));
          setCoreScore(Math.min(value, target));
          if (value >= target) {
            window.clearInterval(timer);
            resolve();
          }
        }, 45);
      });
    } finally {
      button?.classList.remove('scanning');
      card?.classList.remove('scanning');
      if (button) button.disabled = false;
      appState.scanning = false;
    }
    setScreen('positions');
    showToast(appState.decision?.actionable
      ? `Scan complete · ${appState.candidate.side} ผ่านทุก Gate`
      : `Scan complete · AI WAIT · Entry/SL/TP แสดงเป็น Reference เท่านั้น`, 3300);
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
    $('#positionScanButton')?.addEventListener('click', runShadowScan);
    $('#notificationButton')?.addEventListener('click', () => toggleNotifications());
    $('#closeNotifications')?.addEventListener('click', () => toggleNotifications(false));
    $('#capitalPlanForm')?.addEventListener('submit', saveCapitalPlan);
    $('#sessionResultForm')?.addEventListener('submit', saveSessionResult);
    $('#capitalInput')?.addEventListener('input', previewPlanInputs);
    $('#profitTargetInput')?.addEventListener('input', previewPlanInputs);
    $('#planStageList')?.addEventListener('click', event => {
      const stage = event.target.closest('[data-plan-day]');
      if (!stage || !validPlan(appState.plan)) return;
      const day = appState.plan.days[Number(stage.dataset.planDay) - 1];
      showToast(`Day ${day.day}: ${money(day.start)} → ${money(day.expected)} · Max loss ${money(day.maxLoss)}`);
    });

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

    window.addEventListener('storage', event => {
      if (event.key === PLAN_KEY) {
        loadPlan();
        syncPlanInputs();
        previewPlanInputs();
        renderPlan();
        renderAiDecision();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - appState.loadedAt > 5 * 60000) loadRuntimeData({ quiet: true });
    });

    document.addEventListener('pointerdown', event => {
      const panel = $('#notificationPanel');
      if (panel?.classList.contains('open') && !panel.contains(event.target) && !$('#notificationButton')?.contains(event.target)) toggleNotifications(false);
    });
  }

  function boot() {
    bindInteractions();
    updateClock();
    window.setInterval(updateClock, 30000);
    loadPlan();
    syncPlanInputs();
    previewPlanInputs();
    renderPlan();
    let initial = window.location.hash.slice(1);
    if (!validScreens.has(initial)) initial = safeRead(SCREEN_KEY) || 'overview';
    setScreen(validScreens.has(initial) ? initial : 'overview', false);
    loadRuntimeData().catch(error => {
      console.warn('[KAGE CORE] Runtime load failed:', error);
      setText('#feedStatus', 'runtime unavailable');
      showToast('โหลด AI Runtime ไม่สำเร็จ กรุณากด RUN SHADOW SCAN อีกครั้ง');
    });

    window.KageCoreV40 = {
      refresh: runShadowScan,
      snapshot: () => ({
        screen: appState.screen,
        score: appState.score,
        candidate: appState.candidate ? { ...appState.candidate } : null,
        decision: appState.decision ? { ...appState.decision, candidate: undefined } : null,
        plan: validPlan(appState.plan) ? { start: appState.plan.start, target: appState.plan.target, completed: completedSessions() } : null
      })
    };

    // V40 is preserved as a preview page only. The production V39 runtime owns
    // the root service worker, so this preview must never replace that registration.
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
