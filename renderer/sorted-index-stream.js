import { assertGpuUpload } from './gpu-diagnostics.js';

// Canonical EBOs remain immutable. Each vertex-storage owner gets a separate
// sorted EBO and VAO; segments only select intervals in that frame's stream.
export class SortedIndexStream {
  constructor(gl, { maxBytes = 8 * 1024 * 1024, deferValidation = null } = {}) {
    this.gl = gl;
    this.maxBytes = maxBytes;
    this.resources = new Map();
    this.capacityBytes = 0;
    this.uploadBytes = 0;
    this.lastError = null;
    this.deferValidation = deferValidation;
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
        committedData: new source.constructor(0), committedUsed: 0, staging: null, pending: null,
        indexBytes: source.BYTES_PER_ELEMENT, indexType: handle.indexType, vao: null, ebo: null, ready: false };
      this.resources.set(owner, resource);
    }
    // The renderer normally admits no newer frame behind its validation fence.
    // Keep the pending CPU order immutable even for a direct caller that does.
    if (resource.pending) return null;
    resource.handle = handle;
    const required = resource.used + count;
    if (required > resource.data.length) {
      const capacity = Math.max(256, 2 ** Math.ceil(Math.log2(required)));
      const added = (capacity - resource.data.length) * resource.indexBytes * (this.deferValidation ? 2 : 1);
      if (this.capacityBytes + added > this.maxBytes) return null;
      const data = new source.constructor(capacity);
      data.set(resource.data);
      resource.data = data;
      if (this.deferValidation) {
        const committed = new source.constructor(capacity);
        committed.set(resource.committedData);
        resource.committedData = committed;
      }
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
      if (this.deferValidation) { this.uploadDeferred(resource); continue; }
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

  uploadDeferred(resource) {
    if (resource.pending) return;
    const gl = this.gl;
    let unchanged = Boolean(resource.vao) && resource.used === resource.committedUsed;
    for (let i = 0; unchanged && i < resource.used; i++) unchanged = resource.data[i] === resource.committedData[i];
    if (unchanged) {
      if (resource.boundVbo !== resource.handle.vbo) configureVertexArray(gl,resource.handle,resource.layout,resource.vao,resource.ebo);
      else gl.bindVertexArray(resource.vao);
      resource.boundVbo = resource.handle.vbo;
      resource.ready = true;
      return;
    }
    let staging = resource.staging;
    try {
      if (!staging || staging.capacity < resource.data.length) {
        if (staging) this.deleteGpu(staging);
        resource.staging = null;
        staging = {vao:null,ebo:null,capacity:resource.data.length,boundVbo:resource.handle.vbo};
        staging.vao = gl.createVertexArray();if (!staging.vao) throw Error('Sorted index VAO allocation returned null');
        staging.ebo = gl.createBuffer();if (!staging.ebo) throw Error('Sorted index buffer allocation returned null');
        configureVertexArray(gl,resource.handle,resource.layout,staging.vao,staging.ebo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,resource.data.byteLength,gl.DYNAMIC_DRAW);
      } else {
        configureVertexArray(gl,resource.handle,resource.layout,staging.vao,staging.ebo);
        staging.boundVbo = resource.handle.vbo;
      }
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER,0,resource.data,0,resource.used);
      const used = resource.used;
      resource.staging = null;
      resource.pending = staging;
      this.uploadBytes += used * resource.indexBytes;
      this.deferValidation({
        commit:()=>{
          if (resource.released) return;
          resource.staging = resource.vao ? {vao:resource.vao,ebo:resource.ebo,capacity:resource.gpuCapacity,boundVbo:resource.boundVbo} : null;
          resource.vao = staging.vao;resource.ebo = staging.ebo;resource.gpuCapacity = staging.capacity;
          resource.boundVbo = staging.boundVbo;
          resource.committedData.set(resource.data.subarray(0,used));resource.committedUsed = used;
          resource.pending = null;
        },
        abort:error=>{
          if (resource.released) return;
          this.deleteGpu(staging);resource.pending = null;
          resource.ready = false;this.lastError = error;
        },
      });
      // This frame's global queue uses immutable canonical indices until the
      // new order validates. Never draw last frame's order for a new camera.
      resource.ready = false;
    } catch (error) {
      this.lastError = error;resource.ready = false;
      if (staging) this.deleteGpu(staging);
      resource.staging = resource.pending = null;
    }
  }

  deleteGpu(storage,lost=false) {
    if (!lost) { if (storage.vao) this.gl.deleteVertexArray(storage.vao);if (storage.ebo) this.gl.deleteBuffer(storage.ebo); }
  }

  endFrame() {
    for (const [owner, resource] of this.resources) if (!resource.used && !resource.pending) {
      this.delete(resource); this.resources.delete(owner);
    }
  }

  delete(resource, lost = false) {
    resource.released = true;
    this.capacityBytes -= resource.data.byteLength+resource.committedData.byteLength;
    for (const storage of [resource,resource.staging,resource.pending]) if (storage) this.deleteGpu(storage,lost);
  }

  dispose({ lost = false } = {}) {
    for (const resource of this.resources.values()) this.delete(resource, lost);
    this.resources.clear();
  }

  snapshot() {
    return { owners: this.resources.size, cpuIndexCapacityBytes: this.capacityBytes,
      gpuIndexCapacityBytes: [...this.resources.values()].reduce((n, r) => n + (r.gpuCapacity+(r.staging?.capacity??0)+(r.pending?.capacity??0)) * r.indexBytes, 0),
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
