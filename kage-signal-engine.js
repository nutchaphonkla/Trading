(() => {
  'use strict';
  const VERSION='KAGE_SIGNAL_ENGINE_V48';

  function num(v){ const n=Number(v); return Number.isFinite(n)?n:null; }
  function clamp(v,a,b){ return Math.min(b,Math.max(a,v)); }
  function confidenceLevel(v){
    const n=Number(v)||0;
    if(n>=90)return 'VERY HIGH';
    if(n>=80)return 'HIGH';
    if(n>=65)return 'MEDIUM';
    if(n>=50)return 'LOW';
    return 'VERY LOW';
  }
  function stageFromState(state){
    const s=String(state||'').trim().toUpperCase();
    if(s==='ENTRY READY')return 'ENTRY_READY';
    if(s==='APPROACHING')return 'APPROACHING';
    if(s==='EARLY WATCH')return 'EARLY_WATCH';
    if(s==='IN ZONE')return 'IN_ZONE';
    if(s==='NEWS HOLD')return 'NEWS_HOLD';
    if(s==='LATE DETECTED')return 'CHASE_BLOCK';
    if(s==='REFERENCE ONLY')return 'REFERENCE_ONLY';
    if(s==='WAIT')return 'WAIT';
    return s.replace(/\s+/g,'_')||'WAIT';
  }
  function planIdFor(p){
    const sig=[
      String(p?.type||'PLAN'),
      Number(p?.entry||0).toFixed(2),
      Number(p?.sl||0).toFixed(2),
      Number(p?.tp1||0).toFixed(2)
    ].join('|');
    let h=2166136261;
    for(const ch of sig){ h^=ch.charCodeAt(0); h=Math.imul(h,16777619); }
    return `XAUUSD-${(h>>>0).toString(16)}`;
  }
  function fromAppDecision(p,pp,ctx={}){
    if(!p || p.qualifiedPlan!==true)return null;
    const stage=stageFromState(pp?.state);
    const type=String(p.type||'PLAN').replace(/_/g,' ').toUpperCase();
    return {
      engineVersion:VERSION,
      planId:planIdFor(p),
      symbol:'XAUUSD',
      side:type,
      type,
      stage,
      entry:num(p.entry),
      zoneLow:num(p.entryLow),
      zoneHigh:num(p.entryHigh),
      sl:num(p.sl),
      tp1:num(p.tp1),
      tp2:num(p.tp2),
      confidence:clamp(num(ctx.confidence)??0,0,100),
      confidenceLevel:confidenceLevel(num(ctx.confidence)??0),
      quality:clamp(num(ctx.quality)??0,0,100),
      currentPrice:num(ctx.currentPrice),
      distance:num(pp?.lead?.distance),
      approachDistance:num(pp?.lead?.approachDistance),
      canPlace:pp?.canPlace===true,
      marketOpen:ctx.marketOpen!==false,
      newsLock:ctx.newsLock===true,
      reason:String(pp?.note||pp?.executionNote||''),
      updatedAt:Date.now(),
      expiresAt:Date.now()+3*60*60*1000
    };
  }
  function changed(prev,next){
    if(!prev)return {changed:true,kind:'NEW'};
    if(prev.planId!==next.planId)return {changed:true,kind:'NEW_PLAN'};
    if(prev.stage!==next.stage)return {changed:true,kind:'STAGE'};
    for(const f of ['entry','zoneLow','zoneHigh','sl','tp1','tp2']){
      const a=Number(prev[f]),b=Number(next[f]);
      if(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)>=0.05){
        return {changed:true,kind:'PLAN_UPDATED',field:f};
      }
    }
    if(Math.abs((Number(prev.confidence)||0)-(Number(next.confidence)||0))>=5){
      return {changed:true,kind:'CONFIDENCE_UPDATED'};
    }
    if(Math.abs((Number(prev.quality)||0)-(Number(next.quality)||0))>=5){
      return {changed:true,kind:'QUALITY_UPDATED'};
    }
    return {changed:false,kind:'NOISE'};
  }

  window.KageSignalEngine={VERSION,fromAppDecision,changed,confidenceLevel};
})();
