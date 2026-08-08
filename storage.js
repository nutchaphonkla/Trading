export const PLAN_KEY='one_month_trading_os_v4';
export const SETTINGS_KEY='one_month_studio_settings_v11';
export const AI_KEY='one_month_ai_enabled_v11';
export const API_USAGE_KEY='one_month_api_usage_v11';
export const CACHE_KEY='one_month_market_cache_v11';
export const ACTIVE_SIGNAL_KEY='one_month_active_signal_v11';
const DB_NAME='one-month-ai-v11',DB_VERSION=1,SIGNAL_STORE='signals';

export function readJSON(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}}
export function writeJSON(key,value){localStorage.setItem(key,JSON.stringify(value))}
export function loadPlan(){return readJSON(PLAN_KEY,null)}
export function savePlan(plan){writeJSON(PLAN_KEY,plan)}
export function clearPlan(){localStorage.removeItem(PLAN_KEY)}
export function loadSettings(){return {...{apiKey:'',teKey:'',riskPct:.5,minLot:.01,contractSize:100,lotFactor:.7},...readJSON(SETTINGS_KEY,{})}}
export function saveSettings(s){writeJSON(SETTINGS_KEY,s)}
export function aiEnabled(){return localStorage.getItem(AI_KEY)==='1'}
export function setAiEnabledStorage(v){localStorage.setItem(AI_KEY,v?'1':'0')}

export function apiUsage(){
  const day=new Date().toISOString().slice(0,10),x=readJSON(API_USAGE_KEY,{day,count:0,lastScan:0});
  return x.day===day?x:{day,count:0,lastScan:0};
}
export function addApiUsage(n){const x=apiUsage();x.count+=n;x.lastScan=n;writeJSON(API_USAGE_KEY,x);return x}
export function resetLastScan(){const x=apiUsage();x.lastScan=0;writeJSON(API_USAGE_KEY,x)}

export function loadMarketCache(){return readJSON(CACHE_KEY,{})}
export function saveMarketCache(cache){writeJSON(CACHE_KEY,cache)}

function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(SIGNAL_STORE)){const store=db.createObjectStore(SIGNAL_STORE,{keyPath:'id'});store.createIndex('closedAt','closedAt')}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
export async function putSignal(signal){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(SIGNAL_STORE,'readwrite');tx.objectStore(SIGNAL_STORE).put(signal);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})}
export async function getSignals(limit=500){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(SIGNAL_STORE,'readonly'),req=tx.objectStore(SIGNAL_STORE).getAll();req.onsuccess=()=>resolve(req.result.sort((a,b)=>(b.closedAt||b.createdAt)-(a.closedAt||a.createdAt)).slice(0,limit));req.onerror=()=>reject(req.error)})}
export async function clearSignals(){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(SIGNAL_STORE,'readwrite'),req=tx.objectStore(SIGNAL_STORE).clear();req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error)})}
export async function exportSignals(){return await getSignals(10000)}

export function loadActiveSignal(){return readJSON(ACTIVE_SIGNAL_KEY,null)}
export function saveActiveSignal(s){if(s)writeJSON(ACTIVE_SIGNAL_KEY,s);else localStorage.removeItem(ACTIVE_SIGNAL_KEY)}
