import {loadPlan,savePlan,clearPlan,loadSettings,saveSettings,aiEnabled,setAiEnabledStorage,apiUsage,getSignals,putSignal,exportSignals,loadActiveSignal,saveActiveSignal} from './storage.js';
import {loadStaticPack,loadNewsPack,fetchTf,refreshNews,marketStatus,nextNews,newsLock} from './market.js';
import {analyzeTf,chooseSetup,memoryStats,riskGuardian,lotForSetup,fingerprint} from './engine.js';
import {ema,pivots,clamp} from './indicators.js';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const money=n=>'$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const price=n=>Number.isFinite(Number(n))?Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const pct=n=>(Number(n||0)*100).toFixed(2)+'%';
const toast=t=>{const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>el.classList.remove('show'),2200)};

let plan=loadPlan();
let settings=loadSettings();
let AI=aiEnabled();
let data={M1:[],M5:[],M15:[],H1:[]};
let results={};
let setup=null;
let newsPack={events:[]};
let signals=[];
let activeSignal=loadActiveSignal();
let currentTf='M15';
let scanning=false;

const chartView={
  bars:34,offset:0,crossIndex:null,drag:false,
  dragStartX:0,dragStartOffset:0,moved:false,
  pinchDistance:0,pinchBars:34
};
const tfDefaultBars={M1:30,M5:32,M15:34,H1:36};
function resetChartView(){
  chartView.bars=tfDefaultBars[currentTf]||34;
  chartView.offset=0;
  chartView.crossIndex=null;
  chartView.drag=false;
  chartView.moved=false;
}


function recommendedGrowth(balance){if(balance<50)return .08;if(balance<200)return .07;if(balance<500)return .065;if(balance<2000)return .06;if(balance<10000)return .05;return .04}
function dailyRate(start,target,days){return start>0&&target>start&&days>0?Math.pow(target/start,1/days)-1:0}
function completed(){return plan?.days?.filter(d=>d.actual!=null).length||0}
function currentBalance(){const done=plan?.days?.filter(d=>d.actual!=null)||[];return done.length?Number(done.at(-1).actual):Number(plan?.start||0)}
function todayIndex(){return Math.min(completed(),Math.max(0,(plan?.totalDays||30)-1))}
function maxLossForDay(balance,profit,rate){const r=clamp(rate*.7,.0025,.01),byBal=balance*r,byTarget=Math.max(profit*.85,balance*.0025);return Math.min(balance*.01,Math.max(byBal,Math.min(byTarget,balance*.01)))}
function buildPlan(start,target){plan={start,target,totalDays:30,days:[]};recalcPlan();savePlan(plan)}
function recalcPlan(){
  if(!plan)return;const done=completed(),remain=plan.totalDays-done,actuals=plan.days.map(d=>d.actual),old=plan.days.map(d=>({...d}));let bal=currentBalance(),rate=dailyRate(bal,plan.target,remain),rows=[];
  for(let i=0;i<plan.totalDays;i++){
    if(i<done){const p=old[i]||{},startBal=i===0?plan.start:Number(actuals[i-1]),actual=Number(actuals[i]);rows.push({...p,day:i+1,start:startBal,actual,status:p.status||'wait'});bal=actual}
    else{const profit=bal*rate,expected=bal+profit;rows.push({day:i+1,start:bal,profit,expected,rate,maxLoss:maxLossForDay(bal,profit,rate),actual:null,status:'wait'});bal=expected}
  }
  plan.days=rows;savePlan(plan)
}
function planMaxDrawdown(){if(!plan)return 0;const vals=[plan.start,...plan.days.filter(d=>d.actual!=null).map(d=>Number(d.actual))];let peak=vals[0]||0,max=0;for(const v of vals){peak=Math.max(peak,v);if(peak)max=Math.max(max,(peak-v)/peak)}return max}

