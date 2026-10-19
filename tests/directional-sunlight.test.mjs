import test from "node:test";
import assert from "node:assert/strict";
import { createDirectionalSunlight } from "../chunk/directional-sunlight.js";
import { bakeSectionLighting } from "../chunk/baked-light-field.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { WORLD_SUN_VECTOR, SUNLIGHT_HORIZONTAL_REACH } from "../world/sunlight.js";
import { MAIN_GAME_SUN_DIRECTION } from "../renderer/lighting.js";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { buildRenderSection, commitRenderSection, ensureRenderSections } from "../chunk/render-sections.js";
import { createActualBuildWorker } from "./helpers/actual-build-worker.mjs";

const key = (x,y,z) => `${x}:${y}:${z}`;
function world(cells) {
  const blocks=new Set(cells.map(p=>key(...p))),tops=new Map();
  for(const [x,y,z]of cells)tops.set(`${x}:${z}`,Math.max(tops.get(`${x}:${z}`)??-100,y));
  return {getBlockAtWorld:(x,y,z)=>blocks.has(key(x,y,z))?BLOCK_ID.stone:BLOCK_ID.air,
    getColumnTopAtWorld:(x,z)=>tops.get(`${x}:${z}`)??-100};
}
function box(min,max) {
  const cells=[];
  for(let x=min[0];x<=max[0];x++)for(let y=min[1];y<=max[1];y++)for(let z=min[2];z<=max[2];z++)cells.push([x,y,z]);
  return cells;
}

test("sun disc, material light and baked ray retain the original oblique source",()=>{
  const length=Math.hypot(...WORLD_SUN_VECTOR);
  assert.deepEqual(MAIN_GAME_SUN_DIRECTION,WORLD_SUN_VECTOR.map(v=>v/length));
  assert.ok(MAIN_GAME_SUN_DIRECTION[1]<.4);
});

test("low angled sunlight enters beneath a roof instead of being blocked by its vertical column",()=>{
  const access=world(box([0,8,-20],[3,8,20]));
  assert.ok(access.getColumnTopAtWorld(3,8)>1,"this point is beneath the roof");
  assert.equal(createDirectionalSunlight(access).sample(3,1,8),15);
});

test("a wall towards the sun casts shade where the vertical sky is clear",()=>{
  const access=world(box([-2,0,-20],[-2,12,20]));
  assert.ok(access.getColumnTopAtWorld(4,8)<1,"no blocker overhead");
  assert.equal(createDirectionalSunlight(access).sample(4,1,8),0);
  assert.equal(createDirectionalSunlight(world(box([8,0,-20],[8,12,20]))).sample(4,1,8),15,"a wall behind the receiver is not a sun blocker");
});

test("a roof shadow is displaced away from the sun instead of staying below the roof",()=>{
  const field=createDirectionalSunlight(world(box([-7,4,11],[-3,4,16])));
  assert.equal(field.sample(0,1,8),0,"ground down-sun from the roof");
  assert.equal(field.sample(-4,1,13),15,"ground under the roof receives low side light");
});

// Independent ray/box intersections, not another copy of the voxel traversal.
function oracle(point,cells,access) {
  const horizontal=Math.hypot(WORLD_SUN_VECTOR[0],WORLD_SUN_VECTOR[2]);
  const ray=WORLD_SUN_VECTOR.map(v=>v/horizontal),origin=point.map(v=>v+.5);
  for(const cell of cells) {
    let start=0,end=SUNLIGHT_HORIZONTAL_REACH;
    for(let axis=0;axis<3;axis++) {
      const a=(cell[axis]-origin[axis])/ray[axis],b=(cell[axis]+1-origin[axis])/ray[axis];
      start=Math.max(start,Math.min(a,b));end=Math.min(end,Math.max(a,b));
    }
    if(start<end)return 0;
  }
  const end=origin.map((v,a)=>Math.floor(v+ray[a]*SUNLIGHT_HORIZONTAL_REACH));
  return end[1]>access.getColumnTopAtWorld(end[0],end[2])?15:0;
}

test("bounded voxel rays match independent slab intersections, including negative and large coordinates",()=>{
  let random=19;
  const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random/2**32;};
  const cells=Array.from({length:240},()=>[Math.floor(next()*36)-20,Math.floor(next()*12),Math.floor(next()*36)-12]);
  const points=Array.from({length:180},()=>[Math.floor(next()*24)-8,Math.floor(next()*6),Math.floor(next()*24)-8]);
  for(const offset of [[0,0,0],[-1024,-32,2048],[2147483000,80,-2147483000]]) {
    const translated=cells.map(p=>p.map((v,a)=>v+offset[a])),access=world(translated),field=createDirectionalSunlight(access);
    for(const p of points) {
      const q=p.map((v,a)=>v+offset[a]);
      assert.equal(field.sample(...q),oracle(q,translated,access),q.join(","));
    }
    assert.ok(field.stats.cells<=field.stats.rays*32,"sunlight work must remain bounded");
  }
});

