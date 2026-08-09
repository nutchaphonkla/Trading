import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.cwd());
const TWELVE_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const FALLBACK_URL = (process.env.TV_FALLBACK_URL || '').replace(/\/$/, '');
const FALLBACK_TOKEN = process.env.TV_FALLBACK_TOKEN || '';

const VERSION = 'V44';
const SYMBOL = 'XAU/USD';
const DAY = 86_400_000;
const MINUTE = 60_000;
const PRIMARY_RETENTION = { M1: 30, M5: 90, M15: 180, H1: 365 };
const MT5_RETENTION = { M1: 180, M5: 240, M15: 365, H1: 730 };
const ACTIVE_RETENTION = { M1: 7, M5: 45, M15: 120, H1: 240 };
const PRIMARY_STALE_OPEN_MS = 20 * MINUTE;
const MT5_STALE_OPEN_MS = 4 * MINUTE;
const MT5_HEARTBEAT_MAX_MS = 3 * MINUTE;
const CLOSED_SESSION_MAX_MS = 72 * 60 * MINUTE;
const CLOSED_BAR_SAFETY_MS = 5_000;
const MT5_LATEST_LIMIT = 10_000;
const MT5_HISTORY_PAGE = 5_000;
const MT5_BACKFILL_PAGES_PER_RUN = 3;

function nowIso(){ return new Date().toISOString(); }
function safeMsg(err){ return String(err?.message || err || 'unknown error').slice(0, 260); }
function latestTs(rows=[]){ return rows.length ? Number(rows.at(-1)?.ts) || 0 : 0; }
function oldestTs(rows=[]){ return rows.length ? Number(rows[0]?.ts) || 0 : 0; }
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
      b.set(ts,{ts,datetime:new Date(ts).toISOString().replace('T',' ').slice(0,19),open:c.open,high:c.high,low:c.low,close:c.close,count:1});
    }else{
      p.high=Math.max(p.high,c.high); p.low=Math.min(p.low,c.low); p.close=c.close; p.count++;
    }
  }
  const watermark=Number(closedThroughMs);
  const required=Math.max(1,Math.round(bucketMs/MINUTE));
  return [...b.values()]
    .filter(c=>(!Number.isFinite(watermark)||c.ts+bucketMs<=watermark) && c.count>=required)
    .map(({count,...c})=>c)
    .sort((a,b)=>a.ts-b.ts);
}

export function likelyFxOpen(date=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const day=parts.weekday,h=Number(parts.hour),min=Number(parts.minute),mins=h*60+min;
  if(day==='Sat')return false;
  if(day==='Sun')return mins>=17*60;
  if(day==='Fri')return mins<17*60;
  return true;
}

export function chooseAutoSource({marketOpen=true,mt5Connected=false,mt5Fresh=false,twelveFresh=false,twelveUsable=false,mt5Usable=false}={}){
  // V44 policy: MT5 is preferred while the bridge heartbeat is alive. Twelve Data is ECO fallback.
  if(mt5Connected && (mt5Fresh || (!marketOpen && mt5Usable))) return {kind:'MT5',mode:marketOpen?'MT5_HEAVY':'MT5_LAST_SESSION'};
  if(twelveFresh || (!marketOpen && twelveUsable)) return {kind:'TWELVE',mode:marketOpen?'API_ECO':'API_LAST_SESSION'};
  if(mt5Usable && !marketOpen) return {kind:'MT5',mode:'MT5_LAST_SESSION'};
  return {kind:'LAST_VALID',mode:marketOpen?'HOLD':'LAST_SESSION'};
}

function responseRateInfo(r){
  const names=['api-credits-used','api-credits-left','x-api-credits-used','x-ratelimit-remaining','x-ratelimit-limit','ratelimit-remaining','ratelimit-limit'];
  const out={}; for(const n of names){ const v=r.headers.get(n); if(v!=null) out[n]=v; } return out;
}

async function fetchJson(url,{headers={},timeout=10_000}={}){
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout);
  try{
    const r=await fetch(url,{headers,signal:ctrl.signal,cache:'no-store'});
    const text=await r.text(); let j;
    try{j=JSON.parse(text);}catch{throw new Error(`Invalid JSON (${r.status})`);}
    if(!r.ok || j?.status==='error') throw new Error(j?.message || `HTTP ${r.status}`);
    return {response:r,json:j};
  }finally{clearTimeout(timer);}
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

function mt5Headers(){
  const headers={Accept:'application/json'};
  if(FALLBACK_TOKEN) headers.Authorization=`Bearer ${FALLBACK_TOKEN}`;
  return headers;
}

