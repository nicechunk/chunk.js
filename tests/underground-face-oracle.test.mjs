import assert from "node:assert/strict";
import test from "node:test";
import { ChunkState } from "../chunk/chunk-state.js";
import { meshChunkOpaqueFast } from "../chunk/chunk-mesher.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { expectedFaces,actualFaces } from "./helpers/face-oracle.mjs";

export function flatChunk(cx=0,cz=0,size=16) {
  const minY=-32,height=145,surface=80;
  const profile={surfaceY:new Int16Array(size*size).fill(surface),surfaceBlock:new Uint16Array(size*size).fill(BLOCK_ID.stone),waterY:new Int16Array(size*size).fill(-32768),noWater:-32768,minY,height,maxBuildY:minY+height-1};
  return new ChunkState({chunkX:cx,chunkZ:cz,chunkSize:size,minY,height,baseProfile:profile,baseBlockResolver:(_x,y)=>y<=surface?BLOCK_ID.stone:BLOCK_ID.air});
}

for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]])for(const unrelated of [false,true])for(const depth of [0,1,4,5,20,40]){
  test(`deep boundary oracle ${dx},${dz} unrelated=${unrelated} depth=${depth}`,()=>{
    const chunk=flatChunk(-1,-1),neighbor=flatChunk(-1+dx,-1+dz);
    const x=dx>0?16:dx<0?-1:8,z=dz>0?16:dz<0?-1:8;
    const edit={worldX:chunk.chunkX*16+x,worldY:80-depth,worldZ:chunk.chunkZ*16+z,blockId:BLOCK_ID.air};
    neighbor.applyChainDelta([edit],{protectUntilSnapshot:false});
    if(unrelated)chunk.applyChainDelta([{worldX:-14,worldY:60,worldZ:-14,blockId:BLOCK_ID.air}],{protectUntilSnapshot:false});
    const getWorld=(wx,y,wz)=>{
      const cx=Math.floor(wx/16),cz=Math.floor(wz/16);
      if(cx===chunk.chunkX&&cz===chunk.chunkZ)return chunk.getFinalBlock(wx-cx*16,y,wz-cz*16);
      if(cx===neighbor.chunkX&&cz===neighbor.chunkZ)return neighbor.getFinalBlock(wx-cx*16,y,wz-cz*16);
      return y>=-32&&y<=80?BLOCK_ID.stone:BLOCK_ID.air;
    };
    const mesh=meshChunkOpaqueFast(chunk,{getBlockAtWorld:getWorld,neighborDeltas:[edit]});
    assert.deepEqual(actualFaces(mesh),expectedFaces(chunk,getWorld));
  });
}