function openModal(id){const m=$(id);m.classList.add('open');m.setAttribute('aria-hidden','false')}
function closeModal(id){const m=$(id);m.classList.remove('open');m.setAttribute('aria-hidden','true')}
function showView(name){$$('.view').forEach(v=>v.classList.toggle('active',v.dataset.view===name));$$('[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===name));window.scrollTo({top:0,behavior:'smooth'});if(name==='ai')requestAnimationFrame(drawMarketChart);if(name==='stats')requestAnimationFrame(drawEquity)}

function renderMarketMode(){const st=marketStatus();const el=$('#marketModePill');el.className='market-pill '+(st.open?'live':'closed');$('#marketModeText').textContent=st.open?'MARKET OPEN':'MARKET CLOSED';const feed=$('#feedPill');if(data[currentTf]?.length){feed.className='feed-pill '+(st.open&&AI?'live':'');feed.querySelector('b').textContent=st.open&&AI?'LIVE READY':'HISTORICAL'}else{feed.className='feed-pill';feed.querySelector('b').textContent='STATIC DATA'}}

function renderHome(){
  if(!plan)return;
  const done=completed(),bal=currentBalance(),idx=todayIndex(),d=plan.days[idx],progress=plan.target>plan.start?clamp((bal-plan.start)/(plan.target-plan.start),0,1):1;
  $('#heroBalance').textContent=money(bal);$('#heroBalanceMeta').textContent=(bal-plan.start>=0?'+':'')+money(bal-plan.start)+' since start';$('#homeTarget').textContent=money(plan.target);$('#homeDay').textContent=String(Math.min(done+1,30)).padStart(2,'0')+' / 30';$('#monthProgressBar').style.width=(progress*100)+'%';
  const expected=done?plan.days[done-1].expected:plan.start,diff=bal-expected;$('#homePace').textContent=done===0||Math.abs(diff)<.01?'ON PLAN':diff>0?'AHEAD':'BEHIND';
  if(done>=30){$('#todayProfit').textContent='DONE';$('#todayStart').textContent=money(bal);$('#todayClose').textContent=money(bal);$('#todayMaxLoss').textContent='—';$('#todayRate').textContent='ครบ 30 session';$('#todayStatus').textContent='DONE';return}
  $('#todayProfit').textContent='+'+money(d.profit);$('#todayRate').textContent=pct(d.rate)+' / session';$('#todayStart').textContent=money(d.start);$('#todayClose').textContent=money(d.expected);$('#todayMaxLoss').textContent='-'+money(d.maxLoss);$('#todayRule').textContent='ถึง '+money(d.expected)+' = จบ Session · ต่ำกว่า '+money(d.start-d.maxLoss)+' = หยุดวันนั้น';$('#todayStatus').textContent=d.status==='wait'?'ACTIVE':d.status.toUpperCase();$('#todayStatus').className='status-dot '+(d.status==='hit'?'hit':d.status==='miss'?'miss':'neutral');$('#actualBalance').placeholder='เป้าปิด '+money(d.expected)
}

function renderPlan(){if(!plan)return;const done=completed();$('#roadmapProgress').textContent=Math.round(done/30*100)+'%';$('#roadmapRemaining').textContent=(30-done)+' days';$('#roadmapTarget').textContent=money(plan.target);$('#roadmapTrack').style.width=(done/30*100)+'%';$('#planList').innerHTML=plan.days.map((d,i)=>`<article class="plan-row ${d.status} ${i===todayIndex()&&done<30?'current':''}"><div class="plan-row-head"><div class="day-box">${String(d.day).padStart(2,'0')}</div><div class="plan-row-main"><b>DAY ${String(d.day).padStart(2,'0')}</b><small>${money(d.start)} → ${money(d.expected)}</small></div><div class="plan-row-profit"><span>TARGET</span><b>+${money(d.profit)}</b></div></div><div class="plan-row-meta"><div><span>CLOSE GOAL</span><b>${money(d.expected)}</b></div><div class="result"><span>RESULT</span><b>${d.actual==null?'ยังไม่จบวัน':money(d.actual)}</b></div></div></article>`).join('')}

function renderStats(){
  const done=plan?.days?.filter(d=>d.actual!=null)||[],hits=done.filter(d=>d.status==='hit').length,scored=signals.filter(s=>['TP1','TP2','SL'].includes(s.outcome)),wins=scored.filter(s=>s.outcome==='TP1'||s.outcome==='TP2').length;
  $('#planHitRate').textContent=done.length?Math.round(hits/done.length*100)+'%':'—';$('#drawdown').textContent=(planMaxDrawdown()*100).toFixed(2)+'%';$('#signalCount').textContent=scored.length;$('#signalWinRate').textContent=scored.length?Math.round(wins/scored.length*100)+'%':'—';
  const groups={};scored.forEach(s=>{groups[s.fingerprint]=groups[s.fingerprint]||[];groups[s.fingerprint].push(s)});const ranked=Object.entries(groups).map(([k,a])=>({k,n:a.length,w:a.filter(x=>x.outcome!=='SL').length})).filter(x=>x.n>=3).sort((a,b)=>(b.w/b.n)-(a.w/a.n));
  $('#memorySummary').innerHTML=[['BEST PATTERN',ranked[0]?ranked[0].k.split('|').slice(0,2).join(' · '):'LEARNING'],['SAMPLES',scored.length],['SIGNAL MEMORY','IndexedDB'],['DATA PACK','GitHub + Local']].map(([a,b])=>`<div class="memory-chip"><span>${a}</span><b>${b}</b></div>`).join('');
  $('#replayList').innerHTML=signals.length?signals.slice(0,15).map(s=>`<div class="replay-item"><div class="replay-head"><div><b>${s.side} · ${s.tf} · ${s.setupType}</b><small>${new Intl.DateTimeFormat('th-TH',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(s.createdAt))}</small></div><span class="outcome ${s.outcome==='SL'?'loss':'win'}">${s.outcome}</span></div><div class="replay-levels"><div><span>ENTRY</span><b>${price(s.entryCenter)}</b></div><div><span>SL</span><b>${price(s.sl)}</b></div><div><span>TP1</span><b>${price(s.tp1)}</b></div></div></div>`).join(''):'<div class="empty-row">ยังไม่มีสัญญาณที่จบผล</div>';
}

function drawEquity(){const canvas=$('#equityChart');if(!canvas||!plan)return;const r=canvas.getBoundingClientRect();if(r.width<10)return;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=r.width*dpr;canvas.height=r.height*dpr;const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);const W=r.width,H=r.height,pad={l:6,r:6,t:12,b:16};ctx.clearRect(0,0,W,H);const expected=[plan.start,...plan.days.map(d=>d.expected)],actual=[plan.start,...plan.days.filter(d=>d.actual!=null).map(d=>Number(d.actual))],all=[...expected,...actual];let lo=Math.min(...all),hi=Math.max(...all),rg=Math.max(1,hi-lo);lo-=rg*.12;hi+=rg*.12;const x=i=>pad.l+(W-pad.l-pad.r)*i/30,y=v=>pad.t+(H-pad.t-pad.b)*(1-(v-lo)/(hi-lo));ctx.strokeStyle='rgba(255,255,255,.06)';for(let i=0;i<4;i++){const yy=pad.t+(H-pad.t-pad.b)*i/3;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(W-pad.r,yy);ctx.stroke()}const line=(arr,col,w)=>{ctx.strokeStyle=col;ctx.lineWidth=w;ctx.beginPath();arr.forEach((v,i)=>i?ctx.lineTo(x(i),y(v)):ctx.moveTo(x(i),y(v)));ctx.stroke()};line(expected,'rgba(143,216,255,.55)',1.4);if(actual.length>1)line(actual,'rgba(114,232,190,.95)',2.2);const bal=currentBalance(),expectedNow=actual.length>1?plan.days[actual.length-2].expected:plan.start,diff=bal-expectedNow;$('#equityMeta').textContent=actual.length===1?'On plan':diff>=0?'+'+money(diff)+' ahead':'-'+money(Math.abs(diff))+' behind'}

function chartEmpty(show,title='',desc='',action=''){
  const el=$('#chartEmpty');el.classList.toggle('hidden',!show);
  if(show){$('#chartEmptyTitle').textContent=title;$('#chartEmptyText').textContent=desc;$('#chartEmptyAction').textContent=action||'โหลดข้อมูล'}
}
function candleTime(c){
  if(!c)return'—';
  const dt=Number.isFinite(c.ts)?new Date(c.ts):new Date(String(c.datetime||'').replace(' ','T')+'Z');
  if(!Number.isFinite(dt.getTime()))return'—';
  const opts=currentTf==='H1'?{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}:{hour:'2-digit',minute:'2-digit'};
  return new Intl.DateTimeFormat('th-TH',opts).format(dt);
}
function updateOhlc(c){
  if(!c)return;
  $('#chartCandleTime').textContent=candleTime(c);
  $('#ohlcO').textContent=price(c.open);$('#ohlcH').textContent=price(c.high);$('#ohlcL').textContent=price(c.low);$('#ohlcC').textContent=price(c.close);
}
function visibleChartData(){
  const src=data[currentTf]||[];if(!src.length)return{src,visible:[],start:0,end:0};
  const maxBars=Math.min(72,src.length);
  chartView.bars=clamp(Math.round(chartView.bars),Math.min(18,maxBars),maxBars);
  const bars=chartView.bars,maxOffset=Math.max(0,src.length-bars);
  chartView.offset=clamp(Math.round(chartView.offset),0,maxOffset);
  let end=src.length-chartView.offset,start=Math.max(0,end-bars);end=Math.min(src.length,start+bars);
  return{src,visible:src.slice(start,end),start,end};
}
function drawRoundedTag(ctx,x,y,w,h,fill,text,textColor='#0a0e12'){
  ctx.save();ctx.fillStyle=fill;ctx.beginPath();
  if(ctx.roundRect)ctx.roundRect(x,y,w,h,5);else ctx.rect(x,y,w,h);
  ctx.fill();ctx.fillStyle=textColor;ctx.font='700 8px -apple-system,BlinkMacSystemFont,sans-serif';
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,x+w/2,y+h/2+.3);ctx.restore();
}
function drawMarketChart(){
  const canvas=$('#marketChart');if(!canvas)return;
  const vd=visibleChartData(),candles=vd.visible;
  if(candles.length<8){chartEmpty(true,'ยังไม่มีข้อมูล '+currentTf,'โหลดจาก GitHub Historical Pack ก่อน หรือเปิด AI เพื่อดึงข้อมูลสด','โหลด '+currentTf);return}
  chartEmpty(false);

  const rect=canvas.getBoundingClientRect();if(rect.width<10)return;
  const dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);

  const W=rect.width,H=rect.height,pad={l:10,r:57,t:14,b:28},pw=W-pad.l-pad.r,ph=H-pad.t-pad.b;
  ctx.clearRect(0,0,W,H);

  const warmStart=Math.max(0,vd.start-80),warm=vd.src.slice(warmStart,vd.end),warmCloses=warm.map(c=>c.close);
  const ema9Full=ema(warmCloses,9),ema21Full=ema(warmCloses,21),vo=vd.start-warmStart;
  const e9=ema9Full.slice(vo,vo+candles.length),e21=ema21Full.slice(vo,vo+candles.length);

  const candleLo=Math.min(...candles.map(c=>c.low)),candleHi=Math.max(...candles.map(c=>c.high)),candleRange=Math.max(.01,candleHi-candleLo);
  const drawingLevels=setup&&setup.tf===currentTf&&setup.side!=='WAIT'?[setup.entryLow,setup.entryHigh,setup.sl,setup.tp1,setup.tp2].filter(Number.isFinite):[];
  const nearby=drawingLevels.filter(v=>v>=candleLo-candleRange*.35&&v<=candleHi+candleRange*.35);
  let lo=Math.min(candleLo,...nearby),hi=Math.max(candleHi,...nearby),range=Math.max(.02,hi-lo);lo-=range*.07;hi+=range*.07;range=hi-lo;

  const y=p=>pad.t+(hi-p)/range*ph,step=pw/candles.length,bodyW=clamp(step*.58,4.2,10);
  ctx.fillStyle='#080c10';ctx.fillRect(0,0,W,H);
  ctx.fillStyle='rgba(13,19,25,.72)';ctx.fillRect(W-pad.r+1,0,pad.r-1,H);

  ctx.lineWidth=1;ctx.strokeStyle='rgba(159,174,188,.075)';
  for(let i=0;i<5;i++){
    const yy=pad.t+ph*i/4;ctx.beginPath();ctx.moveTo(pad.l,yy+.5);ctx.lineTo(W-pad.r,yy+.5);ctx.stroke();
    const p=hi-range*i/4;ctx.fillStyle='rgba(145,157,170,.66)';ctx.font='8px ui-monospace,SFMono-Regular,Menlo,monospace';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText(p.toFixed(2),W-5,yy);
  }
  for(let i=1;i<4;i++){const xx=pad.l+pw*i/4;ctx.strokeStyle='rgba(159,174,188,.045)';ctx.beginPath();ctx.moveTo(xx+.5,pad.t);ctx.lineTo(xx+.5,H-pad.b);ctx.stroke()}

  const setupOnChart=setup&&setup.side!=='WAIT'&&setup.tf===currentTf;
  if(setupOnChart&&Number.isFinite(setup.entryLow)&&Number.isFinite(setup.entryHigh)){
    const a=y(Math.max(setup.entryLow,setup.entryHigh)),b=y(Math.min(setup.entryLow,setup.entryHigh));
    if(b>=pad.t&&a<=H-pad.b){ctx.fillStyle='rgba(104,194,229,.075)';ctx.fillRect(pad.l+pw*.34,Math.max(pad.t,a),pw*.66,Math.max(2,Math.min(H-pad.b,b)-Math.max(pad.t,a)))}
  }

  function curve(values,color,width){
    ctx.save();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();
    values.forEach((v,i)=>{if(!Number.isFinite(v))return;const xx=pad.l+step*i+step/2,yy=y(v);if(i===0)ctx.moveTo(xx,yy);else ctx.lineTo(xx,yy)});
    ctx.stroke();ctx.restore();
  }
  curve(e21,'rgba(216,179,95,.72)',1.45);curve(e9,'rgba(105,199,235,.86)',1.6);

  candles.forEach((c,i)=>{
    const xx=pad.l+step*i+step/2,up=c.close>=c.open;
    const wick=up?'rgba(106,218,174,.82)':'rgba(239,105,125,.82)',fill=up?'rgba(93,211,164,.90)':'rgba(235,94,117,.90)',edge=up?'rgba(132,234,194,.96)':'rgba(250,132,148,.96)';
    const oy=y(c.open),cy=y(c.close),hy=y(c.high),ly=y(c.low),top=Math.min(oy,cy),bottom=Math.max(oy,cy),bodyH=Math.max(2.2,bottom-top);
    ctx.strokeStyle=wick;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(xx,hy);ctx.lineTo(xx,ly);ctx.stroke();
    ctx.fillStyle=fill;ctx.fillRect(xx-bodyW/2,top,bodyW,bodyH);ctx.strokeStyle=edge;ctx.lineWidth=.65;ctx.strokeRect(xx-bodyW/2+.35,top+.35,Math.max(1,bodyW-.7),Math.max(1,bodyH-.7));
  });

  const ps=pivots(candles,2,2);
  [...ps.highs.slice(-2).map(p=>({...p,type:'SH'})),...ps.lows.slice(-2).map(p=>({...p,type:'SL'}))].sort((a,b)=>a.i-b.i).forEach(p=>{
    const xx=pad.l+step*p.i+step/2,yy=y(p.price),high=p.type==='SH';
    ctx.save();ctx.strokeStyle='rgba(169,181,193,.65)';ctx.fillStyle='rgba(169,181,193,.78)';ctx.lineWidth=1;ctx.beginPath();
    if(high){ctx.moveTo(xx-3,yy-5);ctx.lineTo(xx,yy-1);ctx.lineTo(xx+3,yy-5)}else{ctx.moveTo(xx-3,yy+5);ctx.lineTo(xx,yy+1);ctx.lineTo(xx+3,yy+5)}
    ctx.stroke();ctx.font='700 6px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textAlign='center';ctx.textBaseline=high?'bottom':'top';ctx.fillText(p.type,xx,high?yy-7:yy+7);ctx.restore();
  });

  function levelLine(p,label,color,tagFill,dash=[5,4]){
    if(!Number.isFinite(p))return;const yy=y(p);if(yy<pad.t-2||yy>H-pad.b+2)return;
    ctx.save();ctx.setLineDash(dash);ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad.l+pw*.34,yy+.5);ctx.lineTo(W-pad.r,yy+.5);ctx.stroke();ctx.restore();
    const tagW=label.length>5?42:34;drawRoundedTag(ctx,W-pad.r-tagW-4,yy-8,tagW,16,tagFill,label,'#081014');
  }
  if(setupOnChart){levelLine(setup.entryCenter,'ENTRY','rgba(105,199,235,.62)','#69c7eb');levelLine(setup.sl,'SL','rgba(235,94,117,.64)','#eb6679',[4,4]);levelLine(setup.tp1,'TP1','rgba(93,211,164,.60)','#5dd3a4');levelLine(setup.tp2,'TP2','rgba(93,211,164,.38)','#426e61',[3,5])}

  const idx=[0,Math.floor((candles.length-1)/2),candles.length-1];
  ctx.fillStyle='rgba(129,142,155,.62)';ctx.font='7px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textBaseline='bottom';
  idx.forEach((i,n)=>{const xx=pad.l+step*i+step/2;ctx.textAlign=n===0?'left':n===2?'right':'center';ctx.fillText(candleTime(candles[i]),n===0?pad.l:n===2?W-pad.r:xx,H-5)});

  const last=candles.at(-1),prev=candles.at(-2)||last,nowY=y(last.close),nowColor=last.close>=prev.close?'#5dd3a4':'#eb6679';
  if(nowY>=pad.t&&nowY<=H-pad.b){
    ctx.save();ctx.setLineDash([2,4]);ctx.strokeStyle='rgba(211,222,231,.26)';ctx.beginPath();ctx.moveTo(pad.l,nowY+.5);ctx.lineTo(W-pad.r,nowY+.5);ctx.stroke();ctx.restore();
    drawRoundedTag(ctx,W-pad.r+3,clamp(nowY-9,pad.t,H-pad.b-18),pad.r-7,18,nowColor,last.close.toFixed(2));
  }

  if(Number.isInteger(chartView.crossIndex)&&chartView.crossIndex>=0&&chartView.crossIndex<candles.length){
    const i=chartView.crossIndex,c=candles[i],xx=pad.l+step*i+step/2,yy=y(c.close);
    ctx.save();ctx.setLineDash([3,4]);ctx.strokeStyle='rgba(205,216,226,.28)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(xx,pad.t);ctx.lineTo(xx,H-pad.b);ctx.stroke();ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(W-pad.r,yy);ctx.stroke();ctx.restore();
    ctx.fillStyle='#dce5eb';ctx.beginPath();ctx.arc(xx,yy,2.6,0,Math.PI*2);ctx.fill();updateOhlc(c);
  }else updateOhlc(last);

  $('#chartPrice').textContent=price(last.close);$('#chartTf').textContent=currentTf;$('#chartLatest').classList.toggle('active',chartView.offset===0);renderMarketMode()
}

