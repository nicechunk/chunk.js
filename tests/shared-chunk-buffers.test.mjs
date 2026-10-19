import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferManager } from '../renderer/buffer-manager.js';
import { prepareMeshDrawRanges } from '../renderer/mesh-draw-ranges.js';
import { WebGL2VoxelRenderer } from '../renderer/webgl2-renderer.js';

function device() {
  const buffers=new Map(),vaos=new Map(),bindings=new Map(),deleted=[];
  let vao=null,error=0,failAt=0,created=0;
  const gl={ARRAY_BUFFER:1,ELEMENT_ARRAY_BUFFER:2,STATIC_DRAW:3,SHORT:4,BYTE:5,UNSIGNED_SHORT:5123,UNSIGNED_INT:5125,UNSIGNED_BYTE:5121,TRIANGLES:4,NO_ERROR:0,
    createBuffer(){if(++created===failAt)return null;const b={};buffers.set(b,new Uint8Array());return b;},
    createVertexArray(){if(++created===failAt)return null;const v={};vaos.set(v,{});return v;},
    bindVertexArray(v){vao=v;},bindBuffer(t,b){bindings.set(t,b);if(t===2&&vao)vaos.get(vao).indices=b;},
    bufferData(t,n){buffers.set(bindings.get(t),typeof n==='number'?new Uint8Array(n):new Uint8Array(n.buffer,n.byteOffset,n.byteLength).slice());},
    bufferSubData(t,o,bytes){buffers.get(bindings.get(t)).set(bytes,o);},
    enableVertexAttribArray(){},vertexAttribIPointer(i){if(i===0)vaos.get(vao).vertices=bindings.get(1);if(i===8)vaos.get(vao).origins=bindings.get(1);},vertexAttribPointer(){},
    deleteBuffer(b){deleted.push(b);buffers.delete(b);},deleteVertexArray(v){deleted.push(v);vaos.delete(v);},
    getError(){const e=error;error=0;return e;},isContextLost(){return false;},
    useProgram(){},uniform1f(){},uniform1i(){},uniform3f(){},drawElements(){},
  };
  return {gl,buffers,vaos,deleted,setError:e=>error=e,setFailure:n=>failAt=created+n};
}
function mesh(layers=[3,28,17],vertexCount=null) {
  const n=vertexCount??layers.length*4,vertices=new Uint8Array(n*20),view=new DataView(vertices.buffer),indices=[];
  for(let v=0;v<n;v++){
    view.setInt16(v*20,(v%4&1)*64,true);view.setInt16(v*20+2,(v%4>>1)*64,true);view.setInt16(v*20+4,Math.floor(v/4)*16,true);view.setInt16(v*20+6,64,true);
    view.setUint8(v*20+10,127);view.setUint8(v*20+11,255);view.setUint16(v*20+16,layers[Math.min(layers.length-1,Math.floor(v/4))],true);
  }
  for(let i=0;i<layers.length;i++)indices.push(i*4,i*4+2,i*4+1,i*4+1,i*4+2,i*4+3);
  return {vertices,indices:new Uint16Array(indices),vertexCount:n,indexCount:indices.length,triangleCount:indices.length/3};
}
function readVertices(d,handle,range,origin) {
  const vertices=new DataView(d.buffers.get(handle.vbo).buffer),indices=d.buffers.get(handle.ibo),offsets=handle.sharedPage?new DataView(d.buffers.get(handle.sharedPage.origins).buffer):null;
  const data=new DataView(indices.buffer),output=[];
  for(let i=range.offset;i<range.offset+range.count;i++) {
    const id=handle.indexBytes===4?data.getUint32(i*4,true):data.getUint16(i*2,true),scale=vertices.getInt16(id*20+6,true);
    output.push([0,1,2].map(k=>vertices.getInt16(id*20+k*2,true)/scale+origin[k]+(offsets?offsets.getInt16(id*8+k*2,true):0)));
  }
  return output;
}

