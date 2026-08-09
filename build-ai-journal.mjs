import fs from 'node:fs';

const PACK='xauusd.json',LEARNING='ai-learning.json',OUTPUT='ai-outcome-journal.json';
const VERSION='1.0',ENGINE='ONEMONTH-BACKGROUND-OUTCOME-JOURNAL-V1';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
function normalize(v){const open=num(v.open),high=num(v.high),low=num(v.low),close=num(v.close);let ts=num(v.ts);if(!Number.isFinite(ts)){const d=String(v.datetime||v.date||'').trim();ts=Date.parse(d.includes('T')?d:d.replace(' ','T')+'Z')}if(!Number.isFinite(ts)||![open,high,low,close].every(Number.isFinite))return null;return{ts,open,high,low,close}}
function clean(a){const x=(a||[]).map(normalize).filter(Boolean).sort((a,b)=>a.ts-b.ts),o=[];let last=-1;for(const c of x){if(c.ts===last)continue;last=c.ts;o.push(c)}return o}
function tr(c){return c.map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-c[i-1].close),Math.abs(x.low-c[i-1].close)):x.high-x.low)}
function wild(v,p=14){const o=new Array(v.length).fill(null);if(v.length<p)return o;let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p;o[p-1]=x;for(let i=p;i<v.length;i++){x=(x*(p-1)+v[i])/p;o[i]=x}return o}
function fingerprint(pack){const t=pack.timeframes||pack.data||pack||{},s=['M1','M5','M15','H1'].map(tf=>{const a=Array.isArray(t[tf])?t[tf]:[],f=a[0]||{},l=a.at(-1)||{};return`${tf}:${a.length}:${f.ts||f.datetime||''}:${f.close||''}:${l.ts||l.datetime||''}:${l.close||''}`}).join('|');let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(16)}
function findAtOrAfter(c,ts){let lo=0,hi=c.length-1,ans=-1;while(lo<=hi){const m=(lo+hi)>>1;if(c[m].ts>=ts){ans=m;hi=m-1}else lo=m+1}return ans>=0?c[ans]:null}
function empty(){return{version:VERSION,engine:ENGINE,updatedAt:null,sourceFingerprint:null,entries:[],summary:{total:0,completed:0,pending:0,verified30m:0,trustedSignals:0,falseSignals:0,hitRate15:null,hitRate30:null,hitRate60:null,avgR30:null,lastDecisionAt:null,updatedAt:null}}}
function summarize(entries){
  const done=(h)=>entries.map(e=>e.horizons?.[h]).filter(x=>x&&x.resolved&&x.correct!==null),rate=h=>{const a=done(h);return a.length?100*a.filter(x=>x.correct).length/a.length:null},h30=done('M30'),trusted=h30.filter(x=>x.correct).length,falseN=h30.filter(x=>!x.correct).length,avg=h30.length?h30.reduce((s,x)=>s+(Number(x.returnR)||0),0)/h30.length:null;
  return{total:entries.length,completed:entries.filter(e=>e.status==='COMPLETE').length,pending:entries.filter(e=>e.status!=='COMPLETE').length,verified30m:h30.length,trustedSignals:trusted,falseSignals:falseN,hitRate15:rate('M15'),hitRate30:rate('M30'),hitRate60:rate('M60'),avgR30:avg,lastDecisionAt:entries.at(-1)?.createdAt||null,updatedAt:new Date().toISOString()};
}
if(!fs.existsSync(PACK)||!fs.existsSync(LEARNING)){console.log('Journal skipped: missing pack/model');process.exit(0)}
const pack=JSON.parse(fs.readFileSync(PACK,'utf8')),learning=JSON.parse(fs.readFileSync(LEARNING,'utf8')),raw=pack.timeframes||pack.data||pack||{},tf=learning?.source?.timeframe||'M15',candles=clean(raw[tf]||raw.M15||raw.M5||raw.M1||[]);
if(!candles.length||!learning?.ready){console.log('Journal waiting for ready model/data');process.exit(0)}
let journal=empty();try{if(fs.existsSync(OUTPUT))journal={...empty(),...JSON.parse(fs.readFileSync(OUTPUT,'utf8'))}}catch(_){}
journal.entries=Array.isArray(journal.entries)?journal.entries:[];
const atrArr=wild(tr(candles),14),latest=candles.at(-1),latestAtr=atrArr.at(-1)||Math.max(.01,latest.high-latest.low),fp=fingerprint(pack);
// Resolve old shadow decisions as new candles arrive.
for(const e of journal.entries){
  if(!e.horizons)e.horizons={};
  for(const [key,min] of [['M15',15],['M30',30],['M60',60]]){
    if(e.horizons[key]?.resolved)continue;const bar=findAtOrAfter(candles,e.ts+min*60000);if(!bar)continue;
    const signed=(e.direction==='SELL'?e.entry-bar.close:bar.close-e.entry)/Math.max(.000001,e.atr||1),neutral=Math.abs(signed)<.05;
    e.horizons[key]={resolved:true,resolvedAt:new Date(bar.ts).toISOString(),close:bar.close,returnR:Number(signed.toFixed(4)),correct:neutral?null:signed>0};
  }
  if(['M15','M30','M60'].every(k=>e.horizons[k]?.resolved))e.status='COMPLETE';
}
// One GitHub shadow decision per new source candle. This works even with the PWA closed.
const current=learning.current||{},id=`${tf}:${latest.ts}:${current.key||current.direction||'WAIT'}`;
if(!journal.entries.some(e=>e.id===id)){
  journal.entries.push({id,createdAt:new Date().toISOString(),ts:latest.ts,sourceFingerprint:fp,sourceTf:tf,direction:current.direction||'WAIT',regime:current.regime||'UNKNOWN',session:current.session||'UNKNOWN',structure:current.structure||'UNKNOWN',entry:latest.close,atr:latestAtr,probability:Number(current.learnedWinProbability)||50,lowerBound:Number(current.lowerBound)||5,upperBound:Number(current.upperBound)||95,trustState:learning?.qualityGuards?.backgroundUse||'UNKNOWN',modelHealth:Number(learning?.modelHealth?.score)||0,status:'PENDING',horizons:{}});
}
journal.entries=journal.entries.slice(-2500);journal.version=VERSION;journal.engine=ENGINE;journal.updatedAt=new Date().toISOString();journal.sourceFingerprint=fp;journal.summary=summarize(journal.entries);
fs.writeFileSync(OUTPUT,JSON.stringify(journal,null,2));
// Surface journal health inside ai-learning.json so the app needs no extra API/file fetch.
learning.backgroundJournal={...journal.summary,source:'ai-outcome-journal.json'};fs.writeFileSync(LEARNING,JSON.stringify(learning,null,2));
console.log(`Journal: ${journal.summary.total} decisions | 30m verified ${journal.summary.verified30m} | hit ${journal.summary.hitRate30==null?'—':journal.summary.hitRate30.toFixed(1)+'%'}`);
