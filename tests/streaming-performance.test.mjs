import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { DEFAULT_SURFACE_DECORATION_RULES } from "../world/surface-decoration-rules.js";
import { sectionRevision, buildRenderSection } from "../chunk/render-sections.js";
import { createActualBuildWorker } from "./helpers/actual-build-worker.mjs";

const hash = mesh => createHash('sha256').update(mesh.vertices).update(new Uint8Array(mesh.indices.buffer,mesh.indices.byteOffset,mesh.indices.byteLength)).digest('hex');
function fixture(rules=[]) {
  const manager=new ChunkManager({useWorkers:false,shadows:false,surfaceDecorationRules:rules});
  const chunk=manager.ensureChunk(72,28);manager.rebuildDirtyChunks(10000);
  return {manager,chunk};
}

test('late decoration rules preserve every terrain commit and match rules supplied before generation',()=>{
  const a=fixture(),b=fixture(DEFAULT_SURFACE_DECORATION_RULES);
  try {
    const previous=[...a.chunk.renderSections.values()].map(s=>({mesh:s.mesh,token:s.meshCommitToken,visual:s.visualMesh}));
    const material=a.manager.materialVersion;
    a.manager.setSurfaceDecorationRules(DEFAULT_SURFACE_DECORATION_RULES);
    const dirty=[...a.chunk.renderSections.values()].filter(s=>s.visualDirty);
    assert.ok(dirty.length>0 && dirty.length<5,'only surface owner sections need rule work');
    assert.ok([...a.chunk.renderSections.values()].every(s=>!s.dirty));
    assert.equal(a.manager.materialVersion,material);
    a.manager.rebuildDirtyChunks(10000);
    for(const [index,section] of a.chunk.renderSections) {
      assert.equal(section.mesh,previous[index].mesh);
      assert.equal(section.meshCommitToken,previous[index].token);
      assert.equal(hash(section.mesh),hash(b.chunk.renderSections.get(index).mesh));
      assert.equal(hash(section.visualMesh),hash(b.chunk.renderSections.get(index).visualMesh));
      if(!dirty.includes(section))assert.equal(section.visualMesh,previous[index].visual);
    }
    a.manager.setSurfaceDecorationRules([]);a.manager.rebuildDirtyChunks(10000);
    const clean=fixture();
    try {for(const [index,section] of a.chunk.renderSections)assert.equal(hash(section.visualMesh),hash(clean.chunk.renderSections.get(index).visualMesh));}
    finally {clean.manager.dispose();}
  } finally {a.manager.dispose();b.manager.dispose();}
});

test('pickup invalidates only owner visuals, persists across unload, and rejects an obsolete resource result',()=>{
  const {manager,chunk}=fixture(DEFAULT_SURFACE_DECORATION_RULES);
  try {
    const column=0,index=Math.floor((chunk.baseProfile.surfaceY[column]-chunk.minY)/16),section=chunk.renderSections.get(index);
    const revision=sectionRevision(section,manager.materialVersion),oldOpaque=section.mesh;
    manager.setPickedSurfaceColumns(72,28,[column]);
    assert.equal(section.dirty,false);assert.equal(section.visualDirty,true);assert.equal(section.mesh,oldOpaque);
    assert.notEqual(sectionRevision(section,manager.materialVersion),revision);
    assert.ok([...chunk.renderSections.values()].filter(s=>s.visualDirty).length<5);
    manager.unloadFarChunks(1000,1000);
    const restored=manager.ensureChunk(72,28);assert.deepEqual(restored.pickedSurfaceColumns,[column]);
  } finally {manager.dispose();}
});

test('edited cave supports refresh alongside generated surfaces without touching terrain',()=>{
  const {manager,chunk}=fixture(DEFAULT_SURFACE_DECORATION_RULES);
  try {
    manager.applyPendingDelta([{worldX:1153,worldY:4,worldZ:449,blockId:BLOCK_ID.air}], 'cave');
    manager.rebuildDirtyChunks(10000);
    const terrain=[...chunk.renderSections.values()].map(s=>s.mesh);
    const changed=DEFAULT_SURFACE_DECORATION_RULES.map(rule=>({...rule,salt:(rule.salt+1)%65536}));
    manager.setSurfaceDecorationRules(changed);
    assert.ok(chunk.renderSections.get(Math.floor((3-chunk.minY)/16)).visualDirty);
    manager.rebuildDirtyChunks(10000);
    for(const [index,section]of chunk.renderSections) {
      assert.equal(section.mesh,terrain[index]);
      const reference=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
      assert.equal(hash(section.visualMesh),hash(reference.visualMesh));
    }
  } finally {manager.dispose();}
});

