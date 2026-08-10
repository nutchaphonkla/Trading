(() => {
  'use strict';

  const CFG = () => window.KAGE_TELEGRAM_CONFIG || {};
  const STORE = {
    deviceId: 'kage_tg_device_id_v47',
    deviceToken: 'kage_tg_device_token_v47'
  };

  let queued = null;
  let timer = null;
  let lastKey = '';

  function configured(){
    const u=String(CFG().workerUrl||'');
    return /^https:\/\//.test(u) && !u.includes('YOUR-');
  }

  function deviceId(){
    let id=localStorage.getItem(STORE.deviceId);
    if(!id){
      id='kage-'+(crypto.randomUUID ? crypto.randomUUID() :
        Date.now().toString(36)+Math.random().toString(36).slice(2));
      localStorage.setItem(STORE.deviceId,id);
    }
    return id;
  }

  function deviceToken(){
    return localStorage.getItem(STORE.deviceToken)||'';
  }

  async function api(path, options={}){
    if(!configured()) throw new Error('TELEGRAM_WORKER_NOT_CONFIGURED');
    const headers=new Headers(options.headers||{});
    headers.set('content-type','application/json');
    const token=deviceToken();
    if(token){
      headers.set('x-kage-device-id',deviceId());
      headers.set('x-kage-device-token',token);
    }
    const r=await fetch(CFG().workerUrl.replace(/\/$/,'')+path,{
      ...options,headers,cache:'no-store'
    });
    let data={};
    try{data=await r.json()}catch(_){}
    if(!r.ok) throw new Error(data.error||`HTTP_${r.status}`);
    return data;
  }

  async function ensureDevice(){
    if(deviceToken()) return true;
    const result=await api('/telegram/register',{
      method:'POST',
      body:JSON.stringify({deviceId:deviceId()})
    });
    if(!result.deviceToken) throw new Error('DEVICE_TOKEN_MISSING');
    localStorage.setItem(STORE.deviceToken,result.deviceToken);
    return true;
  }

  function stageFromState(state){
    const s=String(state||'').toUpperCase();
    if(s==='ENTRY READY')return 'ENTRY_READY';
    if(s==='APPROACHING')return 'APPROACHING';
    if(s==='EARLY WATCH')return 'EARLY_WATCH';
    if(s==='NEWS HOLD')return 'NEWS_HOLD';
    if(s==='LATE DETECTED')return 'CHASE_BLOCK';
    return '';
  }

  function normalizePlan(p,pp,ctx={}){
    if(!p || p.qualifiedPlan!==true)return null;
    const stage=stageFromState(pp?.state);
    if(!stage)return null;

    const type=String(p.type||'PLAN').replace(/_/g,' ');
    const sig=[
      String(p.type||'PLAN'),
      Number(p.entry||0).toFixed(2),
      Number(p.sl||0).toFixed(2)
    ].join('|');

    let enc='';
    try{enc=btoa(unescape(encodeURIComponent(sig))).replace(/[^a-zA-Z0-9]/g,'').slice(0,28)}
    catch(_){enc=String(Math.abs(sig.split('').reduce((a,c)=>((a<<5)-a)+c.charCodeAt(0)|0,0)))}

    return {
      planId:`XAUUSD-${enc}`,
      symbol:'XAUUSD',
      type,
      side:type,
      stage,
      entry:Number(p.entry),
      zoneLow:Number(p.entryLow),
      zoneHigh:Number(p.entryHigh),
      sl:Number(p.sl),
      tp1:Number(p.tp1),
      tp2:Number(p.tp2),
      confidence:Math.max(0,Math.min(100,Number(ctx.confidence)||0)),
      quality:Math.max(0,Math.min(100,Number(ctx.quality)||0)),
      distance:Number(pp?.lead?.distance),
      approachDistance:Number(pp?.lead?.approachDistance),
      currentPrice:Number(ctx.currentPrice),
      reason:String(pp?.note||pp?.executionNote||''),
      expiresAt:Date.now()+3*60*60*1000
    };
  }

  async function sendPlan(plan){
    if(!plan)return false;
    await ensureDevice();
    const key=[
      plan.planId,plan.stage,
      Number(plan.currentPrice||0).toFixed(2),
      Math.round(plan.confidence||0)
    ].join('|');
    if(key===lastKey)return false;
    lastKey=key;
    await api('/telegram/plan',{
      method:'POST',
      body:JSON.stringify(plan)
    });
    return true;
  }

  function syncFromCommand(p,pp,ctx){
    const plan=normalizePlan(p,pp,ctx);
    if(!plan)return;
    queued=plan;
    clearTimeout(timer);
    timer=setTimeout(async()=>{
      const next=queued;queued=null;
      try{await sendPlan(next)}
      catch(e){console.warn('KAGE TELEGRAM SYNC',e)}
    },500);
  }

  window.KageTelegramBridge={
    ensureDevice,
    syncFromCommand,
    async test(){
      await ensureDevice();
      return api('/telegram/test',{method:'POST',body:'{}'});
    }
  };

  // Register once while KAGE is open. No Telegram secret is exposed to GitHub.
  window.addEventListener('load',()=>{
    if(configured()) setTimeout(()=>ensureDevice().catch(e=>console.warn('KAGE TG REGISTER',e)),1200);
  });
})();
