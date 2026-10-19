import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGL2VoxelRenderer } from '../renderer/webgl2-renderer.js';
import { BufferManager } from '../renderer/buffer-manager.js';
import { SortedIndexStream } from '../renderer/sorted-index-stream.js';
import { createCameraState, cameraViewProjection } from '../renderer/camera.js';
import { loadPeasantGuyAvatarMesh } from '../renderer/avatar-mesh.js';
import { traceGl, packedTriangles, animatedTriangles } from './helpers/gpu-trace-gl.mjs';

const origin={worldX:0,worldY:0,worldZ:0};
const camera=reverse=>createCameraState({worldX:0,worldY:0,worldZ:0,targetWorldX:0,targetWorldY:0,targetWorldZ:reverse?-10:10,far:500});
const uniforms=new Proxy({}, {get:(_,name)=>String(name)});
function fixture() {
  const state=traceGl(),baseGl=state.gl,control={ready:false,checks:0,polls:0,deleted:[],failFence:false};let serial=0;
  const gl=new Proxy(baseGl,{get(target,key){if(key==='getError')return()=>{control.checks++;return target.getError();};return target[key];}});
  gl.fenceSync=()=>control.failFence?null:{sync:++serial};
  gl.deleteSync=sync=>control.deleted.push(sync);
  gl.clientWaitSync=(sync,flags,timeout)=>{assert.equal(flags,0);assert.equal(timeout,0);control.polls++;return control.ready?gl.CONDITION_SATISFIED:gl.TIMEOUT_EXPIRED;};
  const r=new WebGL2VoxelRenderer({width:640,height:360,addEventListener(){},removeEventListener(){}},
    {deferredChunkUploads:true,useRegionBatching:false,shadows:false,environmentEffects:false,autoResizeEachFrame:false});
  Object.assign(r,{gl,initialized:true,program:{},uniforms,avatarProgram:{},avatarUniforms:uniforms,
    textureArray:{bind(){},dispose(){}},multiDraw:null,multiDrawCounts:new Int32Array(16),multiDrawOffsets:new Int32Array(16)});
  r.bufferManager=new BufferManager(gl);
  return {...state,gl,r,control};
}
const draw=(f,chunks=[],avatars=[],view=camera())=>f.r.renderTransparentScene(view,chunks,avatars,cameraViewProjection(view),origin,f.r.lighting);
function settle(f,error=false) {
  f.r.sealDeferredUploads();
  assert.ok(f.r.uploadValidationFence);
  assert.equal(f.r.settleDeferredUploads().waiting,true);
  f.control.ready=true;
  const result=f.r.settleDeferredUploads();
  f.control.ready=false;
  assert.equal(result.waiting,false);
  return result;
}
function expectedIndices(entry,reverse=false) {
  return entry.handle.blendUnits.slice().sort((a,b)=>(reverse?a.center[2]-b.center[2]:b.center[2]-a.center[2])
    || `terrain:${entry.id}:${a.sortOffset??a.offset}`.localeCompare(`terrain:${entry.id}:${b.sortOffset??b.offset}`))
    .flatMap(unit=>Array.from(entry.handle.drawIndices.slice(unit.offset,unit.offset+unit.count)));
}
const chunk=mesh=>({id:'glass',chunkX:0,chunkZ:0,chunkSize:16,meshVersion:1,version:1,mesh});

test('deferred first poses omit unverified shared equipment and atomically publish independent entity snapshots',async()=>{
  const f=fixture(),mesh=await loadPeasantGuyAvatarMesh({attachIronPickaxe:true});
  f.r.uploadAvatarMesh('body',mesh);f.control.checks=0;
  const actors=[{id:'a',meshId:'body',opacity:.5,animation:{moving:true,timeMs:100,equipment:{rightHand:'empty'}}},
    {id:'b',meshId:'body',opacity:.5,animation:{moving:true,timeMs:800,equipment:{rightHand:'iron_pickaxe'}}}];
  f.reset();draw(f,[],actors);
  assert.equal(f.trace.draws.length,0,'shared registration is not a valid first pose');
  assert.equal(f.control.checks,0,'pose submission cannot synchronously check GL errors');
  const states=actors.map(a=>f.r.avatarInstances.get(a.id));
  assert.notEqual(states[0].pendingHandle.vbo,states[1].pendingHandle.vbo);
  const pending=states.map(s=>s.pendingVertices.slice());
  const revisions=states.map(s=>s.revision);
  f.r.avatarFrameStates.clear();actors[0].animation.timeMs+=333;draw(f,[],actors);
  states.forEach((s,i)=>{assert.equal(s.revision,revisions[i]);assert.deepEqual(s.pendingVertices,pending[i]);});
  assert.equal(f.trace.uploads.filter(u=>u.transfer&&u.target===f.gl.ARRAY_BUFFER).length,2,'one transfer per entity while pending');
  settle(f);assert.equal(f.control.checks,1,'one completed batch validation for both entities');
  states.forEach((s,i)=>{
    assert.deepEqual(s.committedVertices,pending[i]);
    assert.deepEqual(f.buffers.get(s.handle.vbo),new Uint8Array(s.committedVertices.buffer));
    assert.ok(s.committedDrawState.valid);
  });
  assert.notDeepEqual(states[0].committedVertices,states[1].committedVertices);
  f.r.dispose();assert.equal(f.buffers.size,0);assert.equal(f.vaos.size,1);
});