function renderNews(){const events=newsPack.events||[],now=Date.now(),upcoming=events.map(e=>({...e,ts:Date.parse(e.date)})).filter(e=>Number.isFinite(e.ts)&&e.ts>now-20*60_000).sort((a,b)=>a.ts-b.ts).slice(0,8);$('#newsList').innerHTML=upcoming.length?upcoming.map(e=>{const d=new Date(e.ts),time=new Intl.DateTimeFormat('th-TH',{hour:'2-digit',minute:'2-digit'}).format(d),imp=e.importance>=3?'high':'medium';return`<div class="news-item"><div class="news-row"><div class="news-time">${time}</div><div class="news-copy"><b>${e.event}</b><small>Forecast ${e.forecast??'—'} · Previous ${e.previous??'—'}</small></div><span class="impact ${imp}">${e.importance>=3?'HIGH':'MED'}</span></div></div>`}).join(''):'<div class="empty-row">ไม่มีข่าวสำคัญในช่วงที่โหลดมา</div>'}

async function loadStatic(){try{const pack=await loadStaticPack();for(const tf of Object.keys(data))if(Array.isArray(pack[tf])&&pack[tf].length)data[tf]=pack[tf];drawMarketChart();renderMarketMode()}catch(e){chartEmpty(true,'Historical Pack ยังว่าง','GitHub Action จะสร้าง data/xauusd.json หลังตั้ง Secret และรันครั้งแรก','ใช้ AI API')}}
async function loadNews(){try{newsPack=await loadNewsPack();renderNews()}catch{newsPack={events:[]};renderNews()}}

