import {ema,rsi,atr,adx,macdHist,structure,clamp} from './indicators.js';

export function sessionInfo(now=new Date()){
  const h=now.getUTCHours();
  if(h>=0&&h<7)return{name:'ASIA',quality:.72};
  if(h>=7&&h<13)return{name:'LONDON',quality:1};
  if(h>=13&&h<17)return{name:'LDN + NY',quality:1.05};
  if(h>=17&&h<22)return{name:'NEW YORK',quality:1};
  return{name:'OFF HOURS',quality:.58};
}

export function analyzeTf(candles,tf){
  if(!candles||candles.length<70)return null;
  const c=candles.slice(-220),closes=c.map(x=>x.close),n=closes.length-1;
  const E9=ema(closes,9),E21=ema(closes,21),E50=ema(closes,50),E200=ema(closes,Math.min(200,closes.length));
  const A=atr(c,14)||1,R=rsi(closes,14),D=adx(c,14),M=macdHist(closes),S=structure(c.slice(-90));
  const close=closes[n],slope=(E21[n]-E21[Math.max(0,n-8)])/A,dist=Math.abs(close-E21[n])/A;
  let bull=0,bear=0;
  if(close>E21[n])bull+=9;else bear+=9;
  if(E9[n]>E21[n])bull+=11;else bear+=11;
  if(E21[n]>E50[n])bull+=14;else bear+=14;
  if(close>E200[n])bull+=5;else bear+=5;
  bull+=clamp(slope*9,0,14);bear+=clamp(-slope*9,0,14);
  if(R>=52&&R<=69)bull+=8;else if(R<=48&&R>=31)bear+=8;
  if(M>0)bull+=Math.max(0,(D-15)/4);else bear+=Math.max(0,(D-15)/4);
  if(S.state==='BULL')bull+=14;if(S.state==='BEAR')bear+=14;
  if(S.bos==='BULL')bull+=13;if(S.bos==='BEAR')bear+=13;
  if(D>=22){if(bull>bear)bull+=8;else bear+=8}
  if(D<16){bull-=6;bear-=6}
  const bias=bull-bear,direction=bias>=0?'BUY':'SELL';
  let regime=D>=27?'TREND':D<17?'RANGE':'TRANSITION';
  if(A/close>.0045)regime='VOLATILE';
  const stretched=dist>1.15,pullback=dist<=.45;
  const quality=Math.round(clamp(48+Math.abs(bias)*.58+(D-18)*.8-(stretched?10:0)-(regime==='RANGE'?9:0),0,95));
  return{tf,close,ema9:E9[n],ema21:E21[n],ema50:E50[n],rsi:R,atr:A,adx:D,macd:M,structure:S.state,bos:S.bos,swingHigh:S.swingHigh,swingLow:S.swingLow,bias,direction,regime,quality,stretched,pullback,candles:c};
}

function policy(regime){
  if(regime==='TREND')return{label:'Trend pullback',threshold:76,lot:1};
  if(regime==='TRANSITION')return{label:'Confirmation only',threshold:82,lot:.8};
  if(regime==='VOLATILE')return{label:'Volatility defense',threshold:87,lot:.6};
  return{label:'No-trade range',threshold:99,lot:0};
}

export function chooseSetup(results,{news={lock:false},memory=null,marketOpen=true}={}){
  const H=results.H1,A=results.M15,B=results.M5,C=results.M1;
  if(!H||!A)return{side:'WAIT',tf:'M15',score:0,reason:'ข้อมูล H1/M15 ยังไม่พอ',regime:A?.regime||'—',setupType:'WAIT'};
  const sess=sessionInfo(),weighted=H.bias*.40+A.bias*.34+(B?.bias||0)*.18+(C?.bias||0)*.08,dominant=weighted>=0?'BUY':'SELL';
  const set=[H,A,B,C].filter(Boolean),align=set.filter(x=>x.direction===dominant).length,core=H.direction===dominant&&A.direction===dominant;
  const candidates=[A,B,C].filter(Boolean).map(r=>{
    let q=r.quality+(r.direction===dominant?11:-22)+(r.pullback?7:0)+(r.bos===dominant?10:0)-(r.stretched?13:0)-(r.regime==='RANGE'?14:0);
    if(r.tf==='M5'&&(sess.name==='LONDON'||sess.name==='LDN + NY'||sess.name==='NEW YORK'))q+=6;
    if(r.tf==='M1'&&(!B||B.direction!==dominant))q-=20;
    return{r,q};
  }).sort((x,y)=>y.q-x.q);
  const R=candidates[0]?.r||A,p=policy(A.regime);
  let score=Math.round(clamp(52+Math.min(22,Math.abs(weighted)*.3)+(align-2)*6+(core?10:-13)+(R.pullback?5:0)+(R.bos===dominant?7:0)+(sess.quality-1)*8-(R.stretched?12:0),0,94));
  if(memory?.adjust)score=clamp(score+memory.adjust,0,95);
  const blockers=[];
  if(!marketOpen)blockers.push('MARKET CLOSED');
  if(news.lock)blockers.push('NEWS LOCK');
  if(!core)blockers.push('H1/M15 NOT ALIGNED');
  if(align<3&&set.length>=3)blockers.push('MTF CONFLUENCE LOW');
  if(A.regime==='RANGE')blockers.push('RANGE MARKET');
  if(R.stretched)blockers.push('NO CHASE');
  if(score<p.threshold)blockers.push('CONFIDENCE '+score+' < '+p.threshold);
  let side=blockers.length?'WAIT':dominant;
  let setupType='WAIT',entryCenter=null,entryLow=null,entryHigh=null,sl=null,tp1=null,tp2=null,rr=0;
  if(side!=='WAIT'){
    const X=R.atr;
    if(R.bos===side){setupType='BOS RETEST';entryCenter=(side==='BUY'?R.swingHigh:R.swingLow)??R.ema9}
    else if(R.pullback){setupType='EMA PULLBACK';entryCenter=(R.ema9+R.ema21)/2}
    else{setupType='MEAN RETEST';entryCenter=R.ema21}
    entryLow=entryCenter-X*.10;entryHigh=entryCenter+X*.10;
    if(side==='BUY'){
      const structural=Number.isFinite(R.swingLow)?R.swingLow-X*.12:entryCenter-X;sl=Math.min(structural,entryCenter-X*.8);let risk=entryCenter-sl;if(risk>X*2){sl=entryCenter-X*2;risk=entryCenter-sl}if(risk<X*.7){sl=entryCenter-X*.7;risk=entryCenter-sl}tp1=entryCenter+risk*1.55;tp2=entryCenter+risk*2.25;rr=(tp1-entryCenter)/risk;
    }else{
      const structural=Number.isFinite(R.swingHigh)?R.swingHigh+X*.12:entryCenter+X;sl=Math.max(structural,entryCenter+X*.8);let risk=sl-entryCenter;if(risk>X*2){sl=entryCenter+X*2;risk=sl-entryCenter}if(risk<X*.7){sl=entryCenter+X*.7;risk=sl-entryCenter}tp1=entryCenter-risk*1.55;tp2=entryCenter-risk*2.25;rr=(entryCenter-tp1)/risk;
    }
    if(rr<1.45){side='WAIT';blockers.push('R:R BELOW 1.45')}
  }
  return{...R,side,direction:dominant,score,setupType,entryCenter,entryLow,entryHigh,sl,tp1,tp2,rr,align,weighted,session:sess.name,policy:p,blockers,reason:blockers.length?blockers.slice(0,2).join(' · '):`${setupType} · ${A.regime} · ${align}/${set.length} TF aligned`};
}

