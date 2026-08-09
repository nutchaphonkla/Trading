import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT=path.resolve(process.cwd());
const API=process.env.TWELVE_DATA_API_KEY;
if(!API)throw new Error('Missing TWELVE_DATA_API_KEY secret');
const symbol='XAU/USD',DAY=86400000;
const retention={M1:5,M5:30,M15:90,H1:180};
async function twelve(interval,outputsize){
  const u=new URL('https://api.twelvedata.com/time_series');u.searchParams.set('symbol',symbol);u.searchParams.set('interval',interval);u.searchParams.set('outputsize',String(outputsize));u.searchParams.set('timezone','UTC');u.searchParams.set('apikey',API);
  const r=await fetch(u),j=await r.json();if(!r.ok||j.status==='error'||!Array.isArray(j.values))throw new Error(j.message||`Twelve Data ${interval} failed`);
  return j.values.slice().reverse().map(v=>({ts:Date.parse(String(v.datetime).replace(' ','T')+'Z'),datetime:v.datetime,open:+v.open,high:+v.high,low:+v.low,close:+v.close})).filter(c=>Number.isFinite(c.ts)&&[c.open,c.high,c.low,c.close].every(Number.isFinite));
}
function merge(oldRows,newRows,days){const m=new Map();for(const c of [...(oldRows||[]),...(newRows||[])])if(Number.isFinite(Number(c.ts)))m.set(Number(c.ts),c);const a=[...m.values()].sort((x,y)=>x.ts-y.ts);if(!a.length)return a;const cut=a.at(-1).ts-days*DAY;return a.filter(c=>c.ts>=cut)}
let prev={timeframes:{}};try{prev=JSON.parse(await fs.readFile(path.join(ROOT,'xauusd.json'),'utf8'))}catch(_){}
const [m1n,m5n,m15n,h1n]=await Promise.all([twelve('1min',5000),twelve('5min',5000),twelve('15min',5000),twelve('1h',3000)]);
const tf={M1:merge(prev?.timeframes?.M1,m1n,retention.M1),M5:merge(prev?.timeframes?.M5,m5n,retention.M5),M15:merge(prev?.timeframes?.M15,m15n,retention.M15),H1:merge(prev?.timeframes?.H1,h1n,retention.H1)};
const coverageDays=Object.fromEntries(Object.entries(tf).map(([k,a])=>[k,a.length>1?Number(((a.at(-1).ts-a[0].ts)/DAY).toFixed(1)):0]));
const pack={generatedAt:new Date().toISOString(),source:'Twelve Data rolling history via GitHub Actions',symbol,retentionDays:retention,coverageDays,timeframes:tf};
await fs.writeFile(path.join(ROOT,'xauusd.json'),JSON.stringify(pack));
const goldKeys=['non farm','nonfarm','payroll','cpi','consumer price','pce','fed','fomc','powell','gdp','jobless','jolts','ppi','producer price','retail sales','ism','adp','employment','unemployment','interest rate'];let events=[];
try{const url='https://api.tradingeconomics.com/calendar/country/united%20states?c=guest:guest&importance=2',r=await fetch(url);if(r.ok){const raw=await r.json();events=(Array.isArray(raw)?raw:[]).filter(e=>{const s=((e.Event||'')+' '+(e.Category||'')).toLowerCase();return goldKeys.some(k=>s.includes(k))}).map(e=>({date:e.Date,event:e.Event||'US Event',importance:Number(e.Importance||2),actual:e.Actual??null,forecast:e.Forecast??null,previous:e.Previous??null}))}}catch(err){console.warn('News skipped:',err.message)}
await fs.writeFile(path.join(ROOT,'news.json'),JSON.stringify({generatedAt:new Date().toISOString(),source:'Trading Economics guest feed via GitHub Actions',events}));
console.log('Updated rolling pack',Object.fromEntries(Object.entries(tf).map(([k,a])=>[k,{candles:a.length,days:coverageDays[k]}])));
