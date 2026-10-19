import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuildingMeshWorkerClient } from '../construction/building-mesh-client.js';
import { createBlueprint, encodeNcm3 } from '../ncm/blueprint-codec.js';
import { parseNcm3Building, createBuildingPlacement } from '../construction/building-parser.js';
import { createBuildingChunkMeshes } from '../construction/building-mesher.js';
import { createBuildingMeshResult } from '../construction/building-mesh-result.js';
const code=encodeNcm3(createBlueprint({x:2,y:1,z:1},'recovery').box(64,0,0,0,2,1,1));
const request=id=>({code,buildingId:id,foundation:{id:'land',minX:0,minZ:0,surfaceY:0,width:2,depth:1}});
function resultFor(input){const building=parseNcm3Building(input.code,{id:input.buildingId});
 const placement=createBuildingPlacement(building,input.foundation,{materializeWorldVoxels:false});
 return createBuildingMeshResult(building,placement,createBuildingChunkMeshes(placement));}
function factory(workers){return ()=>{const worker={messages:[],postMessage(input){this.messages.push(input);},terminate(){this.terminated=true;},
 success(index=0){const input=this.messages[index];this.onmessage?.({data:{requestId:input.requestId,ok:true,result:resultFor(input)}});}};workers.push(worker);return worker;};}

test('building Worker cooldown makes queued work progress in fallback and later restores Worker mode',async()=>{
 let clock=0;const workers=[];const client=createBuildingMeshWorkerClient({workerFactory:factory(workers),now:()=>clock});
 try{
  const failed=client.build(request('failed')),queued=client.build(request('queued'));
  const rejected=assert.rejects(failed,error=>error.code==='building-mesh-worker-failed');
  const late=workers[0].onmessage;workers[0].onerror({message:'synthetic runtime error'});await rejected;
  assert.equal((await queued).building.id,'queued');assert.equal(workers.length,1);assert.equal(client.workerMode(),false);
  clock=1001;const recovered=client.build(request('recovered'));assert.equal(workers.length,2);
  late({data:{requestId:1,ok:true,result:{}}});assert.equal(workers[1].terminated,undefined);
  workers[1].success();assert.equal((await recovered).building.id,'recovered');assert.equal(client.workerMode(),true);
 }finally{client.dispose();}
});

test('a silent building Worker times out, releases ownership and leaves fallback available',async()=>{
 const workers=[];const client=createBuildingMeshWorkerClient({workerFactory:factory(workers),workerTimeoutMs:5});
 try{
  const pending=client.build(request('silent'));
  await assert.rejects(pending,error=>/timed out/.test(error.message));
  assert.equal(workers[0].terminated,true);assert.equal(client.stats().active,0);
  assert.equal((await client.build(request('after-timeout'))).building.id,'after-timeout');
 }finally{client.dispose();}
});

test('a queued request is snapshotted before caller mutation and duplicate settled replies do not poison the next job',async()=>{
 const workers=[];const client=createBuildingMeshWorkerClient({workerFactory:factory(workers)});
 try{
  const first=client.build(request('first')),input=request('second'),second=client.build(input);
  input.foundation.minX=999;input.buildingId='mutated';workers[0].success(0);await first;
  assert.equal(workers[0].messages[1].foundation.minX,0);assert.equal(workers[0].messages[1].buildingId,'second');
  workers[0].success(0);assert.equal(workers[0].terminated,undefined);
  workers[0].success(1);assert.equal((await second).building.id,'second');
 }finally{client.dispose();}
});

test('cancelled cooperative building work cannot finish or publish after a later yield',async()=>{
 const continuations=[];let clock=0;
 const client=createBuildingMeshWorkerClient({useWorker:false,now:()=>clock++,fallbackBudgetMs:1,
  yieldToMain:()=>new Promise(resolve=>continuations.push(resolve))});
 const controller=new AbortController();const pending=client.build(request('cancel'),{signal:controller.signal});
 const rejected=assert.rejects(pending,error=>error.name==='AbortError');
 continuations.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(continuations.length>0,'build yielded again before completion');controller.abort();await rejected;
 while(continuations.length)continuations.shift()();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(client.stats().active,0);assert.equal(client.stats().queued,0);client.dispose();
});
