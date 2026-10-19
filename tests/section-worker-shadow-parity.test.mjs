import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before,after,test } from "node:test";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { ensureRenderSections,buildRenderSection,commitRenderSection,sectionDeltaValues,sectionRevision,sectionIndexAt } from "../chunk/render-sections.js";
import { actualFaces,expectedFaces,decodedVertices } from "./helpers/face-oracle.mjs";
import { createActualBuildWorker } from "./helpers/actual-build-worker.mjs";

let worker;
before(async()=>{worker=await createActualBuildWorker();});
after(async()=>{await worker?.dispose();});
const packed=deltas=>Int32Array.from(deltas.flatMap(d=>[d.worldX,d.worldY,d.worldZ,d.blockId]));
const hash=data=>createHash("sha256").update(data).digest("hex");
function sameMesh(actual,expected,context) {
  assert.equal(actual.originY,expected.originY,`${context}: origin`);
  assert.equal(actual.vertexCount,expected.vertexCount,`${context}: vertices`);
  assert.equal(actual.indexCount,expected.indexCount,`${context}: indices`);
  assert.equal(hash(actual.vertices),hash(expected.vertices),`${context}: vertex bytes / normals / materials / shade / baked light`);
  assert.equal(hash(new Uint8Array(actual.indices.buffer,actual.indices.byteOffset,actual.indices.byteLength)),
    hash(new Uint8Array(expected.indices.buffer,expected.indices.byteOffset,expected.indices.byteLength)),`${context}: indexed topology`);
}
function capture(manager,chunk,section) {
  return {worldSeed:manager.worldSeed,chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,
    generationVersion:manager.generationVersion,resourceRuleVersion:manager.resourceRuleVersion,materialVersion:manager.materialVersion,
    options:manager.workerOptions(),mode:"section",taskVersion:chunk.version,sectionIndex:section.sectionIndex,
    sectionRevision:sectionRevision(section,manager.materialVersion),baseProfile:chunk.baseProfile,treeInstances:chunk.treeInstances,
    finalDeltas:packed(sectionDeltaValues(chunk,section.sectionIndex)),neighborDeltas:manager.neighborDeltasForWorker(chunk.chunkX,chunk.chunkZ),
    treeDeltas:manager.treeNeighborDeltasForWorker(chunk.chunkX,chunk.chunkZ),lightingDeltas:manager.visualDeltasForWorker(chunk.chunkX,chunk.chunkZ,8,section.sectionIndex),columnTopHalo:manager.captureColumnTopHalo(chunk)};
}
function topShade(mesh,x=8,y=85,z=15) {
  const vertices=decodedVertices(mesh),values=[];
  for(let i=0;i<vertices.length;i+=4) {
    const quad=vertices.slice(i,i+4);
    if(quad.length!==4||!quad.every(v=>v.n[1]===127&&v.p[1]===y))continue;
    if(Math.min(...quad.map(v=>v.p[0]))<=x+.5&&Math.max(...quad.map(v=>v.p[0]))>=x+.5
      &&Math.min(...quad.map(v=>v.p[2]))<=z+.5&&Math.max(...quad.map(v=>v.p[2]))>=z+.5)values.push(...quad.map(v=>v.shade));
  }
  assert.equal(values.length,4,"the audit target must have exactly one top quad covering its cell");
  return Math.min(...values);
}
function fixture() {
  const manager=new ChunkManager({useWorkers:false});
  const chunk=manager.ensureChunk(0,0);
  manager.ensureChunk(0,1);
  const section=ensureRenderSections(chunk).get(7);
  const result=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
  commitRenderSection(chunk,section,result);
  return {manager,chunk,section,result};
}

for(const [x,z]of [[6,17],[4,18],[3,20],[1,21],[0,22],[-1,23],[-3,24]]) {
  test(`sun halo placement/removal affects (8,84,15), real Worker matches sync: occluder (${x},99,${z})`,async()=>{
    const {manager,chunk,section,result:before}=fixture();
    try {
      const initialShade=topShade(before.mesh),oldLightRevision=section.lightRevision;
      const edit={worldX:x,worldY:99,worldZ:z,blockId:BLOCK_ID.stone};
      manager.applyPendingDelta([edit],"sun-occluder");
      assert.ok(section.lightRevision>oldLightRevision,"sun footprint, not just the one-cell geometry halo, must invalidate target lighting");
      const sync=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
      const response=await worker.build(capture(manager,chunk,section));
      assert.equal(response.visualError,null);
      assert.ok(topShade(sync.mesh)<initialShade,"placing the high occluder must darken the actual target face");
      sameMesh(response.mesh,sync.mesh,`placed (${x},99,${z})`);
      sameMesh(response.visualMesh,sync.visualMesh,`visual placed (${x},99,${z})`);
      commitRenderSection(chunk,section,sync);
      const placedRevision=section.lightRevision;
      manager.rollbackPendingDelta("sun-occluder");
      assert.ok(section.lightRevision>placedRevision,"removing/rolling back the occluder must invalidate the same lighting footprint");
      const restored=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
      const restoredWorker=await worker.build(capture(manager,chunk,section));
      assert.equal(topShade(restored.mesh),initialShade,"removal must restore the original target light");
      sameMesh(restoredWorker.mesh,restored.mesh,`removed (${x},99,${z})`);
    } finally {manager.dispose();}
  });
}

