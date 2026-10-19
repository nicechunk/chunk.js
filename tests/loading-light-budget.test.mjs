import test from "node:test";
import assert from "node:assert/strict";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { bakeSectionLighting } from "../chunk/baked-light-field.js";
import { buildRenderSection, ensureRenderSections, sectionDeltaValues } from "../chunk/render-sections.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { createActualBuildWorker } from "./helpers/actual-build-worker.mjs";
import { DEFAULT_SURFACE_DECORATION_RULES } from "../world/surface-decoration-rules.js";

function sameMesh(actual,expected,label) {
  assert.equal(actual.originY,expected.originY,label+" origin");
  assert.equal(actual.vertexCount,expected.vertexCount,label+" vertices");
  assert.deepEqual(Buffer.from(actual.vertices),Buffer.from(expected.vertices),label+" packed geometry and light");
  assert.deepEqual(actual.indices,expected.indices,label+" topology");
}

for(const [cx,cz]of [[66,29],[0,0],[0,32],[-1,-1],[72,28],[-32,32]])test(`generated section plan exactly matches the complete mesher at ${cx},${cz}`,()=>{
  const manager=new ChunkManager({useWorkers:false,shadows:false,surfaceDecorationRules:DEFAULT_SURFACE_DECORATION_RULES});
  try {
    const chunk=manager.ensureChunk(cx,cz);
    for(const [dx,dz]of [[-1,0],[0,-1],[1,0],[0,1]])manager.ensureChunk(cx+dx,cz+dz);
    const ox=cx*16,oz=cz*16;
    manager.applyPendingDelta([
      {worldX:ox+1,worldY:-8,worldZ:oz+1,blockId:BLOCK_ID.air},
      {worldX:ox-1,worldY:-8,worldZ:oz+1,blockId:BLOCK_ID.air},
      {worldX:ox+3,worldY:299,worldZ:oz+3,blockId:BLOCK_ID.stone},
      {worldX:ox+4,worldY:299,worldZ:oz+3,blockId:BLOCK_ID.lava},
      {worldX:ox+6,worldY:-7,worldZ:oz+5,blockId:BLOCK_ID.water},
      {worldX:ox+7,worldY:-7,worldZ:oz+5,blockId:BLOCK_ID.ice},
      {worldX:ox+8,worldY:-7,worldZ:oz+5,blockId:BLOCK_ID.moss},
    ],"cold-geometry-oracle");
    const access=manager.meshAccessForChunk(chunk),full={...access,generatedTerrain:false,noLocalLightSources:false};
    let skipped=0;
    for(const section of ensureRenderSections(chunk).values()) {
      const actual=buildRenderSection(chunk,section,access),expected=buildRenderSection(chunk,section,full);
      for(const field of ["mesh","visualMesh"])sameMesh(actual[field],expected[field],section.sectionIndex+" "+field);
      if(actual.skippedGeneratedEmpty) {
        skipped++;assert.equal(expected.mesh.vertexCount+expected.visualMesh.vertexCount,0);
        assert.equal(actual.voxelQueries,0);assert.equal(actual.voxelCacheBytes,0);
      }
    }
    assert.ok(skipped>=10,"provably empty layers must skip voxel reconstruction");
  } finally {manager.dispose();}
});

test("a reused section plan observes new edits, removals and emissive sources",()=>{
  const manager=new ChunkManager({useWorkers:false,shadows:false});
  try {
    const chunk=manager.ensureChunk(66,29),section=ensureRenderSections(chunk).get(20),access=manager.meshAccessForChunk(chunk);
    assert.equal(buildRenderSection(chunk,section,access).skippedGeneratedEmpty,true);
    manager.applyPendingDelta([{worldX:1060,worldY:299,worldZ:468,blockId:BLOCK_ID.lava}],"new-light-source");
    assert.equal(access.noLocalLightSources(),false);
    const actual=buildRenderSection(chunk,section,access),full=buildRenderSection(chunk,section,{...access,generatedTerrain:false,noLocalLightSources:false});
    assert.ok(actual.visualMesh.vertexCount>0);
    sameMesh(actual.visualMesh,full.visualMesh,"new emissive edit");
    manager.rollbackPendingDelta("new-light-source");
    assert.equal(access.noLocalLightSources(),true);
    assert.equal(buildRenderSection(chunk,section,access).skippedGeneratedEmpty,true);
  } finally {manager.dispose();}
});

