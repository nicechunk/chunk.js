import assert from "node:assert/strict";
import test from "node:test";
import { ChunkState } from "../chunk/chunk-state.js";
import { meshChunkVisual, meshChunkOpaqueFast } from "../chunk/chunk-mesher.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { decodedVertices, actualFaces, expectedFaces } from "./helpers/face-oracle.mjs";

function profileChunk(size=16,water=false) {
  const profile={surfaceY:new Int16Array(size*size).fill(0),surfaceBlock:new Uint16Array(size*size).fill(BLOCK_ID.stone),waterY:new Int16Array(size*size).fill(water?5:-32768),noWater:-32768,minY:-1,height:10,maxBuildY:8};
  return new ChunkState({chunkX:0,chunkZ:0,chunkSize:size,minY:-1,height:10,baseProfile:profile,baseBlockResolver:(_x,y)=>y<=0?BLOCK_ID.stone:water&&y<=5?BLOCK_ID.water:BLOCK_ID.air});
}
const hasWaterTop=(mesh,x,y,z)=>decodedVertices(mesh).some(v=>v.p[0]>=x&&v.p[0]<=x+1&&v.p[1]===y&&v.p[2]>=z&&v.p[2]<=z+1&&v.n[1]===127);

test("removing water top exposes remaining segment, caps and reopen follow final state",()=>{
  const c=profileChunk(1,true);
  c.applyChainDelta([{worldX:0,worldY:5,worldZ:0,blockId:BLOCK_ID.air}],{protectUntilSnapshot:false});
  assert.ok(hasWaterTop(meshChunkVisual(c),0,5,0));
  c.applyChainDelta([{worldX:0,worldY:5,worldZ:0,blockId:BLOCK_ID.stone}],{protectUntilSnapshot:false});
  assert.equal(hasWaterTop(meshChunkVisual(c),0,5,0),false);
  c.applyChainDelta([{worldX:0,worldY:5,worldZ:0,blockId:BLOCK_ID.water},{worldX:0,worldY:6,worldZ:0,blockId:BLOCK_ID.water}],{protectUntilSnapshot:false});
  const mesh=meshChunkVisual(c);
  assert.ok(hasWaterTop(mesh,0,7,0));assert.equal(hasWaterTop(mesh,0,6,0),false);
});

for(const id of [BLOCK_ID.cotton,BLOCK_ID.flowerWhite])test(`profile and same-value delta emit one plant ${id}`,()=>{
  const c=profileChunk(1);c.getBaseBlock=(_x,y)=>y<=0?BLOCK_ID.stone:y===1?id:BLOCK_ID.air;
  const before=meshChunkVisual(c);
  c.applyChainDelta([{worldX:0,worldY:1,worldZ:0,blockId:id}],{protectUntilSnapshot:false});
  const after=meshChunkVisual(c);
  assert.equal(after.vertexCount,before.vertexCount);assert.deepEqual(after.vertices,before.vertices);
});

for(const size of [16,31,32,33,64])test(`greedy rows do not wrap at bit 31 or 32: size ${size}`,()=>{
  const c=profileChunk(size);const access=(_x,y,_z)=>y>=-1&&y<=0?BLOCK_ID.stone:BLOCK_ID.air;
  assert.deepEqual(actualFaces(meshChunkOpaqueFast(c,{getBlockAtWorld:access,neighborDeltas:[]})),expectedFaces(c,access));
});

for(const y of [-513,-512,319,320,511,512])test(`final vertices remain valid at Y ${y}`,()=>{
  const c=new ChunkState({chunkX:0,chunkZ:0,chunkSize:1,height:1,minY:y,baseBlocks:Uint16Array.of(BLOCK_ID.stone)});
  const mesh=meshChunkOpaqueFast(c);
  const points=decodedVertices(mesh).map(v=>v.p[1]);
  assert.equal(Math.min(...points),y);assert.equal(Math.max(...points),y+1);
});