async function loadTf(tf,force=false){if(!AI||!settings.apiKey)return false;try{chartEmpty(true,'กำลังโหลด '+tf,'Smart cache จะไม่ยิง API ซ้ำถ้าแท่งยังไม่หมดอายุ','กำลังโหลด…');const r=await fetchTf(tf,settings.apiKey,force);data[tf]=r.data;drawMarketChart();renderApi();return true}catch(e){chartEmpty(true,'โหลด '+tf+' ไม่สำเร็จ',e.message,'ลองใหม่');toast(e.message);return false}}
function renderApi(){const u=apiUsage();$('#apiToday').textContent=u.count;$('#apiLast').textContent='Last scan '+u.lastScan}

async function runAi(force=false){
  if(scanning)return;if(!AI){toast('เปิด AI ก่อน');return}if(!settings.apiKey){openSettings();toast('ใส่ Twelve Data API Key ก่อน');return}scanning=true;try{
    const open=marketStatus().open;
    await Promise.all(['H1','M15'].map(tf=>loadTf(tf,force)));
    results.H1=analyzeTf(data.H1,'H1');results.M15=analyzeTf(data.M15,'M15');
    if(open&&results.H1&&results.M15&&results.H1.direction===results.M15.direction)await loadTf('M5',force);
    if(data.M5?.length)results.M5=analyzeTf(data.M5,'M5');
    if(open&&results.M5&&results.M15&&results.M5.direction===results.M15.direction&&results.M5.quality>=68)await loadTf('M1',force);
    if(data.M1?.length)results.M1=analyzeTf(data.M1,'M1');
    const nl=newsLock(newsPack.events||[]),pre=chooseSetup(results,{news:nl,marketOpen:open}),mem=memoryStats(signals,pre),guard=riskGuardian(plan,signals);setup=chooseSetup(results,{news:nl,memory:mem,marketOpen:open});setup.guardian=guard;setup.memory=mem;
    if(guard.locked)setup={...setup,side:'WAIT',reason:guard.reasons.join(' · ')||'RISK GUARDIAN LOCK'};
    updateSignalLifecycle();renderAi();drawMarketChart();toast(open?'วิเคราะห์ตลาดแล้ว':'โหลด Session ล่าสุดแล้ว');
  }finally{scanning=false;renderApi()}
}

