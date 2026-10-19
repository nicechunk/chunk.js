import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ChunkManager } from '../chunk/chunk-manager.js';
import { BLOCK_ID } from '../world/block-registry.js';
import { ensureRenderSections, sectionDeltaValues, sectionRevision } from '../chunk/render-sections.js';
import { createActualBuildWorker } from './helpers/actual-build-worker.mjs';

test('cold Worker dispatch does not reconstruct 2116 unchanged terrain columns on the frame thread',()=>{
  const manager=new ChunkManager({useWorkers:false});
  try {
    const chunk=manager.ensureChunk(50,50);
    manager.getOpaqueColumnTopAtWorld=()=>{throw new Error('unchanged generated columns belong in the Worker');};
    const halo=manager.captureWorkerColumnTopHalo(chunk);
    assert.equal(halo.columns.length,0);
    assert.equal(halo.tops.length,0);
  } finally {manager.dispose();}
});

test('sparse captured tops preserve distant edited skylight and exact real Worker mesh bytes',async()=>{
  const manager=new ChunkManager({useWorkers:false}),worker=await createActualBuildWorker();
  try {
    const chunk=manager.ensureChunk(0,0);manager.ensureChunk(0,1);
    manager.applyPendingDelta([{worldX:-3,worldY:99,worldZ:24,blockId:BLOCK_ID.stone},
      {worldX:8,worldY:84,worldZ:15,blockId:BLOCK_ID.air}], 'captured-shadow');
    const section=ensureRenderSections(chunk).get(7);
    const task={worldSeed:manager.worldSeed,chunkX:0,chunkZ:0,
      generationVersion:manager.generationVersion,resourceRuleVersion:manager.resourceRuleVersion,materialVersion:1,
      options:manager.workerOptions(),mode:'section',taskVersion:chunk.version,sectionIndex:7,
      sectionRevision:sectionRevision(section,1),baseProfile:chunk.baseProfile,treeInstances:chunk.treeInstances,
      finalDeltas:Int32Array.from(sectionDeltaValues(chunk,7).flatMap(d=>[d.worldX,d.worldY,d.worldZ,d.blockId])),
      neighborDeltas:manager.neighborDeltasForWorker(0,0),treeDeltas:manager.treeNeighborDeltasForWorker(0,0),
      lightingDeltas:manager.visualDeltasForWorker(0,0,8,7)};
    const dense=await worker.build({...task,columnTopHalo:manager.captureColumnTopHalo(chunk)});
    const sparse=manager.captureWorkerColumnTopHalo(chunk);
    assert.ok(sparse.columns.length>=3);
    // Capture before changing the live world; the posted snapshot must stand on its own.
    manager.rollbackPendingDelta('captured-shadow');
    const actual=await worker.build({...task,columnTopHalo:sparse});
    const hash=data=>createHash('sha256').update(data).digest('hex');
    for(const field of ['mesh','visualMesh']) {
      assert.equal(hash(actual[field].vertices),hash(dense[field].vertices));
      assert.deepEqual(actual[field].indices,dense[field].indices);
    }
  } finally {await worker.dispose();manager.dispose();}
});

test('custom dense bases retain an exact complete column snapshot',()=>{
  const manager=new ChunkManager({useWorkers:false,chunkSize:4,height:16,minY:0});
  try {
    const chunk=manager.ensureChunk(0,0);
    chunk.setBaseBlocks(new Uint16Array(4*4*16).fill(BLOCK_ID.stone));
    const halo=manager.captureWorkerColumnTopHalo(chunk);
    assert.equal(halo.columns,undefined);
    assert.equal(halo.tops.length,halo.width*halo.width);
  } finally {manager.dispose();}
});
