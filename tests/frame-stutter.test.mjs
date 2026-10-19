import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkState } from '../chunk/chunk-state.js';
import { ChunkManager } from '../chunk/chunk-manager.js';
import { buildRenderSection, sectionRevision } from '../chunk/render-sections.js';
import { localIndex } from '../core/coordinates.js';
import { chunkWorldBounds } from '../renderer/frustum.js';
import { WebGL2VoxelRenderer, flattenRenderSections } from '../renderer/webgl2-renderer.js';
import { BufferManager } from '../renderer/buffer-manager.js';
import { BLOCK_ID } from '../world/block-registry.js';
import { actualFaces, expectedFaces } from './helpers/face-oracle.mjs';
import { FrameStatsCounter } from '../debug/stats.js';

test('frame statistics count submitted images instead of deferred animation callbacks', () => {
  const counter=new FrameStatsCounter({sampleMs:1000});counter.reset(100);
  counter.frame(200,{});
  counter.frame(400,{renderDeferred:true});
  counter.frame(600,{renderDeferred:true});
  const sample=counter.frame(1100,{renderDeferred:true});
  assert.equal(sample.fps,1);assert.equal(counter.sampleCount,1);
  counter.reset(1200);assert.equal(counter.sampleCount,0);
});

test('ordinary voxel reads avoid the authority clock while real remote hints still expire exactly', () => {
  const chunk = new ChunkState({ chunkX: 0, chunkZ: 0, chunkSize: 4, height: 16, minY: 0 });
  let clock = 1000, reads = 0;
  chunk.authorityNow = () => { reads++; return clock; };
  for(let i=0;i<1000;i++) { chunk.getFinalBlock(1, 1, 1); chunk.hasDeltaAt(1, 1, 1); chunk.getFinalDeltaMap(); }
  assert.equal(reads, 0);
  chunk.applyRemoteDelta([{worldX:1, worldY:1, worldZ:1, blockId:BLOCK_ID.stone}], { now:clock, ttlMs:100 });
  clock = 1099;
  assert.equal(chunk.getFinalBlock(1, 1, 1), BLOCK_ID.stone);
  clock = 1100;
  assert.equal(chunk.getFinalBlock(1, 1, 1), BLOCK_ID.air);
  assert.equal(chunk.remoteDeltas.size, 0);
  reads = 0;
  chunk.hasDeltaAt(1, 1, 1);
  assert.equal(reads, 0);
});

test('interactive nearby edits wait for a current Worker mesh without running a synchronous section build', () => {
  const original = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  let manager;
  try {
    manager = new ChunkManager({chunkSize:4,height:16,minY:0,viewDistance:1,useWorkers:false});
    const chunk = manager.ensureChunk(0,0);
    chunk.setBaseBlocks(new Uint16Array(4*4*16).fill(BLOCK_ID.stone));
    manager.rebuildDirtyChunks(10000);
    const old = chunk.mesh;
    manager.useWorkers=true;manager.workerCount=1;manager.activeBuildLimit=1;manager.initWorkers(1);
    manager.applyPendingDelta([{worldX:1,worldY:5,worldZ:1,blockId:BLOCK_ID.air}], 'first');
    manager.rebuildDirtyChunks(4);
    assert.equal(chunk.mesh,old);
    assert.equal(manager.nearFieldRepairs,0);
    const [taskId, task] = [...manager.inFlightBuilds][0];
    const section = chunk.renderSections.get(task.sectionIndex);
    const outdated = buildRenderSection(chunk, section, manager.meshAccessForChunk(chunk));
    manager.applyPendingDelta([{worldX:2,worldY:5,worldZ:1,blockId:BLOCK_ID.air}], 'second');
    task.worker.onmessage({data:{type:'chunkBuilt', taskId, chunkX:0, chunkZ:0, mode:'section', taskVersion:task.version,
      materialVersion:task.materialVersion, sectionRevision:task.sectionRevision, ...outdated}});
    assert.equal(chunk.mesh,old,'an obsolete result must not overwrite the visible committed mesh');
    manager.rebuildDirtyChunks(4);
    const [nextId,nextTask]=[...manager.inFlightBuilds][0];
    const nextSection=chunk.renderSections.get(nextTask.sectionIndex);
    const current=buildRenderSection(chunk,nextSection,manager.meshAccessForChunk(chunk));
    nextTask.worker.onmessage({data:{type:'chunkBuilt',taskId:nextId,chunkX:0,chunkZ:0,mode:'section',taskVersion:nextTask.version,
      materialVersion:nextTask.materialVersion,sectionRevision:sectionRevision(nextSection),...current}});
    assert.deepEqual(actualFaces(chunk.mesh),expectedFaces(chunk,(...p)=>manager.getBlockAtWorld(...p)));
    assert.equal(manager.nearFieldRepairs,0);
  } finally { manager?.dispose(); if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original; }
});

