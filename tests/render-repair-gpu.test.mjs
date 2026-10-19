import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGL2VoxelRenderer } from '../renderer/webgl2-renderer.js';
import { BufferManager } from '../renderer/buffer-manager.js';

export function mockGl() {
  let serial = 0, bound = null;
  const control = { fail: '', error: 0, uploads: [], deleted: [], draws: [], depth: true };
  const constants = { NO_ERROR: 0, CONTEXT_LOST_WEBGL: 0x9242, OUT_OF_MEMORY: 0x505 };
  const target = {
    createVertexArray() { return control.fail === 'vao' ? null : { id: ++serial }; },
    createBuffer() { return control.fail === 'buffer' ? null : { id: ++serial }; },
    deleteBuffer(h) { if(h) control.deleted.push(h); },
    deleteVertexArray(h) { if(h) control.deleted.push(h); },
    bindBuffer(t,h) { bound = h; },
    bufferData(t, data) { control.uploads.push({ bound, bytes: data.byteLength ?? data }); if (control.fail === 'data') control.error = constants.OUT_OF_MEMORY; },
    getError() { const e=control.error; control.error=0; return e; },
    isContextLost() { return control.fail === 'lost'; },
    drawElements(...args) { control.draws.push({args,depth:control.depth}); },
    depthMask(v) {control.depth=v;},
  };
  const gl = new Proxy(target,{get(t,p){ if(p in t) return t[p]; if(p in constants) return constants[p]; if(typeof p==='string' && /^[A-Z_0-9]+$/.test(p)) return constants[p]=0x1000+Object.keys(constants).length; return ()=>{}; }});
  return {gl, control};
}
function canvas() {const listeners=new Map();return {listeners,addEventListener(n,f){listeners.set(n,f);},removeEventListener(n){listeners.delete(n);},width:320,height:180};}
function mesh(x=0, layer=3) {const vertices=new Uint8Array(4*20);const v=new DataView(vertices.buffer);for(let i=0;i<4;i++){v.setInt16(i*20, (x+i%2)*64,true);v.setInt16(i*20+2,Math.floor(i/2)*64,true);v.setInt16(i*20+6,64,true);v.setUint16(i*20+16,layer,true);}return {vertices,indices:new Uint16Array([0,1,2,1,3,2]),indexCount:6,vertexCount:4,triangleCount:2};}
function chunk(id='0,0', x=0) {return {id,chunkX:x,chunkZ:0,chunkSize:16,version:1,meshVersion:1,mesh:mesh(),gpuUploaded:false};}
function renderer() {const r=new WebGL2VoxelRenderer(canvas(),{useRegionBatching:false});const {gl,control}=mockGl();r.gl=gl;r.initialized=true;r.bufferManager=new BufferManager(gl);return {r,gl,control};}

test('bounded off-camera residency keeps draw selection separate and reclaims unuploaded pending sources',()=>{
 const {r}=renderer();r.options.maxUploadCpuMs=10000;
 const front=chunk('0,0',0),back=chunk('0,3',0);back.chunkZ=3;
 const first=r.prepareChunksForRender([front],{maxUploads:4,residencyChunks:[back]});
 assert.equal(first.prefetchUploads,1);assert.ok(r.entryForChunk(front));assert.ok(r.entryForChunk(back));
 assert.deepEqual(r.preparedRenderFrame.chunks,[front]);
 const pending=chunk('9,9',9);pending.chunkZ=9;
 r.prepareChunksForRender([front],{maxUploads:0,residencyChunks:[pending]});
 assert.ok(r.pendingMeshSources.size);r.pruneChunks(new Set([front.id,back.id]));
 assert.equal([...r.pendingMeshSources.values()].some(source=>source.chunk===pending),false);
 r.options.maxPrefetchGpuBytes=0;r.lastPrefetchAt=-Infinity;
 assert.equal(r.prepareChunksForRender([front],{maxUploads:4,residencyChunks:[pending]}).prefetchUploads,0);
 r.dispose();
});

