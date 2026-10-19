import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_ID } from "../world/block-registry.js";
import { meshChunkOpaqueFast } from "../chunk/chunk-mesher.js";
import { ensureRenderSections,buildRenderSection } from "../chunk/render-sections.js";
import { actualFaces,expectedFaces } from "./helpers/face-oracle.mjs";
import { createFlatTestWorld,seededRandom } from "./helpers/render-test-world.mjs";

function verifyFast(world,chunk,context="") {
  const neighborDeltas=[...world.chunks.values()].flatMap(c=>c===chunk?[]:[...c.getFinalDeltaMap().values()]);
  assert.deepEqual(actualFaces(meshChunkOpaqueFast(chunk,{...world.access,neighborDeltas})),expectedFaces(chunk,world.getWorld),context);
}
function verifySections(world,chunk,context="") {
  const coverage=new Map();
  for(const section of ensureRenderSections(chunk).values()) {
    const result=buildRenderSection(chunk,section,world.access);
    assert.equal(result.visualError,null);
    for(const [key,count]of actualFaces(result.mesh)) {
      assert.equal(coverage.has(key),false,`${context}: duplicate across section ${section.sectionIndex}: ${key}`);
      coverage.set(key,count);
    }
  }
  assert.deepEqual(coverage,expectedFaces(chunk,world.getWorld),context);
}

for(const [sx,sz]of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
  test(`negative-coordinate corner and both-side edits have exact coverage ${sx},${sz}`,()=>{
    const world=createFlatTestWorld(),c=world.ensure(-2,-2),x=c.chunkX*16+(sx<0?0:15),z=c.chunkZ*16+(sz<0?0:15);
    world.apply([
      {worldX:x+sx,worldY:40,worldZ:z,blockId:BLOCK_ID.air},
      {worldX:x,worldY:40,worldZ:z+sz,blockId:BLOCK_ID.air},
      {worldX:x+sx,worldY:40,worldZ:z+sz,blockId:BLOCK_ID.air},
      {worldX:x,worldY:41,worldZ:z,blockId:BLOCK_ID.air},
      {worldX:x,worldY:40,worldZ:z,blockId:BLOCK_ID.air},
    ]);
    for(const chunk of world.chunks.values())verifyFast(world,chunk,`corner ${sx},${sz} chunk=${chunk.id}`);
    verifySections(world,c,`corner ${sx},${sz}`);
  });
}

test("pending -> confirmation -> authoritative reload -> backfill preserves exact boundary geometry",()=>{
  const world=createFlatTestWorld(),source=world.ensure(-1,0),neighbor=world.ensure(0,0);
  const edits=[{worldX:-1,worldY:15,worldZ:8,blockId:BLOCK_ID.air},{worldX:0,worldY:15,worldZ:8,blockId:BLOCK_ID.air},
    {worldX:0,worldY:16,worldZ:8,blockId:BLOCK_ID.air},{worldX:-1,worldY:16,worldZ:8,blockId:BLOCK_ID.air}];
  world.apply(edits,{pending:true,txId:"cross-boundary"});
  for(const chunk of [source,neighbor])verifyFast(world,chunk,"pending");
  for(const chunk of world.chunks.values())chunk.confirmPendingDelta("cross-boundary",{slot:123,commitment:"confirmed"});
  const snapshots=[...world.chunks.values()].flatMap(c=>[...c.chainDeltas.values()]);
  const reloaded=createFlatTestWorld();reloaded.apply(snapshots);
  for(const chunk of reloaded.chunks.values()) {
    verifyFast(reloaded,chunk,"reloaded");verifySections(reloaded,chunk,"reloaded sections");
  }
  reloaded.apply(edits.map(edit=>({...edit,blockId:BLOCK_ID.stone})));
  for(const chunk of reloaded.chunks.values()) {
    verifyFast(reloaded,chunk,"backfilled");verifySections(reloaded,chunk,"backfilled sections");
    assert.ok(![...actualFaces(meshChunkOpaqueFast(chunk,reloaded.access)).keys()].some(key=>/:(15|16):8:/.test(key)),"filled tunnel must not retain its internal walls");
  }
});

for(const seed of [0x12345,0x415667,0xf00d,0xabcdef]) {
  test(`fixed-seed multilayer tunnel oracle seed=${seed}`,()=>{
    const world=createFlatTestWorld(),random=seededRandom(seed),c=world.ensure(-1,-1),edits=[];
    for(const y of [-17,-16,-1,0,15,16,31,32,63,64]) {
      const z=-16+2+Math.floor(random()*12);
      for(let x=-17;x<=1;x++)edits.push({worldX:x,worldY:y,worldZ:z,blockId:BLOCK_ID.air});
      for(let i=0;i<7;i++)edits.push({worldX:-16+Math.floor(random()*16),worldY:y+(random()>.5?1:0),worldZ:-16+Math.floor(random()*16),blockId:random()>.2?BLOCK_ID.air:BLOCK_ID.basalt});
    }
    world.apply(edits);
    verifyFast(world,c,`seed=${seed}`);verifySections(world,c,`seed=${seed}`);
  });
}

test("all 23 default sections cover world bottom and final Y320 exactly without section bottoms",()=>{
  const world=createFlatTestWorld({height:353}),chunk=world.ensure(0,-1);
  world.apply([{worldX:8,worldY:-32,worldZ:-8,blockId:BLOCK_ID.air},
    {worldX:8,worldY:-17,worldZ:-8,blockId:BLOCK_ID.air},{worldX:8,worldY:-16,worldZ:-8,blockId:BLOCK_ID.air},
    {worldX:8,worldY:319,worldZ:-8,blockId:BLOCK_ID.basalt},{worldX:8,worldY:320,worldZ:-8,blockId:BLOCK_ID.basalt}]);
  assert.equal(ensureRenderSections(chunk).size,23);
  verifySections(world,chunk,"default 23 sections");
});