test('summary visibility bounds survive lazy array access and empty sections keep their retirement path', () => {
  const manager = new ChunkManager({chunkSize:4,height:32,minY:-32,viewDistance:1,useWorkers:false});
  try {
    const chunk = manager.ensureChunk(0,0);
    const data = new Uint16Array(4*4*32);
    for(let z=0;z<4;z++)for(let y=-32;y<-16;y++)for(let x=0;x<4;x++)data[localIndex(x,y,z,chunk)]=BLOCK_ID.stone;
    chunk.setBaseBlocks(data);manager.rebuildDirtyChunks(10000);
    const expected=chunkWorldBounds(chunk);
    assert.equal(expected.minY,-32);
    assert.ok(expected.maxY>=-16 && expected.maxY<-15.9,'the bound includes the surface and its tiny shadow offset');
    assert.equal(chunk.mesh.materializedArrays.length,0);
    const full=flattenRenderSections([chunk]),active=flattenRenderSections([chunk],{includeEmpty:false});
    assert.equal(full.length,2);assert.equal(active.length,1);
    void chunk.mesh.vertices;
    assert.deepEqual(chunkWorldBounds(chunk),expected,'materializing a legacy mesh must not shift the summary height');
  } finally { manager.dispose(); }
});

function mesh(x=0) {
  const vertices=new Uint8Array(80),data=new DataView(vertices.buffer);
  for(let i=0;i<4;i++){data.setInt16(i*20,(x+i%2)*64,true);data.setInt16(i*20+2,Math.floor(i/2)*64,true);data.setInt16(i*20+6,64,true);data.setUint16(i*20+16,3,true);}
  return {vertices,indices:new Uint16Array([0,1,2,1,3,2]),indexCount:6,vertexCount:4,triangleCount:2};
}
// Model the render call's end-of-frame seal without a native GL draw in unit tests.
function prepare(r, chunks, options) {
  const result=r.prepareChunksForRender(chunks,options);
  if(r.hasUnvalidatedUploads())r.sealDeferredUploads();
  return result;
}
function fixture(region=false) {
  const control={ready:false,error:0,polls:0,checks:0,deleted:[],syncDeleted:[],failFence:false};let serial=0;
  const constants={NO_ERROR:0,OUT_OF_MEMORY:0x505,TIMEOUT_EXPIRED:0x911b,CONDITION_SATISFIED:0x911c,WAIT_FAILED:0x911d};
  const target={
    createVertexArray:()=>({id:++serial}),createBuffer:()=>({id:++serial}),
    deleteBuffer:handle=>control.deleted.push(handle),deleteVertexArray:handle=>control.deleted.push(handle),
    fenceSync:()=>control.failFence?null:{id:++serial},deleteSync:handle=>control.syncDeleted.push(handle),
    clientWaitSync:(fence,flags,timeout)=>{assert.equal(flags,0);assert.equal(timeout,0);control.polls++;return control.ready?constants.CONDITION_SATISFIED:constants.TIMEOUT_EXPIRED;},
    getError:()=>{control.checks++;const error=control.error;control.error=0;return error;},isContextLost:()=>false,
    clear:()=>assert.fail('a pending validation must not submit another draw'),
  };
  const gl=new Proxy(target,{get(t,key){if(key in t)return t[key];if(key in constants)return constants[key];if(/^[A-Z_0-9]+$/.test(String(key)))return String(key);return ()=>{};}});
  const canvas={addEventListener(){},removeEventListener(){},width:320,height:180};
  const renderer=new WebGL2VoxelRenderer(canvas,{deferredChunkUploads:true,useRegionBatching:region,maxUploadCpuMs:10000});
  renderer.gl=gl;renderer.initialized=true;renderer.program={};renderer.bufferManager=new BufferManager(gl);
  const chunk={id:'0,0',chunkX:0,chunkZ:0,chunkSize:16,mesh:mesh(),meshVersion:1,version:1};
  return {renderer,chunk,gl,control};
}

