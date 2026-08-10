import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync(new URL('../kage-persistence-v49.js',import.meta.url),'utf8');
const context={window:{},globalThis:{indexedDB:{}},console};
context.globalThis=context;
context.indexedDB={};
vm.createContext(context);
vm.runInContext(source,context);
const api=context.window.KagePersistenceV49;
assert.ok(api,'persistence API missing');
assert.equal(api.VERSION,'KAGE_PERSISTENCE_V49');

const local={
  outcomeMemory:[],
  adaptiveModel:{generation:1,audit:{total:5}},
  learningState:{replayed:0,eligible:0,lastRun:10},
  localReplayCount:0,
  shadowMode:false,
  scanMemory:[]
};
const saved={
  outcomeMemory:[
    {sig:'a',createdAt:1,outcome:'WIN'},
    {sig:'b',createdAt:2,outcome:'LOSS'}
  ],
  adaptiveModel:{generation:3,audit:{total:20},champion:{trainedCount:20}},
  learningState:{replayed:17,eligible:18,lastRun:100},
  localReplayCount:17,
  shadowMode:true,
  scanMemory:[{id:'x',at:1}]
};
const merged=api.mergeSnapshots(local,saved);
assert.equal(merged.outcomeMemory.length,2);
assert.equal(merged.adaptiveModel.generation,3);
assert.equal(merged.learningState.replayed,17);
assert.equal(merged.localReplayCount,17);
assert.equal(merged.shadowMode,true);
assert.ok(api.score(merged)>api.score(local));

const many={outcomeMemory:Array.from({length:250},(_,i)=>({sig:String(i),createdAt:i}))};
assert.equal(api.normalize(many).outcomeMemory.length,180);
console.log('persistence V49: all tests passed');
