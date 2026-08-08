import fs from 'node:fs';

const INPUT='xauusd.json';
const OUTPUT='ai-learning.json';
const HALF_LIFE_DAYS=45;
const PRIOR_STRENGTH=12;
const Z90=1.645;
const DAY=86400000;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
const median=a=>{const x=a.filter(Number.isFinite).slice().sort((p,q)=>p-q);if(!x.length)return 0;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2};
const safeDiv=(a,b,f=0)=>b?a/b:f;

function normalize(v){
  const open=num(v.open),high=num(v.high),low=num(v.low),close=num(v.close);let ts=num(v.ts);
  if(!Number.isFinite(ts)){const d=String(v.datetime||v.date||'').trim();ts=Date.parse(d.includes('T')?d:d.replace(' ','T')+'Z')}
  if(!Number.isFinite(ts)||![open,high,low,close].every(Number.isFinite)||open<=0||high<Math.max(open,close)||low>Math.min(open,close)||high<low)return null;
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
function recencyWeight(ts,latestTs){const age=Math.max(0,(latestTs-ts)/DAY);return .20+.80*Math.exp(-Math.log(2)*age/HALF_LIFE_DAYS)}
function effectiveN(sumW,sumW2){return sumW2>0?Math.max(1,(sumW*sumW)/sumW2):0}
function posterior(winW,sumW,prior=PRIOR_STRENGTH){return (winW+prior*.5)/(sumW+prior)}
function wilsonFromP(p,n,z=Z90){if(!n)return{low:.05,high:.95};const z2=z*z,d=1+z2/n,c=(p+z2/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)/d;return{low:clamp(c-m,0,1),high:clamp(c+m,0,1)}}
function firstTouch(c,i,horizon,direction,atr){const entry=c[i].close,tp=direction==='BUY'?entry+atr*.8:entry-atr*.8,sl=direction==='BUY'?entry-atr*.6:entry+atr*.6;let mfe=0,mae=0;for(let j=i+1;j<=Math.min(c.length-1,i+horizon);j++){const x=c[j];if(direction==='BUY'){mfe=Math.max(mfe,(x.high-entry)/atr);mae=Math.max(mae,(entry-x.low)/atr);if(x.low<=sl&&x.high>=tp)return{win:false,r:-.6,mfe,mae};if(x.high>=tp)return{win:true,r:.8,mfe,mae};if(x.low<=sl)return{win:false,r:-.6,mfe,mae}}else{mfe=Math.max(mfe,(entry-x.low)/atr);mae=Math.max(mae,(x.high-entry)/atr);if(x.high>=sl&&x.low<=tp)return{win:false,r:-.6,mfe,mae};if(x.low<=tp)return{win:true,r:.8,mfe,mae};if(x.high>=sl)return{win:false,r:-.6,mfe,mae}}}const end=c[Math.min(c.length-1,i+horizon)].close,signed=(direction==='BUY'?end-entry:entry-end)/atr;return{win:signed>.12,r:signed,mfe,mae}}
function featureKeys(x){return[
  {level:'EXACT',key:[x.direction,x.regime,x.sess,x.rb,x.S].join('|'),min:4},
  {level:'REGIME_SESSION_STRUCTURE',key:[x.direction,x.regime,x.sess,x.S].join('|'),min:6},
  {level:'REGIME_STRUCTURE',key:[x.direction,x.regime,x.S].join('|'),min:8},
  {level:'REGIME',key:[x.direction,x.regime].join('|'),min:12},
  {level:'DIRECTION',key:x.direction,min:18}
]}
function emptyAgg(){return{sumW:0,sumW2:0,winW:0,sumR:0,sumMfe:0,sumMae:0,n:0,recentW:0,recentWinW:0}}
function addAgg(a,x,w,recentCut){a.sumW+=w;a.sumW2+=w*w;a.winW+=(x.win?1:0)*w;a.sumR+=x.r*w;a.sumMfe+=x.mfe*w;a.sumMae+=x.mae*w;a.n++;if(x.ts>=recentCut){a.recentW+=w;a.recentWinW+=(x.win?1:0)*w}}
function buildHierarchy(rows,latestTs){
  const maps=[new Map(),new Map(),new Map(),new Map(),new Map()];
  const recentCut=rows.length?rows[Math.max(0,Math.floor(rows.length*.70))].ts:0;
  for(const x of rows){const w=recencyWeight(x.ts,latestTs);const ks=featureKeys(x);for(let i=0;i<ks.length;i++){const k=ks[i].key,a=maps[i].get(k)||emptyAgg();addAgg(a,x,w,recentCut);maps[i].set(k,a)}}
  return{maps,recentCut,latestTs};
}
function summarizeAgg(a,level,key){
  if(!a)return null;const nEff=effectiveN(a.sumW,a.sumW2),p=posterior(a.winW,a.sumW),ci=wilsonFromP(p,nEff),recent=a.recentW?100*a.recentWinW/a.recentW:null;
  return{key,matchLevel:level,samples:a.n,effectiveSamples:Number(nEff.toFixed(2)),posteriorWinRate:p*100,lowerBound:ci.low*100,upperBound:ci.high*100,uncertaintyPts:(ci.high-ci.low)*100,recentWinRate:recent,avgR:safeDiv(a.sumR,a.sumW,0),avgMfeR:safeDiv(a.sumMfe,a.sumW,0),avgMaeR:safeDiv(a.sumMae,a.sumW,0)};
}
function lookupHierarchy(model,x){
  const ks=featureKeys(x);let fallback=null;
  for(let i=0;i<ks.length;i++){
    const a=model.maps[i].get(ks[i].key);if(!a)continue;const s=summarizeAgg(a,ks[i].level,ks[i].key);if(!fallback||s.effectiveSamples>fallback.effectiveSamples)fallback=s;if(s.effectiveSamples>=ks[i].min)return s;
  }
  return fallback;
}
function calibrationError(rows){if(!rows.length)return 0;const bins=new Map();for(const x of rows){const b=Math.round(x.prob*10)/10,r=bins.get(b)||{n:0,w:0,p:0};r.n++;r.w+=x.win?1:0;r.p+=x.prob;bins.set(b,r)}let cal=0;for(const r of bins.values())cal+=r.n/rows.length*Math.abs(r.w/r.n-r.p/r.n);return cal*100}
function metrics(rows){if(!rows.length)return{samples:0,hitRate:50,brier:.25,calibrationError:0,logLoss:.693};const hit=rows.filter(x=>x.win).length/rows.length*100,brier=rows.reduce((s,x)=>s+(x.prob-(x.win?1:0))**2,0)/rows.length,logLoss=rows.reduce((s,x)=>{const p=clamp(x.prob,.03,.97);return s-(x.win?Math.log(p):Math.log(1-p))},0)/rows.length;return{samples:rows.length,hitRate:hit,brier,calibrationError:calibrationError(rows),logLoss}}
function walkForward(samples){
  if(samples.length<60)return{mode:'INSUFFICIENT',folds:[],samples:0,coverage:0,hitRate:50,brier:.25,calibrationError:0,logLoss:.693};
  const ordered=samples.slice().sort((a,b)=>a.ts-b.ts),initial=Math.max(36,Math.floor(ordered.length*.50)),remaining=ordered.length-initial,foldSize=Math.max(8,Math.floor(remaining/4)),preds=[],folds=[];
  for(let f=0;f<4;f++){
    const start=initial+f*foldSize,end=f===3?ordered.length:Math.min(ordered.length,start+foldSize);if(start>=ordered.length||end<=start)break;
    const train=ordered.slice(0,start),test=ordered.slice(start,end),model=buildHierarchy(train,train.at(-1).ts),rows=[];
    for(const x of test){const m=lookupHierarchy(model,x);if(!m)continue;rows.push({win:x.win,prob:clamp(m.posteriorWinRate/100,.05,.95),matchLevel:m.matchLevel})}
    const mm=metrics(rows);folds.push({fold:f+1,trainSamples:train.length,testSamples:test.length,predictedSamples:rows.length,coverage:test.length?Number((rows.length/test.length*100).toFixed(1)):0,hitRate:Number(mm.hitRate.toFixed(2)),brier:Number(mm.brier.toFixed(4)),calibrationError:Number(mm.calibrationError.toFixed(2))});preds.push(...rows)
  }
  const m=metrics(preds),testTotal=folds.reduce((s,x)=>s+x.testSamples,0);return{mode:'EXPANDING_WINDOW_4_FOLD',folds,samples:preds.length,coverage:testTotal?preds.length/testTotal*100:0,hitRate:m.hitRate,brier:m.brier,calibrationError:m.calibrationError,logLoss:m.logLoss};
}

if(!fs.existsSync(INPUT)){console.error('Missing xauusd.json');process.exit(1)}
const pack=JSON.parse(fs.readFileSync(INPUT,'utf8')),raw=pack.timeframes||pack.data||pack||{};
const m1=clean(raw.M1||[]),directM5=clean(raw.M5||[]),directM15=clean(raw.M15||[]);
const derivedM5=m1.length>=300?aggregate(m1,300000):[],derivedM15=m1.length>=900?aggregate(m1,900000):[];
const m5=directM5.length>=derivedM5.length?directM5:derivedM5,m15=directM15.length>=derivedM15.length?directM15:derivedM15;
let candles,sourceTimeframe,barMinutes,horizonBars;
if(m15.length>=260){candles=m15;sourceTimeframe='M15';barMinutes=15;horizonBars={M15:1,M30:2,M60:4}}
else if(m5.length>=280){candles=m5;sourceTimeframe='M5';barMinutes=5;horizonBars={M15:3,M30:6,M60:12}}
else if(m1.length>=320){candles=m1;sourceTimeframe='M1';barMinutes=1;horizonBars={M15:15,M30:30,M60:60}}
else{
  const pending={version:'2.0',engine:'ONEMONTH-PRECISION-LEARNING-V2',status:'WAIT_DATA',generatedAt:new Date().toISOString(),sourceGeneratedAt:pack.generatedAt||null,ready:false,reason:'WAITING_FOR_MORE_MARKET_HISTORY',counts:{M1:m1.length,M5:m5.length,M15:m15.length},minimum:{M1:320,M5:280,M15:260},modelHealth:{score:0,status:'WAIT_DATA',uncertainty:'HIGH',uncertaintyPts:100,driftPts:0},validation:{mode:'WAIT_DATA',samples:0,coverage:0,hitRate:50,brier:.25,calibrationError:0},global:{samples:0,hitRate:50,weightedHitRate:50,avgR:0,brier:.25,calibrationError:0,reliability:0},horizons:{},models:{bestRegime:null,bestSession:null,weights:{regime:0,session:0,structure:0,rsi:0}},current:{key:'WAITING',direction:'WAIT',regime:'UNKNOWN',session:'UNKNOWN',structure:'UNKNOWN',rsi:50,learnedWinProbability:50,samples:0,effectiveSamples:0,reliability:0,lowerBound:5,upperBound:95,uncertaintyPts:90,matchLevel:'NONE'},edges:[]};
  fs.writeFileSync(OUTPUT,JSON.stringify(pending,null,2));console.log(`Learning pending, not failed: M1=${m1.length} M5=${m5.length} M15=${m15.length}`);process.exit(0);
}

const close=candles.map(x=>x.close),E20=ema(close,20),E50=ema(close,50),E200=ema(close,200),R=rsi(close),A=wild(tr(candles),14),D=adx(candles),TR=tr(candles),samples=[],horizons={M15:{n:0,w:0,r:0},M30:{n:0,w:0,r:0},M60:{n:0,w:0,r:0}},latestTs=candles.at(-1).ts;
for(let i=220;i<candles.length-Math.max(...Object.values(horizonBars))-1;i++){
  const atr=A[i]||TR[i]||1;if(!atr)continue;const local=A.slice(Math.max(0,i-80),i+1).filter(Number.isFinite),med=median(local)||atr,S=structure(candles,i),adxv=D[i]||0;let regime=adxv>=27?'TREND':adxv<17?'RANGE':'TRANSITION';if(atr>med*1.75)regime='VOLATILE';
  let bull=0,bear=0;close[i]>E20[i]?bull++:bear++;E20[i]>E50[i]?bull++:bear++;E50[i]>E200[i]?bull++:bear++;if(S==='BULL')bull++;if(S==='BEAR')bear++;const direction=bull>=bear?'BUY':'SELL',sess=session(candles[i].ts),rb=bucketRsi(R[i]??50),rawProb=clamp(52+Math.abs(bull-bear)*4+(adxv>=25?5:0)+(S===(direction==='BUY'?'BULL':'BEAR')?4:0)-(regime==='RANGE'?6:0),52,78)/100;
  const o1=firstTouch(candles,i,horizonBars.M15,direction,atr),o2=firstTouch(candles,i,horizonBars.M30,direction,atr),o4=firstTouch(candles,i,horizonBars.M60,direction,atr);for(const [k,o] of [['M15',o1],['M30',o2],['M60',o4]]){horizons[k].n++;horizons[k].w+=o.win?1:0;horizons[k].r+=o.r}
  samples.push({ts:candles[i].ts,win:o2.win,prob:rawProb,r:o2.r,mfe:o2.mfe,mae:o2.mae,regime,sess,S,rb,direction});
}

const hierarchy=buildHierarchy(samples,latestTs),exactMap=new Map(),recentCut=samples[Math.max(0,Math.floor(samples.length*.70))]?.ts||0;
for(const x of samples){const k=featureKeys(x)[0].key,w=recencyWeight(x.ts,latestTs),a=exactMap.get(k)||emptyAgg();addAgg(a,x,w,recentCut);exactMap.set(k,a)}
const edges=[...exactMap.entries()].map(([key,a])=>{const s=summarizeAgg(a,'EXACT',key),parts=key.split('|');return{...s,direction:parts[0],regime:parts[1],session:parts[2],rsiBucket:parts[3],structure:parts[4],hitRate:100*safeDiv(a.winW,a.sumW,.5),reliability:clamp(Math.log10(s.effectiveSamples+1)/2.2,0,1),avgR:s.avgR,avgMfeR:s.avgMfeR,avgMaeR:s.avgMaeR}}).sort((a,b)=>(b.reliability*(b.posteriorWinRate-50))-(a.reliability*(a.posteriorWinRate-50)));

const total=samples.length,wins=samples.filter(x=>x.win).length,rawMetrics=metrics(samples),sumW=samples.reduce((s,x)=>s+recencyWeight(x.ts,latestTs),0),weightedWins=samples.reduce((s,x)=>s+(x.win?1:0)*recencyWeight(x.ts,latestTs),0),weightedHit=100*safeDiv(weightedWins,sumW,.5),validation=walkForward(samples);
const recent=samples.filter(x=>x.ts>=recentCut),older=samples.filter(x=>x.ts<recentCut),recentHit=recent.length?recent.filter(x=>x.win).length/recent.length*100:50,olderHit=older.length?older.filter(x=>x.win).length/older.length*100:recentHit,driftPts=Math.abs(recentHit-olderHit);
function bestBy(field){const m=new Map();for(const e of edges){const k=e[field],r=m.get(k)||{name:k,samples:0,w:0};r.samples+=e.effectiveSamples;r.w+=e.posteriorWinRate*e.effectiveSamples;m.set(k,r)}return[...m.values()].map(r=>({...r,winRate:r.w/r.samples})).filter(r=>r.samples>=12).sort((a,b)=>b.winRate-a.winRate)[0]||null}
function featurePower(field){const m=new Map();for(const e of edges){const k=e[field],r=m.get(k)||{n:0,w:0};r.n+=e.effectiveSamples;r.w+=e.posteriorWinRate*e.effectiveSamples;m.set(k,r)}const vals=[...m.values()].filter(x=>x.n>=8).map(x=>x.w/x.n);return vals.length?Math.max(...vals)-Math.min(...vals):0}
const powers={regime:featurePower('regime'),session:featurePower('session'),structure:featurePower('structure'),rsi:featurePower('rsiBucket')},psum=Object.values(powers).reduce((a,b)=>a+b,0)||1,weights=Object.fromEntries(Object.entries(powers).map(([k,v])=>[k,Number((v/psum).toFixed(4))]));

const i=candles.length-1,atr=A[i]||1,S=structure(candles,i),adxv=D[i]||0;let regime=adxv>=27?'TREND':adxv<17?'RANGE':'TRANSITION';if(atr>(median(A.slice(-80).filter(Number.isFinite))||atr)*1.75)regime='VOLATILE';let bull=0,bear=0;close[i]>E20[i]?bull++:bear++;E20[i]>E50[i]?bull++:bear++;E50[i]>E200[i]?bull++:bear++;if(S==='BULL')bull++;if(S==='BEAR')bear++;const direction=bull>=bear?'BUY':'SELL',sess=session(candles[i].ts),rb=bucketRsi(R[i]??50),currentFeature={direction,regime,sess,rb,S},match=lookupHierarchy(hierarchy,currentFeature);
const currentUncertainty=match?.uncertaintyPts??90;
const sampleScore=clamp(Math.log10(total+1)/3*100,0,100),validationScore=clamp(100-validation.brier*120-validation.calibrationError*.9,0,100),uncertaintyScore=clamp(100-currentUncertainty*2.1,0,100),driftScore=clamp(100-driftPts*2.0,0,100),coverageScore=clamp(validation.coverage,0,100),healthScore=clamp(sampleScore*.20+validationScore*.35+uncertaintyScore*.20+driftScore*.15+coverageScore*.10,0,100),healthStatus=healthScore>=75?'STRONG':healthScore>=60?'GOOD':healthScore>=45?'CAUTION':'WEAK',uncertaintyLabel=currentUncertainty<=16?'LOW':currentUncertainty<=28?'MEDIUM':'HIGH';
const reliability=clamp((healthScore/100)*.68+Math.log10(total+1)/4*.32,0,1);
const out={
  version:'2.0',engine:'ONEMONTH-PRECISION-LEARNING-V2',status:'READY',generatedAt:new Date().toISOString(),trainedThrough:new Date(latestTs).toISOString(),sourceGeneratedAt:pack.generatedAt||null,ready:true,
  recency:{halfLifeDays:HALF_LIFE_DAYS,minimumWeight:.20,weightedHitRate:Number(weightedHit.toFixed(2)),recentCut:new Date(recentCut).toISOString(),recentHitRate:Number(recentHit.toFixed(2)),olderHitRate:Number(olderHit.toFixed(2))},
  modelHealth:{score:Number(healthScore.toFixed(1)),status:healthStatus,uncertainty:uncertaintyLabel,uncertaintyPts:Number(currentUncertainty.toFixed(1)),driftPts:Number(driftPts.toFixed(1)),validationScore:Number(validationScore.toFixed(1)),coverage:Number(validation.coverage.toFixed(1))},
  validation:{mode:validation.mode,samples:validation.samples,coverage:Number(validation.coverage.toFixed(2)),hitRate:Number(validation.hitRate.toFixed(2)),brier:Number(validation.brier.toFixed(4)),calibrationError:Number(validation.calibrationError.toFixed(2)),logLoss:Number(validation.logLoss.toFixed(4)),folds:validation.folds},
  source:{timeframe:sourceTimeframe,barMinutes,candles:candles.length,counts:{M1:m1.length,M5:m5.length,M15:m15.length}},
  global:{samples:total,hitRate:Number((wins/Math.max(1,total)*100).toFixed(2)),weightedHitRate:Number(weightedHit.toFixed(2)),avgR:Number((samples.reduce((s,x)=>s+x.r,0)/Math.max(1,total)).toFixed(4)),brier:Number(rawMetrics.brier.toFixed(4)),calibrationError:Number(rawMetrics.calibrationError.toFixed(2)),reliability:Number(reliability.toFixed(4))},
  horizons:Object.fromEntries(Object.entries(horizons).map(([k,r])=>[k,{samples:r.n,hitRate:Number((r.w/Math.max(1,r.n)*100).toFixed(2)),avgR:Number((r.r/Math.max(1,r.n)).toFixed(4))}])),
  models:{bestRegime:bestBy('regime'),bestSession:bestBy('session'),weights},
  current:{key:featureKeys(currentFeature)[0].key,direction,regime,session:sess,structure:S,rsi:Number((R[i]??50).toFixed(2)),learnedWinProbability:Number((match?.posteriorWinRate??50).toFixed(2)),samples:match?.samples||0,effectiveSamples:Number((match?.effectiveSamples||0).toFixed(2)),reliability:Number(reliability.toFixed(4)),lowerBound:Number((match?.lowerBound??5).toFixed(2)),upperBound:Number((match?.upperBound??95).toFixed(2)),uncertaintyPts:Number((match?.uncertaintyPts??90).toFixed(2)),matchLevel:match?.matchLevel||'NONE',recentWinRate:Number((match?.recentWinRate??50).toFixed(2)),avgR:Number((match?.avgR??0).toFixed(4)),avgMfeR:Number((match?.avgMfeR??0).toFixed(4)),avgMaeR:Number((match?.avgMaeR??0).toFixed(4))},
  edges:edges.filter(e=>e.effectiveSamples>=3).slice(0,700)
};
fs.writeFileSync(OUTPUT,JSON.stringify(out,null,2));
console.log(`Built ${OUTPUT}: ${total} samples | weighted hit ${out.global.weightedHitRate}% | WF Brier ${out.validation.brier} | health ${out.modelHealth.score}/${out.modelHealth.status} | current ${out.current.matchLevel} ${out.current.learnedWinProbability}% ±${(out.current.uncertaintyPts/2).toFixed(1)}`);