test("baked direct sunlight can enter beneath an overhang while diffuse skylight stays occluded",()=>{
  const vertices=new Uint8Array(80),d=new DataView(vertices.buffer);
  for(let v=0;v<4;v++) {
    for(const [axis,value]of [3.5,1.5,8.5].entries())d.setInt16(v*20+axis*2,value*64,true);
    d.setInt16(v*20+6,64,true);d.setInt8(v*20+8,-127);d.setUint16(v*20+18,2,true);
  }
  // Sun-facing edge on the opposite side of a roof: choose a narrow overhead
  // blocker so the direct ray leaves before hitting it.
  const edgeAccess=world(box([3,8,-12],[3,8,24]));
  bakeSectionLighting({chunkX:0,chunkZ:0,chunkSize:16,minY:0,height:32},{originY:0,height:16},edgeAccess,[{vertices,vertexCount:4}]);
  assert.equal(d.getUint16(18,true)>>>12,15);
  assert.ok(((d.getUint16(18,true)>>>8)&15)<15);
  assert.equal(d.getUint16(18,true)&7,2);
});

test("same-chunk oblique occluder edits invalidate a lower section even when column tops do not change",()=>{
  const manager=new ChunkManager({useWorkers:false,chunkSize:16,minY:0,height:32});
  try {
    const chunk=manager.ensureChunk(0,0),sections=ensureRenderSections(chunk),section=sections.get(0);
    chunk.setBaseBlocks(new Uint16Array(16*16*32).fill(BLOCK_ID.air));
    manager.applyPendingDelta([{worldX:2,worldY:31,worldZ:9,blockId:BLOCK_ID.stone}],"high-roof");
    section.mesh={indexCount:6};section.dirty=false;section.visualDirty=false;
    const revision=section.lightRevision;
    manager.applyPendingDelta([{worldX:2,worldY:20,worldZ:9,blockId:BLOCK_ID.stone}],"oblique-blocker");
    assert.ok(section.lightRevision>revision);assert.equal(section.dirty,true);
  } finally {manager.dispose();}
});

test("production dispatch captures an oblique blocker beyond the former eight-cell halo and real Worker matches",async()=>{
  const manager=new ChunkManager({useWorkers:false}),worker=await createActualBuildWorker();
  try {
    const chunk=manager.ensureChunk(0,0);manager.ensureChunk(-1,0);manager.ensureChunk(-1,1);
    manager.applyPendingDelta([{worldX:1,worldY:299,worldZ:8,blockId:BLOCK_ID.stone}],"receiver");
    const section=ensureRenderSections(chunk).get(20);
    const initial=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
    commitRenderSection(chunk,section,initial);
    const blocker=box([-9,300,12],[-9,310,21]).map(([worldX,worldY,worldZ])=>({worldX,worldY,worldZ,blockId:BLOCK_ID.stone}));
    manager.applyPendingDelta(blocker,"sun-wall");
    let task;
    const fake={postMessage:message=>{task=message;}};
    assert.equal(manager.dispatchSectionBuild(fake,{id:chunk.id,chunk,sectionIndex:20},chunk),true);
    assert.ok(Array.from(task.lightingDeltas).some((value,index)=>index%4===0&&value===-9));
    const sync=buildRenderSection(chunk,section,manager.meshAccessForChunk(chunk));
    const actual=await worker.build(task);
    assert.equal(actual.visualError,null);
    for(const field of ["mesh","visualMesh"]) {
      assert.deepEqual(Buffer.from(actual[field].vertices),Buffer.from(sync[field].vertices),field+" vertex light");
      assert.deepEqual(actual[field].indices,sync[field].indices,field+" geometry");
    }
    const sun=mesh=>{const d=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);let max=0;for(let i=0;i<mesh.vertexCount;i++)if(d.getInt8(i*20+9)===127)max=Math.max(max,d.getUint16(i*20+18,true)>>>12);return max;};
    assert.equal(sun(initial.mesh),15);assert.equal(sun(sync.mesh),0,"the remote wall must shade the top face");
    manager.inFlightBuilds.clear();
  } finally {await worker.dispose();manager.dispose();}
});
