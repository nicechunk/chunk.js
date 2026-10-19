// Deterministic WebGL ownership/coverage trace, not GPU timing or rasterization.
export function traceGl() {
  let serial = 0, vao = null, array = null, error = 0;
  const buffers = new Map(), vaos = new Map([[null, { attributes: new Map(), element: null }]]);
  const trace = { uploads: [], draws: [], uniforms: 0, calls: 0, deleted: [], fail: '', depth: true };
  const constants = { NO_ERROR: 0, OUT_OF_MEMORY: 0x505, ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893, VERTEX_ARRAY_BINDING: 0x85b5, ARRAY_BUFFER_BINDING: 0x8894,
    ELEMENT_ARRAY_BUFFER_BINDING: 0x8895, BUFFER_SIZE: 0x8764, FLOAT: 0x1406,
    UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, SHORT: 0x1402, BYTE: 0x1400,
    UNSIGNED_BYTE: 0x1401, TRIANGLES: 4 };
  const bound = target => target === constants.ARRAY_BUFFER ? array : vaos.get(vao).element;
  const bytes = (source, offset = 0, length) => {
    const view = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
    const element = source.BYTES_PER_ELEMENT ?? 1;
    return view.subarray(offset * element, length == null ? undefined : (offset + length) * element);
  };
  const upload = (target, offset, data, kind) => {
    const buffer = bound(target);
    if (trace.fail === kind) { error = constants.OUT_OF_MEMORY; return; }
    if (!buffer || !buffers.has(buffer)) throw Error('Upload without a live buffer');
    if (kind === 'data') buffers.set(buffer, typeof data === 'number' ? new Uint8Array(data) : new Uint8Array(data));
    else { if (offset + data.length > buffers.get(buffer).length) throw Error('Upload exceeds buffer'); buffers.get(buffer).set(data, offset); }
    trace.uploads.push({ buffer, target, offset, bytes: typeof data === 'number' ? data : data.length, kind, transfer: typeof data !== 'number' });
  };
  const draw = (mode, count, type, offset, instances) => {
    const state = vaos.get(vao), storage = buffers.get(state.element), width = type === constants.UNSIGNED_INT ? 4 : 2;
    if (!storage || offset % width || offset + count * width > storage.length) throw Error('Draw exceeds or misaligns its VAO element buffer');
    const view = new DataView(storage.buffer, storage.byteOffset + offset, count * width);
    const indices = Array.from({ length: count }, (_, i) => width === 4 ? view.getUint32(i * width, true) : view.getUint16(i * width, true));
    const attributes = new Map([...state.attributes].map(([id, a]) => [id, { ...a }]));
    const position = attributes.get(0), first = position && buffers.get(position.buffer);
    const firstPosition = first && indices.length ? new DataView(first.buffer).getFloat32(position.offset + indices[0] * position.stride, true) : null;
    const instance = attributes.get(2), instanceData = instance && buffers.get(instance.buffer);
    const instanceX = instances != null && instanceData ? Array.from({length:instances}, (_, i) => new DataView(instanceData.buffer).getFloat32(instance.offset + i * instance.stride, true)) : null;
    const instanceZ = instances != null && instanceData ? Array.from({length:instances}, (_, i) => new DataView(instanceData.buffer).getFloat32(instance.offset + i * instance.stride + 8, true)) : null;
    trace.draws.push({ mode, count, type, offset, instances, vao, element: state.element, indices, attributes, firstPosition, instanceX, instanceZ, depth: trace.depth });
  };
  const methods = {
    createBuffer() { if (trace.fail === 'buffer') return null; const b = { buffer: ++serial }; buffers.set(b, new Uint8Array()); return b; },
    createVertexArray() { if (trace.fail === 'vao') return null; const v = { vao: ++serial }; vaos.set(v, { attributes: new Map(), element: null }); return v; },
    bindVertexArray(v) { if (!vaos.has(v)) throw Error('Unknown VAO'); vao = v; },
    bindBuffer(target, b) { if (target === constants.ARRAY_BUFFER) array = b; else vaos.get(vao).element = b; },
    bufferData(target, source, usage, offset, length) { upload(target, 0, typeof source === 'number' ? source : bytes(source, offset, length), 'data'); },
    bufferSubData(target, offset, source, start, length) { upload(target, offset, bytes(source, start, length), 'subdata'); },
    vertexAttribPointer(id, size, type, normalized, stride, offset) { vaos.get(vao).attributes.set(id, { buffer: array, size, type, normalized, stride, offset }); },
    vertexAttribIPointer(id, size, type, stride, offset) { methods.vertexAttribPointer(id, size, type, false, stride, offset); },
    vertexAttribDivisor(id, divisor) { const a = vaos.get(vao).attributes.get(id); if (a) a.divisor = divisor; },
    getParameter(key) { if (key === constants.VERTEX_ARRAY_BINDING) return vao; if (key === constants.ARRAY_BUFFER_BINDING) return array; if (key === constants.ELEMENT_ARRAY_BUFFER_BINDING) return vaos.get(vao).element; return 0; },
    getBufferParameter() { return buffers.get(bound(constants.ELEMENT_ARRAY_BUFFER))?.length ?? 0; },
    getError() { const value = error; error = 0; return value; },
    isContextLost() { return trace.fail === 'lost'; },
    getExtension() { return null; },
    createShader() { return { shader: ++serial }; },
    createProgram() { return { program: ++serial }; },
    getShaderParameter() { return true; },
    getProgramParameter() { return true; },
    deleteBuffer(b) { if (b) { buffers.delete(b); trace.deleted.push(b); } },
    deleteVertexArray(v) { if (v) { vaos.delete(v); trace.deleted.push(v); if (vao === v) vao = null; } },
    drawElements(...args) { draw(...args); },
    drawElementsInstanced(...args) { draw(...args); },
    depthMask(value) { trace.depth = value; },
  };
  const gl = new Proxy(methods, { get(target, key) {
    if (key in target) return (...args) => { trace.calls++; return target[key](...args); };
    if (key in constants) return constants[key];
    if (/^[A-Z_0-9]+$/.test(String(key))) return constants[key] = 0x2000 + Object.keys(constants).length;
    return () => { trace.calls++; if (String(key).startsWith('uniform')) trace.uniforms++; };
  } });
  const reset = () => { trace.uploads.length = 0; trace.draws.length = 0; trace.uniforms = 0; trace.calls = 0; };
  return { gl, trace, reset, buffers, vaos };
}