test('deferred pose failure preserves the old GPU pose, exact CPU sort vertices and visibility',()=>{
  const f=fixture(),mesh=animatedTriangles(4),actor={id:'a',meshId:'body',opacity:.5,animation:{moving:true,timeMs:100}};
  f.r.uploadAvatarMesh('body',mesh);draw(f,[],[actor]);settle(f);
  const state=f.r.avatarInstances.get('a'),handle=state.handle,vertices=state.committedVertices.slice(),visibility=state.committedDrawState;
  f.trace.fail='subdata';actor.animation.timeMs=700;f.r.avatarFrameStates.clear();f.reset();draw(f,[],[actor]);
  assert.equal(state.handle,handle);assert.deepEqual(state.vertices,vertices);assert.equal(state.drawState,visibility);
  assert.ok(f.trace.draws.length>0);assert.ok(f.trace.draws.every(d=>d.attributes.get(0).buffer===handle.vbo));
  f.trace.fail='';settle(f);
  assert.equal(state.handle,handle);assert.deepEqual(state.vertices,vertices);assert.equal(state.committedDrawState,visibility);
  assert.ok(f.r.lastAvatarUploadError);assert.ok(f.buffers.has(handle.vbo));
  f.r.dispose();assert.equal(f.buffers.size,0);assert.equal(f.vaos.size,1);
});

for(const index32 of [false,true])test(`deferred sorted ${index32?'UInt32':'UInt16'} orders use canonical fallback until validation, then reuse unchanged batches`,()=>{
  const f=fixture(),c=chunk(packedTriangles(40,{index32})),entry=f.r.uploadChunk(c),canonical=f.buffers.get(entry.handle.ibo).slice();
  f.control.checks=0;f.reset();draw(f,[c]);
  assert.equal(f.trace.draws.length,40);assert.deepEqual(f.trace.draws.flatMap(d=>d.indices),expectedIndices(entry));
  assert.equal(f.control.checks,0);settle(f);assert.equal(f.control.checks,1);
  f.reset();draw(f,[c]);assert.equal(f.trace.draws.length,1);
  assert.deepEqual(f.trace.draws.flatMap(d=>d.indices),expectedIndices(entry));
  assert.equal(f.trace.uploads.filter(u=>u.transfer).length,0,'identical verified sorted order needs no transfer or validation');
  assert.equal(f.r.dynamicUploadStages.length,0);
  const verifiedEbo=f.trace.draws[0].element;
  f.trace.fail='subdata';f.reset();draw(f,[c],[],camera(true));
  assert.equal(f.trace.draws.length,40);assert.deepEqual(f.trace.draws.flatMap(d=>d.indices),expectedIndices(entry,true));
  assert.ok(f.trace.draws.every(d=>d.element===entry.handle.ibo));
  f.trace.fail='';settle(f);assert.ok(f.r.sortedIndexStream.lastError);
  f.reset();draw(f,[c]);assert.equal(f.trace.draws.length,1);assert.equal(f.trace.draws[0].element,verifiedEbo);
  assert.deepEqual(f.buffers.get(entry.handle.ibo),canonical);
  f.r.dispose();assert.equal(f.buffers.size,0);assert.equal(f.vaos.size,1);
});

test('pending dynamic generations and fence allocation failures never publish and release every owned resource',()=>{
  for(const failure of ['generation','fence','dispose']) {
    const f=fixture(),c=chunk(packedTriangles(4)),mesh=animatedTriangles(2),actor={id:'a',meshId:'body',opacity:.5};
    f.r.uploadChunk(c);f.r.uploadAvatarMesh('body',mesh);draw(f,[c],[actor]);
    const state=f.r.avatarInstances.get('a');assert.equal(state.handle,null);
    if(failure==='generation'){f.r.sealDeferredUploads();f.r.contextGeneration++;f.control.ready=true;f.r.settleDeferredUploads();assert.equal(state.handle,null);}
    if(failure==='fence'){f.control.failFence=true;f.r.sealDeferredUploads();assert.equal(f.r.uploadValidationFence,null);assert.equal(state.handle,null);}
    f.r.dispose();assert.equal(f.buffers.size,0,failure);assert.equal(f.vaos.size,1,failure);assert.equal(f.r.dynamicUploadStages.length,0);
  }
});

test('deferred sorted CPU snapshots remain inside the configured index cap',()=>{
  const f=fixture(),c=chunk(packedTriangles(40));f.r.uploadChunk(c);
  f.r.sortedIndexStream=new SortedIndexStream(f.gl,{maxBytes:64,deferValidation:stage=>f.r.queueDynamicUpload(stage)});
  f.reset();draw(f,[c]);assert.equal(f.trace.draws.length,40);assert.ok(f.r.sortedIndexStream.capacityBytes<=64);
  assert.equal(f.r.dynamicUploadStages.length,0);f.r.dispose();assert.equal(f.buffers.size,0);
});
