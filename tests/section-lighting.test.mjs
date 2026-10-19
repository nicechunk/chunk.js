import assert from "node:assert/strict";
import test from "node:test";
import { ChunkState } from "../chunk/chunk-state.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { ensureRenderSections,buildRenderSection } from "../chunk/render-sections.js";

function fixture() {
  const c=new ChunkState({chunkX:0,chunkZ:0,chunkSize:8,height:16,minY:0,baseBlocks:new Uint16Array(8*8*16).fill(BLOCK_ID.stone)});
  const edits=[{worldX:3,worldY:3,worldZ:3,blockId:BLOCK_ID.air},{worldX:4,worldY:3,worldZ:3,blockId:BLOCK_ID.air}];
  c.applyChainDelta(edits,{protectUntilSnapshot:false});
  const getBlockAtWorld=(x,y,z)=>c.getFinalBlock(x,y,z);
  const access={getBlockAtWorld,getColumnTopAtWorld:(x,z)=>{for(let y=15;y>=0;y--)if(getBlockAtWorld(x,y,z)===BLOCK_ID.stone)return y;return -1;}};
  return {c,access,build:()=>buildRenderSection(c,ensureRenderSections(c).get(0),access)};
}

function innerFlags(mesh) {
  const data=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength),values=[];
  for(let v=0;v<mesh.vertexCount;v+=4){const p=[0,0,0];for(let j=0;j<4;j++){const o=(v+j)*20,s=data.getInt16(o+6,true);for(let a=0;a<3;a++)p[a]+=data.getInt16(o+a*2,true)/s/4;}
    if(p[0]>=3&&p[0]<=5&&p[1]>=3&&p[1]<=4&&p[2]>=3&&p[2]<=4)values.push(data.getUint16(v*20+18,true));
  }return values;
}

test("sealed cavity has no sun or sky, skylight opening and sealing recompute transport",()=>{
  const f=fixture();const sealed=innerFlags(f.build().mesh);assert.ok(sealed.length>0);
  assert.ok(sealed.every(flags=>(flags&128)&&((flags>>>8)&255)===0));
  f.c.applyChainDelta(Array.from({length:12},(_,i)=>({worldX:3,worldY:i+4,worldZ:3,blockId:BLOCK_ID.air})),{protectUntilSnapshot:false});
  const opened=innerFlags(f.build().mesh);assert.ok(opened.some(flags=>((flags>>>8)&15)>0));
  f.c.applyChainDelta([{worldX:3,worldY:4,worldZ:3,blockId:BLOCK_ID.stone}],{protectUntilSnapshot:false});
  assert.ok(innerFlags(f.build().mesh).every(flags=>((flags>>>8)&255)===0));
});

test("emissive local source illuminates a sealed cavity without creating sunlight",()=>{
  const f=fixture();
  f.c.applyChainDelta([{worldX:4,worldY:3,worldZ:3,blockId:BLOCK_ID.lava}],{protectUntilSnapshot:false});
  const flags=innerFlags(f.build().mesh);
  assert.ok(flags.some(value=>((value>>>3)&15)>0));
  assert.ok(flags.every(value=>((value>>>8)&255)===0));
});
