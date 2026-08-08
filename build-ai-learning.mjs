import fs from 'node:fs';

const INPUT='xauusd.json';
const HISTORY='ai-history.json';
const OUTPUT='ai-learning.json';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
const median=a=>{const x=a.filter(Number.isFinite).slice().sort((p,q)=>p-q);if(!x.length)return 0;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2};

function normalize(v){
  const open=num(v.open),high=num(v.high),low=num(v.low),close=num(v.close);let ts=num(v.ts);
  if(!Number.isFinite(ts)){const d=String(v.datetime||v.date||'').trim();ts=Date.parse(d.includes('T')?d:d.replace(' ','T')+'Z')}
  if(!Number.isFinite(ts)||![open,high,low,close].every(Number.isFinite)||open<=0||high<Math.max(open,close)||low>Math.min(open,close))return null;
  return{ts,open,high,low,close};
}
function clean(a){const x=(a||[]).map(normalize).filter(Boolean).sort((a,b)=>a.ts-b.ts),o=[];let last=-1;for(const c of x){if(c.ts===last)continue;last=c.ts;o.push(c)}return o}
function aggregate(src,ms){const o=[];let b=-1,c=null;for(const x of src){const q=Math.floor(x.ts/ms)*ms;if(q!==b){if(c)o.push(c);b=q;c={ts:q,open:x.open,high:x.high,low:x.low,close:x.close}}else{c.high=Math.max(c.high,x.high);c.low=Math.min(c.low,x.low);c.close=x.close}}if(c)o.push(c);return o}
function ema(v,p){const o=[];if(!v.length)return o;const k=2/(p+1);let x=v[0];for(let i=0;i<v.length;i++){x=i?v[i]*k+x*(1-k):v[i];o.push(x)}return o}
function tr(c){return c.map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-c[i-1].close),Math.abs(x.low-c[i-1].close)):x.high-x.low)}
function wild(v,p=14){const o=new Array(v.length).fill(null);if(v.length<p)return o;let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p;o[p-1]=x;for(let i=p;i<v.length;i++){x=(x*(p-1)+v[i])/p;o[i]=x}return o}
function rsi(v,p=14){const o=new Array(v.length).fill(null);if(v.length<=p)return o;let g=0,l=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}let ag=g/p,al=l/p;o[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;o[i]=al===0?100:100-100/(1+ag/al)}return o}
function adx(c,p=14){const T=tr(c),pd=[0],md=[0];for(let i=1;i<c.length;i++){const u=c[i].high-c[i-1].high,d=c[i-1].low-c[i].low;pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0)}const a=wild(T,p),pw=wild(pd,p),mw=wild(md,p),dx=new Array(c.length).fill(0);for(let i=0;i<c.length;i++){if(a[i]&&pw[i]!=null&&mw[i]!=null){const P=100*pw[i]/a[i],M=100*mw[i]/a[i],s=P+M;dx[i]=s?100*Math.abs(P-M)/s:0}}return wild(dx,p)}
function bucketRsi(v){return v<40?'LOW':v>60?'HIGH':'MID'}
function structure(c,i){if(i<40)return'RANGE';const a=c.slice(i-19,i+1),b=c.slice(i-39,i-19),ha=Math.max(...a.map(x=>x.high)),la=Math.min(...a.map(x=>x.low)),hb=Math.max(...b.map(x=>x.high)),lb=Math.min(...b.map(x=>x.low));if(ha>hb&&la>lb)return'BULL';if(ha<hb&&la<lb)return'BEAR';return'RANGE'}
function session(ts){const h=new Date(ts).getUTCHours();if(h>=0&&h<7)return'ASIA';if(h>=7&&h<13)return'LONDON';if(h>=13&&h<21)return'NEW_YORK';return'OFF_HOURS'}
function wilson(w,n,z=1.0){if(!n)return.5;const p=w/n,z2=z*z,d=1+z2/n,c=(p+z2/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)/d;return clamp(c-m,0,1)}
function posterior(w,n,prior=16){return (w+prior*.5)/(n+prior)}
function firstTouch(c,i,horizon,direction,atr){const entry=c[i].close,tp=direction==='BUY'?entry+atr*.8:entry-atr*.8,sl=direction==='BUY'?entry-atr*.6:entry+atr*.6;let mfe=0,mae=0;for(let j=i+1;j<=Math.min(c.length-1,i+horizon);j++){const x=c[j];if(direction==='BUY'){mfe=Math.max(mfe,(x.high-entry)/atr);mae=Math.max(mae,(entry-x.low)/atr);if(x.low<=sl&&x.high>=tp)return{win:false,r:-.6,mfe,mae};if(x.high>=tp)return{win:true,r:.8,mfe,mae};if(x.low<=sl)return{win:false,r:-.6,mfe,mae}}else{mfe=Math.max(mfe,(entry-x.low)/atr);mae=Math.max(mae,(x.high-entry)/atr);if(x.high>=sl&&x.low<=tp)return{win:false,r:-.6,mfe,mae};if(x.low<=tp)return{win:true,r:.8,mfe,mae};if(x.high>=sl)return{win:false,r:-.6,mfe,mae}}}const end=c[Math.min(c.length-1,i+horizon)].close,signed=(direction==='BUY'?end-entry:entry-end)/atr;return{win:signed>.12,r:signed,mfe,mae}}