test('managed commit observation retires emptied channels once and reuploads after explicit removal',()=>{
 const {r}=renderer();r.options.maxUploadCpuMs=10000;
 const section={...chunk('0,0@0'),parentId:'0,0',generation:1};
 const parent={id:'0,0',renderSections:new Map([[0,section]]),renderActiveSections:[section],renderSectionCommitRevision:1};
 assert.equal(r.prepareChunksForRender([parent],{maxUploads:4}).uploaded,1);
 assert.equal(r.prepareChunksForRender([parent],{maxUploads:4}).uploaded,0);
 r.removeChunk(parent.id);
 assert.equal(r.prepareChunksForRender([parent],{maxUploads:4}).uploaded,1);
 section.mesh={...mesh(),indices:new Uint16Array(),indexCount:0};section.meshVersion++;parent.renderSectionCommitRevision++;parent.renderActiveSections=[];
 r.prepareChunksForRender([parent],{maxUploads:4});assert.equal(r.chunkBuffers.size,0);
 r.dispose();
});

test('completed and staged chunk uploads validate once per stage and still reject GL allocation errors',()=>{
 const {gl,control}=mockGl(),manager=new BufferManager(gl);let polls=0;const getError=gl.getError;
 gl.getError=()=>{polls++;return getError();};
 const handle=manager.createChunkBuffers(mesh());assert.equal(polls,1);manager.disposeChunkBuffers(handle);
 const transaction=manager.beginChunkBuffers(mesh());assert.equal(polls,1);
 assert.equal(manager.advanceChunkBuffers(transaction,32).done,false);assert.equal(polls,2);
 assert.equal(manager.advanceChunkBuffers(transaction,1000).done,true);assert.equal(polls,3);manager.disposeChunkBuffers(transaction.handle);
 control.fail='data';assert.throws(()=>manager.createChunkBuffers(mesh()),/WebGL error/);assert.equal(polls,4);
});

test('R03: same coordinate/count/revision replacement never reuses stale source',()=>{const {r}=renderer();const a=chunk(),b={...a,mesh:mesh(2)};const first=r.getRegionGroups([a]);const second=r.getRegionGroups([b]);assert.notEqual(second,first);assert.equal(second[0].chunks[0],b);r.uploadChunk(a);const next=r.updateChunk(b);assert.equal(next.source,b);assert.equal(next.mesh,b.mesh);r.dispose();});
test('R07: render and completed uploads during loss do not initialize or detach recovery',()=>{const {r}=renderer();let inits=0;r.init=()=>{inits++;throw Error('must not initialize');};r.contextLost=true;r.initialized=false;assert.doesNotThrow(()=>r.render({},[]));assert.doesNotThrow(()=>r.uploadChunk(chunk()));assert.equal(inits,0);assert.equal(r.canvas.listeners.size,2);r.dispose();});
test('R09: null and GL allocation errors retain old handle, do not commit flags, and retry',()=>{for(const fail of ['vao','buffer','data']) {const {r,control}=renderer();const c=chunk();const first=r.uploadChunk(c);c.mesh=mesh(2);c.meshVersion++;c.gpuUploaded=false;control.fail=fail;assert.doesNotThrow(()=>r.uploadChunk(c));assert.equal(r.chunkBuffers.get(c.id),first);assert.equal(c.gpuUploaded,false);assert.equal(control.deleted.includes(first.handle.vbo),false);control.fail='';r.retryUploads?.clear();r.uploadChunk(c);assert.equal(c.gpuUploaded,true);assert.notEqual(r.chunkBuffers.get(c.id),first);r.dispose();}});
test('R08: unchanged CPU avatar registration survives loss for automatic restoration',()=>{const {r}=renderer();const m={vertices:new Float32Array(30),indices:new Uint16Array([0,1,2]),indexCount:3,triangleCount:1};r.uploadAvatarMesh('player',m);r.canvas.listeners.get('webglcontextlost')({preventDefault(){}});assert.equal(r.avatarMeshes?.get('player'),m);r.uploadAvatarMesh('late',m);assert.equal(r.avatarMeshes?.get('late'),m);r.dispose();assert.equal(r.avatarMeshes?.size,0);});

import { materialRenderPass, prepareMeshDrawRanges } from '../renderer/mesh-draw-ranges.js';
import { GpuResourceLedger, instrumentGl, AsyncGpuTimer } from '../renderer/gpu-diagnostics.js';
import { waterCellAt, WATER_CELL_SIZES, positiveModulo, waterPrecisionUniforms } from '../renderer/water-precision.js';
import { alphaCoverage, downsampleMaterialMip, TextureArrayManager } from '../renderer/texture-array-manager.js';
import { RenderStageStats } from '../debug/stats.js';