for(const extension of [false,true])test(`shared chunk geometry and ordered cross-column draws agree with independent source data, extension=${extension}`,()=>{
  const d=device(),manager=new BufferManager(d.gl,{shared:true});
  const origin={worldX:2**24+5,worldY:35,worldZ:-(2**24)-7},chunks=[],expected=[],handles=[];
  for(let i=0;i<6;i++) {
    const source=mesh(),placement={x:2**24+i*16,y:-32+i*16,z:-(2**24)},handle=manager.createChunkBuffers(source,placement);
    assert.ok(handle.sharedPage);handles.push(handle);
    chunks.push({chunkX:placement.x/16,chunkZ:placement.z/16,chunkSize:16,entry:{handle,originY:placement.y}});
    const prepared=prepareMeshDrawRanges(source),v=new DataView(source.vertices.buffer);
    for(const pass of ['opaque','cutout']) {
      const range=prepared.drawRanges[pass];
      for(let j=range.offset;j<range.offset+range.count;j++) {
        const id=prepared.indices[j],s=v.getInt16(id*20+6,true);
        expected.push([0,1,2].map(k=>v.getInt16(id*20+k*2,true)/s+[placement.x-origin.worldX,placement.y-origin.worldY,placement.z-origin.worldZ][k]));
      }
    }
  }
  assert.equal(new Set(handles.map(h=>h.vao)).size,1);
  assert.equal(d.buffers.size,3,'all section channels share three actual GPU buffers');
  const renderer=Object.create(WebGL2VoxelRenderer.prototype),actual=[];let bound,offset,draws=0;
  const byVao=new Map(handles.map(h=>[h.vao,h]));
  d.gl.bindVertexArray=v=>bound=v;d.gl.uniform3f=(u,x,y,z)=>offset=[x,y,z];
  const draw=(count,type,bytes)=>{draws++;actual.push(...readVertices(d,byVao.get(bound),{offset:bytes/4,count},offset));};
  d.gl.drawElements=(mode,count,type,bytes)=>draw(count,type,bytes);
  Object.assign(renderer,{gl:d.gl,program:{},uniforms:{uUseChunkOffset:{},uSurfacePass:{}},multiDrawCounts:new Int32Array(2),multiDrawOffsets:new Int32Array(2),
    entryForChunk:c=>c.entry,multiDraw:extension?{multiDrawElementsWEBGL(mode,counts,a,type,offsets,b,n){draws++;for(let i=0;i<n;i++)actual.push(...readVertices(d,byVao.get(bound),{offset:offsets[b+i]/4,count:counts[a+i]},offset));}}:null});
  const result=renderer.renderMeshPass(chunks,origin,['opaque','cutout']);
  assert.deepEqual(actual,expected);assert.equal(result.triangles,expected.length/3);assert.equal(result.drawCalls,draws);
  assert.equal(draws,extension?1:6,'combine across chunks, or contiguous opaque/cutout ranges without the extension');
  for(const handle of handles)manager.disposeChunkBuffers(handle);
  assert.equal(manager.shared.snapshot().sharedBufferLiveBytes,0);manager.dispose();assert.equal(d.buffers.size,0);
});

test('byte-limited replacement uploads occupy disjoint storage and released gaps are reusable',()=>{
  const d=device(),manager=new BufferManager(d.gl,{shared:true}),source=mesh(),placement={x:0,y:0,z:0};
  const old=manager.createChunkBuffers(source,placement),before=d.buffers.get(old.vbo).slice(old.vertexStart*20,(old.vertexStart+old.vertexCount)*20);
  const changed=mesh();changed.vertices[0]=17;
  const task=manager.beginChunkBuffers(changed,placement);
  assert.notEqual(task.handle.vertexStart,old.vertexStart);
  let total=0;while(!task.done){const p=manager.advanceChunkBuffers(task,31);assert.ok(p.uploadedBytes<=31);total+=p.uploadedBytes;}
  assert.equal(total,task.handle.byteLength);
  assert.deepEqual(d.buffers.get(old.vbo).slice(old.vertexStart*20,(old.vertexStart+old.vertexCount)*20),before);
  manager.commitChunkBuffers(task.handle);manager.disposeChunkBuffers(old);
  const reuse=manager.createChunkBuffers(source,placement);assert.equal(reuse.vertexStart,old.vertexStart);assert.equal(reuse.indexStart,old.indexStart);
  manager.disposeChunkBuffers(reuse);manager.disposeChunkBuffers(reuse);manager.disposeChunkBuffers(task.handle);manager.dispose();assert.equal(d.buffers.size,0);
});