function currentDayRisk(){const d=plan?.days?.[todayIndex()];return d||{maxLoss:0}}
function renderAi(){
  const open=marketStatus().open,guard=riskGuardian(plan,signals),d=currentDayRisk(),lot=lotForSetup(setup,{balance:currentBalance(),maxLoss:d.maxLoss,contractSize:settings.contractSize,minLot:settings.minLot,lotFactor:settings.lotFactor,guardian:guard,riskPct:settings.riskPct}),n=nextNews(newsPack.events||[]),nl=newsLock(newsPack.events||[]);
  $('#bestTf').textContent=setup?.tf||'—';$('#bestTfMeta').textContent=setup?.setupType||'รอสแกน';const side=setup?.side||'WAIT';$('#direction').textContent=side;$('#direction').style.color=side==='BUY'?'var(--accent)':side==='SELL'?'var(--danger)':'var(--warning)';$('#confidence').textContent='Confidence '+(setup?.score??0)+'%';$('#lotToday').textContent=lot.suggested?lot.suggested+' lot':'—';$('#maxLotToday').textContent='Max '+(lot.max?lot.max+' lot':'—');
  let state='WAIT',cls='wait',title='ยังไม่มี Setup',reason=setup?.reason||'รอสแกน',action='ไม่เข้าไม้จนกว่าจะมี Setup ที่ผ่านครบ';
  if(!AI){title='AI OFF · 0 CREDIT';reason='ใช้ Historical Pack ได้โดยไม่ยิง API';action='เปิด AI เมื่อพร้อมวิเคราะห์'}
  else if(!open){state='CLOSED';title='MARKET CLOSED · LAST SESSION';reason=setup?`${setup.direction||'—'} bias · ${setup.regime||'—'}`:'โหลด H1/M15 ล่าสุดเพื่อดู Bias';action='ดูกราฟย้อนหลังได้ แต่ Entry ใหม่ถูกปิด'}
  else if(guard.locked){state='LOCK';cls='lock';title='RISK GUARDIAN LOCK';reason=guard.reasons.join(' · ');action='หยุดเพิ่มความเสี่ยง'}
  else if(nl.lock){state='NEWS';cls='lock';title='NEWS LOCK';reason='ข่าวแรงใกล้ออก';action='รอหลังข่าวแล้วสแกนใหม่'}
  else if(setup?.side==='BUY'||setup?.side==='SELL'){state=setup.side;cls=setup.side.toLowerCase();title=setup.side+' '+setup.tf+' · '+setup.setupType;reason=setup.reason;action='Setup ผ่าน · รอราคาเข้า Entry Zone เท่านั้น'}
  $('#commandState').textContent=state;$('#commandState').className='command-state '+cls;$('#commandTitle').textContent=title;$('#commandReason').textContent=reason;$('#commandAction').textContent=action;$('#commandAction').className='command-action '+(cls==='lock'?'lock':setup?.side!=='WAIT'?'ready':'');$('#regime').textContent=setup?.regime||'—';$('#session').textContent=setup?.session||'—';$('#memoryEdge').textContent=setup?.memory?.n?Math.round(setup.memory.rate*100)+'% · n'+setup.memory.n:'NEW';$('#nextNews').textContent=n?new Intl.DateTimeFormat('th-TH',{hour:'2-digit',minute:'2-digit'}).format(new Date(n.ts)):'CLEAR';
  $('#setupTitle').textContent=side;$('#setupTitle').style.color=side==='BUY'?'var(--accent)':side==='SELL'?'var(--danger)':'var(--warning)';$('#setupScore').textContent=(setup?.score??0)+'%';$('#setupReason').textContent=setup?.reason||'ระบบยังไม่อนุญาต Entry';$('#entry').textContent=setup?.side!=='WAIT'?price(setup.entryLow)+'–'+price(setup.entryHigh):'—';$('#sl').textContent=setup?.side!=='WAIT'?price(setup.sl):'—';$('#tp1').textContent=setup?.side!=='WAIT'?price(setup.tp1):'—';$('#tp2').textContent=setup?.side!=='WAIT'?price(setup.tp2):'—';$('#rr').textContent=setup?.side!=='WAIT'?'1 : '+setup.rr.toFixed(2):'—';$('#setupExpiry').textContent=activeSignal?'Expires '+new Intl.DateTimeFormat('th-TH',{hour:'2-digit',minute:'2-digit'}).format(new Date(activeSignal.expiresAt)):'No active signal';renderMarketMode();renderApi()
}

