import assert from 'node:assert/strict';
import test from 'node:test';
import {ChunkManager} from '../chunk/chunk-manager.js';

test('prediction adds a bounded complete ring and preserves all current identities',()=>{
  const manager=new ChunkManager({useWorkers:false,viewDistance:2,preloadMargin:1,maxPredictivePreloadChunks:3});
  try {
    manager.updatePlayerPosition(15,1,-1);
    const original=new Map(manager.chunks);
    manager.updatePlayerPosition(15,1,-1,{prefetchWorldX:47,prefetchWorldZ:-1});
    assert.equal(manager.centerChunkX,0);assert.equal(manager.centerChunkZ,-1);
    assert.equal(manager.prefetchChunkX,2);
    for(const [key,value] of original)assert.equal(manager.chunks.get(key),value);
    for(let x=-3;x<=5;x++)for(let z=-4;z<=2;z++)assert.ok(manager.chunks.has(`${x},${z}`));
    assert.equal(manager.chunks.size,63);
    manager.updatePlayerPosition(15,1,-1,{prefetchWorldX:1e10,prefetchWorldZ:-1e10});
    assert.equal(manager.prefetchChunkX,3);assert.equal(manager.prefetchChunkZ,-4);
    manager.updatePlayerPosition(16000,1,16000);
    assert.ok([...manager.chunks.values()].every(c=>Math.max(Math.abs(c.chunkX-1000),Math.abs(c.chunkZ-1000))<=5));
    manager.unloadFarChunks(2000,2000);assert.equal(manager.chunks.size,0);
  }finally{manager.dispose();}
});

test('parallel boundary work respects the pool limit and does not dispatch duplicate columns',()=>{
  const prior=globalThis.Worker;
  globalThis.Worker=class {postMessage(){} terminate(){}};
  const manager=new ChunkManager({useWorkers:true,workerCount:4,deferInitialBuilds:true,
    viewDistance:2,preloadMargin:1,maxPredictivePreloadChunks:3,shadows:false});
  try {
    manager.updatePlayerPosition(15,128,0,{prefetchWorldX:63,prefetchWorldZ:0});
    manager.setBuildConcurrencyLimit(4);
    assert.equal(manager.inFlightBuilds.size,4);
    assert.equal(new Set([...manager.inFlightBuilds.values()].map(t=>t.id)).size,4);
    for(let i=0;i<20;i++)manager.dispatchBuilds();
    assert.equal(manager.inFlightBuilds.size,4);
  }finally{manager.dispose();if(prior===undefined)delete globalThis.Worker;else globalThis.Worker=prior;}
});
