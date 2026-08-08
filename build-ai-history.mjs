import fs from 'node:fs';

const INPUT='xauusd.json';
const OUTPUT='ai-history.json';
const TF_MS={M1:60000,M5:300000,M15:900000,H1:3600000};
const FWD={M1:15,M5:8,M15:4,H1:2};
const STRIDE={M1:12,M5:5,M15:3,H1:1};

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const median=a=>{
  const x=a.filter(Number.isFinite).slice().sort((p,q)=>p-q);
  if(!x.length)return 0;
  const m=Math.floor(x.length/2);
  return x.length%2?x[m]:(x[m-1]+x[m])/2;
};
function num(v){const n=Number(v);return Number.isFinite(n)?n:NaN}
function normalize(v){
  const open=num(v.open),high=num(v.high),low=num(v.low),close=num(v.close);
  let ts=num(v.ts);
  if(!Number.isFinite(ts)){
    const d=String(v.datetime||v.date||'').trim();
    ts=Date.parse(d.includes('T')?d:d.replace(' ','T')+'Z');
  }
  if(!Number.isFinite(ts)||![open,high,low,close].every(Number.isFinite))return null;
  if(open<=0||high<=0||low<=0||close<=0||high<Math.max(open,close)||low>Math.min(open,close)||high<low)return null;
  return{ts,open,high,low,close};
}
function clean(raw){
  const a=(raw||[]).map(normalize).filter(Boolean).sort((x,y)=>x.ts-y.ts);
  const out=[];let last=-1;
  for(const c of a){if(c.ts===last)continue;last=c.ts;out.push(c)}
  return out;
}
function aggregate(src,tf){
  const ms=TF_MS[tf],out=[];let bucket=-1,cur=null;
  for(const c of src){
    const b=Math.floor(c.ts/ms)*ms;
    if(b!==bucket){
      if(cur)out.push(cur);
      bucket=b;cur={ts:b,open:c.open,high:c.high,low:c.low,close:c.close};
    }else{
      cur.high=Math.max(cur.high,c.high);
      cur.low=Math.min(cur.low,c.low);
      cur.close=c.close;
    }
  }
  if(cur)out.push(cur);
  return out;
}
function ema(vals,p){
  if(!vals.length)return[];
  const k=2/(p+1),out=[];let x=vals[0];
  for(let i=0;i<vals.length;i++){x=i?vals[i]*k+x*(1-k):vals[i];out.push(x)}
  return out;
}
function trueRanges(c){
  const out=[];
  for(let i=0;i<c.length;i++){
    if(i===0)out.push(c[i].high-c[i].low);
    else out.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));
  }
  return out;
}
function wilders(vals,p=14){
  const out=new Array(vals.length).fill(null);
  if(vals.length<p)return out;
  let x=vals.slice(0,p).reduce((a,b)=>a+b,0)/p;
  out[p-1]=x;
  for(let i=p;i<vals.length;i++){x=(x*(p-1)+vals[i])/p;out[i]=x}
  return out;
}
function rsi(vals,p=14){
  const out=new Array(vals.length).fill(null);
  if(vals.length<=p)return out;
  let g=0,l=0;
  for(let i=1;i<=p;i++){const d=vals[i]-vals[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}
  let ag=g/p,al=l/p;out[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<vals.length;i++){
    const d=vals[i]-vals[i-1];
    ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;
    out[i]=al===0?100:100-100/(1+ag/al);
  }
  return out;
}
function adx(c,p=14){
  const tr=trueRanges(c),pd=[0],md=[0];
  for(let i=1;i<c.length;i++){
    const up=c[i].high-c[i-1].high,dn=c[i-1].low-c[i].low;
    pd.push(up>dn&&up>0?up:0);md.push(dn>up&&dn>0?dn:0);
  }
  const a=wilders(tr,p),pw=wilders(pd,p),mw=wilders(md,p),dx=new Array(c.length).fill(0);
  for(let i=0;i<c.length;i++){
    if(a[i]&&pw[i]!=null&&mw[i]!=null){
      const plus=100*pw[i]/a[i],minus=100*mw[i]/a[i],s=plus+minus;
      dx[i]=s?100*Math.abs(plus-minus)/s:0;
    }
  }
  return wilders(dx,p);
}
function bucketRsi(v){return v<40?'LOW':v>60?'HIGH':'MID'}
function rollingStructure(c,i){
  if(i<42)return'RANGE';
  const a=c.slice(i-19,i+1),b=c.slice(i-39,i-19);
  const hiA=Math.max(...a.map(x=>x.high)),loA=Math.min(...a.map(x=>x.low));
  const hiB=Math.max(...b.map(x=>x.high)),loB=Math.min(...b.map(x=>x.low));
  if(hiA>hiB&&loA>loB)return'BULL';
  if(hiA<hiB&&loA<loB)return'BEAR';
  return'RANGE';
}
function analyzeTf(c,tf){
  if(c.length<80)return null;
  const close=c.map(x=>x.close),E9=ema(close,9),E21=ema(close,21),E50=ema(close,50),E200=ema(close,200);
  const RS=rsi(close),AT=wilders(trueRanges(c),14),AD=adx(c),ranges=trueRanges(c);
  const patterns=new Map(),regimes={TREND_BUY:0,TREND_SELL:0,RANGE:0,VOLATILE:0,TRANSITION:0};
  const forward=FWD[tf]||4,stride=STRIDE[tf]||2;
  let sampleCount=0;
  for(let i=80;i<c.length-forward;i+=stride){
    const atr=AT[i]||ranges[i]||1;
    const slope=(E21[i]-E21[Math.max(0,i-8)])/atr;
    let bull=0,bear=0;
    close[i]>E21[i]?bull+=1:bear+=1;
    E9[i]>E21[i]?bull+=1:bear+=1;
    E21[i]>E50[i]?bull+=1:bear+=1;
    close[i]>E200[i]?bull+=.5:bear+=.5;
    slope>.12?bull+=.8:slope<-.12?bear+=.8:0;
    const direction=bull>=bear?'BUY':'SELL';
    const structure=rollingStructure(c,i);
    if(structure==='BULL')bull+=1;
    if(structure==='BEAR')bear+=1;
    const ad=AD[i]||0;
    const localAtr=AT.slice(Math.max(0,i-80),i+1).filter(Number.isFinite);
    const medAtr=median(localAtr)||atr;
    let regime=ad>=27?'TREND':ad<17?'RANGE':'TRANSITION';
    if(atr>medAtr*1.75)regime='VOLATILE';
    if(regime==='TREND')regimes[direction==='BUY'?'TREND_BUY':'TREND_SELL']++;
    else regimes[regime]=(regimes[regime]||0)+1;
    const key=[direction,regime,bucketRsi(RS[i]??50),structure].join('|');
    const future=c.slice(i+1,i+1+forward);
    const end=future.at(-1)?.close??close[i];
    const retR=(end-close[i])/atr;
    const mfe=(Math.max(...future.map(x=>x.high))-close[i])/atr;
    const mae=(close[i]-Math.min(...future.map(x=>x.low)))/atr;
    const row=patterns.get(key)||{key,n:0,up:0,sumRetR:0,sumMfeR:0,sumMaeR:0};
    row.n++;if(retR>0)row.up++;row.sumRetR+=retR;row.sumMfeR+=mfe;row.sumMaeR+=mae;
    patterns.set(key,row);sampleCount++;
  }
  const n=c.length-1,atr=AT[n]||ranges[n]||Math.abs(close[n])*.001||1;
  const ret=bars=>n>=bars?(close[n]-close[n-bars])/atr:0;
  let signed=0;
  signed+=close[n]>E21[n]?12:-12;
  signed+=E9[n]>E21[n]?10:-10;
  signed+=E21[n]>E50[n]?15:-15;
  signed+=close[n]>E200[n]?7:-7;
  signed+=clamp(ret(Math.min(20,n))*2.7,-12,12);
  signed+=clamp(ret(Math.min(50,n))*1.5,-12,12);
  signed+=clamp(ret(Math.min(200,n))*.7,-12,12);
  const latestStructure=rollingStructure(c,n);
  if(latestStructure==='BULL')signed+=8;if(latestStructure==='BEAR')signed-=8;
  const bias=signed>12?'BUY':signed<-12?'SELL':'NEUTRAL';
  const strength=Math.round(clamp(50+Math.abs(signed)*.60,0,97));

  const list=[...patterns.values()].map(r=>({
    key:r.key,n:r.n,upRate:r.n?r.up/r.n:.5,
    avgReturnR:r.n?r.sumRetR/r.n:0,
    avgMfeR:r.n?r.sumMfeR/r.n:0,
    avgMaeR:r.n?r.sumMaeR/r.n:0
  })).filter(r=>r.n>=3).sort((a,b)=>b.n-a.n);

  const currentRegime=(AD[n]||0)>=27?'TREND':(AD[n]||0)<17?'RANGE':'TRANSITION';
  const currentKey=[bias==='NEUTRAL'?(E21[n]>=E50[n]?'BUY':'SELL'):bias,currentRegime,bucketRsi(RS[n]??50),latestStructure].join('|');
  const match=list.find(x=>x.key===currentKey);
  const upProbability=match&&match.n>=5
    ? Math.round(clamp(match.upRate*100,5,95))
    : Math.round(clamp(50+signed*.45,7,93));

  return{
    candles:c.length,
    from:new Date(c[0].ts).toISOString(),
    to:new Date(c[n].ts).toISOString(),
    sampleCount,
    forwardBars:forward,
    latest:{
      bias,strength,upProbability,
      rsi:Number((RS[n]??50).toFixed(2)),
      adx:Number((AD[n]??0).toFixed(2)),
      structure:latestStructure,
      key:currentKey
    },
    regimes,
    patterns:list.slice(0,400)
  };
}
function fingerprint(pack){
  const t=pack.timeframes||pack.data||pack||{};
  const rows=['M1','M5','M15','H1'].map(tf=>{
    const a=t[tf]||[];return `${tf}:${a.length}:${a[0]?.ts||a[0]?.datetime||''}:${a.at(-1)?.ts||a.at(-1)?.datetime||''}`;
  }).join('|');
  let h=2166136261;
  for(let i=0;i<rows.length;i++){h^=rows.charCodeAt(i);h=Math.imul(h,16777619)}
  return (h>>>0).toString(16);
}

if(!fs.existsSync(INPUT)){
  console.error(`Missing ${INPUT}`);
  process.exit(1);
}
const pack=JSON.parse(fs.readFileSync(INPUT,'utf8'));
const raw=pack.timeframes||pack.data||pack||{};
const M1=clean(raw.M1||[]);
const data={M1};
for(const tf of ['M5','M15','H1']){
  const own=clean(raw[tf]||[]);
  data[tf]=M1.length>=180?aggregate(M1,tf):own;
}
const timeframes={};
for(const tf of ['M1','M5','M15','H1']){
  const r=analyzeTf(data[tf]||[],tf);
  if(r)timeframes[tf]=r;
}
const weights={H1:.36,M15:.34,M5:.20,M1:.10};
let signed=0,wSum=0,totalCandles=0,totalPatterns=0,biasVotes=[];
for(const [tf,row] of Object.entries(timeframes)){
  const w=weights[tf]||.1,p=row.latest.upProbability;
  signed+=(p-50)*w;wSum+=w;totalCandles+=row.candles;totalPatterns+=row.patterns.length;
  biasVotes.push(row.latest.bias);
}
const upProbability=Math.round(clamp(50+(wSum?signed/wSum:0),5,95));
const globalBias=upProbability>=55?'BUY':upProbability<=45?'SELL':'NEUTRAL';
const same=biasVotes.filter(x=>x===globalBias).length;
const out={
  version:'1.0',
  engine:'ONEMONTH-HISTORY-V1',
  symbol:'XAUUSD',
  generatedAt:new Date().toISOString(),
  sourceGeneratedAt:pack.generatedAt||null,
  sourceFingerprint:fingerprint(pack),
  ready:Object.keys(timeframes).length>=2,
  totalCandles,
  timeframes,
  global:{
    bias:globalBias,
    upProbability,
    agreement:biasVotes.length?Math.round(same/biasVotes.length*100):0,
    totalPatterns
  }
};
fs.writeFileSync(OUTPUT,JSON.stringify(out,null,2));
console.log(`Built ${OUTPUT}`);
console.log(`Bias ${globalBias} | UP ${upProbability}% | ${totalCandles} candles | ${totalPatterns} patterns`);
