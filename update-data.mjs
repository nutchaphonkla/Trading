import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT=path.resolve(process.cwd());
const API=process.env.TWELVE_DATA_API_KEY;
if(!API)throw new Error('Missing TWELVE_DATA_API_KEY secret');

const symbol='XAU/USD';
async function twelve(interval,outputsize){
  const u=new URL('https://api.twelvedata.com/time_series');
  u.searchParams.set('symbol',symbol);u.searchParams.set('interval',interval);u.searchParams.set('outputsize',String(outputsize));u.searchParams.set('timezone','UTC');u.searchParams.set('apikey',API);
  const r=await fetch(u);const j=await r.json();if(!r.ok||j.status==='error'||!Array.isArray(j.values))throw new Error(j.message||`Twelve Data ${interval} failed`);
  return j.values.slice().reverse().map(v=>({ts:Date.parse(String(v.datetime).replace(' ','T')+'Z'),datetime:v.datetime,open:+v.open,high:+v.high,low:+v.low,close:+v.close})).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite));
}
function aggregate(candles,minutes){
  const ms=minutes*60_000,map=new Map();for(const c of candles){const bucket=Math.floor(c.ts/ms)*ms;let x=map.get(bucket);if(!x){x={ts:bucket,datetime:new Date(bucket).toISOString().replace('T',' ').slice(0,19),open:c.open,high:c.high,low:c.low,close:c.close};map.set(bucket,x)}else{x.high=Math.max(x.high,c.high);x.low=Math.min(x.low,c.low);x.close=c.close}}
  return [...map.values()].sort((a,b)=>a.ts-b.ts);
}

const [m1,h1]=await Promise.all([twelve('1min',5000),twelve('1h',500)]);
const pack={generatedAt:new Date().toISOString(),source:'Twelve Data via GitHub Actions',symbol,timeframes:{M1:m1.slice(-1400),M5:aggregate(m1,5).slice(-1000),M15:aggregate(m1,15).slice(-700),H1:h1.slice(-500)}};
await fs.mkdir(path.join(ROOT,'data'),{recursive:true});
await fs.writeFile(path.join(ROOT,'data','xauusd.json'),JSON.stringify(pack));

const goldKeys=['non farm','nonfarm','payroll','cpi','consumer price','pce','fed','fomc','powell','gdp','jobless','jolts','ppi','producer price','retail sales','ism','adp','employment','unemployment','interest rate'];
let events=[];
try{
  const url='https://api.tradingeconomics.com/calendar/country/united%20states?c=guest:guest&importance=2';
  const r=await fetch(url);if(r.ok){const raw=await r.json();events=(Array.isArray(raw)?raw:[]).filter(e=>{const s=((e.Event||'')+' '+(e.Category||'')).toLowerCase();return goldKeys.some(k=>s.includes(k))}).map(e=>({date:e.Date,event:e.Event||'US Event',importance:Number(e.Importance||2),actual:e.Actual??null,forecast:e.Forecast??null,previous:e.Previous??null}))}
}catch(err){console.warn('News pack update skipped:',err.message)}
await fs.writeFile(path.join(ROOT,'data','news.json'),JSON.stringify({generatedAt:new Date().toISOString(),source:'Trading Economics guest feed via GitHub Actions',events}));
console.log(`Updated market pack: M1 ${pack.timeframes.M1.length}, M5 ${pack.timeframes.M5.length}, M15 ${pack.timeframes.M15.length}, H1 ${pack.timeframes.H1.length}; news ${events.length}`);
