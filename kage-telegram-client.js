(() => {
  'use strict';
  const CFG=()=>window.KAGE_TELEGRAM_CONFIG||{};
  const STORE={
    deviceId:'kage_tg_device_id_v48',
    deviceToken:'kage_tg_device_token_v48',
    lastDecision:'kage_tg_last_decision_v48'
  };
  let timer=null,queued=null;

  function configured(){
    const u=String(CFG().workerUrl||'');
    return /^https:\/\//.test(u)&&!u.includes('YOUR-');
  }
  function deviceId(){
    let id=localStorage.getItem(STORE.deviceId);
    if(!id){
      id='kage-'+(crypto.randomUUID?crypto.randomUUID():
        Date.now().toString(36)+Math.random().toString(36).slice(2));
      localStorage.setItem(STORE.deviceId,id);
    }
    return id;
  }
  function token(){return localStorage.getItem(STORE.deviceToken)||''}
  async function api(path,options={}){
    if(!configured())throw new Error('WORKER_NOT_CONFIGURED');
    const headers=new Headers(options.headers||{});
    headers.set('content-type','application/json');
    if(token()){
      headers.set('x-kage-device-id',deviceId());
      headers.set('x-kage-device-token',token());
    }
    const r=await fetch(CFG().workerUrl.replace(/\/$/,'')+path,{
      ...options,headers,cache:'no-store'
    });
    let data={};try{data=await r.json()}catch(_){}
    if(!r.ok)throw new Error(data.error||`HTTP_${r.status}`);
    return data;
  }
  async function ensureDevice(){
    if(token())return true;
    const r=await api('/telegram/register',{
      method:'POST',
      body:JSON.stringify({deviceId:deviceId()})
    });
    if(!r.deviceToken)throw new Error('DEVICE_TOKEN_MISSING');
    localStorage.setItem(STORE.deviceToken,r.deviceToken);
    return true;
  }
  function lastDecision(){
    try{return JSON.parse(localStorage.getItem(STORE.lastDecision)||'null')}
    catch(_){return null}
  }
  async function sendDecision(decision){
    if(!decision)return;
    await ensureDevice();
    const change=window.KageSignalEngine?.changed?.(lastDecision(),decision)
      || {changed:true,kind:'UNKNOWN'};
    if(!change.changed)return;
    await api('/telegram/decision',{
      method:'POST',
      body:JSON.stringify({changeKind:change.kind,decision})
    });
    localStorage.setItem(STORE.lastDecision,JSON.stringify(decision));
  }
  function publishDecision(decision){
    if(!decision)return;
    queued=decision;
    clearTimeout(timer);
    timer=setTimeout(async()=>{
      const d=queued;queued=null;
      try{await sendDecision(d)}
      catch(e){console.warn('KAGE CLOUD DECISION',e)}
    },500);
  }
  window.KageTelegramBridge={
    ensureDevice,
    publishDecision,
    async test(){
      await ensureDevice();
      return api('/telegram/test',{method:'POST',body:'{}'});
    }
  };
  window.addEventListener('load',()=>{
    if(configured())setTimeout(()=>ensureDevice().catch(()=>{}),1200);
  });
})();