if(!fs.existsSync(INPUT)){console.error('Missing xauusd.json');process.exit(1)}
const pack=JSON.parse(fs.readFileSync(INPUT,'utf8')),raw=pack.timeframes||pack.data||pack||{};
const m1=clean(raw.M1||[]),directM5=clean(raw.M5||[]),directM15=clean(raw.M15||[]);
const derivedM5=m1.length>=300?aggregate(m1,300000):[];
const derivedM15=m1.length>=900?aggregate(m1,900000):[];
const m5=directM5.length>=derivedM5.length?directM5:derivedM5;
const m15=directM15.length>=derivedM15.length?directM15:derivedM15;
let candles,sourceTimeframe,barMinutes,horizonBars;
if(m15.length>=260){candles=m15;sourceTimeframe='M15';barMinutes=15;horizonBars={M15:1,M30:2,M60:4}}
else if(m5.length>=280){candles=m5;sourceTimeframe='M5';barMinutes=5;horizonBars={M15:3,M30:6,M60:12}}
else if(m1.length>=320){candles=m1;sourceTimeframe='M1';barMinutes=1;horizonBars={M15:15,M30:30,M60:60}}
else{
  const pending={version:'1.1',engine:'ONEMONTH-SELF-LEARNING-V1.1',generatedAt:new Date().toISOString(),sourceGeneratedAt:pack.generatedAt||null,ready:false,reason:'WAITING_FOR_MORE_MARKET_HISTORY',counts:{M1:m1.length,M5:m5.length,M15:m15.length},minimum:{M1:320,M5:280,M15:260},global:{samples:0,hitRate:50,avgR:0,brier:0,calibrationError:0,reliability:0},horizons:{},models:{bestRegime:null,bestSession:null,weights:{regime:0,session:0,structure:0,rsi:0}},current:{key:'WAITING',direction:'WAIT',regime:'UNKNOWN',session:'UNKNOWN',structure:'UNKNOWN',rsi:50,learnedWinProbability:50,samples:0,reliability:0},edges:[]};
  fs.writeFileSync(OUTPUT,JSON.stringify(pending,null,2));
  console.log(`Learning pending, not failed: M1=${m1.length} M5=${m5.length} M15=${m15.length}`);
  process.exit(0);
}
const close=candles.map(x=>x.close),E20=ema(close,20),E50=ema(close,50),E200=ema(close,200),R=rsi(close),A=wild(tr(candles),14),D=adx(candles),atrMedian=[];
const groups=new Map(),samples=[],horizons={M15:{n:0,w:0,r:0},M30:{n:0,w:0,r:0},M60:{n:0,w:0,r:0}};
for(let i=220;i<candles.length-Math.max(...Object.values(horizonBars))-1;i++){
  const atr=A[i]||tr(candles)[i]||1;if(!atr)continue;
  const local=A.slice(Math.max(0,i-80),i+1).filter(Number.isFinite),med=median(local)||atr;atrMedian[i]=med;
  const S=structure(candles,i),adxv=D[i]||0;
  let regime=adxv>=27?'TREND':adxv<17?'RANGE':'TRANSITION';if(atr>med*1.75)regime='VOLATILE';
  let bull=0,bear=0;close[i]>E20[i]?bull+=1:bear+=1;E20[i]>E50[i]?bull+=1:bear+=1;E50[i]>E200[i]?bull+=1:bear+=1;if(S==='BULL')bull+=1;if(S==='BEAR')bear+=1;
  const direction=bull>=bear?'BUY':'SELL',sess=session(candles[i].ts),rb=bucketRsi(R[i]??50),key=[direction,regime,sess,rb,S].join('|');
  const rawProb=clamp(52+Math.abs(bull-bear)*4+(adxv>=25?5:0)+(S===(direction==='BUY'?'BULL':'BEAR')?4:0)-(regime==='RANGE'?6:0),52,78)/100;
  const o1=firstTouch(candles,i,horizonBars.M15,direction,atr),o2=firstTouch(candles,i,horizonBars.M30,direction,atr),o4=firstTouch(candles,i,horizonBars.M60,direction,atr);
  horizons.M15.n++;horizons.M15.w+=o1.win?1:0;horizons.M15.r+=o1.r;horizons.M30.n++;horizons.M30.w+=o2.win?1:0;horizons.M30.r+=o2.r;horizons.M60.n++;horizons.M60.w+=o4.win?1:0;horizons.M60.r+=o4.r;
  const row=groups.get(key)||{key,direction,regime,session:sess,rsiBucket:rb,structure:S,samples:0,wins:0,sumR:0,sumMfe:0,sumMae:0,sumProb:0,brier:0};
  row.samples++;row.wins+=o2.win?1:0;row.sumR+=o2.r;row.sumMfe+=o2.mfe;row.sumMae+=o2.mae;row.sumProb+=rawProb;row.brier+=(rawProb-(o2.win?1:0))**2;groups.set(key,row);
  samples.push({win:o2.win,prob:rawProb,r:o2.r,regime,sess,S,rb,direction});
}
const edges=[...groups.values()].map(r=>{const post=posterior(r.wins,r.samples),lower=wilson(r.wins,r.samples),rel=clamp(Math.log10(r.samples+1)/2.2,0,1);return{key:r.key,direction:r.direction,regime:r.regime,session:r.session,rsiBucket:r.rsiBucket,structure:r.structure,samples:r.samples,hitRate:r.wins/r.samples*100,posteriorWinRate:post*100,wilsonLower:lower*100,reliability:rel,avgR:r.sumR/r.samples,avgMfeR:r.sumMfe/r.samples,avgMaeR:r.sumMae/r.samples,brier:r.brier/r.samples}}).sort((a,b)=>(b.reliability*(b.posteriorWinRate-50))-(a.reliability*(a.posteriorWinRate-50)));
const total=samples.length,wins=samples.filter(x=>x.win).length,hit=total?wins/total*100:50,brier=total?samples.reduce((s,x)=>s+(x.prob-(x.win?1:0))**2,0)/total:0;
const bins=new Map();for(const x of samples){const b=Math.round(x.prob*10)/10,row=bins.get(b)||{n:0,w:0,p:0};row.n++;row.w+=x.win?1:0;row.p+=x.prob;bins.set(b,row)}let cal=0;for(const r of bins.values())cal+=r.n/total*Math.abs(r.w/r.n-r.p/r.n);cal*=100;
function bestBy(field){const m=new Map();for(const e of edges){const k=e[field],r=m.get(k)||{name:k,samples:0,w:0};r.samples+=e.samples;r.w+=e.posteriorWinRate*e.samples;m.set(k,r)}return[...m.values()].map(r=>({...r,winRate:r.w/r.samples})).filter(r=>r.samples>=20).sort((a,b)=>b.winRate-a.winRate)[0]||null}
function featurePower(field){const m=new Map();for(const e of edges){const k=e[field],r=m.get(k)||{n:0,w:0};r.n+=e.samples;r.w+=e.posteriorWinRate*e.samples;m.set(k,r)}const vals=[...m.values()].filter(x=>x.n>=10).map(x=>x.w/x.n);return vals.length?Math.max(...vals)-Math.min(...vals):0}
const powers={regime:featurePower('regime'),session:featurePower('session'),structure:featurePower('structure'),rsi:featurePower('rsiBucket')},psum=Object.values(powers).reduce((a,b)=>a+b,0)||1,weights=Object.fromEntries(Object.entries(powers).map(([k,v])=>[k,Number((v/psum).toFixed(4))]));
const i=candles.length-1,atr=A[i]||1,S=structure(candles,i),adxv=D[i]||0;let regime=adxv>=27?'TREND':adxv<17?'RANGE':'TRANSITION';if(atr>(median(A.slice(-80).filter(Number.isFinite))||atr)*1.75)regime='VOLATILE';let bull=0,bear=0;close[i]>E20[i]?bull++:bear++;E20[i]>E50[i]?bull++:bear++;E50[i]>E200[i]?bull++:bear++;if(S==='BULL')bull++;if(S==='BEAR')bear++;const direction=bull>=bear?'BUY':'SELL',sess=session(candles[i].ts),key=[direction,regime,sess,bucketRsi(R[i]??50),S].join('|'),match=edges.find(e=>e.key===key)||edges.filter(e=>e.direction===direction&&e.regime===regime).sort((a,b)=>b.samples-a.samples)[0]||null;
const out={version:'1.1',engine:'ONEMONTH-SELF-LEARNING-V1.1',generatedAt:new Date().toISOString(),sourceGeneratedAt:pack.generatedAt||null,ready:true,source:{timeframe:sourceTimeframe,barMinutes,candles:candles.length,counts:{M1:m1.length,M5:m5.length,M15:m15.length}},global:{samples:total,hitRate:Number(hit.toFixed(2)),avgR:Number((samples.reduce((s,x)=>s+x.r,0)/total).toFixed(4)),brier:Number(brier.toFixed(4)),calibrationError:Number(cal.toFixed(2)),reliability:Number(clamp(Math.log10(total+1)/4,0,1).toFixed(4))},horizons:Object.fromEntries(Object.entries(horizons).map(([k,r])=>[k,{samples:r.n,hitRate:Number((r.w/r.n*100).toFixed(2)),avgR:Number((r.r/r.n).toFixed(4))}])),models:{bestRegime:bestBy('regime'),bestSession:bestBy('session'),weights},current:{key,direction,regime,session:sess,structure:S,rsi:Number((R[i]??50).toFixed(2)),learnedWinProbability:Number((match?.posteriorWinRate??50).toFixed(2)),samples:match?.samples||0,reliability:Number((match?.reliability||0).toFixed(4))},edges:edges.filter(e=>e.samples>=4).slice(0,600)};
fs.writeFileSync(OUTPUT,JSON.stringify(out,null,2));console.log(`Built ${OUTPUT}: ${total} samples | hit ${out.global.hitRate}% | calibration ${out.global.calibrationError} pts | current ${key} ${out.current.learnedWinProbability}%`);