function newActiveSignal(s){return{id:'SIG-'+Date.now(),createdAt:Date.now(),expiresAt:Date.now()+({M1:18,M5:45,M15:120,H1:300}[s.tf]||90)*60_000,status:'WATCH',side:s.side,direction:s.direction,tf:s.tf,setupType:s.setupType,session:s.session,regime:s.regime,score:s.score,entryLow:s.entryLow,entryHigh:s.entryHigh,entryCenter:s.entryCenter,sl:s.sl,tp1:s.tp1,tp2:s.tp2,atr:s.atr,fingerprint:fingerprint(s),hitTp1:false}}
function updateSignalLifecycle(){if(!setup||setup.side==='WAIT'||!marketStatus().open)return;if(activeSignal&&activeSignal.status&&!['SL','TP2','INVALID','EXPIRED'].includes(activeSignal.status))return;activeSignal=newActiveSignal(setup);saveActiveSignal(activeSignal)}
async function finalizeSignal(outcome,closePrice){if(!activeSignal)return;const done={...activeSignal,outcome,status:outcome,closedAt:Date.now(),closePrice};await putSignal(done);signals=await getSignals();activeSignal=null;saveActiveSignal(null);renderStats();renderAi()}
async function processLatestCandle(){if(!activeSignal)return;const c=data[activeSignal.tf]?.at(-1);if(!c)return;if(Date.now()>activeSignal.expiresAt){await finalizeSignal(activeSignal.hitTp1?'TP1':'EXPIRED',c.close);return}if(activeSignal.status==='WATCH'){const entered=c.high>=activeSignal.entryLow&&c.low<=activeSignal.entryHigh,invalid=activeSignal.side==='BUY'?c.low<=activeSignal.sl:c.high>=activeSignal.sl;if(invalid&&!entered){await finalizeSignal('INVALID',c.close);return}if(entered){activeSignal.status='ACTIVE';saveActiveSignal(activeSignal)}}if(activeSignal?.status==='ACTIVE'||activeSignal?.status==='TP1'){const sl=activeSignal.side==='BUY'?c.low<=activeSignal.sl:c.high>=activeSignal.sl,tp2=activeSignal.side==='BUY'?c.high>=activeSignal.tp2:c.low<=activeSignal.tp2,tp1=activeSignal.side==='BUY'?c.high>=activeSignal.tp1:c.low<=activeSignal.tp1;if(sl){await finalizeSignal(activeSignal.hitTp1?'TP1':'SL',activeSignal.sl);return}if(tp2){await finalizeSignal('TP2',activeSignal.tp2);return}if(tp1&&!activeSignal.hitTp1){activeSignal.hitTp1=true;activeSignal.status='TP1';saveActiveSignal(activeSignal)}}}