test('P02: sixteen members update only one channel; camera subset changes never repack; prune reclaims members',()=>{
 const {r,control}=renderer();r.options.useRegionBatching=true;r.options.maxUploadCpuMs=10000;
 const chunks=Array.from({length:16},(_,i)=>({...chunk(`${i%4},${Math.floor(i/4)}`,i%4),chunkZ:Math.floor(i/4)}));
 assert.equal(r.prepareChunksForRender(chunks,{maxUploads:32}).uploaded,16);
 const before=control.uploads.length;
 chunks[7].mesh=mesh(3);chunks[7].meshVersion++;chunks[7].gpuUploaded=false;
 const update=r.prepareChunksForRender(chunks,{maxUploads:32});assert.equal(update.uploaded,1);assert.equal(update.uploadedBytes,92);assert.equal(control.uploads.length-before,2);
 assert.equal(r.prepareChunksForRender([chunks[2],chunks[9]],{maxUploads:32}).uploaded,0);
 assert.equal(r.prepareChunksForRender(chunks.slice().reverse(),{maxUploads:32}).uploaded,0);
 r.pruneChunks(new Set(chunks.slice(0,4).map(c=>c.id)));assert.equal(r.regionBuffers.get('0,0').members.size,4);r.dispose();
});
test('P02/R09: byte-limited upload advances across frames and atomically preserves old resource',()=>{
 const {r,control}=renderer();r.options.maxUploadBytesPerFrame=32;r.options.maxUploadCpuMs=10000;
 const c=chunk();r.uploadChunk(c);const old=r.chunkBuffers.get(c.id);c.mesh=mesh(3);c.meshVersion++;c.gpuUploaded=false;
 const first=r.prepareChunksForRender([c],{maxUploads:1});assert.equal(first.uploaded,0);assert.equal(first.uploadedBytes,32);assert.equal(r.chunkBuffers.get(c.id),old);assert.equal(c.gpuUploaded,false);assert.equal(control.deleted.includes(old.handle.vbo),false);
 const second=r.prepareChunksForRender([c],{maxUploads:1});assert.equal(second.uploaded,0);assert.equal(second.uploadedBytes,32);
 const third=r.prepareChunksForRender([c],{maxUploads:1});assert.equal(third.uploaded,1);assert.equal(third.uploadedBytes,28);assert.notEqual(r.chunkBuffers.get(c.id),old);assert.equal(control.deleted.includes(old.handle.vbo),true);r.dispose();
});
test('R03/P02: section origins, same-object generation changes, unload and empty commits are distinct',()=>{
 const {r}=renderer();r.options.useRegionBatching=true;r.options.maxUploadCpuMs=10000;
 const section={...chunk('0,0@0'),parentId:'0,0',originY:-32,generation:1};section.mesh.originY=-32;
 const parent={id:'0,0',renderSections:new Map([[0,section]])};assert.equal(r.prepareChunksForRender([parent],{maxUploads:4}).uploaded,1);const old=r.chunkBuffers.get(section.id);assert.equal(old.originY,-32);
 section.generation++;assert.equal(r.entryForChunk(section),null);assert.equal(r.prepareChunksForRender([parent],{maxUploads:4}).uploaded,1);
 section.mesh={...mesh(),indices:new Uint16Array(),indexCount:0};section.meshVersion++;r.prepareChunksForRender([parent],{maxUploads:4});assert.equal(r.chunkBuffers.has(section.id),false);
 r.uploadChunk({...section,mesh:mesh()});r.pruneChunks(new Set());assert.equal(r.chunkBuffers.size,0);r.dispose();
});
test('R13: material semantics partition mixed channel indices; cutouts/flowers never enter blend',()=>{
 assert.equal(materialRenderPass(48),'opaque');assert.equal(materialRenderPass(28),'cutout');assert.equal(materialRenderPass(17),'blend');assert.equal(materialRenderPass(12),'blend');assert.equal(materialRenderPass(58),'blend');assert.equal(materialRenderPass(54),'shadow');
 const inputs=[mesh(0,48),mesh(0,28),mesh(0,17),mesh(0,54)];const vertices=new Uint8Array(4*80);const indices=new Uint16Array(24);inputs.forEach((m,i)=>{vertices.set(m.vertices,i*80);indices.set(Array.from(m.indices,id=>id+i*4),i*6);});
 const m=prepareMeshDrawRanges({vertices,indices,indexCount:24,vertexCount:16,triangleCount:8});for(const pass of ['opaque','cutout','shadow','blend'])assert.equal(m.drawRanges[pass].count,6);assert.equal(m.blendUnits.filter(u=>u.pass==='blend').length,2);
});
test('R09: every allocation failure cleans partial resources; bufferSubData GL error is rejected',()=>{
 for(const failAt of [1,2,3]){const {gl,control}=mockGl();let calls=0,created=0;const fake=new Proxy(gl,{get(t,k){if(k==='createVertexArray'||k==='createBuffer')return()=>{calls++;if(calls===failAt)return null;created++;return {id:calls};};return t[k];}});const manager=new BufferManager(fake);assert.throws(()=>manager.createChunkBuffers(mesh()),/allocation/);assert.equal(control.deleted.length,created);}
 const {gl,control}=mockGl();gl.bufferSubData=()=>{control.error=gl.OUT_OF_MEMORY;};assert.throws(()=>new BufferManager(gl).createChunkBuffers(mesh()),/WebGL error/);assert.equal(control.deleted.length,3);
});
test('P05: unique-handle ledger counts resident+transition peak and resets across generations',()=>{
 const ledger=new GpuResourceLedger(),{gl}=mockGl();const traced=instrumentGl(gl,ledger);const a=traced.createBuffer();traced.bindBuffer(gl.ARRAY_BUFFER,a);traced.bufferData(gl.ARRAY_BUFFER,new Uint8Array(80),gl.STATIC_DRAW);
 const b=traced.createBuffer();traced.bindBuffer(gl.ARRAY_BUFFER,b);traced.bufferData(gl.ARRAY_BUFFER,new Uint8Array(100),gl.STATIC_DRAW);assert.equal(ledger.snapshot().bufferBytes,180);assert.equal(ledger.peakBytes,180);traced.deleteBuffer(a);traced.deleteBuffer(a);assert.equal(ledger.bytes,100);assert.equal(ledger.snapshot().buffers,1);ledger.reset(2);assert.equal(ledger.bytes,0);assert.equal(ledger.snapshot().contextGeneration,2);assert.equal(ledger.peakBytes,180);
});
test('P05: asynchronous GPU timing stays bounded and reports unavailable/disjoint without fake zero',()=>{
 const {gl}=mockGl();gl.getExtension=()=>null;const absent=new AsyncGpuTimer(gl);absent.begin();absent.end();assert.deepEqual(absent.snapshot(),{gpuTimeMs:null,gpuTimerStatus:'unsupported',gpuQueriesPending:0});
 const ext={TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2};let ready=false,disjoint=false,deleted=0;gl.getExtension=()=>ext;gl.createQuery=()=>({});gl.getParameter=()=>disjoint;gl.getQueryParameter=(q,p)=>p===gl.QUERY_RESULT_AVAILABLE?ready:2500000;gl.deleteQuery=()=>deleted++;
 const timer=new AsyncGpuTimer(gl,{maxPending:2,generation:5});for(let i=0;i<8;i++){timer.begin();timer.end();}assert.equal(timer.pending.length,2);assert.equal(timer.lastMs,null);ready=true;timer.poll();assert.equal(timer.lastMs,2.5);assert.equal(deleted,2);timer.begin();timer.end();disjoint=true;timer.poll();assert.equal(timer.lastMs,null);assert.equal(timer.status,'disjoint');assert.equal(timer.pending.length,0);timer.dispose();
});
test('Q03: generated mip coverage is nearest achievable, pixel preset omits mip, missing anisotropy falls back',()=>{
 const tile=new Uint8Array(8*8*4);for(let i=0;i<64;i++){tile[i*4]=80;tile[i*4+1]=120;tile[i*4+2]=20;tile[i*4+3]=i%4<2?255:0;}
 const mip=downsampleMaterialMip(tile,8,8,.5);assert.equal(alphaCoverage(mip),.5);
 const {gl}=mockGl();gl.createTexture=()=>({});gl.getExtension=()=>null;for(const quality of ['pixel','balanced','high']){const manager=new TextureArrayManager(gl,{tileSize:8,materials:[{materialId:1,textureLayer:0,shaderType:'cutout'}],quality});manager.createTextureArray([tile]);assert.equal(manager.mipLevels,quality==='pixel'?1:4);assert.ok(manager.byteLength>=tile.byteLength);manager.dispose();}
});
test('B03: large signed origins preserve cell identity and sub-block phase across camera/chunk boundaries',()=>{
 for(const origin of [0,-1,255,256,2**20,-(2**20),2**24,-(2**24)])for(const size of WATER_CELL_SIZES)for(const fraction of [.125,.25,.625]){
   const world=origin+16+fraction;const a=waterCellAt(world,origin,size),b=waterCellAt(world,origin+16,size);assert.equal(a.cell,b.cell);assert.ok(Math.abs(a.fraction-b.fraction)<1e-7);
 }
 const reduced=waterPrecisionUniforms({worldX:2**24+1,worldZ:-(2**24)-1});assert.deepEqual(reduced.originPhase,[1,255]);assert.equal(positiveModulo(-1,256),255);
});
test('P05: bounded CPU stage summaries preserve measured units and finite storage',()=>{
 const stats=new RenderStageStats({capacity:16});for(let i=0;i<100;i++)stats.record('mesh',i);stats.record('gpu',NaN);assert.equal(stats.snapshot().mesh.samples,16);assert.equal(stats.snapshot().mesh.p99,99);assert.equal(stats.snapshot().gpu,undefined);stats.reset();assert.deepEqual(stats.snapshot(),{});
});
test('R08/R09: shared avatar aliases allocate once, survive alias removal, and retry failed replacement',()=>{
 const {r,control}=renderer();const m={vertices:new Float32Array(30),indices:new Uint16Array([0,1,2]),indexCount:3,triangleCount:1};const a=r.uploadAvatarMesh('a',m),b=r.uploadAvatarMesh('b',m);assert.equal(a.handle,b.handle);r.removeAvatarMesh('a');assert.equal(control.deleted.includes(b.handle.vbo),false);
 const next={...m,vertices:new Float32Array(30)};control.fail='vao';r.uploadAvatarMesh('b',next);assert.equal(r.avatarBuffers.get('b'),b);control.fail='';r.retryUploads.clear();r.prepareChunksForRender([],{maxUploads:0});assert.equal(r.avatarBuffers.get('b').mesh,next);assert.equal(control.deleted.includes(b.handle.vbo),true);r.dispose();
});
test('P02/R13: worker-supplied pass layout is verified and reused; invalid and duplicate metadata fail closed',()=>{
 const packed=prepareMeshDrawRanges(mesh(0,17));assert.equal(packed.materialPassLayout,1);assert.equal(prepareMeshDrawRanges(packed),packed);
 for(const broken of [{...packed,drawRanges:{...packed.drawRanges,blend:{offset:0,count:3}}},{...packed,blendUnits:[packed.blendUnits[0],packed.blendUnits[0]]},{...packed,blendUnits:packed.blendUnits.map((u,i)=>i?u:{...u,center:[NaN,0,0]})}])assert.throws(()=>prepareMeshDrawRanges(broken),/range|unit/i);
});
test('R07: loss during initialization is a pause, preserves restoration listeners, and never becomes a fatal init error',()=>{
 const c=canvas(),{gl,control}=mockGl();c.getContext=()=>gl;c.getBoundingClientRect=()=>({width:32,height:32});gl.createShader=()=>({});gl.createProgram=()=>({});gl.createTexture=()=>({});gl.getShaderParameter=()=>true;gl.getProgramParameter=()=>true;gl.getExtension=()=>null;gl.getParameter=()=>32;
 const r=new WebGL2VoxelRenderer(c,{textureTileSize:1,cloudRadius:1,maxVoxelParticles:16,maxDynamicShadowCasters:1,onInitStage(stage){if(stage==='sky gradient')control.fail='lost';}});
 assert.doesNotThrow(()=>r.init());assert.equal(r.contextLost,true);assert.equal(r.initialized,false);assert.equal(c.listeners.size,2);assert.equal(r.resourceLedger.bytes,0);r.dispose();
});