test('one real Worker batch accepts unchanged siblings and rejects an edited section',async()=>{
  const previous=globalThis.Worker;
  globalThis.Worker=class {constructor(){this.messages=[];}postMessage(message){this.messages.push(message);}terminate(){}};
  const {manager,chunk}=fixture(DEFAULT_SURFACE_DECORATION_RULES),worker=await createActualBuildWorker();
  try {
    worker.setSurfaceDecorationRules(DEFAULT_SURFACE_DECORATION_RULES);
    manager.useWorkers=true;manager.workerCount=1;manager.activeBuildLimit=1;manager.initWorkers(1);
    manager.applyPendingDelta([{worldX:1153,worldY:4,worldZ:449,blockId:BLOCK_ID.air},
      {worldX:1153,worldY:36,worldZ:449,blockId:BLOCK_ID.air}], 'two-sections');
    manager.rebuildDirtyChunks(10000);
    const [taskId,task]=[...manager.inFlightBuilds][0],payload=task.worker.messages.find(m=>m.type==='buildChunk');
    assert.ok(payload.sectionJobs.length>=2 && payload.sectionJobs.length<=4);
    const response=await worker.build(payload),first=payload.sectionJobs[0],section=chunk.renderSections.get(first.sectionIndex),old=section.mesh;
    section.dataRevision++;
    task.worker.onmessage({data:{...response,taskId}});
    assert.equal(section.mesh,old);assert.equal(section.dirty,true);assert.equal(section.buildTaskId,null);
    for(const job of payload.sectionJobs.slice(1))assert.equal(chunk.renderSections.get(job.sectionIndex).dirty,false);
    assert.equal(manager.inFlightBuilds.size,0);
  } finally {manager.dispose();await worker.dispose();if(previous===undefined)delete globalThis.Worker;else globalThis.Worker=previous;}
});

test('reusable meshes have a byte cap, fresh instances and rule/pickup/authority guards',()=>{
  const {manager,chunk}=fixture(DEFAULT_SURFACE_DECORATION_RULES);
  try {
    chunk.reusableBaseVersion=chunk.version;
    manager.setSurfaceDecorationRules(DEFAULT_SURFACE_DECORATION_RULES.map(rule=>({...rule,salt:(rule.salt+1)%65536})));
    manager.rebuildDirtyChunks(10000);
    assert.equal(chunk.reusableBaseVersion,chunk.version,'current rule-only replacements preserve pure generated cache eligibility');
    chunk.reusableBaseVersion=chunk.version;manager.retainReusableMesh(chunk);
    assert.equal(manager.reusableMeshes.size,1);assert.ok(manager.reusableMeshBytes<=manager.maxCachedMeshBytes);
    const oldGeneration=chunk.renderSections.get(0).generation,expected=hash(chunk.renderSections.get(7).mesh);
    manager.chunks.delete(chunk.id);
    const next=manager.ensureChunk(72,28);assert.notEqual(next,chunk);
    assert.notEqual(next.renderSections.get(0).generation,oldGeneration);
    assert.equal(hash(next.renderSections.get(7).mesh),expected);
    assert.equal(manager.reusableMeshBytes,0);
    manager.retainReusableMesh(next);manager.chunks.delete(next.id);
    manager.setPickedSurfaceColumns(72,28,[0]);
    const picked=manager.ensureChunk(72,28);assert.equal(picked.mesh,null);assert.deepEqual(picked.pickedSurfaceColumns,[0]);
    manager.rebuildDirtyChunks(10000);picked.reusableBaseVersion=picked.version;
    manager.maxCachedMeshBytes=1;manager.retainReusableMesh(picked);assert.equal(manager.reusableMeshes.size,0);
    manager.maxCachedMeshBytes=32*1024*1024;
    manager.applyPendingDelta([{worldX:1153,worldY:5,worldZ:449,blockId:BLOCK_ID.air}], 'changed');
    manager.rebuildDirtyChunks(10000);manager.retainReusableMesh(picked);assert.equal(manager.reusableMeshes.size,0);
  } finally {manager.dispose();}
});

test('cache eviction protects a returning column awaiting budgeted rehydration',()=>{
  const a=fixture(DEFAULT_SURFACE_DECORATION_RULES),other=new ChunkManager({useWorkers:false,shadows:false,surfaceDecorationRules:DEFAULT_SURFACE_DECORATION_RULES});
  try {
    a.chunk.reusableBaseVersion=a.chunk.version;a.manager.retainReusableMesh(a.chunk);
    const firstBytes=a.manager.reusableMeshBytes;
    a.manager.chunks.delete(a.chunk.id);
    const returning=a.manager.ensureChunk(72,28,{deferBase:true});assert.equal(returning.baseBlocksReady,false);
    const chunk=other.ensureChunk(73,28);other.rebuildDirtyChunks(10000);chunk.reusableBaseVersion=chunk.version;
    a.manager.retainReusableMesh(chunk);
    const secondBytes=a.manager.reusableMeshes.get(chunk.id).bytes;
    a.manager.maxCachedMeshBytes=Math.max(firstBytes,secondBytes);
    a.manager.retainReusableMesh(chunk);
    assert.ok(a.manager.reusableMeshes.has(returning.id));assert.equal(a.manager.reusableMeshes.has(chunk.id),false);
    assert.ok(a.manager.reusableMeshBytes<=a.manager.maxCachedMeshBytes);
    a.manager.rebuildDirtyChunks(10000);assert.equal(returning.baseBlocksReady,true);assert.equal(a.manager.reusedMeshChunks,1);
  } finally {a.manager.dispose();other.dispose();}
});
