import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.cwd());
const TWELVE_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const FALLBACK_URL = (process.env.TV_FALLBACK_URL || '').replace(/\/$/, '');
const FALLBACK_TOKEN = process.env.TV_FALLBACK_TOKEN || '';

const VERSION = 'V42';
const SYMBOL = 'XAU/USD';
const DAY = 86_400_000;
const MINUTE = 60_000;
const PRIMARY_RETENTION = { M1: 30, M5: 90, M15: 180, H1: 365 };
const FALLBACK_RETENTION = { M1: 14, M5: 45, M15: 90, H1: 180 };
const ACTIVE_RETENTION = { M1: 7, M5: 45, M15: 120, H1: 240 };
const PRIMARY_STALE_OPEN_MS = 20 * MINUTE;
const FALLBACK_STALE_OPEN_MS = 4 * MINUTE;
const CLOSED_SESSION_MAX_MS = 72 * 60 * MINUTE;
const PRIMARY_RECOVERY_REQUIRED = 2;
const CLOSED_BAR_SAFETY_MS = 5_000;

function nowIso(){ return new Date().toISOString(); }
function safeMsg(err){ return String(err?.message || err || 'unknown error').slice(0,260); }
function latestTs(rows=[]){ return rows.length ? Number(rows.at(-1)?.ts) || 0 : 0; }
function ageMs(ts){ return ts ? Math.max(0, Date.now() - ts) : Infinity; }

export function normalizeCandle(v){
  const rawTime = String(v?.datetime || v?.time || '');
  const parsedTime = rawTime
    ? Date.parse(rawTime.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(rawTime) ? '' : 'Z'))
    : 0;
  const tsRaw = Number(v?.ts) || parsedTime || 0;
  const ts = tsRaw > 0 && tsRaw < 10_000_000_000 ? tsRaw * 1000 : tsRaw;
  const open=Number(v?.open), high=Number(v?.high), low=Number(v?.low), close=Number(v?.close);
  if(!ts || ![open,high,low,close].every(Number.isFinite)) return null;
  if(open<=0 || high<=0 || low<=0 || close<=0) return null;
  if(high < Math.max(open,close) || low > Math.min(open,close) || high < low) return null;
  const minuteTs = Math.trunc(ts/MINUTE)*MINUTE;
  return { ts:minuteTs, datetime:new Date(minuteTs).toISOString().replace('T',' ').slice(0,19), open,high,low,close };
}

export function dedupeSort(rows=[]){
  const m=new Map();
  for(const raw of rows){ const c=normalizeCandle(raw); if(c) m.set(c.ts,c); }
  return [...m.values()].sort((a,b)=>a.ts-b.ts);
}

export function rollHistory(oldRows=[], newRows=[], days=7){
  const m=new Map();
  for(const raw of oldRows){ const c=normalizeCandle(raw); if(c) m.set(c.ts,c); }
  for(const raw of newRows){ const c=normalizeCandle(raw); if(c) m.set(c.ts,c); }
  const rows=[...m.values()].sort((a,b)=>a.ts-b.ts);
  if(!rows.length) return [];
  const cut=rows.at(-1).ts-days*DAY;
  return rows.filter(x=>x.ts>=cut);
}

export function closedBars(rows=[], timeframeMs=MINUTE, watermarkMs=Date.now()-CLOSED_BAR_SAFETY_MS){
  const tf=Math.max(MINUTE,Number(timeframeMs)||MINUTE);
  const watermark=Number(watermarkMs);
  if(!Number.isFinite(watermark)) return [];
  return dedupeSort(rows).filter(c=>c.ts+tf<=watermark);
}

export function aggregate(rows,bucketMs,closedThroughMs=Infinity){
  const b=new Map();
  for(const c of dedupeSort(rows)){
    const ts=Math.floor(c.ts/bucketMs)*bucketMs;
    const p=b.get(ts);
    if(!p){
      b.set(ts,{ts,datetime:new Date(ts).toISOString().replace('T',' ').slice(0,19),open:c.open,high:c.high,low:c.low,close:c.close});
    }else{
      p.high=Math.max(p.high,c.high); p.low=Math.min(p.low,c.low); p.close=c.close;
    }
  }
  const watermark=Number(closedThroughMs);
  return [...b.values()]
    .filter(c=>!Number.isFinite(watermark)||c.ts+bucketMs<=watermark)
    .sort((a,b)=>a.ts-b.ts);
}

