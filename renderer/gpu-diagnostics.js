// These are application allocations, not the driver's physical VRAM total.
export class GpuResourceLedger {
  constructor() {
    this.generation = 0;
    this.records = new Map();
    this.bytes = 0;
    this.peakBytes = 0;
    this.allocationFailures = 0;
    this.uploadBytes = 0;
    this.bufferBytes = 0;
    this.textureBytes = 0;
    this.buffers = 0;
    this.textures = 0;
  }
  create(handle, kind) {
    if (!handle) {
      this.allocationFailures += 1;
      throw new Error(`WebGL ${kind} allocation returned null`);
    }
    if (this.records.has(handle)) return handle;
    this.records.set(handle, { kind, bytes: 0, generation: this.generation });
    if (kind === "buffer") this.buffers += 1;
    if (kind === "texture") this.textures += 1;
    return handle;
  }
  size(handle, bytes) {
    const record = this.records.get(handle);
    if (!record) return;
    const next = Math.max(0, bytes), difference = next - record.bytes;
    this.bytes += difference;
    if (record.kind === "buffer") this.bufferBytes += difference;
    if (record.kind === "texture") this.textureBytes += difference;
    record.bytes = next;
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
  }
  remove(handle) {
    const record = this.records.get(handle);
    if (!record) return;
    this.bytes -= record.bytes;
    if (record.kind === "buffer") { this.buffers -= 1; this.bufferBytes -= record.bytes; }
    if (record.kind === "texture") { this.textures -= 1; this.textureBytes -= record.bytes; }
    this.records.delete(handle);
  }
  reset(generation) {
    this.records.clear();
    this.bytes = this.bufferBytes = this.textureBytes = this.buffers = this.textures = 0;
    this.generation = generation;
  }
  snapshot() {
    return {
      applicationResidentBytes: this.bytes, applicationResidentPeakBytes: this.peakBytes,
      bufferBytes: this.bufferBytes, textureBytes: this.textureBytes,
      buffers: this.buffers, textures: this.textures,
      allocationFailures: this.allocationFailures, uploadBytes: this.uploadBytes,
      contextGeneration: this.generation,
    };
  }
}

// A context-local proxy covers auxiliary passes as well as terrain/avatar buffers.
// Bind native methods to the native context: WebGL methods perform receiver checks.
export function instrumentGl(gl, ledger) {
  const bindings = new Map(), textureBindings = new Map(), methods = new Map();
  const creationKinds = { createBuffer: "buffer", createTexture: "texture", createVertexArray: "vao", createQuery: "query" };
  const deletionMethods = new Set(["deleteBuffer", "deleteTexture", "deleteVertexArray", "deleteQuery"]);
  const trackedMethods = new Set([...Object.keys(creationKinds), ...deletionMethods,
    "bindBuffer", "bufferData", "bufferSubData", "bindTexture", "texStorage3D", "texImage2D"]);
  return new Proxy(gl, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      if (methods.has(key)) return methods.get(key);
      if (!trackedMethods.has(key)) {
        const native = value.bind(target);
        methods.set(key, native);
        return native;
      }
      const wrapped = (...args) => {
        if (creationKinds[key]) return ledger.create(value.apply(target, args), creationKinds[key]);
        if (deletionMethods.has(key)) {
          const result = value.apply(target, args);
          ledger.remove(args[0]);
          return result;
        }
        const result = value.apply(target, args);
        if (key === "bindBuffer") bindings.set(args[0], args[1]);
        if (key === "bufferData") {
          const bytes = typeof args[1] === "number" ? args[1] : args[1]?.byteLength ?? 0;
          ledger.size(bindings.get(args[0]), bytes);
          if (typeof args[1] !== "number") ledger.uploadBytes += bytes;
        }
        if (key === "bufferSubData") ledger.uploadBytes += args[2]?.byteLength ?? 0;
        if (key === "bindTexture") textureBindings.set(args[0], args[1]);
        if (key === "texStorage3D") {
          let pixels = 0;
          for (let level = 0; level < args[1]; level += 1) pixels += Math.max(1, args[3] >> level) * Math.max(1, args[4] >> level) * args[5];
          ledger.size(textureBindings.get(args[0]), pixels * 4); // RGBA8 arrays used by this renderer.
        }
        if (key === "texImage2D" && typeof args[3] === "number") ledger.size(textureBindings.get(args[0]), args[3] * args[4] * 4);
        return result;
      };
      methods.set(key, wrapped);
      return wrapped;
    },
  });
}

export class AsyncGpuTimer {
  constructor(gl, { generation = 0, maxPending = 4 } = {}) {
    this.gl = gl;
    this.generation = generation;
    this.maxPending = maxPending;
    this.extension = gl.getExtension?.("EXT_disjoint_timer_query_webgl2") ?? null;
    this.pending = [];
    this.active = null;
    this.lastMs = null;
    this.status = this.extension ? "waiting" : "unsupported";
    this.retryAt = 0;
  }
  begin() {
    this.poll();
    if (!this.extension || this.active || this.status === "disjoint" || this.pending.length >= this.maxPending || this.gl.isContextLost?.() || performance.now() < this.retryAt) return;
    try {
      const query = this.gl.createQuery();
      if (!query) throw new Error("GPU timer query allocation returned null");
      this.active = query;
      this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    } catch {
      if(this.active){this.gl.deleteQuery(this.active);this.active=null;}
      // Optional diagnostics must not make rendering fail during allocation pressure.
      this.status = "allocation-failed";
      this.lastMs = null;
      this.retryAt = performance.now() + 1000;
    }
  }
  end() {
    if (!this.active) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push({ query: this.active, generation: this.generation });
    this.active = null;
  }
  poll() {
    if (!this.extension || this.gl.isContextLost?.()) return;
    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      for (const { query } of this.pending) this.gl.deleteQuery(query);
      this.pending = [];
      this.lastMs = null;
      this.status = "disjoint";
      return;
    }
    if (this.status === "disjoint") this.status = "waiting";
    while (this.pending.length) {
      const { query, generation } = this.pending[0];
      if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const nanoseconds = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT);
      this.gl.deleteQuery(query);
      if (generation === this.generation) {
        this.lastMs = nanoseconds / 1e6;
        this.status = "available";
      }
    }
  }
  snapshot() { return { gpuTimeMs: this.lastMs, gpuTimerStatus: this.status, gpuQueriesPending: this.pending.length + (this.active ? 1 : 0) }; }
  dispose({ lost = false } = {}) {
    if (!lost) {
      if (this.active) this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      if (this.active) this.gl.deleteQuery(this.active);
      for (const { query } of this.pending) this.gl.deleteQuery(query);
    }
    this.pending = [];
    this.active = null;
    this.lastMs = null;
  }
}

// Allocation/upload boundaries only; never called from the draw hot path.
export function assertGpuUpload(gl, label = "upload") {
  if (gl.isContextLost?.()) throw new Error(`${label}: WebGL context lost`);
  if (typeof gl.getError === "function") {
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`${label}: WebGL error 0x${Number(error).toString(16)}`);
  }
}
