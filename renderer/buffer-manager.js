import { CHUNK_VERTEX_STRIDE_BYTES } from "../chunk/chunk-mesher.js";

export class BufferManager {
  constructor(gl) {
    this.gl = gl;
  }

  createChunkBuffers(mesh) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 4, gl.SHORT, CHUNK_VERTEX_STRIDE_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.BYTE, true, CHUNK_VERTEX_STRIDE_BYTES, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.UNSIGNED_SHORT, false, CHUNK_VERTEX_STRIDE_BYTES, 12);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.UNSIGNED_SHORT, false, CHUNK_VERTEX_STRIDE_BYTES, 16);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, true, CHUNK_VERTEX_STRIDE_BYTES, 11);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      vao,
      vbo,
      ibo,
      indexCount: mesh.indexCount,
      indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      byteLength: mesh.vertices.byteLength + mesh.indices.byteLength,
      triangleCount: mesh.triangleCount,
    };
  }

  disposeChunkBuffers(handle) {
    const gl = this.gl;
    if (!handle) return;
    gl.deleteBuffer(handle.vbo);
    gl.deleteBuffer(handle.ibo);
    gl.deleteVertexArray(handle.vao);
  }
}