test("negative-boundary section output matches a six-neighbour oracle in the real Worker",async()=>{
  const manager=new ChunkManager({useWorkers:false});
  try {
    const chunk=manager.ensureChunk(-1,-1);manager.ensureChunk(0,-1);manager.ensureChunk(-1,0);
    manager.applyPendingDelta([{worldX:-1,worldY:31,worldZ:-1,blockId:BLOCK_ID.air},
      {worldX:0,worldY:31,worldZ:-1,blockId:BLOCK_ID.air},{worldX:-1,worldY:31,worldZ:0,blockId:BLOCK_ID.air},
      {worldX:-1,worldY:32,worldZ:-1,blockId:BLOCK_ID.air}],"negative-corner");
    for(const index of [3,4]) {
      const section=ensureRenderSections(chunk).get(index),response=await worker.build(capture(manager,chunk,section));
      const sync=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
      const view={chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,chunkSize:chunk.chunkSize,minY:section.originY,height:section.height,
        getFinalBlock:chunk.getFinalBlock.bind(chunk)};
      assert.deepEqual(actualFaces(response.mesh),expectedFaces(view,(...p)=>manager.getBlockAtWorld(...p)),`section ${index}`);
      sameMesh(response.mesh,sync.mesh,`negative section ${index}`);
    }
  } finally {manager.dispose();}
});

test("real late Worker section cannot overwrite a changed or replacement chunk instance",async()=>{
  const manager=new ChunkManager({useWorkers:false});
  try {
    const chunk=manager.ensureChunk(-1,-1),section=ensureRenderSections(chunk).get(3);
    const task=capture(manager,chunk,section),oldRevision=task.sectionRevision;
    const pending=worker.build(task);
    manager.applyPendingDelta([{worldX:-2,worldY:31,worldZ:-2,blockId:BLOCK_ID.air}],"during-build");
    const result=await pending;
    assert.equal(commitRenderSection(chunk,section,result,oldRevision),false,"same-section edits invalidate the captured data revision");
    manager.chunks.delete(chunk.id);
    const replacement=manager.ensureChunk(-1,-1),next=ensureRenderSections(replacement).get(3);
    assert.notEqual(next.generation,section.generation);
    assert.equal(commitRenderSection(replacement,next,result,oldRevision),false,"same coordinate is not the same instance generation");
  } finally {manager.dispose();}
});

test("section Worker captures upstream pickup masks and cannot restore a collected surface model",async()=>{
  const manager=new ChunkManager({useWorkers:false});
  try {
    const chunk=manager.ensureChunk(0,32),profile=chunk.baseProfile;
    const column=Array.from(profile.surfaceY.keys()).find(i=>{
      const y=profile.surfaceY[i],x=i%chunk.chunkSize,z=Math.floor(i/chunk.chunkSize);
      return profile.waterY[i]===profile.noWater&&chunk.getFinalBlock(x,y+1,z)===BLOCK_ID.air;
    });
    assert.notEqual(column,undefined,"the deterministic fixture needs an exposed dry surface");
    manager.setSurfaceDecorationRules([{ruleId:500,decorationId:100,surfaceBlockId:profile.surfaceBlock[column],
      dropBlockId:BLOCK_ID.stone,rollStartBps:0,rollEndBps:10000,minY:-32,maxY:320,salt:500,flags:0}]);
    worker.setSurfaceDecorationRules(manager.surfaceDecorationRules.rules,manager.surfaceDecorationRulesRevision);
    const section=ensureRenderSections(chunk).get(sectionIndexAt(chunk,profile.surfaceY[column]+1));
    const before=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
    assert.ok(before.visualMesh.indexCount>0,"verified rules must produce a surface model before collection");
    chunk.pickedSurfaceColumns=[column];chunk.markDirty();
    const expected=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
    assert.ok(expected.visualMesh.indexCount<before.visualMesh.indexCount,"collection removes actual geometry while preserving terrain");
    let payload;
    manager.dispatchSectionBuild({postMessage(message){payload=message;}},
      {id:chunk.id,chunk,sectionIndex:section.sectionIndex,chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,mode:"section"},chunk);
    assert.deepEqual(payload.pickedSurfaceColumns,[column],"the production section dispatch must carry the authoritative pickup mask");
    assert.notEqual(payload.pickedSurfaceColumns,chunk.pickedSurfaceColumns,"the task must own a captured array");
    chunk.pickedSurfaceColumns.push((column+1)%(chunk.chunkSize*chunk.chunkSize));chunk.markDirty();
    assert.deepEqual(payload.pickedSurfaceColumns,[column],"later mask edits cannot mutate an in-flight request");
    const response=await worker.build(payload);
    assert.equal(response.visualError,null);
    sameMesh(response.mesh,expected.mesh,"collected terrain");
    sameMesh(response.visualMesh,expected.visualMesh,"collected visual");
    assert.equal(commitRenderSection(chunk,section,response,payload.sectionRevision),false,"a later pickup invalidates the old complete result");
  } finally {
    worker.setSurfaceDecorationRules([],0);
    manager.dispose();
  }
});