export function memoryStats(signals,setup){
  if(!setup)return{n:0,rate:.5,adjust:0};
  const key=[setup.setupType,setup.tf,setup.session,setup.regime,setup.direction].join('|');
  const rows=(signals||[]).filter(s=>s.fingerprint===key&&['TP1','TP2','SL'].includes(s.outcome));
  const wins=rows.filter(s=>s.outcome==='TP1'||s.outcome==='TP2').length,n=rows.length,rate=(wins+2)/(n+4),adjust=n>=5?clamp(Math.round((rate-.5)*26),-10,10):0;
  return{key,n,wins,rate,adjust};
}

export function riskGuardian(plan,signals){
  const done=(plan?.days||[]).filter(d=>d.actual!=null).slice().reverse();let dayStreak=0;for(const d of done){if(d.status==='miss')dayStreak++;else break}
  const scored=(signals||[]).filter(s=>['TP1','TP2','SL'].includes(s.outcome)).slice().sort((a,b)=>(b.closedAt||0)-(a.closedAt||0));let aiStreak=0;for(const s of scored){if(s.outcome==='SL')aiStreak++;else break}
  let dd=0;if(plan){const vals=[plan.start,...(plan.days||[]).filter(d=>d.actual!=null).map(d=>d.actual)],peak=()=>{};let p=vals[0]||0;for(const v of vals){p=Math.max(p,v);if(p)dd=Math.max(dd,(p-v)/p)}}
  let mult=1,locked=false;const reasons=[];
  if(dayStreak>=2){mult=.65;reasons.push('2 day miss streak')}if(dayStreak>=3){locked=true;mult=0;reasons.push('3 day miss streak')}
  if(aiStreak>=2){mult=Math.min(mult,.7);reasons.push('AI loss streak')}if(aiStreak>=3){mult=Math.min(mult,.45)}
  if(dd>=.05){mult=Math.min(mult,.7);reasons.push('Drawdown ≥ 5%')}if(dd>=.1){locked=true;mult=0;reasons.push('Drawdown ≥ 10%')}
  return{mult,locked,dayStreak,aiStreak,dd,reasons};
}

export function lotForSetup(setup,{balance,maxLoss,contractSize=100,minLot=.01,lotFactor=.7,guardian={mult:1},riskPct=.5}={}){
  if(!setup||setup.side==='WAIT'||!Number.isFinite(setup.sl)||!Number.isFinite(setup.entryCenter)||guardian.locked)return{suggested:null,max:null,riskMoney:0};
  const dist=Math.abs(setup.entryCenter-setup.sl),base=Math.min(Number(maxLoss||0)/2,balance*(riskPct/100)),riskMoney=base*(guardian.mult??1)*(setup.policy?.lot??1);
  if(!dist||!riskMoney)return{suggested:null,max:null,riskMoney};const raw=riskMoney/(dist*contractSize),floor=v=>Math.floor((v+1e-10)/minLot)*minLot;
  if(raw<minLot)return{suggested:'< '+minLot.toFixed(2),max:'< '+minLot.toFixed(2),riskMoney};return{suggested:Math.max(minLot,floor(raw*lotFactor)).toFixed(2),max:Math.max(minLot,floor(raw)).toFixed(2),riskMoney};
}

export function fingerprint(signal){return[signal.setupType,signal.tf,signal.session,signal.regime,signal.direction||signal.side].join('|')}