test("no-shadow surfaces without emitters skip all light cells and transport allocations",()=>{
  const chunk={chunkX:0,chunkZ:0,chunkSize:16,minY:0,height:16,shadows:false};
  const vertices=new Uint8Array(128*20),data=new DataView(vertices.buffer);
  for(let v=0;v<128;v++) {
    [2.5+v%12,5.5,2.5+Math.floor(v/12)].forEach((value,axis)=>data.setInt16(v*20+axis*2,value*64,true));
    data.setInt16(v*20+6,64,true);data.setInt8(v*20+9,127);
  }
  const fast={vertices:vertices.slice(),vertexCount:128},full={vertices:vertices.slice(),vertexCount:128};
  const access={getBlockAtWorld:()=>BLOCK_ID.air,getColumnTopAtWorld:()=>-1};
  const old=bakeSectionLighting(chunk,{originY:0,height:16},access,[full]);
  const next=bakeSectionLighting(chunk,{originY:0,height:16},{noLocalLightSources:true,
    getBlockAtWorld:()=>{throw new Error("unneeded voxel query");},
    getColumnTopAtWorld:()=>{throw new Error("disabled shadow query");}},[fast]);
  assert.deepEqual(fast.vertices,full.vertices);
  assert.ok(old.cells>next.cells*4);
  assert.equal(next.cells,0);assert.equal(next.domainCells,0);assert.equal(next.occlusion,false);
  assert.equal(next.cells,next.samples);assert.equal(next.transportCacheBytes,0);assert.equal(next.sunlight,null);
});

test("no-emitter shortcut exactly matches ordinary sky transport across roofs and cavities",()=>{
  let seed=97;
  const cells=new Set();
  for(let y=0;y<12;y++)for(let z=0;z<16;z++)for(let x=0;x<16;x++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    if(seed%5===0)cells.add(`${x}:${y}:${z}`);
  }
  const access={getBlockAtWorld:(x,y,z)=>cells.has(`${x}:${y}:${z}`)?BLOCK_ID.stone:BLOCK_ID.air,
    getColumnTopAtWorld:(x,z)=>{for(let y=11;y>=0;y--)if(cells.has(`${x}:${y}:${z}`))return y;return -1;}};
  const chunk={chunkX:0,chunkZ:0,chunkSize:16,minY:0,height:16,shadows:true};
  for(const radius of [1,2,4,8]) {
    const vertices=new Uint8Array(80*20),d=new DataView(vertices.buffer);
    for(let v=0;v<80;v++) {
      [2.5+v%12,1.5+Math.floor(v/12),2.5+v%10].forEach((value,axis)=>d.setInt16(v*20+axis*2,value*64,true));
      d.setInt16(v*20+6,64,true);d.setInt8(v*20+8,-127);
    }
    const fast={vertices:vertices.slice(),vertexCount:80},full={vertices:vertices.slice(),vertexCount:80};
    bakeSectionLighting(chunk,{originY:0,height:16},access,[full],{radius});
    bakeSectionLighting(chunk,{originY:0,height:16},{...access,noLocalLightSources:true},[fast],{radius});
    assert.deepEqual(fast.vertices,full.vertices,"radius "+radius);
  }
});

test("cold actual Worker commits every layer with exact full-path geometry and illumination",async()=>{
  const manager=new ChunkManager({useWorkers:false,shadows:false}),worker=await createActualBuildWorker();
  try {
    const chunk=manager.ensureChunk(66,29);
    manager.applyPendingDelta([{worldX:1056,worldY:-8,worldZ:468,blockId:BLOCK_ID.air},
      {worldX:1057,worldY:299,worldZ:468,blockId:BLOCK_ID.lava}],"cold-worker-edits");
    const task={worldSeed:manager.worldSeed,chunkX:66,chunkZ:29,generationVersion:manager.generationVersion,
      resourceRuleVersion:manager.resourceRuleVersion,materialVersion:1,options:manager.workerOptions(),mode:"base",taskVersion:chunk.version,
      finalDeltas:Int32Array.from(Array.from(chunk.getFinalDeltaMap().values()).flatMap(d=>[d.worldX,d.worldY,d.worldZ,d.blockId])),
      neighborDeltas:manager.neighborDeltasForWorker(66,29),treeDeltas:manager.treeNeighborDeltasForWorker(66,29),
      lightingDeltas:manager.visualDeltasForWorker(66,29,8),columnTopHalo:manager.captureWorkerColumnTopHalo(chunk)};
    const actual=await worker.build(task),sections=ensureRenderSections(chunk);
    assert.equal(actual.sectionResults.length,sections.size);
    const access={...manager.meshAccessForChunk(chunk),generatedTerrain:false,noLocalLightSources:false};
    for(const result of actual.sectionResults) {
      const expected=buildRenderSection(chunk,sections.get(result.sectionIndex),access);
      assert.equal(result.visualError,null);
      for(const field of ["mesh","visualMesh"])sameMesh(result[field],expected[field],result.sectionIndex+" "+field);
    }
  } finally {await worker.dispose();manager.dispose();}
});
