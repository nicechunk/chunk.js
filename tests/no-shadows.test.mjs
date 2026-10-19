import test from "node:test";
import assert from "node:assert/strict";
import { ChunkState } from "../chunk/chunk-state.js";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { meshChunkOpaque, meshChunkVisual } from "../chunk/chunk-mesher.js";
import { bakeSectionLighting } from "../chunk/baked-light-field.js";
import { ensureRenderSections, buildRenderSection, sectionDeltaValues, sectionRevision } from "../chunk/render-sections.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { createActualBuildWorker } from "./helpers/actual-build-worker.mjs";

function fixture(shadows) {
  const blocks=new Uint16Array(16*16*16);
  for(let z=0;z<16;z++)for(let x=0;x<16;x++)blocks[x+16*16*z]=BLOCK_ID.stone;
  for(const [x,y,z,id]of [[3,1,3,BLOCK_ID.bush],[8,1,8,BLOCK_ID.cactus]])blocks[x+16*(y+16*z)]=id;
  return new ChunkState({chunkX:0,chunkZ:0,chunkSize:16,height:16,minY:0,baseBlocks:blocks,shadows,
    worldSeed:new Uint8Array(32).fill(7),treeInstances:[{id:"tree",x:12,z:12,baseY:1,trunkHeight:4,pine:false,variantSeed:7}]});
}
function shadowVertices(mesh) {
  const d=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);let count=0;
  for(let v=0;v<mesh.vertexCount;v++)count+=d.getUint16(v*20+16,true)===54;
  return count;
}

test("disabling shadows omits vegetation, cactus and tree projection geometry and terrain shadow sampling",()=>{
  const on=fixture(true),off=fixture(false);
  assert.ok(shadowVertices(meshChunkVisual(on))>0,"fixture must contain actual cast-shadow geometry");
  const visual=meshChunkVisual(off);
  assert.equal(shadowVertices(visual),0);assert.ok(visual.vertexCount>0,"plant models must remain");
  let shadowQueries=0;
  meshChunkOpaque(off,{getColumnTopAtWorld:()=>{shadowQueries++;return 15;}});
  assert.equal(shadowQueries,0,"terrain height-field shadow samples must be skipped");
  meshChunkOpaque(on,{getColumnTopAtWorld:()=>{shadowQueries++;return 15;}});
  assert.ok(shadowQueries>0,"the enabled fixture must exercise terrain shadow samples");
});

test("disabled shadows skip directional and diffuse-sky occlusion while preserving material/local bits",()=>{
  const access={getColumnTopAtWorld:(x)=>x===-2?12:-1,
    getBlockAtWorld:(x,y)=>x===-2&&y>=0&&y<=12?BLOCK_ID.stone:BLOCK_ID.air};
  const values=[];
  for(const shadows of [true,false]) {
    const vertices=new Uint8Array(80),data=new DataView(vertices.buffer);
    for(let v=0;v<4;v++) {
      [4.5,1.5,8.5].forEach((value,axis)=>data.setInt16(v*20+axis*2,value*64,true));
      data.setInt16(v*20+6,64,true);data.setInt8(v*20+9,127);data.setUint16(v*20+18,2,true);
    }
    const light=bakeSectionLighting({chunkX:0,chunkZ:0,chunkSize:16,minY:0,height:16,shadows},{originY:0,height:16},access,[{vertices,vertexCount:4}]);
    values.push({light,flags:data.getUint16(18,true)});
  }
  assert.equal(values[0].flags>>>12,0);assert.equal(values[1].flags>>>12,15);
  assert.equal((values[1].flags>>>8)&15,15,"sky must not be darkened by a roof");
  assert.equal(values[0].flags&255,values[1].flags&255,"local light and material bits must be unchanged");
  assert.equal(values[1].light.sunlight,null,"no ray field is allocated or traced");
});

test("no-shadow lighting removes sealed-cave occlusion and preserves additive emissive local light",()=>{
  const c=fixture(false);c.setBaseBlocks(new Uint16Array(16*16*16).fill(BLOCK_ID.stone));
  c.applyChainDelta([{worldX:8,worldY:4,worldZ:8,blockId:BLOCK_ID.air},
    {worldX:9,worldY:4,worldZ:8,blockId:BLOCK_ID.lava}],{protectUntilSnapshot:false});
  const result=buildRenderSection(c,ensureRenderSections(c).get(0),{
    getBlockAtWorld:(x,y,z)=>x>=0&&z>=0&&x<16&&z<16?c.getFinalBlock(x,y,z):BLOCK_ID.stone,getColumnTopAtWorld:()=>15});
  const d=new DataView(result.mesh.vertices.buffer);let local=false,caveVertices=0;
  for(let v=0;v<result.mesh.vertexCount;v++) {
    const offset=v*20,scale=d.getInt16(offset+6,true);
    const p=[0,1,2].map(axis=>d.getInt16(offset+axis*2,true)/scale);
    if(p[0]<8||p[0]>10||p[1]<4||p[1]>5||p[2]<8||p[2]>9)continue;
    caveVertices++;
    const flags=d.getUint16(offset+18,true);
    assert.equal(flags>>>8,255);local ||= ((flags>>>3)&15)>0;
  }
  assert.ok(caveVertices>0);assert.ok(local);assert.equal(result.lighting.sunlight,null);
});

test("actual Worker preserves the manager no-shadow policy, all non-shadow geometry and exact mesh bytes",async()=>{
  const manager=new ChunkManager({useWorkers:false,shadows:false}),worker=await createActualBuildWorker();
  try {
    const chunk=manager.ensureChunk(66,29),index=Math.floor((chunk.baseProfile.surfaceY[136]-manager.minY)/16),section=ensureRenderSections(chunk).get(index);
    const sync=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
    assert.equal(chunk.shadows,false);assert.equal(manager.workerOptions().shadows,false);
    const task={worldSeed:manager.worldSeed,chunkX:66,chunkZ:29,generationVersion:manager.generationVersion,
      resourceRuleVersion:manager.resourceRuleVersion,materialVersion:1,options:manager.workerOptions(),mode:"section",sectionIndex:index,
      sectionRevision:sectionRevision(section,1),baseProfile:chunk.baseProfile,treeInstances:chunk.treeInstances,
      finalDeltas:Int32Array.from(sectionDeltaValues(chunk,index).flatMap(d=>[d.worldX,d.worldY,d.worldZ,d.blockId])),
      neighborDeltas:manager.neighborDeltasForWorker(66,29,index),treeDeltas:manager.treeNeighborDeltasForWorker(66,29,index),
      lightingDeltas:manager.visualDeltasForWorker(66,29,8,index),columnTopHalo:manager.captureWorkerColumnTopHalo(chunk)};
    const actual=await worker.build(task);
    assert.equal(actual.visualError,null);assert.equal(actual.lighting.sunlight,null);
    for(const field of ["mesh","visualMesh"]) {
      assert.equal(shadowVertices(actual[field]),0);
      assert.deepEqual(Buffer.from(actual[field].vertices),Buffer.from(sync[field].vertices));
      assert.deepEqual(actual[field].indices,sync[field].indices);
    }
  } finally {await worker.dispose();manager.dispose();}
});
