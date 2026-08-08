import {addApiUsage,loadMarketCache,saveMarketCache} from './storage.js';

export const TF={M1:{api:'1min',ttl:55_000},M5:{api:'5min',ttl:270_000},M15:{api:'15min',ttl:840_000},H1:{api:'1h',ttl:3_300_000}};

export function marketStatus(now=new Date()){
  const day=now.getDay(),h=now.getUTCHours(),m=now.getUTCMinutes(),mins=h*60+m;
  if(day===6)return{open:false,label:'MARKET CLOSED'};
  if(day===0&&mins<22*60)return{open:false,label:'MARKET CLOSED'};
  if(day===5&&mins>=22*60)return{open:false,label:'MARKET CLOSED'};
  return{open:true,label:'MARKET OPEN'};
}

export async function loadStaticPack(){
  const res=await fetch('./data/xauusd.json',{cache:'no-store'});
  if(!res.ok)throw new Error('โหลด Historical Pack ไม่สำเร็จ');
  const json=await res.json();
  return json.timeframes||{};
}

export async function loadNewsPack(){
  const res=await fetch('./data/news.json',{cache:'no-store'});
  if(!res.ok)throw new Error('โหลด News Pack ไม่สำเร็จ');
  return await res.json();
}

function normalize(values){return (values||[]).slice().reverse().map(v=>({ts:Date.parse(String(v.datetime).replace(' ','T')+'Z'),datetime:v.datetime,open:+v.open,high:+v.high,low:+v.low,close:+v.close})).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite))}

export async function fetchTf(tf,apiKey,force=false){
  if(!TF[tf])throw new Error('Timeframe ไม่รองรับ');
  if(!apiKey)throw new Error('ยังไม่มี Twelve Data API Key');
  const cache=loadMarketCache(),hit=cache[tf],now=Date.now();
  if(!force&&hit&&now-hit.at<TF[tf].ttl&&Array.isArray(hit.data)&&hit.data.length>20)return{data:hit.data,credit:0,cached:true};
  const url='https://api.twelvedata.com/time_series?symbol='+encodeURIComponent('XAU/USD')+'&interval='+encodeURIComponent(TF[tf].api)+'&outputsize=240&timezone=UTC&apikey='+encodeURIComponent(apiKey);
  const res=await fetch(url,{cache:'no-store'}),json=await res.json();
  if(!res.ok||json.status==='error'||!Array.isArray(json.values))throw new Error(json.message||'Market API error');
  const data=normalize(json.values);cache[tf]={at:now,data};saveMarketCache(cache);addApiUsage(1);return{data,credit:1,cached:false};
}

export async function refreshNews(teKey=''){
  if(!teKey)return loadNewsPack();
  const auth=encodeURIComponent(teKey),url='https://api.tradingeconomics.com/calendar/country/united%20states?c='+auth+'&importance=2';
  const res=await fetch(url,{cache:'no-store'});if(!res.ok)throw new Error('News API error');const raw=await res.json();
  return {generatedAt:new Date().toISOString(),events:filterGoldNews(raw)};
}

export function filterGoldNews(events=[]){
  const keys=['non farm','nonfarm','payroll','cpi','consumer price','pce','fed','fomc','powell','gdp','jobless','jolts','ppi','producer price','retail sales','ism','adp','employment','unemployment','interest rate'];
  return events.filter(e=>{
    const s=((e.Event||e.event||'')+' '+(e.Category||'')).toLowerCase();
    return keys.some(k=>s.includes(k));
  }).map(e=>({date:e.Date||e.date,event:e.Event||e.event||'US Event',importance:Number(e.Importance??e.importance??2),actual:e.Actual??e.actual??null,forecast:e.Forecast??e.forecast??null,previous:e.Previous??e.previous??null}));
}

export function nextNews(events=[],now=new Date()){
  const list=events.map(e=>({...e,ts:Date.parse(e.date)})).filter(e=>Number.isFinite(e.ts)&&e.ts>=now.getTime()-15*60_000).sort((a,b)=>a.ts-b.ts);
  return list[0]||null;
}

export function newsLock(events=[],now=new Date()){
  const nearest=nextNews(events,now);if(!nearest)return{lock:false,nearest:null,mins:Infinity};
  const mins=(nearest.ts-now.getTime())/60_000;
  const lock=nearest.importance>=3&&mins>=-10&&mins<=20;
  return{lock,nearest,mins};
}
