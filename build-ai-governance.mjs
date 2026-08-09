import fs from 'node:fs';

const CANDIDATE='ai-learning-candidate.json';
const CHAMPION='ai-learning.json';
const PREVIOUS='ai-learning-previous.json';
const GOVERNANCE='ai-model-governance.json';
const JOURNAL='ai-outcome-journal.json';
const VERSION='1.1';
const ENGINE='ONEMONTH-MODEL-GOVERNANCE-V1.1-PENDING-QUALITY';
const HOUR=3600000;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const read=(p,f=null)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch(_){return f}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
const n=v=>Number.isFinite(Number(v))?Number(v):0;
const modelId=m=>m?.modelId||`${m?.engine||'MODEL'}:${m?.sourceFingerprint||'NOFP'}`;

function modelScore(m){
  if(!m?.ready)return 0;
  const mh=m.modelHealth||{},v=m.validation||{},q=m.qualityGuards||{},c=m.current||{},g=m.global||{};
  const health=clamp(n(mh.score),0,100);
  const brier=clamp(n(v.brier||g.brier||.40),0,1);
  const cal=clamp(n(v.calibrationError||g.calibrationError||99),0,100);
  const cov=clamp(n(v.coverage||mh.coverage),0,100);
  const unc=clamp(n(c.uncertaintyPts||mh.uncertaintyPts||90),0,100);
  const drift=clamp(n(mh.driftPts),0,100);
  const samples=n(g.samples);
  const sampleScore=clamp(Math.log10(samples+1)/3*100,0,100);
  const s=health*.30+clamp(100-brier*220,0,100)*.20+clamp(100-cal*3,0,100)*.20+cov*.10+clamp(100-unc*2,0,100)*.08+clamp(100-drift*2.5,0,100)*.07+sampleScore*.05;
  const disqualified=!!q.hardQuarantine||n(v.coverage)<15||n(v.brier)>.34||n(v.calibrationError)>30||samples<55;
  return disqualified?Math.min(35,s):clamp(s,0,100);
}
function compact(m){
  if(!m)return null;
  return{modelId:modelId(m),engine:m.engine||null,sourceFingerprint:m.sourceFingerprint||null,generatedAt:m.generatedAt||null,trainedThrough:m.trainedThrough||null,score:Number(modelScore(m).toFixed(2)),health:n(m.modelHealth?.score),samples:n(m.global?.samples),brier:n(m.validation?.brier),calibration:n(m.validation?.calibrationError),coverage:n(m.validation?.coverage),drift:n(m.modelHealth?.driftPts),uncertainty:n(m.current?.uncertaintyPts),guard:m.qualityGuards?.backgroundUse||'UNKNOWN'};
}
function journalStatsFor(journal,id){
  const rows=(journal?.entries||[]).filter(e=>e.modelId===id&&e.horizons?.M30?.resolved&&e.horizons.M30.correct!==null).slice(-40);
  if(!rows.length)return{samples:0,hitRate:null,avgR:null,goodEntryRate:null,falseSignals:0};
  const hit=rows.filter(e=>e.horizons.M30.correct).length;
  const avgR=rows.reduce((s,e)=>s+n(e.horizons.M30.returnR),0)/rows.length;
  const quality=rows.map(e=>e.horizons.M30.entryQuality).filter(Boolean);
  const good=quality.filter(x=>x==='GOOD_ENTRY').length;
  return{samples:rows.length,hitRate:100*hit/rows.length,avgR,goodEntryRate:quality.length?100*good/quality.length:null,falseSignals:rows.length-hit};
}
function planJournalStatsFor(journal,id){
  const rows=(journal?.planEntries||[]).filter(e=>e.modelId===id&&e.horizons?.M30?.resolved&&e.horizons.M30.correct!==null).slice(-40);
  if(!rows.length)return{samples:0,hitRate:null,avgR:null,goodEntryRate:null,fillCount:0};
  const hit=rows.filter(e=>e.horizons.M30.correct).length,avgR=rows.reduce((s,e)=>s+n(e.horizons.M30.returnR),0)/rows.length,good=rows.filter(e=>e.horizons.M30.entryQuality==='GOOD_ENTRY').length;
  return{samples:rows.length,hitRate:100*hit/rows.length,avgR,goodEntryRate:100*good/rows.length,fillCount:rows.length};
}
function annotate(m,role,gov){
  return{...m,modelId:modelId(m),role,governance:{...(m.governance||{}),...gov}};
}

const candidate=read(CANDIDATE);
let champion=read(CHAMPION);
let previous=read(PREVIOUS);
const journal=read(JOURNAL,{entries:[]});
let state=read(GOVERNANCE,{version:VERSION,engine:ENGINE,promotions:[],rollbacks:[]});
if(!candidate){console.log('Governance: no challenger pack yet');process.exit(0)}

candidate.modelId=modelId(candidate);
if(champion)champion.modelId=modelId(champion);
if(previous)previous.modelId=modelId(previous);

const now=new Date().toISOString();
let action='KEEP_CHAMPION',reason='Champion remains stronger or challenger not proven';
let rolledBack=false,promoted=false;