export function packedTriangles(count, { layer = 17, index32 = false, mixed = false } = {}) {
  const vertices = new Uint8Array(count * 3 * 20), data = new DataView(vertices.buffer);
  const indices = index32 ? new Uint32Array(count * 3) : new Uint16Array(count * 3);
  for (let i = 0; i < count; i++) for (let corner = 0; corner < 3; corner++) {
    const v = i * 3 + corner, offset = v * 20;
    data.setInt16(offset, corner === 1 ? 64 : 0, true);
    data.setInt16(offset + 2, corner === 2 ? 64 : 0, true);
    data.setInt16(offset + 4, ((i * 37) % count) * 4, true);
    data.setInt16(offset + 6, 64, true); data.setInt8(offset + 10, -127);
    data.setUint8(offset + 11, 255); data.setUint16(offset + 16, mixed && i % 2 ? 3 : layer, true);
    indices[v] = v;
  }
  return { vertices, indices, indexCount: indices.length, vertexCount: count * 3, triangleCount: count };
}

export function animatedTriangles(count = 100) {
  const vertices = new Float32Array(count * 3 * 10), indices = new Uint16Array(count * 3);
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) {
    const id = i * 3 + c, offset = id * 10;
    vertices.set([c === 1 ? 1 : 0, c === 2 ? 1 : 0, i * .02, 0, 0, -1, .8, .3, .2, .5], offset);
    indices[id] = id;
  }
  return { vertices, indices, indexCount: indices.length, triangleCount: count, vertexStrideBytes: 40,
    parts: [{ vertices: new Float32Array(vertices), vertexOffset: 0, vertexCount: count * 3, bone: 'body', pivot: [0,0,0] }] };
}