export function likelyFxOpen(date=new Date()){
  // Spot FX/gold session boundary tracks 17:00 New York, which moves with DST.
  // Hard-coding UTC hours makes the feed gate wrong by one hour for part of the year.
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const day=parts.weekday,h=Number(parts.hour),min=Number(parts.minute),mins=h*60+min;
  if(day==='Sat')return false;
  if(day==='Sun')return mins>=17*60;
  if(day==='Fri')return mins<17*60;
  return true;
}

function responseRateInfo(r){
  const names=['api-credits-used','api-credits-left','x-api-credits-used','x-ratelimit-remaining','x-ratelimit-limit','ratelimit-remaining','ratelimit-limit'];
  const out={}; for(const n of names){ const v=r.headers.get(n); if(v!=null) out[n]=v; } return out;
}

async function fetchTwelveM1(){
  if(!TWELVE_API_KEY) throw new Error('TWELVE_DATA_API_KEY is not configured');
  const u=new URL('https://api.twelvedata.com/time_series');
  u.searchParams.set('symbol',SYMBOL); u.searchParams.set('interval','1min');
  u.searchParams.set('outputsize','5000'); u.searchParams.set('timezone','UTC'); u.searchParams.set('apikey',TWELVE_API_KEY);
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),12_000);
  try{
    const r=await fetch(u,{signal:ctrl.signal}); const text=await r.text(); let j;
    try{ j=JSON.parse(text); }catch{ throw new Error(`Twelve Data invalid JSON (${r.status})`); }
    if(!r.ok || j?.status==='error' || !Array.isArray(j?.values)){
      const e=new Error(j?.message || `Twelve Data HTTP ${r.status}`); e.httpStatus=r.status; e.rateInfo=responseRateInfo(r); throw e;
    }
    const received=dedupeSort(j.values.slice().reverse());
    const watermark=Date.now()-CLOSED_BAR_SAFETY_MS;
    const rows=closedBars(received,MINUTE,watermark);
    if(!rows.length) throw new Error('Twelve Data returned no closed M1 candles');
    return {rows,meta:{status:'ONLINE',httpStatus:r.status,latestTs:latestTs(rows),ageMs:ageMs(latestTs(rows)),closedBarWatermark:watermark,droppedOpenBars:received.length-rows.length,credits:responseRateInfo(r),fetchedAt:nowIso()}};
  }finally{ clearTimeout(timer); }
}

async function fetchMt5Fallback(limit=10_000){
  if(!FALLBACK_URL) throw new Error('TV_FALLBACK_URL is not configured');
  const u=new URL(FALLBACK_URL+'/feed'); u.searchParams.set('limit',String(Math.min(10_000,Math.max(1000,limit))));
  const headers={Accept:'application/json'}; if(FALLBACK_TOKEN) headers.Authorization=`Bearer ${FALLBACK_TOKEN}`;
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),8_000);
  try{
    const r=await fetch(u,{headers,signal:ctrl.signal,cache:'no-store'}); const text=await r.text(); let j;
    try{ j=JSON.parse(text); }catch{ throw new Error(`MT5 fallback invalid JSON (${r.status})`); }
    if(!r.ok || j?.status==='error') throw new Error(j?.message || `MT5 fallback HTTP ${r.status}`);
    const received=dedupeSort(j?.timeframes?.M1 || j?.bars || []);
    const watermark=Date.now()-CLOSED_BAR_SAFETY_MS;
    const rows=closedBars(received,MINUTE,watermark);
    if(!rows.length) throw new Error('MT5 fallback returned no closed M1 bars');
    return {rows,meta:{status:'ONLINE',httpStatus:r.status,latestTs:latestTs(rows),ageMs:ageMs(latestTs(rows)),count:rows.length,closedBarWatermark:watermark,droppedOpenBars:received.length-rows.length,fetchedAt:nowIso()}};
  }finally{ clearTimeout(timer); }
}