// 1) Auto rollback if the deployed champion has accumulated clearly poor live shadow outcomes.
if(champion&&previous){
  const live=journalStatsFor(journal,modelId(champion)),planLive=planJournalStatsFor(journal,modelId(champion));
  const prevScore=modelScore(previous),champScore=modelScore(champion);
  const badSignal=live.samples>=12&&((live.hitRate!=null&&live.hitRate<38)||(live.avgR!=null&&live.avgR<-.10));
  const badPending=planLive.samples>=10&&((planLive.hitRate!=null&&planLive.hitRate<38)||(planLive.avgR!=null&&planLive.avgR<-.12));
  const badLive=badSignal||badPending;
  if(badLive&&prevScore>=champScore-3){
    const bad=champion;champion=previous;previous=bad;rolledBack=true;
    write(PREVIOUS,annotate(previous,'PREVIOUS',{retiredAt:now,retireReason:'AUTO_ROLLBACK_DEGRADED'}));
    action='AUTO_ROLLBACK';reason=badPending?`Pending-plan quality degraded: ${planLive.samples} fills, hit ${planLive.hitRate?.toFixed(1)??'—'}%, avgR ${planLive.avgR?.toFixed(3)??'—'}`:`Champion live journal degraded: ${live.samples} samples, hit ${live.hitRate?.toFixed(1)??'—'}%, avgR ${live.avgR?.toFixed(3)??'—'}`;
    state.rollbacks=[...(state.rollbacks||[]),{at:now,from:modelId(bad),to:modelId(champion),reason,live,planLive}].slice(-30);
  }
}

// 2) Champion vs challenger. A fresh challenger must be non-inferior, or materially better.
const candScore=modelScore(candidate),champScore=modelScore(champion);
const candQ=candidate.qualityGuards||{},candV=candidate.validation||{},candG=candidate.global||{};
const candQualified=!!candidate.ready&&!candQ.hardQuarantine&&n(candV.coverage)>=15&&n(candV.brier)<=.34&&n(candV.calibrationError)<=30&&n(candG.samples)>=55;
const champAge=champion?.generatedAt?Date.now()-Date.parse(champion.generatedAt):Infinity;
const materiallyBetter=!champion||candScore>=champScore+1.5;
const freshNonInferior=!!champion&&champAge>12*HOUR&&candScore>=champScore-1.5;
const legacyMigration=!!champion&&champion.engine!==candidate.engine&&candScore>=champScore-3;
const rollbackProtection=rolledBack; // cooling-off: never replace a just-restored safe model in the same run

if(candQualified&&!rollbackProtection&&(materiallyBetter||freshNonInferior||legacyMigration)){
  const old=champion;
  if(old)write(PREVIOUS,annotate(old,'PREVIOUS',{retiredAt:now}));
  champion=annotate(candidate,'CHAMPION',{deployedAt:now,promotionReason:legacyMigration?'V34_3_GOVERNANCE_MIGRATION':materiallyBetter?'BETTER_VALIDATION':'FRESH_NON_INFERIOR'});
  write(CHAMPION,champion);
  promoted=true;action='PROMOTE_CHALLENGER';reason=legacyMigration?`Migrate legacy champion into V34.3 governance (${candScore.toFixed(1)} vs ${champScore.toFixed(1)})`:materiallyBetter?`Challenger score ${candScore.toFixed(1)} > champion ${champScore.toFixed(1)}`:`Champion age >12h and challenger is non-inferior (${candScore.toFixed(1)} vs ${champScore.toFixed(1)})`;
  state.promotions=[...(state.promotions||[]),{at:now,from:old?modelId(old):null,to:modelId(champion),candidateScore:Number(candScore.toFixed(2)),championScore:Number(champScore.toFixed(2)),reason}].slice(-50);
}else if(!champion){
  champion=annotate(candidate,'CHAMPION',{deployedAt:now,promotionReason:'FIRST_MODEL'});write(CHAMPION,champion);promoted=true;action='PROMOTE_FIRST_MODEL';reason='No champion existed';
}else{
  // Keep the proven champion. Update governance metadata only, never its training timestamp.
  champion=annotate(champion,'CHAMPION',{lastChallengedAt:now,lastChallengerId:modelId(candidate),lastChallengerScore:Number(candScore.toFixed(2)),keepReason:reason});write(CHAMPION,champion);
}

const deployed=read(CHAMPION,champion),deployedStats=journalStatsFor(journal,modelId(deployed)),deployedPlanStats=planJournalStatsFor(journal,modelId(deployed));
state={...state,version:VERSION,engine:ENGINE,updatedAt:now,action,reason,champion:compact(deployed),challenger:compact(candidate),previous:compact(read(PREVIOUS,previous)),deployedJournal:deployedStats,deployedPlanJournal:deployedPlanStats,decision:{promoted,rolledBack,candidateQualified:candQualified,materiallyBetter,freshNonInferior,legacyMigration}};
write(GOVERNANCE,state);
console.log(`Governance ${action}: ${reason}`);
console.log('Champion',state.champion);
console.log('Challenger',state.challenger);
