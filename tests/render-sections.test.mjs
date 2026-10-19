import assert from "node:assert/strict";
import test from "node:test";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { ChunkState } from "../chunk/chunk-state.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { ensureRenderSections,sectionIndexAt,sectionRevision,buildRenderSection,commitRenderSection } from "../chunk/render-sections.js";
import { expectedFaces,actualFaces } from "./helpers/face-oracle.mjs";

test("default world covers 23 sections anchored at -32 including one final layer",()=>{
  const c=new ChunkState({chunkX:-1,chunkZ:-2});const sections=ensureRenderSections(c);
  assert.equal(sections.size,23);assert.equal(sections.get(22).originY,320);assert.equal(sections.get(22).height,1);
  for(const y of [-32,-31,-17,-16,-1,0,319,320])assert.equal(sections.get(sectionIndexAt(c,y)).originY,-32+Math.floor((y+32)/16)*16);
});

function denseManager() {
  const m=new ChunkManager({chunkSize:4,height:48,minY:-16,useWorkers:false,viewDistance:1});
  const c=m.ensureChunk(0,0);c.setBaseBlocks(new Uint16Array(4*48*4).fill(BLOCK_ID.stone));
  m.rebuildDirtyChunks(10000);return {m,c};
}

test("a local edit invalidates only its section and one-cell vertical halo",()=>{
  const {m,c}=denseManager();const original=[...c.renderSections.values()].map(s=>s.meshCommitToken);
  m.applyPendingDelta([{worldX:1,worldY:5,worldZ:1,blockId:BLOCK_ID.air}],"dig");
  assert.equal([...c.renderSections.values()].filter(s=>s.dirty).length,1);
  m.rebuildDirtyChunks(10000);
  assert.equal(c.renderSections.get(0).meshCommitToken,original[0]);assert.equal(c.renderSections.get(2).meshCommitToken,original[2]);
  assert.notEqual(c.renderSections.get(1).meshCommitToken,original[1]);
  assert.deepEqual(actualFaces(c.mesh),expectedFaces(c,(...p)=>m.getBlockAtWorld(...p)));
  m.dispose();
});

test("section border exposes real neighbour state without manufacturing a bottom plane",()=>{
  const {m,c}=denseManager();
  m.applyPendingDelta([{worldX:1,worldY:15,worldZ:1,blockId:BLOCK_ID.air},{worldX:1,worldY:16,worldZ:1,blockId:BLOCK_ID.air}],"vertical-tunnel");
  m.rebuildDirtyChunks(10000);
  assert.deepEqual(actualFaces(c.mesh),expectedFaces(c,(...p)=>m.getBlockAtWorld(...p)));m.dispose();
});

test("old section results are rejected; unrelated section edits do not stale the task",()=>{
  const {m,c}=denseManager(),section=c.renderSections.get(1),revision=sectionRevision(section,c.materialVersion);
  const result=buildRenderSection(c,section,m.meshAccessForChunk(c));
  m.applyPendingDelta([{worldX:1,worldY:25,worldZ:1,blockId:BLOCK_ID.air}],"far-section");
  assert.equal(commitRenderSection(c,section,result,revision),true);
  const nextRevision=sectionRevision(section,c.materialVersion);
  m.applyPendingDelta([{worldX:1,worldY:5,worldZ:1,blockId:BLOCK_ID.air}],"same-section");
  assert.equal(commitRenderSection(c,section,result,nextRevision),false);m.dispose();
});

test("visual failure retains its previous channel, retries, and accepts a legitimate empty result",()=>{
  const {m,c}=denseManager(),section=c.renderSections.get(1),old=section.visualMesh;
  const revision=sectionRevision(section,c.materialVersion),result=buildRenderSection(c,section,m.meshAccessForChunk(c));
  assert.equal(commitRenderSection(c,section,{...result,visualMesh:null,visualError:"injected visual failure"},revision),true);
  assert.equal(section.visualMesh,old);assert.equal(section.visualDirty,true);assert.ok(section.visualRetryAt>performance.now());
  assert.equal(section.visualError,"injected visual failure");
  commitRenderSection(c,section,{mesh:null,visualMesh:null,visualError:null},revision);
  assert.equal(section.visualMesh,null);assert.equal(section.visualDirty,false);assert.equal(section.visualError,null);m.dispose();
});