function openSettings(){settings=loadSettings();$('#apiKey').value=settings.apiKey||'';$('#teKey').value=settings.teKey||'';$('#riskPct').value=settings.riskPct;$('#minLot').value=settings.minLot;openModal('#settingsModal')}
function setupOnboarding(){const cap=Number($('#startCapital').value)||100,rec=cap*(1+recommendedGrowth(cap)),target=Number($('#targetBalance').value)||rec;$('#targetGrowth').textContent=(target/cap-1>=0?'+':'')+pct(target/cap-1)+' / month';$('#targetDaily').textContent='+'+pct(dailyRate(cap,target,30))+' / day'}

async function init(){
  signals=await getSignals();renderMarketMode();renderApi();await Promise.all([loadStatic(),loadNews()]);if(!plan)openModal('#onboardingModal');else{recalcPlan();renderAll()}setAiSwitch();renderAi();processLatestCandle();
}
function renderAll(){renderHome();renderPlan();renderStats();renderAi();requestAnimationFrame(drawEquity);requestAnimationFrame(drawMarketChart)}
function setAiSwitch(){const b=$('#aiSwitch');b.classList.toggle('on',AI);b.setAttribute('aria-pressed',String(AI));b.querySelector('b').textContent=AI?'AI ON':'AI OFF';b.querySelector('small').textContent=AI?'SMART CREDIT':'0 credit'}