test('asynchronous uploads never check errors before completion and publish one complete validated batch', () => {
  for(const region of [false,true]) {
    const {renderer:r,chunk:c,control}=fixture(region);
    try {
      prepare(r, [c],{maxUploads:2});
      assert.equal(control.checks,0);assert.equal(r.entryForChunk(c),null);
      assert.equal(r.render({},[c]).renderDeferred,true);
      assert.equal(prepare(r, [c],{maxUploads:2}).validationPending,true);
      assert.equal(control.checks,0);
      r.uploadAvatarMesh('late',{vertices:new Float32Array(30),indices:new Uint16Array([0,1,2]),indexCount:3});
      assert.equal(control.checks,0,'avatar registration must not consume errors from a fenced terrain batch');
      assert.ok(r.avatarMeshes.has('late'));r.avatarMeshes.delete('late');
      control.ready=true;
      const done=prepare(r, [c],{maxUploads:2});
      assert.equal(done.uploaded,1);assert.equal(control.checks,1);assert.equal(c.gpuUploaded,true);
      assert.equal(r.entryForChunk(c).mesh,c.mesh);assert.equal(control.syncDeleted.length,1);
    } finally { r.dispose(); }
  }
});

test('asynchronous allocation failures retain old GPU geometry and retry; obsolete uploads never publish', () => {
  const {renderer:r,chunk:c,control,gl}=fixture();
  try {
    const old=r.uploadChunk(c);c.mesh=mesh(2);c.meshVersion++;c.gpuUploaded=false;control.checks=0;
    prepare(r, [c],{maxUploads:1});control.error=gl.OUT_OF_MEMORY;
    assert.equal(r.entryForChunk(c),old);assert.equal(control.deleted.includes(old.handle.vbo),false);
    control.ready=true;prepare(r, [c],{maxUploads:1});
    assert.equal(r.entryForChunk(c),old);assert.equal(c.gpuUploaded,false);assert.equal(r.uploadDiagnostics.failed,1);
    r.retryUploads.clear();prepare(r, [c],{maxUploads:1});
    c.mesh=mesh(3);c.meshVersion++;
    prepare(r, [c],{maxUploads:1});
    assert.equal(r.entryForChunk(c),old,'a superseded pending upload must be discarded');
    prepare(r, [c],{maxUploads:1});prepare(r, [c],{maxUploads:1});
    assert.equal(r.entryForChunk(c).mesh,c.mesh);assert.equal(control.deleted.includes(old.handle.vbo),true);
  } finally { r.dispose(); }
});

test('byte-limited asynchronous transfers remain atomic and pruning releases unpublished resources', () => {
  const {renderer:r,chunk:c,control}=fixture();
  try {
    r.options.maxUploadBytesPerFrame=32;
    for(const bytes of [32,32,28]) {
      const start=prepare(r, [c],{maxUploads:1});assert.equal(start.uploadedBytes,bytes);
      assert.equal(c.gpuUploaded,false);
      control.ready=true;const done=prepare(r, [c],{maxUploads:1});
      assert.equal(done.uploaded,bytes===28?1:0);control.ready=false;
    }
    assert.equal(c.gpuUploaded,true);
    c.mesh=mesh(4);c.meshVersion++;c.gpuUploaded=false;
    prepare(r, [c],{maxUploads:1});
    const staged=[...r.uploadStaging.values()][0].transaction.handle;
    r.pruneChunks(new Set());assert.equal(r.uploadStaging.size,0);
    assert.ok(control.deleted.includes(staged.vbo));
  } finally { r.dispose(); }
});

test('fence allocation failure releases unpublished buffers and preserves retryability', () => {
  const {renderer:r,chunk:c,control}=fixture();
  try {
    control.failFence=true;prepare(r, [c],{maxUploads:1});
    assert.equal(r.uploadStaging.size,0);assert.equal(r.uploadValidationFence,null);
    assert.equal(r.uploadDiagnostics.failed,1);assert.equal(control.deleted.length,3);
    control.failFence=false;control.ready=true;r.retryUploads.clear();
    prepare(r, [c],{maxUploads:1});prepare(r, [c],{maxUploads:1});
    assert.equal(c.gpuUploaded,true);
  } finally { r.dispose(); }
});

test('GPU frame pacing bounds in-flight work with zero-time polling and disposes every fence', () => {
  const {renderer:r,control}=fixture();
  try {
    r.fenceSubmittedFrame();r.fenceSubmittedFrame();
    assert.equal(r.frameCompletionFences.length,2);
    assert.equal(r.render({},[]).renderDeferred,true);
    assert.equal(r.frameCompletionFences.length,2);
    assert.equal(control.checks,0);
    control.ready=true;r.pollFrameCompletion();
    assert.equal(r.frameCompletionFences.length,0);assert.equal(control.syncDeleted.length,2);
    r.fenceSubmittedFrame();
  } finally { r.dispose(); }
  assert.equal(control.syncDeleted.length,3);
});
