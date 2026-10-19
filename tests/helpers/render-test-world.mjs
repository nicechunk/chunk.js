import { ChunkState } from "../../chunk/chunk-state.js";
import { BLOCK_ID } from "../../world/block-registry.js";

export function createFlatTestWorld({ chunkSize=16,minY=-32,height=145,surface=80 }={}) {
  const chunks=new Map();
  const baseAt=(_x,y,_z)=>y>=minY&&y<minY+height&&y<=surface?BLOCK_ID.stone:BLOCK_ID.air;
  function ensure(cx,cz) {
    const id=`${cx},${cz}`;
    if(chunks.has(id))return chunks.get(id);
    const profile={surfaceY:new Int16Array(chunkSize*chunkSize).fill(surface),surfaceBlock:new Uint16Array(chunkSize*chunkSize).fill(BLOCK_ID.stone),waterY:new Int16Array(chunkSize*chunkSize).fill(-32768),noWater:-32768,minY,height,maxBuildY:minY+height-1};
    const chunk=new ChunkState({chunkX:cx,chunkZ:cz,chunkSize,minY,height,baseProfile:profile,baseBlockResolver:baseAt});
    chunks.set(id,chunk);return chunk;
  }
  function getWorld(x,y,z) {
    const cx=Math.floor(x/chunkSize),cz=Math.floor(z/chunkSize),chunk=chunks.get(`${cx},${cz}`);
    return chunk?chunk.getFinalBlock(x-cx*chunkSize,y,z-cz*chunkSize):baseAt(x,y,z);
  }
  function apply(edits,{pending=false,txId="fixture"}={}) {
    const grouped=new Map();
    for(const edit of edits) {
      const cx=Math.floor(edit.worldX/chunkSize),cz=Math.floor(edit.worldZ/chunkSize),chunk=ensure(cx,cz);
      let group=grouped.get(chunk);if(!group)grouped.set(chunk,group=[]);group.push(edit);
    }
    for(const [chunk,group]of grouped) {
      if(pending)chunk.applyPendingDelta(group,txId);
      else chunk.applyChainDelta(group,{protectUntilSnapshot:false});
    }
  }
  const access={getBlockAtWorld:getWorld,getColumnTopAtWorld:(x,z)=>{
    for(let y=minY+height-1;y>=minY;y--)if(getWorld(x,y,z)!==BLOCK_ID.air)return y;
    return minY-1;
  }};
  return {chunks,ensure,getWorld,apply,access,options:{chunkSize,minY,height,surface}};
}

export function seededRandom(seed) {
  let state=seed>>>0;
  return () => { state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296; };
}