$$('[data-nav]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.nav)));
$('#openSettings').addEventListener('click',openSettings);$$('[data-close-modal]').forEach(x=>x.addEventListener('click',()=>closeModal('#settingsModal')));$('#closeSettings').addEventListener('click',()=>{settings.riskPct=Number($('#riskPct').value)||.5;settings.minLot=Number($('#minLot').value)||.01;saveSettings(settings);closeModal('#settingsModal');renderAi()});
$('#saveApiKey').addEventListener('click',()=>{settings.apiKey=$('#apiKey').value.trim();saveSettings(settings);toast('บันทึก Market API Key แล้ว')});$('#saveTeKey').addEventListener('click',()=>{settings.teKey=$('#teKey').value.trim();saveSettings(settings);toast('บันทึก News API Key แล้ว')});
$('#aiSwitch').addEventListener('click',async()=>{AI=!AI;setAiEnabledStorage(AI);setAiSwitch();if(AI){if(!settings.apiKey){openSettings();toast('ใส่ API Key ก่อนใช้ Live AI')}else await runAi(false)}renderAi()});
$('#chartEmptyAction').addEventListener('click',async()=>{if(data[currentTf]?.length){drawMarketChart();return}if(AI&&settings.apiKey)await loadTf(currentTf,false);else await loadStatic()});
$('#tfTabs').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-tf]');if(!b)return;
  currentTf=b.dataset.tf;resetChartView();
  $$('#tfTabs button').forEach(x=>x.classList.toggle('active',x===b));
  if(!data[currentTf]?.length&&AI&&settings.apiKey)await loadTf(currentTf,false);
  drawMarketChart();
});
$('#refreshNews').addEventListener('click',async()=>{try{newsPack=await refreshNews(settings.teKey);renderNews();toast('อัปเดตข่าวแล้ว')}catch(e){toast(e.message)}});
$('#saveDay').addEventListener('click',()=>{if(!plan)return;const v=Number($('#actualBalance').value),done=completed();if(!v||done>=30)return toast('ใส่ Balance ให้ถูกต้อง');const row=plan.days[done];row.actual=v;row.status=v>=row.expected?'hit':'miss';plan.days[done]=row;recalcPlan();$('#actualBalance').value='';renderAll();toast(row.status==='hit'?'Target hit · ไปวันถัดไป':'บันทึกแล้ว · ระบบปรับ Roadmap ใหม่')});
$('#editTarget').addEventListener('click',()=>{if(!plan)return;const t=prompt('Month target ใหม่',plan.target.toFixed(2));const n=Number(t);if(n>currentBalance()){plan.target=n;recalcPlan();renderAll();toast('อัปเดต Target แล้ว')}});
$('#resetPlan').addEventListener('click',()=>{if(confirm('ลบแผนทั้งหมดและเริ่มใหม่?')){clearPlan();location.reload()}});
$('#startCapital').addEventListener('input',()=>{const cap=Number($('#startCapital').value)||100;$('#targetBalance').value=(cap*(1+recommendedGrowth(cap))).toFixed(2);setupOnboarding()});$('#targetBalance').addEventListener('input',setupOnboarding);$('#useRecommended').addEventListener('click',()=>{const cap=Number($('#startCapital').value)||100;$('#targetBalance').value=(cap*(1+recommendedGrowth(cap))).toFixed(2);setupOnboarding()});$('#createPlan').addEventListener('click',()=>{const s=Number($('#startCapital').value),t=Number($('#targetBalance').value);if(!(s>0&&t>s))return toast('ตรวจทุนและ Target');buildPlan(s,t);closeModal('#onboardingModal');renderAll();toast('สร้างแผนแล้ว')});
$('#exportDataset').addEventListener('click',async()=>{const rows=await exportSignals();const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),signals:rows},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='one-month-ai-dataset.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
$('#chartLatest').addEventListener('click',()=>{resetChartView();drawMarketChart()});

const marketCanvas=$('#marketChart');
marketCanvas.addEventListener('pointerdown',e=>{
  marketCanvas.setPointerCapture?.(e.pointerId);
  chartView.drag=true;chartView.moved=false;chartView.dragStartX=e.clientX;chartView.dragStartOffset=chartView.offset;
});
marketCanvas.addEventListener('pointermove',e=>{
  if(!chartView.drag)return;
  const vd=visibleChartData();if(!vd.visible.length)return;
  const rect=marketCanvas.getBoundingClientRect(),step=Math.max(1,(rect.width-67)/vd.visible.length),dx=e.clientX-chartView.dragStartX;
  if(Math.abs(dx)>6)chartView.moved=true;
  if(chartView.moved){chartView.crossIndex=null;chartView.offset=chartView.dragStartOffset+Math.round(dx/step);drawMarketChart()}
});
function finishChartPointer(e){
  if(!chartView.drag)return;
  if(!chartView.moved){
    const rect=marketCanvas.getBoundingClientRect(),vd=visibleChartData(),padL=10,padR=57,pw=rect.width-padL-padR;
    const local=clamp(e.clientX-rect.left-padL,0,pw-.001);
    chartView.crossIndex=clamp(Math.floor(local/(pw/vd.visible.length)),0,vd.visible.length-1);
    drawMarketChart();
  }
  chartView.drag=false;
}
marketCanvas.addEventListener('pointerup',finishChartPointer);
marketCanvas.addEventListener('pointercancel',()=>{chartView.drag=false});
marketCanvas.addEventListener('touchstart',e=>{
  if(e.touches.length===2){const a=e.touches[0],b=e.touches[1];chartView.pinchDistance=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);chartView.pinchBars=chartView.bars}
},{passive:true});
marketCanvas.addEventListener('touchmove',e=>{
  if(e.touches.length!==2||!chartView.pinchDistance)return;
  e.preventDefault();const a=e.touches[0],b=e.touches[1],dist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);if(dist<20)return;
  chartView.bars=clamp(Math.round(chartView.pinchBars*(chartView.pinchDistance/dist)),18,72);chartView.crossIndex=null;drawMarketChart();
},{passive:false});
marketCanvas.addEventListener('touchend',e=>{if(e.touches.length<2)chartView.pinchDistance=0});
marketCanvas.addEventListener('dblclick',()=>{resetChartView();drawMarketChart()});

window.addEventListener('resize',()=>{requestAnimationFrame(drawMarketChart);requestAnimationFrame(drawEquity)});
setupOnboarding();init();
