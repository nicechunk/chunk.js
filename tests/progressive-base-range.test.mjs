import assert from "node:assert/strict";
import test from "node:test";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { getBlockAt } from "../world/world-generator.js";

test("a synchronous view expansion reserves chunks without eagerly reconstructing every base",()=>{
  const manager=new ChunkManager({useWorkers:false,viewDistance:2,preloadMargin:0,deferInitialBuilds:true});
  try {
    const existing=manager.ensureChunk(0,0);
    assert.equal(existing.baseBlocksReady,true,"explicit ensureChunk keeps its immediate synchronous contract");
    let generated=0;
    const build=manager.ensureChunkBaseSync.bind(manager);
    manager.ensureChunkBaseSync=chunk=>{if(!chunk.baseBlocksReady)generated++;return build(chunk);};
    manager.setViewDistance(20,{preloadMargin:0});
    assert.equal(manager.chunks.size,41*41);
    assert.equal(generated,0,"view changes must not perform 1680 base reconstructions in one call");
    assert.equal(manager.chunks.get("20,20").baseBlocksReady,false);
    const x=20*16+8,z=20*16+8;
    assert.equal(manager.getBlockAtWorld(x,65,z),getBlockAt(manager.config.worldSeed,x,65,z,manager.generationVersion,manager.workerOptions()),"collision reads retain canonical generation before the base is ready");
    const explicit=manager.ensureChunk(20,20);
    assert.equal(explicit.baseBlocksReady,true);
    assert.equal(generated,1);
    // A tiny deadline still gives the closest dirty section forward progress;
    // it cannot synchronously reconstruct the whole newly reserved view.
    manager.rebuildDirtyChunks(.001);
    assert.ok(generated<4);
    assert.ok(existing.renderSections.size===23);
    manager.setViewDistance(2,{preloadMargin:0});
    manager.unloadFarChunks(0,0);
    assert.equal(manager.chunks.has("20,20"),false);
  } finally {manager.dispose();}
});

test("small-budget synchronous fallback generates the next near base progressively",()=>{
  const manager=new ChunkManager({useWorkers:false,viewDistance:1,preloadMargin:0,deferInitialBuilds:true});
  try {
    manager.ensureChunkRange(0,0);
    assert.ok([...manager.chunks.values()].every(chunk=>!chunk.baseBlocksReady));
    manager.rebuildDirtyChunks(.001);
    assert.equal(manager.chunks.get("0,0").baseBlocksReady,true);
    assert.equal([...manager.chunks.values()].filter(chunk=>chunk.baseBlocksReady).length,1);
    assert.ok(manager.chunks.get("0,0").renderSections.get(0).mesh);
  } finally {manager.dispose();}
});
