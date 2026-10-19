import { CHUNK_VERTEX_STRIDE_BYTES } from "../chunk/chunk-mesher.js";

const BASE_VERTICES = 32768;
const BASE_INDICES = 65536;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

// Immutable mesh commits own disjoint slices. Replacement uploads never write
// over the last published slice. Free slices may be reused after release: WebGL
// command ordering preserves previously submitted draws using that storage.
export class SharedChunkBuffers {
  constructor(gl, { maxBytes = 32 * 1024 * 1024, canReuse = () => true } = {}) {
    this.gl = gl;
    this.maxBytes = Math.max(0, Math.min(64 * 1024 * 1024, Number.isFinite(Number(maxBytes)) ? Math.trunc(Number(maxBytes)) : 32 * 1024 * 1024));
    this.pages = new Set();
    this.bytes = 0;
    this.disabled = false;
    this.canReuse = canReuse;
    this.retired = [];
  }

  begin(mesh, placement) {
    this.reclaim();
    const vertices = mesh.vertices.byteLength / CHUNK_VERTEX_STRIDE_BYTES;
    if (this.disabled || !placement || !vertices || !mesh.indices.length || !Number.isInteger(vertices)
      || (mesh.vertexStrideBytes && mesh.vertexStrideBytes !== CHUNK_VERTEX_STRIDE_BYTES)
      || ![placement.x, placement.y, placement.z].every(Number.isSafeInteger)) return null;
    const tags = surfaceTags(mesh, vertices);
    if (!tags) return null;
    let page, vertexBlock, indexBlock;
    for (const candidate of this.pages) {
      if (!fitsOrigin(candidate, placement)) continue;
      const v = findBlock(candidate.freeVertices, vertices), i = findBlock(candidate.freeIndices, mesh.indices.length);
      if (v >= 0 && i >= 0) { page = candidate; vertexBlock = v; indexBlock = i; break; }
    }
    if (!page) {
      const vertexCapacity = Math.max(BASE_VERTICES, powerOfTwo(vertices));
      const indexCapacity = Math.max(BASE_INDICES, powerOfTwo(mesh.indices.length));
      const bytes = vertexCapacity * (CHUNK_VERTEX_STRIDE_BYTES + 8) + indexCapacity * 4;
      if (bytes > MAX_PAGE_BYTES) return null;
      // Empty cached pages must not strand the hard allocation budget.
      if (this.bytes + bytes > this.maxBytes) for (const candidate of [...this.pages]) {
        if (!candidate.live) this.deletePage(candidate);
      }
      if (this.bytes + bytes > this.maxBytes) return null;
      try { page = this.createPage(vertexCapacity, indexCapacity, placement, bytes); }
      catch (error) { this.disabled = true; throw error; }
      vertexBlock = indexBlock = 0;
    }
    const vertexStart = takeBlock(page.freeVertices, vertexBlock, vertices);
    const indexStart = takeBlock(page.freeIndices, indexBlock, mesh.indices.length);
    page.live++;
    try {
      const offsets = new Int16Array(vertices * 4);
      const dx = placement.x - page.x, dy = placement.y - page.y, dz = placement.z - page.z;
      for (let v = 0; v < vertices; v++) {
        offsets[v * 4] = dx; offsets[v * 4 + 1] = dy; offsets[v * 4 + 2] = dz;
        offsets[v * 4 + 3] = tags[v] === 1 ? 1 : 0;
      }
      const indices = new Uint32Array(mesh.indices.length);
      for (let i = 0; i < indices.length; i++) indices[i] = mesh.indices[i] + vertexStart;
      const drawRanges = Object.fromEntries(Object.entries(mesh.drawRanges).map(([pass, range]) => [pass, { offset: range.offset + indexStart, count: range.count, sortOffset: range.offset }]));
      const blendUnits = mesh.blendUnits.map(unit => ({ ...unit, offset: unit.offset + indexStart, sortOffset: unit.offset }));
      const handle = { vao: page.vao, vbo: page.vbo, ibo: page.ibo, sharedPage: page,
        vertexStart, vertexCount: vertices, indexStart, indexCount: indices.length,
        indexType: this.gl.UNSIGNED_INT, indexBytes: 4, triangleCount: mesh.triangleCount,
        byteLength: mesh.vertices.byteLength + offsets.byteLength + indices.byteLength,
        drawRanges, blendUnits, bounds: mesh.bounds, originY: mesh.originY ?? 0, released: false };
      page.liveBytes += handle.byteLength;
      return { handle, vertices: mesh.vertices, indices: new Uint8Array(indices.buffer),
        origins: new Uint8Array(offsets.buffer), vertexOffset: 0, indexOffset: 0,
        originOffset: 0, done: false, uploadedBytes: 0 };
    } catch (error) {
      putBlock(page.freeVertices, vertexStart, vertices);
      putBlock(page.freeIndices, indexStart, mesh.indices.length);
      page.live--;
      if (!page.live && !page.validated) this.deletePage(page);
      throw error;
    }
  }