async function probeMt5(){
  if(!FALLBACK_URL) throw new Error('TV_FALLBACK_URL is not configured');
  const {json:j}=await fetchJson(new URL(FALLBACK_URL+'/health'),{headers:mt5Headers(),timeout:8_000});
  const latest=j?.latest||{};
  const receiveAgeMs=Number(latest.receiveAgeMs);
  const candleAgeMs=Number(latest.candleAgeMs);
  const connected=j?.status==='ok' && Number.isFinite(receiveAgeMs) && receiveAgeMs<=MT5_HEARTBEAT_MAX_MS;
  return {
    connected,
    status:j?.status||'UNKNOWN',
    bars:Number(j?.bars||0),
    receiveAgeMs:Number.isFinite(receiveAgeMs)?receiveAgeMs:null,
    candleAgeMs:Number.isFinite(candleAgeMs)?candleAgeMs:null,
    latestTs:Number(latest.ts)||0,
    checkedAt:nowIso(),
  };
}

async function fetchMt5Latest(limit=MT5_LATEST_LIMIT){
  if(!FALLBACK_URL) throw new Error('TV_FALLBACK_URL is not configured');
  const u=new URL(FALLBACK_URL+'/feed'); u.searchParams.set('limit',String(Math.min(10_000,Math.max(1000,limit))));
  const {response:r,json:j}=await fetchJson(u,{headers:mt5Headers(),timeout:12_000});
  const received=dedupeSort(j?.timeframes?.M1 || j?.bars || []);
  const watermark=Date.now()-CLOSED_BAR_SAFETY_MS;
  const rows=closedBars(received,MINUTE,watermark);
  if(!rows.length) throw new Error('MT5 bridge returned no closed M1 bars');
  return {rows,meta:{status:'ONLINE',httpStatus:r.status,latestTs:latestTs(rows),ageMs:ageMs(latestTs(rows)),count:rows.length,closedBarWatermark:watermark,droppedOpenBars:received.length-rows.length,fetchedAt:nowIso()}};
}

async function fetchMt5History(beforeTs,limit=MT5_HISTORY_PAGE){
  if(!FALLBACK_URL || !(Number(beforeTs)>0)) return [];
  const u=new URL(FALLBACK_URL+'/history');
  u.searchParams.set('before',String(Math.trunc(Number(beforeTs))));
  u.searchParams.set('limit',String(Math.min(5_000,Math.max(500,limit))));
  const {json:j}=await fetchJson(u,{headers:mt5Headers(),timeout:12_000});
  return closedBars(dedupeSort(j?.timeframes?.M1 || j?.bars || []),MINUTE,Date.now()-CLOSED_BAR_SAFETY_MS);
}

async function readJson(name,fallback={}){ try{return JSON.parse(await fs.readFile(path.join(ROOT,name),'utf8'));}catch{return fallback;} }
async function writeJson(name,value){ await fs.writeFile(path.join(ROOT,name),JSON.stringify(value,null,2)); }