async function readJson(name,fallback={}){ try{return JSON.parse(await fs.readFile(path.join(ROOT,name),'utf8'));}catch{return fallback;} }

export function sourcePackFromM1(previousSourcePack, rows, source, feedMeta, retention){
  const prev=previousSourcePack?.timeframes || {};
  const r=retention || ACTIVE_RETENTION;
  const incoming=dedupeSort(rows);
  const closedThrough=latestTs(incoming)+MINUTE;
  const m1=closedBars(rollHistory(prev.M1||[],incoming,r.M1),MINUTE,closedThrough);
  const a5=aggregate(m1,5*MINUTE,closedThrough), a15=aggregate(m1,15*MINUTE,closedThrough), a60=aggregate(m1,60*MINUTE,closedThrough);
  const tf={
    M1:m1,
    M5:rollHistory(closedBars(prev.M5||[],5*MINUTE,closedThrough),a5,r.M5),
    M15:rollHistory(closedBars(prev.M15||[],15*MINUTE,closedThrough),a15,r.M15),
    H1:rollHistory(closedBars(prev.H1||[],60*MINUTE,closedThrough),a60,r.H1),
  };
  const coverageDays=Object.fromEntries(Object.entries(tf).map(([k,a])=>[k,a.length>1?Number(((a.at(-1).ts-a[0].ts)/DAY).toFixed(1)):0]));
  return {generatedAt:nowIso(),source,symbol:SYMBOL,retentionDays:r,coverageDays,closedBarWatermark:closedThrough,feed:{...feedMeta,closedBarWatermark:closedThrough},timeframes:tf};
}

async function fetchNews(){
  const keys=['non farm','nonfarm','payroll','cpi','consumer price','pce','fed','fomc','powell','gdp','jobless','jolts','ppi','producer price','retail sales','ism','adp','employment','unemployment','interest rate'];
  let events=[];
  try{
    const r=await fetch('https://api.tradingeconomics.com/calendar/country/united%20states?c=guest:guest&importance=2');
    if(r.ok){
      const raw=await r.json(); events=(Array.isArray(raw)?raw:[]).filter(e=>{const s=((e.Event||'')+' '+(e.Category||'')).toLowerCase();return keys.some(k=>s.includes(k));}).map(e=>({date:e.Date,event:e.Event||'US Event',importance:Number(e.Importance||2),actual:e.Actual??null,forecast:e.Forecast??null,previous:e.Previous??null}));
    }
  }catch(e){ console.warn('News skipped:',safeMsg(e)); }
  return {generatedAt:nowIso(),source:'Trading Economics guest feed via GitHub Actions',events};
}

