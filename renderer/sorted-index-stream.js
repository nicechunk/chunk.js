import { assertGpuUpload } from './gpu-diagnostics.js';

// Canonical EBOs remain immutable. Each vertex-storage owner gets a separate
// sorted EBO and VAO; segments only select intervals in that frame's stream.
export class SortedIndexStream {
  constructor(gl, { maxBytes = 8 * 1024 * 1024 } = {}) {
    this.gl = gl;
    this.maxBytes = maxBytes;
    this.resources = new Map();
    this.capacityBytes = 0;
    this.uploadBytes = 0;
    this.lastError = null;
  }

  beginFrame() {
    this.uploadBytes = 0;
    this.lastError = null;
    for (const resource of this.resources.values()) { resource.used = 0; resource.ready = false; }
  }

  append(handle, layout, sourceOffset, count) {
    const source = handle.drawIndices;
    if (!(source instanceof Uint16Array || source instanceof Uint32Array)
      || !Number.isInteger(sourceOffset) || sourceOffset < 0 || count <= 0
      || sourceOffset + count > source.length) return null;
    const owner = handle.sortOwner ?? handle.sharedPage ?? handle;
    let resource = this.resources.get(owner);
    if (!resource) {
      resource = { owner, handle, layout, data: new source.constructor(0), used: 0, gpuCapacity: 0,
        indexBytes: source.BYTES_PER_ELEMENT, indexType: handle.indexType, vao: null, ebo: null, ready: false };
      this.resources.set(owner, resource);
    }
    resource.handle = handle;
    const required = resource.used + count;
    if (required > resource.data.length) {
      const capacity = Math.max(256, 2 ** Math.ceil(Math.log2(required)));
      const added = (capacity - resource.data.length) * resource.indexBytes;
      if (this.capacityBytes + added > this.maxBytes) return null;
      const data = new source.constructor(capacity);
      data.set(resource.data);
      resource.data = data;
      this.capacityBytes += added;
    }
    const offset = resource.used;
    for (let i = 0; i < count; i++) resource.data[offset + i] = source[sourceOffset + i];
    resource.used = required;
    resource.appendOffset = offset;
    return resource;
  }

  upload() {
    const gl = this.gl;
    for (const resource of this.resources.values()) {
      if (!resource.used) continue;
      let vao = resource.vao, ebo = resource.ebo, replacement = false;
      try {
        if (!vao || resource.gpuCapacity < resource.data.length) {
          replacement = true;
          vao = gl.createVertexArray(); if (!vao) throw Error('Sorted index VAO allocation returned null');
          ebo = gl.createBuffer(); if (!ebo) throw Error('Sorted index buffer allocation returned null');
          configureVertexArray(gl, resource.handle, resource.layout, vao, ebo);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, resource.data.byteLength, gl.DYNAMIC_DRAW);
        } else if (resource.boundVbo !== resource.handle.vbo) configureVertexArray(gl, resource.handle, resource.layout, vao, ebo);
        else gl.bindVertexArray(vao);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, resource.data, 0, resource.used);
        assertGpuUpload(gl, 'sorted transparent indices');
        if (replacement) {
          if (resource.vao) gl.deleteVertexArray(resource.vao);
          if (resource.ebo) gl.deleteBuffer(resource.ebo);
          resource.vao = vao; resource.ebo = ebo; resource.gpuCapacity = resource.data.length;
        }
        resource.ready = true;
        resource.boundVbo = resource.handle.vbo;
        this.uploadBytes += resource.used * resource.indexBytes;
      } catch (error) {
        this.lastError = error;
        // No draw may use a partial or previous frame's sorted order. Callers
        // fall back to the still-committed canonical EBO in global queue order.
        resource.ready = false;
        if (replacement) { if (vao) gl.deleteVertexArray(vao); if (ebo) gl.deleteBuffer(ebo); }
      }
    }
    gl.bindVertexArray(null);
  }

  endFrame() {
    for (const [owner, resource] of this.resources) if (!resource.used) {
      this.delete(resource); this.resources.delete(owner);
    }
  }

  delete(resource, lost = false) {
    this.capacityBytes -= resource.data.byteLength;
    if (!lost) {
      if (resource.vao) this.gl.deleteVertexArray(resource.vao);
      if (resource.ebo) this.gl.deleteBuffer(resource.ebo);
    }
  }

  dispose({ lost = false } = {}) {
    for (const resource of this.resources.values()) this.delete(resource, lost);
    this.resources.clear();
  }

  snapshot() {
    return { owners: this.resources.size, cpuIndexCapacityBytes: this.capacityBytes,
      gpuIndexCapacityBytes: [...this.resources.values()].reduce((n, r) => n + r.gpuCapacity * r.indexBytes, 0),
      frameIndexUploadBytes: this.uploadBytes, failed: Boolean(this.lastError) };
  }
}

export function configureAvatarVertexArray(gl, vbo, ibo, stride = 40, vao = null) {
  if (vao) gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  for (const [id, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 4, 24]]) {
    gl.enableVertexAttribArray(id); gl.vertexAttribPointer(id, size, gl.FLOAT, false, stride, offset);
  }
  for (const [id, size, offset, minimum] of [[3, 2, 40, 52], [4, 1, 48, 52], [5, 1, 52, 56]]) {
    if (stride >= minimum) { gl.enableVertexAttribArray(id); gl.vertexAttribPointer(id, size, gl.FLOAT, false, stride, offset); }
    else { gl.disableVertexAttribArray(id); if (size === 2) gl.vertexAttrib2f(id, 0, 0); else gl.vertexAttrib1f(id, id === 4 ? -1 : 0); }
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
}

function configureVertexArray(gl, handle, layout, vao, ebo) {
  gl.bindVertexArray(vao);
  if (layout === 'avatar') return configureAvatarVertexArray(gl, handle.vbo, ebo, handle.stride, vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, handle.vbo);
  gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 4, gl.SHORT, 20, 0);
  for (const [id, size, type, normalized, offset] of [[1, 3, gl.BYTE, true, 8],
    [2, 2, gl.UNSIGNED_SHORT, false, 12], [3, 2, gl.UNSIGNED_SHORT, false, 16], [4, 1, gl.UNSIGNED_BYTE, true, 11]]) {
    gl.enableVertexAttribArray(id); gl.vertexAttribPointer(id, size, type, normalized, 20, offset);
  }
  if (handle.sharedPage) {
    gl.bindBuffer(gl.ARRAY_BUFFER, handle.sharedPage.origins);
    gl.enableVertexAttribArray(8); gl.vertexAttribIPointer(8, 4, gl.SHORT, 8, 0);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
}
