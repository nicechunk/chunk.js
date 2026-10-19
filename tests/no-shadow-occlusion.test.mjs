import test from "node:test";
import assert from "node:assert/strict";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { ChunkState } from "../chunk/chunk-state.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { buildRenderSection, commitRenderSection, ensureRenderSections, prepareRenderSnapshotInvalidation } from "../chunk/render-sections.js";

test("no-shadow roof and enclosed room never query a sky blocker or light cell without emitters",()=>{
  const chunk=new ChunkState({chunkX:0,chunkZ:0,chunkSize:16,height:64,minY:0,shadows:false,
    baseBlocks:new Uint16Array(16*16*64).fill(BLOCK_ID.stone)});
  chunk.applyChainDelta([{worldX:8,worldY:4,worldZ:8,blockId:BLOCK_ID.air}],{protectUntilSnapshot:false});
  const sections=ensureRenderSections(chunk);
  assert.equal(chunk.renderColumnTops.size,0,"no sky top bookkeeping");
  const result=buildRenderSection(chunk,sections.get(0),{noLocalLightSources:true,
    getColumnTopAtWorld:()=>{throw Error("shadow blocker query");},
    getBlockAtWorld:()=>BLOCK_ID.stone});
  assert.ok(result.mesh.vertexCount);
  assert.equal(result.lighting.cells,0);assert.equal(result.lighting.transportCacheBytes,0);
  assert.equal(result.lighting.occlusion,false);assert.equal(result.lighting.sunlight,null);
  const data=new DataView(result.mesh.vertices.buffer);
  for(let v=0;v<result.mesh.vertexCount;v++)assert.equal(data.getUint16(v*20+18,true)>>>8,255);
});

test("removing roof occlusion stops distant lower-section rebakes for edits and atomic snapshots",()=>{
  const chunk=new ChunkState({chunkX:0,chunkZ:0,chunkSize:16,height:64,minY:0,shadows:false,
    baseBlocks:new Uint16Array(16*16*64)});
  chunk.applyChainDelta([{worldX:8,worldY:1,worldZ:8,blockId:BLOCK_ID.stone}],{protectUntilSnapshot:false});
  const sections=ensureRenderSections(chunk),low=sections.get(0);
  commitRenderSection(chunk,low,buildRenderSection(chunk,low,{getBlockAtWorld:()=>BLOCK_ID.air,noLocalLightSources:true}));
  const revision=low.lightRevision;
  chunk.applyChainDelta([{worldX:8,worldY:50,worldZ:8,blockId:BLOCK_ID.stone}],{protectUntilSnapshot:false});
  assert.equal(low.dirty,false);assert.equal(low.lightRevision,revision);
  const changes=[{worldX:8,worldY:51,worldZ:8,localX:8,localY:51,localZ:8,blockId:BLOCK_ID.stone}];
  const plan=prepareRenderSnapshotInvalidation(chunk,chunk.chainDeltas,changes);
  let step;do{step=plan.next();}while(!step.done);step.value.commit();
  assert.equal(low.dirty,false);assert.equal(low.lightRevision,revision);
});

test("no-shadow manager never captures shadow column halos, including dense edited worlds",()=>{
  const manager=new ChunkManager({useWorkers:false,shadows:false});
  try {
    const chunk=manager.ensureChunk(66,29);chunk.setBaseBlocks(new Uint16Array(16*16*manager.height));
    manager.getOpaqueColumnTopAtWorld=()=>{throw Error("unused shadow halo");};
    const halo=manager.captureWorkerColumnTopHalo(chunk);
    assert.equal(halo.width,0);assert.equal(halo.tops.length,0);
  }finally{manager.dispose();}
});