export async function main(){
const previousActive=await readJson('xauusd.json',{timeframes:{},feed:{}});
const previousPrimary=await readJson('xauusd-primary.json',{timeframes:{},feed:{}});
const previousFallback=await readJson('xauusd-fallback.json',{timeframes:{},feed:{}});
const previousHealth=await readJson('feed-health.json',previousActive?.feed||{});
const marketOpen=likelyFxOpen();
const prevActiveName=String(previousHealth?.active||previousActive?.feed?.active||'').toUpperCase();
let recoveryStreak=Number(previousHealth?.switching?.primaryRecoveryStreak||0); if(!Number.isFinite(recoveryStreak)||recoveryStreak<0) recoveryStreak=0;

let primary={checked:true,ok:false,fresh:false,rows:[],meta:{status:'OFFLINE'},error:null};
try{
  const p=await fetchTwelveM1(); primary.ok=true; primary.rows=p.rows; primary.meta=p.meta;
  primary.fresh=marketOpen?p.meta.ageMs<=PRIMARY_STALE_OPEN_MS:p.meta.ageMs<=CLOSED_SESSION_MAX_MS;
  primary.meta.status=primary.fresh?'ONLINE':'STALE';
}catch(err){ primary.error=safeMsg(err); primary.meta={status:'OFFLINE',httpStatus:err?.httpStatus||null,credits:err?.rateInfo||{},fetchedAt:nowIso()}; }

let fallback={checked:false,ok:false,fresh:false,rows:[],meta:{status:FALLBACK_URL?'STANDBY':'NOT_CONFIGURED'},error:null};
async function checkFallback(){
  fallback.checked=true;
  try{
    const f=await fetchMt5Fallback(); fallback.ok=true; fallback.rows=f.rows; fallback.meta=f.meta;
    fallback.fresh=marketOpen?f.meta.ageMs<=FALLBACK_STALE_OPEN_MS:f.meta.ageMs<=CLOSED_SESSION_MAX_MS;
    fallback.meta.status=fallback.fresh?'ONLINE':'STALE';
  }catch(err){ fallback.error=safeMsg(err); fallback.meta={status:FALLBACK_URL?'OFFLINE':'NOT_CONFIGURED',fetchedAt:nowIso()}; }
}

const wasOnFallback=prevActiveName.includes('MT5') || String(previousHealth?.mode||'').toUpperCase().includes('FALLBACK') || String(previousHealth?.mode||'').toUpperCase().includes('RECOVERY');
let active='LAST_VALID',mode=marketOpen?'HOLD':'LAST_SESSION',reason='No active source; preserving last valid pack';
let selectedRows=[],selectedKind=null;

if(marketOpen){
  if(primary.fresh){
    // PRIMARY source pack is updated even while recovery guard keeps live mode on MT5.
    if(wasOnFallback){
      recoveryStreak+=1;
      if(recoveryStreak>=PRIMARY_RECOVERY_REQUIRED){
        active='TWELVE_DATA'; mode='PRIMARY'; selectedRows=primary.rows; selectedKind='PRIMARY';
        reason=`Twelve Data recovered ${recoveryStreak}/${PRIMARY_RECOVERY_REQUIRED}; switched back to PRIMARY`;
        recoveryStreak=PRIMARY_RECOVERY_REQUIRED;
      }else{
        await checkFallback();
        if(fallback.fresh){
          active='MT5_FALLBACK'; mode='PRIMARY_RECOVERY'; selectedRows=fallback.rows; selectedKind='FALLBACK';
          reason=`Twelve healthy ${recoveryStreak}/${PRIMARY_RECOVERY_REQUIRED}; staying on MT5 until second confirmation`;
        }else{
          active='TWELVE_DATA'; mode='PRIMARY'; selectedRows=primary.rows; selectedKind='PRIMARY';
          reason='Twelve recovered and fallback unavailable; switched back to PRIMARY'; recoveryStreak=PRIMARY_RECOVERY_REQUIRED;
        }
      }
    }else{
      active='TWELVE_DATA'; mode='PRIMARY'; selectedRows=primary.rows; selectedKind='PRIMARY';
      reason='Twelve Data healthy; MT5 remains standby'; recoveryStreak=PRIMARY_RECOVERY_REQUIRED;
    }
  }else{
    recoveryStreak=0; await checkFallback();
    if(fallback.fresh){ active='MT5_FALLBACK'; mode='FALLBACK'; selectedRows=fallback.rows; selectedKind='FALLBACK'; reason=`Twelve ${primary.meta?.httpStatus===429?'rate limited':primary.ok?'stale':'unavailable'}; switched to isolated MT5 fallback`; }
    else{ active='LAST_VALID'; mode='HOLD'; reason='Both PRIMARY and FALLBACK unavailable/stale; no new live plan'; }
  }
}else{
  if(primary.ok && primary.meta.ageMs<=CLOSED_SESSION_MAX_MS){ active='TWELVE_DATA';mode='LAST_SESSION';selectedRows=primary.rows;selectedKind='PRIMARY';reason='Market closed; Twelve last session';recoveryStreak=PRIMARY_RECOVERY_REQUIRED; }
  else{ await checkFallback(); if(fallback.ok && fallback.meta.ageMs<=CLOSED_SESSION_MAX_MS){active='MT5_FALLBACK';mode='LAST_SESSION';selectedRows=fallback.rows;selectedKind='FALLBACK';reason='Market closed; MT5 last session';} else{reason='Market closed; preserving last valid pack';} }
}

const primaryFeedMeta={provider:'Twelve Data',configured:Boolean(TWELVE_API_KEY),checked:true,ok:primary.ok,fresh:primary.fresh,...primary.meta,error:primary.error};
const fallbackFeedMeta={provider:'MT5 -> Cloudflare Worker/D1',configured:Boolean(FALLBACK_URL),checked:fallback.checked,ok:fallback.ok,fresh:fallback.fresh,publicFeedUrl:FALLBACK_URL?`${FALLBACK_URL}/public-feed`:null,...fallback.meta,error:fallback.error};

// Maintain isolated histories. They are NEVER price-averaged or cross-filled.
let primaryPack=previousPrimary;
if(primary.ok && primary.rows.length){
  primaryPack=sourcePackFromM1(previousPrimary,primary.rows,'Twelve Data PRIMARY isolated history',{version:VERSION,active:'TWELVE_DATA',mode:'PRIMARY_HISTORY',status:primary.fresh?'LIVE':'STALE',marketLikelyOpen:marketOpen,primary:primaryFeedMeta,switching:{policy:'PRIMARY_ISOLATED',mergeFeeds:false}},PRIMARY_RETENTION);
  await fs.writeFile(path.join(ROOT,'xauusd-primary.json'),JSON.stringify(primaryPack));
}

let fallbackPack=previousFallback;
if(fallback.checked && fallback.ok && fallback.rows.length){
  fallbackPack=sourcePackFromM1(previousFallback,fallback.rows,'MT5 FALLBACK isolated history',{version:VERSION,active:'MT5_FALLBACK',mode:'FALLBACK_HISTORY',status:fallback.fresh?'LIVE':'STALE',marketLikelyOpen:marketOpen,fallback:fallbackFeedMeta,switching:{policy:'FALLBACK_ISOLATED',mergeFeeds:false}},FALLBACK_RETENTION);
  await fs.writeFile(path.join(ROOT,'xauusd-fallback.json'),JSON.stringify(fallbackPack));
}

function activeView(sourcePack, sourceLabel){
  const tf=sourcePack?.timeframes||{};
  const watermark=Number(sourcePack?.closedBarWatermark||sourcePack?.feed?.closedBarWatermark||0);
  const widths={M1:MINUTE,M5:5*MINUTE,M15:15*MINUTE,H1:60*MINUTE};
  const out={};
  for(const k of ['M1','M5','M15','H1']){
    const rows=rollHistory([],tf[k]||[],ACTIVE_RETENTION[k]);
    out[k]=watermark>0?closedBars(rows,widths[k],watermark):rows;
  }
  return {generatedAt:nowIso(),source:sourceLabel,symbol:SYMBOL,retentionDays:ACTIVE_RETENTION,closedBarWatermark:watermark||null,timeframes:out};
}

let activePack=previousActive;
if(selectedKind==='PRIMARY'){
  const src=primaryPack?.timeframes?.M1?.length?primaryPack:sourcePackFromM1({},selectedRows,'Twelve Data PRIMARY',{},PRIMARY_RETENTION);
  activePack=activeView(src,'Twelve Data PRIMARY isolated feed');
}else if(selectedKind==='FALLBACK'){
  const src=fallbackPack?.timeframes?.M1?.length?fallbackPack:sourcePackFromM1({},selectedRows,'MT5 FALLBACK',{},FALLBACK_RETENTION);
  activePack=activeView(src,'MT5 FALLBACK isolated feed');
}else if(!activePack?.timeframes?.M1?.length){
  throw new Error('No last-valid XAUUSD pack exists and both feeds are unavailable');
}

const preSanitizeLatest=latestTs(activePack?.timeframes?.M1||[]);
const activeWatermark=Number(activePack?.closedBarWatermark||activePack?.feed?.closedBarWatermark||(preSanitizeLatest?preSanitizeLatest+MINUTE:0));
if(activeWatermark>0){
  const widths={M1:MINUTE,M5:5*MINUTE,M15:15*MINUTE,H1:60*MINUTE};
  activePack={...activePack,closedBarWatermark:activeWatermark,timeframes:Object.fromEntries(
    ['M1','M5','M15','H1'].map(tf=>[tf,closedBars(activePack?.timeframes?.[tf]||[],widths[tf],activeWatermark)])
  )};
}
const activeLatest=latestTs(activePack?.timeframes?.M1||[]),liveAge=ageMs(activeLatest);
let overallStatus=!marketOpen?(liveAge<=CLOSED_SESSION_MAX_MS?'LAST_SESSION':'STALE'):(mode==='PRIMARY'&&liveAge<=PRIMARY_STALE_OPEN_MS?'LIVE':((mode==='FALLBACK'||mode==='PRIMARY_RECOVERY')&&liveAge<=FALLBACK_STALE_OPEN_MS?'FALLBACK_ACTIVE':'HOLD'));
const health={
  version:VERSION,generatedAt:nowIso(),symbol:SYMBOL,marketLikelyOpen:marketOpen,active,mode,status:overallStatus,reason,
  latestM1Ts:activeLatest,latestM1AgeMs:liveAge,closedBarWatermark:activeWatermark||null,
  primary:primaryFeedMeta,fallback:fallbackFeedMeta,
  switching:{policy:'PRIMARY_ONLY_THEN_ISOLATED_FAILOVER',mergeFeeds:false,primaryRecoveryStreak:recoveryStreak,primaryRecoveryRequired:PRIMARY_RECOVERY_REQUIRED,note:'Only one live feed is selected. Primary and fallback histories are stored separately. No price averaging or simultaneous source merge.'},
  isolation:{primaryFile:'xauusd-primary.json',fallbackFile:'xauusd-fallback.json',activeFile:'xauusd.json',trainingRecommendation:'Train ML on PRIMARY file; score current ACTIVE file.'},
  efficiency:{twelveRequestsThisRun:1,fallbackRequestsThisRun:fallback.checked?1:0,strategy:'Twelve M1 PRIMARY. MT5 queried only during failure/recovery/closed-session fallback.',primaryTrainingRetentionDays:PRIMARY_RETENTION,activeAppRetentionDays:ACTIVE_RETENTION},
};

activePack={...activePack,generatedAt:nowIso(),source:selectedKind==='PRIMARY'?'Twelve Data PRIMARY isolated feed':selectedKind==='FALLBACK'?'MT5 FALLBACK isolated feed':'Last valid isolated feed pack',feed:health};
await fs.writeFile(path.join(ROOT,'xauusd.json'),JSON.stringify(activePack));
await fs.writeFile(path.join(ROOT,'feed-health.json'),JSON.stringify(health,null,2));
await fs.writeFile(path.join(ROOT,'news.json'),JSON.stringify(await fetchNews()));

console.log('V42 STRICT PRIMARY -> ISOLATED FAILOVER',{active,mode,status:overallStatus,reason,closedBarWatermark:activeWatermark||null,primary:{ok:primary.ok,fresh:primary.fresh,error:primary.error},fallback:{checked:fallback.checked,ok:fallback.ok,fresh:fallback.fresh,error:fallback.error},mergeFeeds:false,activeCandles:Object.fromEntries(Object.entries(activePack.timeframes||{}).map(([k,a])=>[k,a.length])),primaryCandles:Object.fromEntries(Object.entries(primaryPack?.timeframes||{}).map(([k,a])=>[k,a.length])),fallbackCandles:Object.fromEntries(Object.entries(fallbackPack?.timeframes||{}).map(([k,a])=>[k,a.length]))});
}

const invokedPath=process.argv[1]?path.resolve(process.argv[1]):'';
if(invokedPath&&invokedPath===path.resolve(fileURLToPath(import.meta.url))){
  await main();
}
