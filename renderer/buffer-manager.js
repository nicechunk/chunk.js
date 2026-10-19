import { CHUNK_VERTEX_STRIDE_BYTES } from "../chunk/chunk-mesher.js";
import { assertGpuUpload } from "./gpu-diagnostics.js";
import { prepareMeshDrawRanges } from "./mesh-draw-ranges.js";

export class BufferManager {
  constructor(gl) { this.gl = gl; }
  createChunkBuffers(mesh) {
    const transaction=this.beginChunkBuffers(mesh);
    try {this.advanceChunkBuffers(transaction,Infinity);return transaction.handle;}
    catch(error){this.disposeChunkBuffers(transaction.handle);throw error;}
  }
  beginChunkBuffers(mesh) {
    const gl = this.gl;
    const prepared = prepareMeshDrawRanges(mesh);
    let vao=null,vbo=null,ibo=null;
    try {
      vao=gl.createVertexArray(); if(!vao)throw new Error('WebGL vertex array allocation returned null');
      vbo=gl.createBuffer(); if(!vbo)throw new Error('WebGL vertex buffer allocation returned null');
      ibo=gl.createBuffer(); if(!ibo)throw new Error('WebGL index buffer allocation returned null');
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
      gl.bufferData(gl.ARRAY_BUFFER,prepared.vertices.byteLength,gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0,4,gl.SHORT,CHUNK_VERTEX_STRIDE_BYTES,0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.BYTE,true,CHUNK_VERTEX_STRIDE_BYTES,8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,2,gl.UNSIGNED_SHORT,false,CHUNK_VERTEX_STRIDE_BYTES,12);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3,2,gl.UNSIGNED_SHORT,false,CHUNK_VERTEX_STRIDE_BYTES,16);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4,1,gl.UNSIGNED_BYTE,true,CHUNK_VERTEX_STRIDE_BYTES,11);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,prepared.indices.byteLength,gl.STATIC_DRAW);
      const handle={vao,vbo,ibo,indexCount:prepared.indexCount,indexType:prepared.indices instanceof Uint32Array?gl.UNSIGNED_INT:gl.UNSIGNED_SHORT,indexBytes:prepared.indices.BYTES_PER_ELEMENT,byteLength:prepared.vertices.byteLength+prepared.indices.byteLength,triangleCount:prepared.triangleCount,drawRanges:prepared.drawRanges,blendUnits:prepared.blendUnits,bounds:prepared.bounds,originY:mesh.originY??0};
      return {handle,vertices:prepared.vertices,indices:new Uint8Array(prepared.indices.buffer,prepared.indices.byteOffset,prepared.indices.byteLength),vertexOffset:0,indexOffset:0,done:false,uploadedBytes:0};
    } catch(error) {this.disposeChunkBuffers({vao,vbo,ibo});throw error;}
    finally {gl.bindVertexArray(null);}
  }
  advanceChunkBuffers(transaction,maxBytes=Infinity){
    const gl=this.gl,t=transaction;let remaining=Math.max(0,maxBytes),uploaded=0;
    for(const channel of ['vertex','index']){
      const source=channel==='vertex'?t.vertices:t.indices;
      const offsetKey=channel==='vertex'?'vertexOffset':'indexOffset';
      const target=channel==='vertex'?gl.ARRAY_BUFFER:gl.ELEMENT_ARRAY_BUFFER;
      const buffer=channel==='vertex'?t.handle.vbo:t.handle.ibo;
      const count=Math.min(source.byteLength-t[offsetKey],remaining);
      if(count>0){gl.bindVertexArray(t.handle.vao);gl.bindBuffer(target,buffer);gl.bufferSubData(target,t[offsetKey],source.subarray(t[offsetKey],t[offsetKey]+count));t[offsetKey]+=count;remaining-=count;uploaded+=count;}
    }
    // Validate allocations and this stage's transfers together before the caller
    // can publish a handle. A single check also catches earlier queued GL errors.
    gl.bindVertexArray(null);assertGpuUpload(gl,"staged chunk upload");
    t.done=t.vertexOffset===t.vertices.byteLength&&t.indexOffset===t.indices.byteLength;t.uploadedBytes+=uploaded;
    return {done:t.done,uploadedBytes:uploaded};
  }
  disposeChunkBuffers(handle) {const gl=this.gl;if(!handle)return;if(handle.vbo)gl.deleteBuffer(handle.vbo);if(handle.ibo)gl.deleteBuffer(handle.ibo);if(handle.vao)gl.deleteVertexArray(handle.vao);}
}