test('shared allocation cap, far origins and mixed-pass vertex conflicts retain the standalone fallback',()=>{
  const d=device(),manager=new BufferManager(d.gl,{shared:true,maxSharedBytes:1179648}),large=mesh([3],24000);
  const a=manager.createChunkBuffers(large,{x:0,y:0,z:0}),b=manager.createChunkBuffers(large,{x:16,y:0,z:0});
  assert.ok(a.sharedPage);assert.equal(b.sharedPage,undefined);assert.ok(manager.shared.bytes<=1179648);
  const far=manager.createChunkBuffers(mesh(),{x:2**25,y:0,z:0});assert.equal(far.sharedPage,undefined);
  const conflict=mesh([3]);const v=new DataView(conflict.vertices.buffer);v.setUint16(2*20+16,28,true);conflict.indices=new Uint16Array([0,1,2,2,1,3]);
  const fallback=manager.createChunkBuffers(conflict,{x:0,y:0,z:0});assert.equal(fallback.sharedPage,undefined);
  for(const h of [a,b,far,fallback])manager.disposeChunkBuffers(h);manager.dispose();assert.equal(d.buffers.size,0);
});

test('allocation and upload failures clean unpublished slices and leave committed geometry intact',()=>{
  for(let allocation=1;allocation<=4;allocation++) {
    const d=device(),manager=new BufferManager(d.gl,{shared:true});d.setFailure(allocation);
    assert.throws(()=>manager.createChunkBuffers(mesh(),{x:0,y:0,z:0}),/allocation/);
    assert.equal(d.buffers.size,0);assert.equal(d.vaos.size,0);assert.equal(manager.shared.bytes,0);
    const retry=manager.createChunkBuffers(mesh(),{x:0,y:0,z:0});assert.equal(retry.sharedPage,undefined);manager.disposeChunkBuffers(retry);manager.dispose();
  }
  const d=device(),manager=new BufferManager(d.gl,{shared:true}),source=mesh(),placement={x:0,y:0,z:0};
  const old=manager.createChunkBuffers(source,placement),before=readVertices(d,old,old.drawRanges.opaque,[0,0,0]);
  d.setError(1285);assert.throws(()=>manager.createChunkBuffers(mesh(),placement),/WebGL error/);
  assert.deepEqual(readVertices(d,old,old.drawRanges.opaque,[0,0,0]),before);
  const retry=manager.createChunkBuffers(source,placement);assert.equal(retry.sharedPage,undefined);
  manager.disposeChunkBuffers(old);manager.disposeChunkBuffers(retry);manager.dispose();assert.equal(d.buffers.size,0);
});

test('context loss drops shared ownership without deleting invalidated context handles',()=>{
  const d=device(),manager=new BufferManager(d.gl,{shared:true}),handle=manager.createChunkBuffers(mesh(),{x:0,y:0,z:0});
  manager.dispose({lost:true});assert.equal(manager.shared.bytes,0);assert.equal(d.deleted.length,0);
  manager.disposeChunkBuffers(handle);assert.equal(d.deleted.length,0);manager.dispose();assert.equal(d.deleted.length,0);
});

test('storage read by an in-flight frame is quarantined until the renderer reports completion',()=>{
  const d=device();let ready=true;
  const manager=new BufferManager(d.gl,{shared:true,canReuseSharedSlices:()=>ready}),placement={x:0,y:0,z:0},source=mesh();
  const old=manager.createChunkBuffers(source,placement);
  ready=false;manager.disposeChunkBuffers(old);
  assert.equal(manager.shared.snapshot().sharedBufferRetiredSlices,1);
  const next=manager.createChunkBuffers(source,placement);assert.notEqual(next.vertexStart,old.vertexStart);
  manager.reclaimSharedChunks();assert.equal(manager.shared.snapshot().sharedBufferRetiredSlices,1);
  ready=true;manager.reclaimSharedChunks();assert.equal(manager.shared.snapshot().sharedBufferRetiredSlices,0);
  const reused=manager.createChunkBuffers(source,placement);assert.equal(reused.vertexStart,old.vertexStart);
  manager.disposeChunkBuffers(next);manager.disposeChunkBuffers(reused);manager.dispose();assert.equal(d.buffers.size,0);
});
