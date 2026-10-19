import assert from "node:assert/strict";
import test from "node:test";
import { ChunkState } from "../chunk/chunk-state.js";
import { BLOCK_ID, isOpaqueSolidBlock } from "../world/block-registry.js";
import { ensureRenderSections, buildRenderSection } from "../chunk/render-sections.js";
import { bakeSectionLighting } from "../chunk/baked-light-field.js";
import { bakeDenseLightingOracle } from "./helpers/dense-light-field-oracle.mjs";

for(const seed of [1,7,19,41,83,101])test(`sparse finite light transport matches dense reference, seed ${seed}`,()=>{
  let random=seed;
  const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random/2**32;};
  const c=new ChunkState({chunkX:-1,chunkZ:1,chunkSize:4,height:16,minY:-16,baseBlocks:new Uint16Array(4*4*16)});
  for(let i=0;i<c.baseBlocks.length;i++)c.baseBlocks[i]=next()<.4?BLOCK_ID.stone:next()<.035?BLOCK_ID.lava:BLOCK_ID.air;
  const access={getBlockAtWorld:(x,y,z)=>c.getFinalBlock(x+4,y,z-4),getColumnTopAtWorld:(x,z)=>{
    for(let y=-1;y>=-16;y--)if(isOpaqueSolidBlock(c.getFinalBlock(x+4,y,z-4)))return y;
    return -17;
  }};
  const section=ensureRenderSections(c).get(0),result=buildRenderSection(c,section,access);
  const sparse=[result.mesh,result.visualMesh].filter(Boolean).map(mesh=>({...mesh,vertices:mesh.vertices.slice()}));
  const dense=sparse.map(mesh=>({...mesh,vertices:mesh.vertices.slice()}));
  // Different radii and interior solids/emissive cells exercise path length,
  // blocked transport, local sources and fractional model face samples.
  for(const radius of [1,2,4,8]){
    bakeSectionLighting(c,section,access,sparse,{radius});
    bakeDenseLightingOracle(c,section,access,dense,{radius});
    for(let i=0;i<sparse.length;i++) {
      // This dense reference retains the old vertical direct-sun seed. Only its
      // diffuse/local transport is an oracle; directional rays have separate tests.
      const diffuse=mesh=>{const bytes=mesh.vertices.slice();for(let v=0;v<mesh.vertexCount;v++)bytes[v*20+19]&=15;return bytes;};
      assert.deepEqual(diffuse(sparse[i]),diffuse(dense[i]),`radius ${radius}, mesh ${i}`);
    }
  }
});

test("a sealed single-cell edit queries its reachable light neighbours, not an entire section halo",()=>{
  const c=new ChunkState({chunkX:0,chunkZ:0,chunkSize:16,height:353,minY:-32,baseBlocks:new Uint16Array(16*16*353).fill(BLOCK_ID.stone)});
  c.applyChainDelta([{worldX:8,worldY:65,worldZ:8,blockId:BLOCK_ID.air}],{protectUntilSnapshot:false});
  const result=buildRenderSection(c,ensureRenderSections(c).get(6),{
    getBlockAtWorld:(x,y,z)=>x>=0&&x<16&&z>=0&&z<16?c.getFinalBlock(x,y,z):BLOCK_ID.stone,
    getColumnTopAtWorld:()=>320,
  });
  assert.ok(result.lighting.samples>0);
  assert.ok(result.lighting.cells<result.lighting.domainCells/100);
});