export function sourcePackFromM1(previousSourcePack, rows, source, feedMeta, retention){
  const prev=previousSourcePack?.timeframes || {};
  const r=retention || ACTIVE_RETENTION;
  const incoming=dedupeSort(rows);
  const closedThrough=latestTs(incoming)+MINUTE;
  const previousWatermark=Number(previousSourcePack?.closedBarWatermark||previousSourcePack?.feed?.closedBarWatermark||0);
  const watermark=Math.max(closedThrough||0,previousWatermark||0);
  const m1=closedBars(rollHistory(prev.M1||[],incoming,r.M1),MINUTE,watermark);
  const a5=aggregate(m1,5*MINUTE,watermark), a15=aggregate(m1,15*MINUTE,watermark), a60=aggregate(m1,60*MINUTE,watermark);
  const tf={
    M1:m1,
    M5:rollHistory(closedBars(prev.M5||[],5*MINUTE,watermark),a5,r.M5),
    M15:rollHistory(closedBars(prev.M15||[],15*MINUTE,watermark),a15,r.M15),
    H1:rollHistory(closedBars(prev.H1||[],60*MINUTE,watermark),a60,r.H1),
  };
  const coverageDays=Object.fromEntries(Object.entries(tf).map(([k,a])=>[k,a.length>1?Number(((a.at(-1).ts-a[0].ts)/DAY).toFixed(1)):0]));
  return {generatedAt:nowIso(),source,symbol:SYMBOL,retentionDays:r,coverageDays,closedBarWatermark:watermark,feed:{...feedMeta,closedBarWatermark:watermark},timeframes:tf};
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

export function trainingView(sourcePack, trainingFeed){
  if(!sourcePack?.timeframes?.M1?.length) return null;
  const active=trainingFeed==='MT5_ACADEMY'?'MT5_FALLBACK':'TWELVE_DATA';
  const mode=trainingFeed==='MT5_ACADEMY'?'MT5_HEAVY_TRAINING':'API_ECO_TRAINING';
  return {
    ...sourcePack,
    generatedAt:nowIso(),
    source:trainingFeed==='MT5_ACADEMY'?'MT5 ACADEMY single-source training history':'Twelve Data PRIMARY single-source training history',
    feed:{
      ...(sourcePack.feed||{}),
      version:VERSION,
      active,
      mode,
      trainingFeed,
      trainingSource:'xauusd-training.json',
      switching:{policy:'V44_SINGLE_SOURCE_TRAINING_ROUTER',mergeFeeds:false,note:'One training source at a time. Source-specific histories are never merged.'},
    },
  };
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
  const previousTraining=await readJson('xauusd-training.json',{});
  const marketOpen=likelyFxOpen();
  let twelveRequests=0,mt5Requests=0,mt5HistoryPages=0;

  let mt5={checked:false,connected:false,ok:false,fresh:false,rows:[],health:null,meta:{status:FALLBACK_URL?'STANDBY':'NOT_CONFIGURED'},error:null};
  if(FALLBACK_URL){
    mt5.checked=true;
    try{
      mt5Requests++; mt5.health=await probeMt5(); mt5.connected=mt5.health.connected;
      if(mt5.connected){
        mt5Requests++; const f=await fetchMt5Latest(); mt5.ok=true; mt5.rows=f.rows; mt5.meta={...f.meta,heartbeat:mt5.health};
        mt5.fresh=marketOpen?f.meta.ageMs<=MT5_STALE_OPEN_MS:f.meta.ageMs<=CLOSED_SESSION_MAX_MS;
        mt5.meta.status=mt5.fresh?'ONLINE':'STALE';
      }else{
        mt5.meta={status:'OFFLINE',heartbeat:mt5.health,fetchedAt:nowIso()};
      }
    }catch(err){mt5.error=safeMsg(err);mt5.meta={status:'OFFLINE',heartbeat:mt5.health,fetchedAt:nowIso()};}
  }

  let primary={checked:false,ok:false,fresh:false,rows:[],meta:{status:TWELVE_API_KEY?'ECO_STANDBY':'NOT_CONFIGURED'},error:null};
  // API ECO rule: Twelve Data stays idle while MT5 is both connected and usable.
  // If the bridge heartbeat is alive but the live candle becomes stale during an open market,
  // fall back to one Twelve Data request instead of freezing the live app.
  if(!mt5.connected || (marketOpen && !mt5.fresh)){
    primary.checked=true;
    try{
      twelveRequests++; const p=await fetchTwelveM1(); primary.ok=true; primary.rows=p.rows; primary.meta=p.meta;
      primary.fresh=marketOpen?p.meta.ageMs<=PRIMARY_STALE_OPEN_MS:p.meta.ageMs<=CLOSED_SESSION_MAX_MS;
      primary.meta.status=primary.fresh?'ONLINE':'STALE';
    }catch(err){ primary.error=safeMsg(err); primary.meta={status:'OFFLINE',httpStatus:err?.httpStatus||null,credits:err?.rateInfo||{},fetchedAt:nowIso()}; }
  }

  // If Twelve failed, make one last MT5 data attempt even if heartbeat was stale. This preserves the old failover safety path.
  if(!mt5.ok && !primary.fresh && FALLBACK_URL){
    try{
      mt5Requests++; const f=await fetchMt5Latest(); mt5.ok=true; mt5.rows=f.rows; mt5.meta={...f.meta,heartbeat:mt5.health};
      mt5.fresh=marketOpen?f.meta.ageMs<=MT5_STALE_OPEN_MS:f.meta.ageMs<=CLOSED_SESSION_MAX_MS;
      mt5.meta.status=mt5.fresh?'ONLINE':'STALE';
    }catch(err){ if(!mt5.error)mt5.error=safeMsg(err); }
  }

  const primaryFeedMeta={provider:'Twelve Data',configured:Boolean(TWELVE_API_KEY),checked:primary.checked,ok:primary.ok,fresh:primary.fresh,...primary.meta,error:primary.error};
  const mt5FeedMeta={provider:'MT5 -> Cloudflare Worker/D1',configured:Boolean(FALLBACK_URL),checked:mt5.checked,connected:mt5.connected,ok:mt5.ok,fresh:mt5.fresh,publicFeedUrl:FALLBACK_URL?`${FALLBACK_URL}/public-feed`:null,...mt5.meta,error:mt5.error};

  let primaryPack=previousPrimary;
  if(primary.ok&&primary.rows.length){
    primaryPack=sourcePackFromM1(previousPrimary,primary.rows,'Twelve Data PRIMARY isolated history',{version:VERSION,active:'TWELVE_DATA',mode:'PRIMARY_HISTORY',status:primary.fresh?'LIVE':'STALE',marketLikelyOpen:marketOpen,primary:primaryFeedMeta,trainingFeed:'TWELVE_DATA_PRIMARY',switching:{policy:'PRIMARY_ISOLATED',mergeFeeds:false}},PRIMARY_RETENTION);
    await writeJson('xauusd-primary.json',primaryPack);
  }

  let fallbackPack=previousFallback;
  if(mt5.ok&&mt5.rows.length){
    fallbackPack=sourcePackFromM1(previousFallback,mt5.rows,'MT5 isolated academy history',{version:VERSION,active:'MT5_FALLBACK',mode:'MT5_HISTORY',status:mt5.fresh?'LIVE':'STALE',marketLikelyOpen:marketOpen,fallback:mt5FeedMeta,trainingFeed:'MT5_ACADEMY',switching:{policy:'MT5_ISOLATED',mergeFeeds:false}},MT5_RETENTION);

    // Progressive older-history pull. Each run extends the local archive backward without re-downloading the whole archive.
    let before=oldestTs(fallbackPack?.timeframes?.M1||[]);
    if(mt5.connected && before>0){
      for(let page=0;page<MT5_BACKFILL_PAGES_PER_RUN;page++){
        let older=[];
        try{mt5Requests++; older=await fetchMt5History(before,MT5_HISTORY_PAGE);}catch(err){console.warn('MT5 history page skipped:',safeMsg(err));break;}
        if(!older.length)break;
        const nextOldest=oldestTs(older);
        if(!(nextOldest>0) || nextOldest>=before)break;
        mt5HistoryPages++;
        fallbackPack=sourcePackFromM1(fallbackPack,older,'MT5 isolated academy history',{version:VERSION,active:'MT5_FALLBACK',mode:'MT5_HISTORY',status:mt5.fresh?'LIVE':'STALE',marketLikelyOpen:marketOpen,fallback:mt5FeedMeta,trainingFeed:'MT5_ACADEMY',switching:{policy:'MT5_ISOLATED',mergeFeeds:false}},MT5_RETENTION);
        before=nextOldest;
      }
    }
    await writeJson('xauusd-fallback.json',fallbackPack);
  }

  const route=chooseAutoSource({marketOpen,mt5Connected:mt5.connected,mt5Fresh:mt5.fresh,twelveFresh:primary.fresh,twelveUsable:primary.ok&&Number(primary.meta?.ageMs)<=CLOSED_SESSION_MAX_MS,mt5Usable:mt5.ok&&Number(mt5.meta?.ageMs)<=CLOSED_SESSION_MAX_MS});
  let selectedKind=route.kind;
  let mode=route.mode;
  let active='LAST_VALID';
  let reason='No fresh source; preserving last valid isolated pack';
  let sourcePack=null;

  if(selectedKind==='MT5'&&fallbackPack?.timeframes?.M1?.length){
    sourcePack=fallbackPack; active='MT5_FALLBACK';
    reason=marketOpen?'MT5 heartbeat online: HEAVY mode; Twelve Data API skipped':'MT5 heartbeat online: last-session HEAVY archive; Twelve Data API skipped';
  }else if(selectedKind==='TWELVE'&&primaryPack?.timeframes?.M1?.length){
    sourcePack=primaryPack; active='TWELVE_DATA';
    reason=marketOpen?'MT5 offline: switched automatically to Twelve Data API ECO mode':'MT5 offline: Twelve Data API ECO last-session mode';
  }else{
    selectedKind='LAST_VALID'; mode=marketOpen?'HOLD':'LAST_SESSION';
  }

  let activePack=previousActive;
  if(sourcePack){
    activePack=activeView(sourcePack,selectedKind==='MT5'?'MT5 isolated live feed':'Twelve Data PRIMARY isolated feed');
  }else if(!activePack?.timeframes?.M1?.length){
    throw new Error('No last-valid XAUUSD pack exists and both MT5/API sources are unavailable');
  }

  const activeLatest=latestTs(activePack?.timeframes?.M1||[]);
  const activeWatermark=Number(activePack?.closedBarWatermark||activePack?.feed?.closedBarWatermark||(activeLatest?activeLatest+MINUTE:0));
  if(activeWatermark>0){
    const widths={M1:MINUTE,M5:5*MINUTE,M15:15*MINUTE,H1:60*MINUTE};
    activePack={...activePack,closedBarWatermark:activeWatermark,timeframes:Object.fromEntries(['M1','M5','M15','H1'].map(tf=>[tf,closedBars(activePack?.timeframes?.[tf]||[],widths[tf],activeWatermark)]))};
  }
  const liveAge=ageMs(latestTs(activePack?.timeframes?.M1||[]));
  const overallStatus=!marketOpen?(liveAge<=CLOSED_SESSION_MAX_MS?'LAST_SESSION':'STALE'):(mode==='MT5_HEAVY'&&liveAge<=MT5_STALE_OPEN_MS?'LIVE':mode==='API_ECO'&&liveAge<=PRIMARY_STALE_OPEN_MS?'LIVE':'HOLD');

  let trainingPack=previousTraining;
  let trainingFeed=String(previousTraining?.feed?.trainingFeed||'');
  if(selectedKind==='MT5'&&fallbackPack?.timeframes?.M1?.length){
    trainingPack=trainingView(fallbackPack,'MT5_ACADEMY'); trainingFeed='MT5_ACADEMY';
  }else if(selectedKind==='TWELVE'&&primaryPack?.timeframes?.M1?.length){
    trainingPack=trainingView(primaryPack,'TWELVE_DATA_PRIMARY'); trainingFeed='TWELVE_DATA_PRIMARY';
  }
  if(trainingPack?.timeframes?.M1?.length) await writeJson('xauusd-training.json',trainingPack);

  const health={
    version:VERSION,generatedAt:nowIso(),symbol:SYMBOL,marketLikelyOpen:marketOpen,active,mode,status:overallStatus,reason,
    latestM1Ts:latestTs(activePack?.timeframes?.M1||[]),latestM1AgeMs:liveAge,closedBarWatermark:activeWatermark||null,
    primary:primaryFeedMeta,fallback:mt5FeedMeta,
    training:{file:'xauusd-training.json',feed:trainingFeed||null,mode:trainingFeed==='MT5_ACADEMY'?'HEAVY':'ECO',counts:Object.fromEntries(Object.entries(trainingPack?.timeframes||{}).map(([k,a])=>[k,a.length]))},
    switching:{policy:'MT5_FIRST_THEN_TWELVE_API_ECO',mergeFeeds:false,note:'MT5 heartbeat online => MT5 live + heavy historical training and zero Twelve request. MT5 offline => Twelve Data ECO. Histories remain isolated.'},
    isolation:{primaryFile:'xauusd-primary.json',fallbackFile:'xauusd-fallback.json',trainingFile:'xauusd-training.json',activeFile:'xauusd.json',rule:'Exactly one source supplies active/training views at a time. No cross-source candle merge.'},
    efficiency:{twelveRequestsThisRun:twelveRequests,mt5RequestsThisRun:mt5Requests,mt5HistoryPagesThisRun:mt5HistoryPages,strategy:'MT5-first auto router; Twelve Data is credit-saving ECO fallback only.',primaryRetentionDays:PRIMARY_RETENTION,mt5RetentionDays:MT5_RETENTION,activeAppRetentionDays:ACTIVE_RETENTION},
  };

  activePack={...activePack,generatedAt:nowIso(),source:selectedKind==='MT5'?'MT5 isolated live feed':selectedKind==='TWELVE'?'Twelve Data PRIMARY isolated feed':'Last valid isolated feed pack',feed:health};
  await writeJson('xauusd.json',activePack);
  await writeJson('feed-health.json',health);
  await fs.writeFile(path.join(ROOT,'news.json'),JSON.stringify(await fetchNews()));

  console.log('V44 AUTO HYBRID ROUTER',{
    active,mode,status:overallStatus,trainingFeed,reason,mergeFeeds:false,
    requests:{twelve:twelveRequests,mt5:mt5Requests,historyPages:mt5HistoryPages},
    mt5:{connected:mt5.connected,ok:mt5.ok,fresh:mt5.fresh,error:mt5.error},
    twelve:{checked:primary.checked,ok:primary.ok,fresh:primary.fresh,error:primary.error},
    activeCandles:Object.fromEntries(Object.entries(activePack.timeframes||{}).map(([k,a])=>[k,a.length])),
    trainingCandles:Object.fromEntries(Object.entries(trainingPack?.timeframes||{}).map(([k,a])=>[k,a.length])),
  });
}

const invokedPath=process.argv[1]?path.resolve(process.argv[1]):'';
if(invokedPath&&invokedPath===path.resolve(fileURLToPath(import.meta.url))){
  await main();
}