  createPage(vertices, indices, placement, bytes) {
    const gl = this.gl;
    const page = { ...placement, bytes, live: 0, liveBytes: 0, validated: false,
      freeVertices: [{ start: 0, count: vertices }], freeIndices: [{ start: 0, count: indices }] };
    try {
      page.vao = gl.createVertexArray(); if (!page.vao) throw new Error("Shared chunk VAO allocation returned null");
      page.vbo = gl.createBuffer(); if (!page.vbo) throw new Error("Shared chunk vertex allocation returned null");
      page.ibo = gl.createBuffer(); if (!page.ibo) throw new Error("Shared chunk index allocation returned null");
      page.origins = gl.createBuffer(); if (!page.origins) throw new Error("Shared chunk origin allocation returned null");
      gl.bindVertexArray(page.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, page.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, vertices * CHUNK_VERTEX_STRIDE_BYTES, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 4, gl.SHORT, CHUNK_VERTEX_STRIDE_BYTES, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.BYTE, true, CHUNK_VERTEX_STRIDE_BYTES, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.UNSIGNED_SHORT, false, CHUNK_VERTEX_STRIDE_BYTES, 12);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.UNSIGNED_SHORT, false, CHUNK_VERTEX_STRIDE_BYTES, 16);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, true, CHUNK_VERTEX_STRIDE_BYTES, 11);
      gl.bindBuffer(gl.ARRAY_BUFFER, page.origins);
      gl.bufferData(gl.ARRAY_BUFFER, vertices * 8, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(8); gl.vertexAttribIPointer(8, 4, gl.SHORT, 8, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, page.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices * 4, gl.STATIC_DRAW);
      this.pages.add(page); this.bytes += bytes;
      return page;
    } catch (error) { this.deletePage(page); throw error; }
    finally { gl.bindVertexArray(null); }
  }

  release(handle, { failed = false } = {}) {
    if (handle.released) return;
    handle.released = true;
    const page = handle.sharedPage;
    if (failed) this.disabled = true;
    if (!this.pages.has(page)) return;
    // Keep freed storage unavailable while previously submitted frames may
    // still read it. Polling is owned by the renderer; recycling never waits.
    if (!this.canReuse()) { this.retired.push(handle); return; }
    this.free(handle);
  }

  free(handle) {
    const page=handle.sharedPage;
    if (!this.pages.has(page)) return;
    page.live--; page.liveBytes -= handle.byteLength;
    putBlock(page.freeVertices, handle.vertexStart, handle.vertexCount);
    putBlock(page.freeIndices, handle.indexStart, handle.indexCount);
    if (!page.live && (!page.validated || [...this.pages].filter(p => !p.live).length > 2)) this.deletePage(page);
  }

  reclaim() {
    if (!this.retired.length || !this.canReuse()) return;
    const retired=this.retired;this.retired=[];
    for (const handle of retired) this.free(handle);
  }

  deletePage(page, lost = false) {
    if (this.pages.delete(page)) this.bytes -= page.bytes;
    if (!lost) {
      const gl = this.gl;
      if (page.vbo) gl.deleteBuffer(page.vbo);
      if (page.ibo) gl.deleteBuffer(page.ibo);
      if (page.origins) gl.deleteBuffer(page.origins);
      if (page.vao) gl.deleteVertexArray(page.vao);
    }
  }

  snapshot() {
    return { sharedBufferPages: this.pages.size, sharedBufferBytes: this.bytes,
      sharedBufferLiveBytes: [...this.pages].reduce((n, p) => n + p.liveBytes, 0), sharedBufferFallback: this.disabled,
      sharedBufferRetiredSlices: this.retired.length };
  }

  dispose({ lost = false } = {}) { this.retired=[];for (const page of [...this.pages]) this.deletePage(page, lost); }
}

function fitsOrigin(page, p) { return [p.x - page.x, p.y - page.y, p.z - page.z].every(n => n >= -32768 && n <= 32767); }
function powerOfTwo(n) { return 2 ** Math.ceil(Math.log2(Math.max(1, n))); }
function findBlock(blocks, count) {
  let best = -1;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].count >= count && (best < 0 || blocks[i].count < blocks[best].count)) best = i;
  return best;
}
function takeBlock(blocks, index, count) {
  const block = blocks[index], start = block.start;
  block.start += count; block.count -= count;
  if (!block.count) blocks.splice(index, 1);
  return start;
}
function putBlock(blocks, start, count) {
  blocks.push({ start, count }); blocks.sort((a, b) => a.start - b.start);
  for (let i = 1; i < blocks.length;) {
    const a = blocks[i - 1], b = blocks[i];
    if (a.start + a.count === b.start) { a.count += b.count; blocks.splice(i, 1); }
    else i++;
  }
}
function surfaceTags(mesh, vertices) {
  const tags = new Int8Array(vertices); tags.fill(-1);
  // A host mesh may share a vertex across incompatible material passes. Keep
  // the ordinary per-range uniform path in that case instead of changing pixels.
  for (const [pass, tag] of [["opaque", 0], ["cutout", 1]]) {
    const range = mesh.drawRanges[pass];
    for (let i = range.offset; i < range.offset + range.count; i++) {
      const v = mesh.indices[i];
      if (v >= vertices || (tags[v] >= 0 && tags[v] !== tag)) return null;
      tags[v] = tag;
    }
  }
  return tags;
}
