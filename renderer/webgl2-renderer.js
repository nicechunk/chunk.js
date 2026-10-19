import { DEFAULT_VIEW_DISTANCE, MAX_DESKTOP_DPR, MAX_MOBILE_DPR } from "../core/constants.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { cameraForward, cameraOrigin, cameraViewProjection } from "./camera.js";
import { filterChunksByCameraFrustum } from "./frustum.js";
import { avatarHoldsTransparentBlock, updateAvatarMeshVertices } from "./avatar-mesh.js";
import { BufferManager } from "./buffer-manager.js";
import { AsyncGpuTimer, GpuResourceLedger, instrumentGl, assertGpuUpload } from "./gpu-diagnostics.js";
import { waterPrecisionUniforms } from "./water-precision.js";
import { RenderStageStats } from "../debug/stats.js";
import { CloudLayer } from "./cloud-layer.js";
import { applyLightingUniforms, createUnderwaterLighting, createWorldLighting } from "./lighting.js";
import { createProgram, FAST_FLUID_FRAGMENT_SHADER, OPAQUE_FRAGMENT_SHADER, SOLID_FRAGMENT_SHADER, OPAQUE_VERTEX_SHADER } from "./shader-manager.js";
import { renderResolution } from "./render-resolution.js";
import { ProjectedShadowLayer } from "./projected-shadow-layer.js";
import { SkyGradient } from "./sky-gradient.js";
import { SunDisc } from "./sun-disc.js";
import { TextureArrayManager, materialTileCacheStats } from "./texture-array-manager.js";
import { meshDrawRangeArrays } from "./mesh-draw-ranges.js";
import { VoxelOverlay } from "./voxel-overlay.js";
import { VoxelParticleLayer } from "./voxel-particle-layer.js";

const AVATAR_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aUv;
layout(location = 4) in float aTextureLayer;
layout(location = 5) in float aTransparentSurface;

uniform mat4 uViewProjection;
uniform vec3 uAvatarOrigin;
uniform float uAvatarYaw;

out vec3 vNormal;
out vec4 vColor;
out vec2 vUv;
flat out float vTextureLayer;
flat out float vTransparentSurface;

void main() {
  float c = cos(uAvatarYaw);
  float s = sin(uAvatarYaw);
  mat3 yaw = mat3(
    c, 0.0, -s,
    0.0, 1.0, 0.0,
    s, 0.0, c
  );
  vec3 p = yaw * aPosition + uAvatarOrigin;
  gl_Position = uViewProjection * vec4(p, 1.0);
  vNormal = normalize(yaw * aNormal);
  vColor = aColor;
  vUv = aUv;
  vTextureLayer = aTextureLayer;
  vTransparentSurface = aTransparentSurface;
}
`;

const UNDERWATER_ENTER_RATE = 6.5;
const UNDERWATER_EXIT_RATE = 4.0;

const AVATAR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uTextureArray;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyLightColor;
uniform vec3 uGroundLightColor;
uniform vec4 uLightParams;
uniform float uAvatarOpacity;
uniform float uAvatarSurfacePass;

in vec3 vNormal;
in vec4 vColor;
in vec2 vUv;
flat in float vTextureLayer;
flat in float vTransparentSurface;

out vec4 outColor;

void main() {
  bool blendedSurface=vTransparentSurface>0.5 || vColor.a<0.999;
  if (uAvatarSurfacePass > 0.5 && uAvatarSurfacePass < 1.5 && blendedSurface) discard;
  if (uAvatarSurfacePass > 1.5 && !blendedSurface) discard;
  vec4 surface = vColor;
  if (vTextureLayer >= 0.0) {
    surface = textureGrad(uTextureArray, vec3(fract(vUv), floor(vTextureLayer + 0.5)), dFdx(vUv), dFdy(vUv));
    if (surface.a < 0.08) discard;
  }
  vec3 normal = normalize(vNormal);
  float sun = max(dot(normal, normalize(uSunDirection)), 0.0);
  float hemiUp = normal.y * 0.5 + 0.5;
  vec3 ambient = uSkyLightColor * uLightParams.x;
  vec3 hemi = mix(uGroundLightColor, uSkyLightColor, hemiUp) * uLightParams.z;
  vec3 direct = uSunColor * (sun * uLightParams.y);
  vec3 color = surface.rgb * (ambient + hemi + direct) * uLightParams.w;
  outColor = vec4(color, surface.a * uAvatarOpacity);
}
`;

export class WebGL2VoxelRenderer {
  constructor(canvas, options = {}) {
    if (!canvas) throw new Error("WebGL2VoxelRenderer requires a canvas.");
    const lighting = createWorldLighting(options.lighting ?? {}, { mobile: isCoarsePointer() });
    if (Array.isArray(options.clearColor)) lighting.clearColor = [...options.clearColor];
    this.lighting = lighting;
    this.canvas = canvas;
    this.options = {
      clearColor: options.clearColor ?? lighting.clearColor,
      dpr: options.dpr ?? null,
      maxMobileDpr: options.maxMobileDpr ?? MAX_MOBILE_DPR,
      maxDesktopDpr: options.maxDesktopDpr ?? MAX_DESKTOP_DPR,
      maxRenderPixels: options.maxRenderPixels ?? Infinity,
      environmentEffects: options.environmentEffects ?? true,
      waterEffects: options.waterEffects ?? true,
      gpuTiming: options.gpuTiming ?? true,
      textureTileSize: options.textureTileSize ?? 32,
      textureSeed: options.textureSeed ?? "nicechunk-materials-v1",
      viewDistance: options.viewDistance ?? DEFAULT_VIEW_DISTANCE,
      maxChunkUploadsPerFrame: options.maxChunkUploadsPerFrame ?? defaultUploadBudget(),
      regionChunkSize: options.regionChunkSize ?? 4,
      useRegionBatching: options.useRegionBatching ?? true,
      cloudHeight: options.cloudHeight ?? 226,
      cloudRadius: options.cloudRadius ?? 2200,
      cloudCellSize: options.cloudCellSize ?? 128,
      cloudFarPadding: options.cloudFarPadding ?? 540,
      maxVoxelParticles: options.maxVoxelParticles ?? 320,
      maxDynamicShadowCasters: options.maxDynamicShadowCasters ?? 8,
      autoResizeEachFrame: options.autoResizeEachFrame ?? true,
      textureQuality: options.textureQuality ?? "balanced",
      maxUploadBytesPerFrame: options.maxUploadBytesPerFrame ?? 4 * 1024 * 1024,
      maxUploadCpuMs: options.maxUploadCpuMs ?? 4,
      uploadRetryMs: options.uploadRetryMs ?? 250,
      antialias: options.antialias ?? false,
    };
    this.onInitStage = typeof options.onInitStage === "function" ? options.onInitStage : null;
    this.gl = null;
    this.program = null;
    this.solidProgram = null;
    this.solidUniforms = null;
    this.avatarProgram = null;
    this.uniforms = null;
    this.avatarUniforms = null;
    this.bufferManager = null;
    this.textureArray = null;
    this.chunkBuffers = new Map();
    this.visualChunkBuffers = new Map();
    this.regionBuffers = new Map();
    this.visualRegionBuffers = new Map();
    this.avatarBuffers = new Map();
    this.avatarMeshes = new Map();
    this.avatarResourceCache = new WeakMap();
    this.contextGeneration = 0;
    this.disposed = false;
    this.retryUploads = new Map();
    this.uploadStaging = new Map();
    this.lastUploadAttemptBytes=0;
    this.resourceLedger = new GpuResourceLedger();
    this.gpuTimer = null;
    this.stageStats=new RenderStageStats();
    this.cpuMeshBytesDirty=true;
    this.cachedCpuMeshBytes=0;
    this.uploadDiagnostics = { failed: 0, bytes: 0, cpuMs: 0, oldestPendingMs: 0 };
    this.pendingUploadSince = new Map();
    this.pendingMeshSources = new Map();
    this.avatarFrameStates = new Map();
    this.cloudLayer = null;
    this.skyGradient = null;
    this.sunDisc = null;
    this.projectedShadowLayer = null;
    this.voxelOverlay = null;
    this.voxelParticles = null;
    this.contextLost = false;
    this.initialized = false;
    this.stats = emptyStats();
    this.renderLogger = null;
    this.renderFrameId = 0;
    this.regionGroupCache = new Map();
    this.frustumFilterCache = null;
    this.underwaterBlend = 0;
    this.lastUnderwaterFrameAt = null;
    this._contextListenersAttached = false;
    this._onContextLost = (event) => {
      event.preventDefault();
      this.pauseContext();
    };
    this._onContextRestored = () => {
      if (this.disposed || !this.contextLost) return;
      this.contextLost = false;
      this.contextLossHandled=false;
      this.contextGeneration += 1;
      this.resourceLedger.reset(this.contextGeneration);
      // Recreate every context-owned pass. CPU avatar/model registrations survive.
      this.gl = null; this.program = null; this.avatarProgram = null;
      this.chunkBuffers.clear(); this.visualChunkBuffers.clear();
      this.regionBuffers.clear(); this.visualRegionBuffers.clear(); this.avatarBuffers.clear();
      this.regionGroupCache.clear(); this.frustumFilterCache = null;
      try { this.init(); } catch (error) { this.lastInitError = error; }
    };
    this.attachContextListeners();
  }

  pauseContext() {
    if(this.disposed||this.contextLossHandled)return;
    this.contextLossHandled=true;
    this.contextLost = true;
    this.initialized = false;
    this.contextGeneration += 1;
    this.gpuTimer?.dispose({ lost: true });
    this.gpuTimer = null;
    this.resourceLedger.reset(this.contextGeneration);
    this.chunkBuffers.clear(); this.visualChunkBuffers.clear();
    this.regionBuffers.clear(); this.visualRegionBuffers.clear(); this.avatarBuffers.clear();
    this.regionGroupCache.clear(); this.frustumFilterCache = null;
    this.avatarResourceCache = new WeakMap();
    this.retryUploads.clear(); this.uploadStaging.clear();
  }

  init() {
    if (this.disposed || this.contextLost) return this;
    if (this.initialized && this.gl && !this.contextLost) return this;
    const canvasDimensions = {
      width: this.canvas.width,
      height: this.canvas.height,
    };
    const runStage = (label, callback, details = null) => {
      const startedAt = performance.now();
      const result = callback();
      this.onInitStage?.(label, performance.now() - startedAt, typeof details === "function" ? details(result) : details);
      return result;
    };
    try {
      this.attachContextListeners();
      const rawGl = runStage("context", () => this.canvas.getContext("webgl2", {
        alpha: false,
        antialias: this.options.antialias,
        depth: true,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
      }), (context) => webGlContextDetails(context));
      if (!rawGl) throw new Error("WebGL2 is not available in this browser.");
      if (rawGl.isContextLost?.()) { this.pauseContext(); return this; }
      const gl = instrumentGl(rawGl, this.resourceLedger);
      this.gl = gl;
      this.gpuTimer = this.options.gpuTiming ? new AsyncGpuTimer(gl, { generation: this.contextGeneration }) : null;
      runStage("shader programs", () => {
        this.program = createProgram(gl, OPAQUE_VERTEX_SHADER,
          this.options.waterEffects ? OPAQUE_FRAGMENT_SHADER : FAST_FLUID_FRAGMENT_SHADER);
        this.solidProgram = createProgram(gl, OPAQUE_VERTEX_SHADER, SOLID_FRAGMENT_SHADER);
        this.avatarProgram = createProgram(gl, AVATAR_VERTEX_SHADER, AVATAR_FRAGMENT_SHADER);
        this.uniforms = collectUniforms(gl, this.program);
        this.solidUniforms = collectUniforms(gl, this.solidProgram);
        this.avatarUniforms = collectAvatarUniforms(gl, this.avatarProgram);
      });
      this.bufferManager = new BufferManager(gl);
      this.textureArray = new TextureArrayManager(gl, {
        tileSize: this.options.textureTileSize,
        seed: this.options.textureSeed,
        quality: this.options.textureQuality,
      });
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      runStage("baked texture array", () => this.textureArray.createTextureArray(), () => ({
        layers: this.textureArray.layerCount,
        tileSize: this.textureArray.tileSize,
      }));
      if (this.options.environmentEffects) {
        this.cloudLayer = new CloudLayer(gl, {
          seed: this.options.textureSeed,
          baseHeight: this.options.cloudHeight,
          radius: this.options.cloudRadius,
          cellSize: this.options.cloudCellSize,
        });
        runStage("cloud geometry", () => this.cloudLayer.init());
        this.skyGradient = new SkyGradient(gl);
        runStage("sky gradient", () => this.skyGradient.init());
        this.sunDisc = new SunDisc(gl);
        runStage("sun disc", () => this.sunDisc.init());
        this.projectedShadowLayer = new ProjectedShadowLayer(gl, {
          maxCasters: this.options.maxDynamicShadowCasters ?? 8,
        });
        runStage("projected shadows", () => this.projectedShadowLayer.init());
      }
      this.voxelOverlay = new VoxelOverlay(gl);
      runStage("voxel overlays", () => this.voxelOverlay.init());
      this.voxelParticles = new VoxelParticleLayer(gl, {
        maxParticles: this.options.maxVoxelParticles,
      });
      runStage("voxel particles", () => this.voxelParticles.init());
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.disable(gl.BLEND);
      gl.useProgram(this.program);
      gl.uniform1i(this.uniforms.uTextureArray, 0);
      gl.uniform1f(this.uniforms.uOpacity, 1.0);
      runStage("canvas resize", () => this.resize());
      assertGpuUpload(gl, "renderer initialization");
      this.initialized = true;
      this.lastInitError=null;
      this.restoreAvatarUploads();
      return this;
    } catch (error) {
      if(this.gl?.isContextLost?.())this.pauseContext();
      this.releaseContextResources();
      restoreCanvasDimensions(this.canvas, canvasDimensions);
      if (this.contextLost) return this;
      this.detachContextListeners();
      throw error;
    }
  }

  resize(width = null, height = null, dpr = null) {
    const gl = this.gl;
    if (!gl || this.contextLost || this.disposed || gl.isContextLost?.()) return false;
    const explicitSize = Number.isFinite(width) && Number.isFinite(height);
    const rect = explicitSize
      ? null
      : this.canvas.getBoundingClientRect?.() ?? {
          width: this.canvas.clientWidth || 1,
          height: this.canvas.clientHeight || 1,
        };
    const cssWidth = Math.max(1, Math.floor(width ?? rect.width ?? 1));
    const cssHeight = Math.max(1, Math.floor(height ?? rect.height ?? 1));
    const pixelRatio = this.clampedDpr(dpr);
    const { width: targetWidth, height: targetHeight } = renderResolution(cssWidth, cssHeight, pixelRatio, this.options.maxRenderPixels);
    if (this.canvas.width === targetWidth && this.canvas.height === targetHeight) return false;
    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    gl.viewport(0, 0, targetWidth, targetHeight);
    return true;
  }

  clampedDpr(dpr = null) {
    if (Number.isFinite(this.options.dpr)) return Math.max(0.5, Number(this.options.dpr));
    const raw = Number.isFinite(dpr) ? dpr : (globalThis.devicePixelRatio || 1);
    const coarse = globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    return Math.min(Math.max(0.75, raw || 1), coarse ? this.options.maxMobileDpr : this.options.maxDesktopDpr);
  }

  residentCpuMeshBytes(){
    if(!this.cpuMeshBytesDirty)return this.cachedCpuMeshBytes;
    this.cachedCpuMeshBytes=this.diagnostics({maxEntries:0}).cpuMeshBytes;this.cpuMeshBytesDirty=false;return this.cachedCpuMeshBytes;
  }
  diagnostics({maxEntries=64}={}) {
    const arrays=new Set(),meshes=new Set(),entries=[];let cpuMeshBytes=0,pendingUploadBytes=0;
    const addMesh=(mesh)=>{if(!mesh||meshes.has(mesh))return;meshes.add(mesh);for(const a of [mesh.vertices,mesh.indices,...meshDrawRangeArrays(mesh)])if(a?.buffer&&!arrays.has(a.buffer)){arrays.add(a.buffer);cpuMeshBytes+=a.buffer.byteLength;}};
    for(const mesh of this.avatarMeshes.values())addMesh(mesh);
    for(const snapshot of this.avatarFrameStates.values())if(snapshot.vertices?.buffer&&!arrays.has(snapshot.vertices.buffer)){arrays.add(snapshot.vertices.buffer);cpuMeshBytes+=snapshot.vertices.buffer.byteLength;}
    for(const {chunk,visual}of this.pendingMeshSources.values())addMesh(chunk?.[visual?"visualMesh":"mesh"]);
    for(const groups of this.regionGroupCache.values())for(const group of groups)for(const chunk of group.chunks)addMesh(chunk?.[group.meshField??"mesh"]);
    const addEntry=entry=>{addMesh(entry.mesh);if(entries.length<maxEntries)entries.push({id:entry.id,instanceGeneration:entry.instanceGeneration,worldRevision:entry.source?.version,dataRevision:entry.source?.dataRevision,meshRevision:entry.version,haloRevision:entry.source?.haloRevision,lightRevision:entry.source?.lightRevision,gpuToken:entry.token,contextGeneration:entry.generation});};
    for(const map of [this.chunkBuffers,this.visualChunkBuffers])for(const e of map.values())addEntry(e);
    for(const map of [this.regionBuffers,this.visualRegionBuffers])for(const region of map.values())for(const e of region.members?.values()??[])addEntry(e);
    for(const stage of this.uploadStaging.values()){const t=stage.transaction;addMesh(stage.source?.mesh);pendingUploadBytes+=t.vertices.byteLength+t.indices.byteLength-t.uploadedBytes;}
    return {...this.resourceLedger.snapshot(),...this.gpuTimer?.snapshot(),cpuStages:this.stageStats.snapshot(),cpuTextureTileCache:materialTileCacheStats(),cpuMeshBytes,pendingUploadBytes,regionCacheEntries:this.regionGroupCache.size,pendingUploads:this.pendingUploadSince.size,uploadStaging:this.uploadStaging.size,upload:{...this.uploadDiagnostics},entries};
  }

  setRenderLogger(logger) {
    this.renderLogger = logger || null;
  }

  logRenderEvent(type, data = {}) {
    this.renderLogger?.record?.(type, data);
  }

  getRegionGroups(chunks, meshField = "mesh") {
    const list = Array.isArray(chunks) ? chunks : Array.from(chunks ?? []);
    const key = regionGroupCacheKey(list, this.options.regionChunkSize, meshField);
    const cached = this.regionGroupCache.get(key);
    if (cached) return cached;
    const groups = groupChunksByRegion(list, this.options.regionChunkSize, meshField);
    this.regionGroupCache.set(key, groups);
    if (this.regionGroupCache.size > 8) {
      const oldest = this.regionGroupCache.keys().next().value;
      this.regionGroupCache.delete(oldest);
    }
    return groups;
  }

  filterChunksForCamera(chunks, cameraState) {
    const cached = this.frustumFilterCache;
    if (cached?.chunks === chunks && sameFrustumCamera(cached.camera, cameraState)) return cached.visible;
    const visible = filterChunksByCameraFrustum(chunks, cameraState);
    this.frustumFilterCache = { chunks, camera: captureFrustumCamera(cameraState), visible };
    return visible;
  }

  gpuReady() {
    if(this.gl?.isContextLost?.())this.pauseContext();
    if (this.disposed || this.contextLost) return false;
    if (!this.initialized) this.init();
    return this.initialized && Boolean(this.gl) && !this.contextLost;
  }

  uploadChannel(chunk, visual = false, target = null, maxBytes = Infinity) {
    this.lastUploadAttemptBytes=0;
    const mesh = chunk?.[visual ? "visualMesh" : "mesh"];
    if (!mesh?.indexCount || !this.gpuReady()) return null;
    const key = `${visual ? "visual" : "opaque"}:${chunk.id}`;
    if ((this.retryUploads.get(key) ?? 0) > performance.now()) return null;
    const startedAt = performance.now();
    const buffers = target ?? (visual ? this.visualChunkBuffers : this.chunkBuffers);
    const existing = buffers.get(chunk.id);
    let handle = null;
    try {
      const generation = this.contextGeneration;
      chunk[visual ? "visualGpuUploaded" : "gpuUploaded"]=false;
      if(Number.isFinite(maxBytes) && this.bufferManager.beginChunkBuffers){
        const token=meshIdentity(chunk,visual);
        let staging=this.uploadStaging.get(key);
        if(staging && (staging.token!==token || staging.generation!==generation)){
          this.bufferManager.disposeChunkBuffers(staging.transaction.handle);this.uploadStaging.delete(key);staging=null;
        }
        if(!staging){staging={token,generation,transaction:this.bufferManager.beginChunkBuffers(mesh),source:chunk};this.uploadStaging.set(key,staging);}
        const progress=this.bufferManager.advanceChunkBuffers(staging.transaction,Math.max(1,maxBytes));
        this.lastUploadAttemptBytes=progress.uploadedBytes;
        if(!progress.done)return null;
        handle=staging.transaction.handle;this.uploadStaging.delete(key);
      }else{handle = this.bufferManager.createChunkBuffers(mesh);this.lastUploadAttemptBytes=handle.byteLength;}

      if (this.contextLost || this.disposed || generation !== this.contextGeneration || this.gl.isContextLost?.()) {
        throw new Error("GPU context changed during upload");
      }
      const entry = { id: chunk.id, source: chunk, mesh, token: meshIdentity(chunk, visual),
        version: committedMeshVersion(chunk, visual), instanceGeneration: chunk.generation??0, generation, chunkX: chunk.chunkX,
        chunkZ: chunk.chunkZ, originY: mesh.originY ?? chunk.originY ?? 0,
        parentId: chunk.parentId ?? chunk.parentChunkId ?? chunk.id, handle };
      buffers.set(chunk.id, entry);
      this.cpuMeshBytesDirty=true;this.lastUploadError=null;
      if (existing) this.bufferManager.disposeChunkBuffers(existing.handle);
      chunk[visual ? "visualGpuUploaded" : "gpuUploaded"] = true;
      this.retryUploads.delete(key);
      this.pendingUploadSince.delete(key);this.pendingMeshSources.delete(key);
      this.uploadDiagnostics.bytes += handle.byteLength;
      this.uploadDiagnostics.cpuMs += performance.now() - startedAt;
      this.stageStats.record("chunk-upload-cpu",performance.now()-startedAt);
      this.logRenderEvent("chunk-upload", { chunkId: chunk.id, meshType: visual ? "visual" : "opaque", bytes: handle.byteLength,
        elapsedMs: performance.now() - startedAt, token: entry.token, contextGeneration: generation });
      return entry;
    } catch (error) {
      if (handle) this.bufferManager?.disposeChunkBuffers(handle);
      const staging=this.uploadStaging.get(key);if(staging){this.bufferManager?.disposeChunkBuffers(staging.transaction.handle);this.uploadStaging.delete(key);}
      chunk[visual ? "visualGpuUploaded" : "gpuUploaded"] = false;
      this.retryUploads.set(key, performance.now() + this.options.uploadRetryMs);
      this.uploadDiagnostics.failed += 1;
      this.lastUploadError = error;
      this.logRenderEvent("upload-error", { chunkId: chunk.id, message: String(error?.message ?? error) });
      return null;
    }
  }
  uploadChunk(chunk) { return this.uploadChannel(chunk); }
  uploadVisualChunk(chunk) { return this.uploadChannel(chunk, true); }
  updateChunk(chunk) { const old = this.chunkBuffers.get(chunk?.id); return old?.generation===this.contextGeneration && old?.token === meshIdentity(chunk, false) && chunk.gpuUploaded ? old : this.uploadChunk(chunk); }
  updateVisualChunk(chunk) { const old = this.visualChunkBuffers.get(chunk?.id); return old?.generation===this.contextGeneration && old?.token === meshIdentity(chunk, true) && chunk.visualGpuUploaded ? old : this.uploadVisualChunk(chunk); }

  removeChunk(chunkId) {
    this.cpuMeshBytesDirty=true;
    for (const buffers of [this.chunkBuffers, this.visualChunkBuffers]) {
      for (const [id, entry] of buffers) if (id === chunkId || entry.parentId === chunkId) {
        this.bufferManager?.disposeChunkBuffers(entry.handle); buffers.delete(id);
      }
    }
    for (const regions of [this.regionBuffers, this.visualRegionBuffers]) for (const [id, region] of regions) {
      for (const [memberId, entry] of region.members ?? []) if (memberId === chunkId || entry.parentId === chunkId) {
        this.bufferManager?.disposeChunkBuffers(entry.handle); region.members.delete(memberId); region.chunkIds.delete(memberId);
      }
      if (!region.members?.size) regions.delete(id);
    }
    for (const [key, groups] of this.regionGroupCache) if (groups.some(group => group.chunks.some(c => c.id === chunkId || c.parentId === chunkId))) this.regionGroupCache.delete(key);
    for (const key of this.retryUploads.keys()) if (key.endsWith(`:${chunkId}`) || key.includes(`:${chunkId}@`)) this.retryUploads.delete(key);
    for(const [key,staging]of this.uploadStaging)if(staging.source.id===chunkId||staging.source.parentId===chunkId){this.bufferManager?.disposeChunkBuffers(staging.transaction.handle);this.uploadStaging.delete(key);}
    for(const key of this.pendingUploadSince.keys())if(key.endsWith(`:${chunkId}`)||key.includes(`:${chunkId}@`)){this.pendingUploadSince.delete(key);this.pendingMeshSources.delete(key);}
    this.frustumFilterCache = null;
  }
  pruneChunks(liveChunkIds) {
    const live = liveChunkIds instanceof Set ? liveChunkIds : new Set(liveChunkIds ?? []);
    const dead = new Set();
    for (const buffers of [this.chunkBuffers, this.visualChunkBuffers]) for (const [id, entry] of buffers) if (!live.has(id) && !live.has(entry.parentId)) dead.add(entry.parentId ?? id);
    for (const regions of [this.regionBuffers, this.visualRegionBuffers]) for (const region of regions.values()) for (const [id,entry] of region.members ?? []) if (!live.has(id) && !live.has(entry.parentId)) dead.add(entry.parentId ?? id);
    for (const id of dead) this.removeChunk(id);
    for (const [key,groups] of this.regionGroupCache) if(groups.some(group=>group.chunks.some(c=>!live.has(c.id)&&!live.has(c.parentId)))) this.regionGroupCache.delete(key);
  }

  prepareChunksForRender(visibleChunks = [], { maxUploads = this.options.maxChunkUploadsPerFrame, cameraState = null } = {}) {
    if (!this.gpuReady()) return { uploaded: 0, pendingUploads: 0, paused: true };
    this.restoreAvatarUploads();
    const chunks = this.filterChunksForCamera(flattenRenderSections(visibleChunks), cameraState);
    retireCommittedEmptyChunkBuffers(this, chunks);
    const startedAt = performance.now(), limit = Math.max(0, Math.trunc(maxUploads ?? 0));
    let uploaded=0, bytes=0, attempts=0,pendingUploads=0, oldestPendingMs=0;
    // A task is one chunk/section channel. Region membership never causes repacking.
    for (const visual of [false,true]) for (const chunk of chunks) {
      const mesh=chunk?.[visual?'visualMesh':'mesh']; if(!mesh?.indexCount)continue;
      const existing=this.entryForChunk(chunk,visual);
      if(existing?.token===meshIdentity(chunk,visual) && chunk[visual?'visualGpuUploaded':'gpuUploaded'])continue;
      const key=`${visual?'visual':'opaque'}:${chunk.id}`;
      if(!this.pendingUploadSince.has(key))this.pendingUploadSince.set(key,performance.now());
      this.pendingMeshSources.set(key,{chunk,visual});
      const taskBytes=mesh.vertices.byteLength+mesh.indices.byteLength;
      const overBudget=attempts>=limit || bytes>=this.options.maxUploadBytesPerFrame || (attempts>0 && performance.now()-startedAt>=this.options.maxUploadCpuMs);
      if(overBudget) {pendingUploads++;oldestPendingMs=Math.max(oldestPendingMs,performance.now()-this.pendingUploadSince.get(key));continue;}
      const region = this.options.useRegionBatching && regionBatchEligible(chunk) ? this.getRegionGroups([chunk],visual?'visualMesh':'mesh')[0] : null;
      const remainingBytes=Math.max(1,this.options.maxUploadBytesPerFrame-bytes);
      const result=region?this.uploadRegion(region,undefined,{visual,maxBytes:remainingBytes}):this.uploadChannel(chunk,visual,null,remainingBytes);
      attempts++;bytes+=this.lastUploadAttemptBytes;
      if(result)uploaded++;else {pendingUploads++;oldestPendingMs=Math.max(oldestPendingMs,performance.now()-(this.pendingUploadSince.get(key)??performance.now()));}
    }
    this.uploadDiagnostics.oldestPendingMs=oldestPendingMs;
    return {uploaded,pendingUploads,uploadedBytes:bytes,cpuMs:performance.now()-startedAt,oldestPendingMs};
  }

  uploadRegion(region, signature = null, { visual = false, maxBytes=Infinity } = {}) {
    if(!region?.chunks?.length || !this.gpuReady()) return null;
    const target=visual?this.visualRegionBuffers:this.regionBuffers;
    const previous=target.get(region.id), members=new Map(previous?.members ?? []);
    let changed=false;
    for(const chunk of region.chunks) {
      if(members.get(chunk.id)?.token===meshIdentity(chunk,visual))continue;
      if(this.uploadChannel(chunk,visual,members,maxBytes))changed=true;
    }
    if(!changed)return null;
    const entry={...region,members,chunkIds:new Set(members.keys()),chunkVersions:new Map(Array.from(members,([id,m])=>[id,m.version])),
      signature:signature??Array.from(members.values(),m=>m.token).join('|'),handle:members.values().next().value?.handle};
    target.set(region.id,entry);return entry;
  }
  entryForChunk(chunk, visual=false) {
    const buffers=visual?this.visualChunkBuffers:this.chunkBuffers;
    const direct=buffers.get(chunk.id);
    if(direct)return direct.generation===this.contextGeneration&&direct.source===chunk&&direct.instanceGeneration===(chunk.generation??0)?direct:null;
    if(!regionBatchEligible(chunk))return null;
    const regions=visual?this.visualRegionBuffers:this.regionBuffers;
    const member=regions.get(regionIdForChunk(chunk,this.options.regionChunkSize))?.members?.get(chunk.id);
    return member?.generation===this.contextGeneration&&member?.source===chunk&&member.instanceGeneration===(chunk.generation??0)?member:null;
  }
  uploadAvatarMesh(id, mesh) {
    if(!mesh?.vertices || !mesh?.indices || this.disposed)return null;
    const key=String(id||mesh.name||'avatar');this.avatarMeshes.set(key,mesh);this.cpuMeshBytesDirty=true;
    if(!this.gpuReady())return null;
    const retryKey=`avatar:${key}`;
    if((this.retryUploads.get(retryKey)??0)>performance.now())return null;
    const existing=this.avatarBuffers.get(key);
    if(existing?.mesh===mesh && existing.generation===this.contextGeneration)return existing;
    try {
      const generation=this.contextGeneration;
      let handle=this.avatarResourceCache.get(mesh);
      if(handle?.generation===generation && handle.avatarRefs>0){handle.avatarRefs+=1;}else{handle=this.createAvatarBuffers(mesh);handle.generation=generation;handle.avatarRefs=1;this.avatarResourceCache.set(mesh,handle);}
      if(this.contextLost || this.disposed || generation!==this.contextGeneration){this.disposeAvatarBuffers(handle);return null;}
      const entry={id:key,mesh,handle,generation};this.avatarBuffers.set(key,entry);
      if(existing)this.disposeAvatarBuffers(existing.handle);
      this.retryUploads.delete(retryKey);this.lastUploadError=null;return entry;
    } catch(error) {this.lastUploadError=error;this.uploadDiagnostics.failed++;this.retryUploads.set(retryKey,performance.now()+this.options.uploadRetryMs);return null;}
  }
  restoreAvatarUploads() {
    if(this.contextLost||this.disposed||!this.initialized)return;
    let attempted=0,bytes=0;
    for(const [id,mesh]of this.avatarMeshes){const entry=this.avatarBuffers.get(id);if(entry?.mesh===mesh&&entry.generation===this.contextGeneration)continue;
      if((this.retryUploads.get(`avatar:${id}`)??0)>performance.now())continue;
      if(attempted>=2 || (attempted>0&&bytes+mesh.vertices.byteLength+mesh.indices.byteLength>this.options.maxUploadBytesPerFrame))break;
      this.uploadAvatarMesh(id,mesh);attempted++;bytes+=mesh.vertices.byteLength+mesh.indices.byteLength;
    }
  }
  removeAvatarMesh(id) {this.cpuMeshBytesDirty=true;const key=String(id);this.avatarMeshes.delete(key);const old=this.avatarBuffers.get(key);if(old)this.disposeAvatarBuffers(old.handle);this.avatarBuffers.delete(key);this.retryUploads.delete(`avatar:${key}`);}

  emitVoxelParticles(kind, options = {}) {
    if (!this.gpuReady()) return false;
    if (!this.voxelParticles) return false;
    if (kind === "break") {
      this.voxelParticles.emitBreak(options);
      return true;
    }
    if (kind === "fracture") {
      return this.voxelParticles.emitFracture(options) > 0;
    }
    if (kind === "splash") {
      this.voxelParticles.emitSplash(options);
      return true;
    }
    return false;
  }

  updateVoxelParticles(dt, collision = null) {
    return this.voxelParticles?.update?.(dt, collision) ?? 0;
  }

  render(cameraState, visibleChunks = [], avatars = [], overlays = []) {
    if (!this.gpuReady() || !this.program) return this.stats;
    this.restoreAvatarUploads();
    const drawSubmitStartedAt=performance.now();
    this.gpuTimer?.begin();
    const gl = this.gl;
    if (this.options.autoResizeEachFrame) this.resize();
    cameraState.aspect = Math.max(1, this.canvas.width) / Math.max(1, this.canvas.height);
    const renderChunks = this.filterChunksForCamera(
      filterChunksByRenderRadius(flattenRenderSections(visibleChunks), cameraState, this.options.viewDistance),
      cameraState,
    );
    const previewChunks = renderChunks.filter((chunk) => chunk?.buildingPreview === true);
    const worldChunks = previewChunks.length
      ? renderChunks.filter((chunk) => chunk?.buildingPreview !== true)
      : renderChunks;
    const logDraw = Boolean(this.renderLogger?.enabled);
    const frameId = ++this.renderFrameId;
    if (logDraw) this.renderLogger.beginFrame({ visibleChunks: renderChunks.length });
    this.avatarFrameStates.clear();
    const viewProjection = cameraViewProjection(cameraState);
    const origin = cameraOrigin(cameraState);
    const frameTime = performance.now();
    const underwater = cameraIsInsideFluid(cameraState, visibleChunks);
    if (this.lastUnderwaterFrameAt === null) {
      this.underwaterBlend = underwater ? 1 : 0;
    } else {
      this.underwaterBlend = advanceUnderwaterBlend(
        this.underwaterBlend,
        underwater,
        frameTime - this.lastUnderwaterFrameAt,
      );
    }
    this.lastUnderwaterFrameAt = frameTime;
    const lighting = createUnderwaterLighting(this.lighting, this.underwaterBlend);
    const clear = lighting.clearColor ?? this.options.clearColor;

    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let drawCalls = 0;
    let triangles = 0;
    let bufferMemory = 0;
    const skyStats = this.renderSkyGradient(cameraState, lighting);
    drawCalls += skyStats.drawCalls;
    triangles += skyStats.triangles;
    bufferMemory += skyStats.bufferMemory;
    const sunStats = this.renderSunDisc(viewProjection, cameraState, lighting);
    drawCalls += sunStats.drawCalls;
    triangles += sunStats.triangles;
    bufferMemory += sunStats.bufferMemory;
    const cloudStats = this.cloudLayer
      ? this.renderClouds(this.cloudViewProjection(cameraState), origin, lighting)
      : { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    drawCalls += cloudStats.drawCalls;
    triangles += cloudStats.triangles;
    bufferMemory += cloudStats.bufferMemory;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, viewProjection);
    gl.uniform1f(this.uniforms.uTileScale, 1.0);
    gl.uniform1f(this.uniforms.uOpacity, 1.0);
    applyLightingUniforms(gl, this.uniforms, lighting);
    gl.uniform1f(this.uniforms.uTime, frameTime * 0.001);
    gl.uniform1f(this.uniforms.uUnderwater, this.underwaterBlend);
    gl.uniform3f(this.uniforms.uCameraLocalEye,cameraState.localOffsetX||0,cameraState.localOffsetY||0,cameraState.localOffsetZ||0);
    gl.uniform1f(this.uniforms.uCaveAmbientFloor,lighting.caveAmbientFloor??0.12);
    gl.uniform3f(this.uniforms.uLocalLightColor,...(lighting.localLightColor??[1.0,0.72,0.42]));
    if (this.options.waterEffects) {
      const water = waterPrecisionUniforms(origin);
      gl.uniform2f(this.uniforms.uWaterOriginPhase, ...water.originPhase);
      gl.uniform2iv(this.uniforms.uWaterCellOrigin, water.cellOrigins);
      gl.uniform2fv(this.uniforms.uWaterCellPhase, water.cellPhases);
    }
    this.textureArray.bind(0);

    if(this.solidProgram) {
      gl.useProgram(this.solidProgram);
      const uniforms=this.solidUniforms;
      gl.uniformMatrix4fv(uniforms.uViewProjection,false,viewProjection);
      gl.uniform1f(uniforms.uTileScale,1);gl.uniform1f(uniforms.uOpacity,1);
      applyLightingUniforms(gl,uniforms,lighting);
      gl.uniform1f(uniforms.uTime,frameTime*0.001);
      gl.uniform1f(uniforms.uUnderwater,this.underwaterBlend);
      gl.uniform3f(uniforms.uCameraLocalEye,cameraState.localOffsetX||0,cameraState.localOffsetY||0,cameraState.localOffsetZ||0);
      gl.uniform1f(uniforms.uCaveAmbientFloor,lighting.caveAmbientFloor??0.12);
      gl.uniform3f(uniforms.uLocalLightColor,...(lighting.localLightColor??[1.0,0.72,0.42]));
    }
    // CPU visibility is not proof that any terrain has reached the GPU.
    const renderedChunks = worldChunks.filter(chunk=>[this.entryForChunk(chunk),this.entryForChunk(chunk,true)].some(entry=>entry?.handle?.indexCount>0)).length;
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
    const terrainStats=this.renderMeshPass(worldChunks,origin,['opaque','cutout']);
    drawCalls+=terrainStats.drawCalls;triangles+=terrainStats.triangles;
    const visualStats=this.renderMeshPass(worldChunks,origin,['opaque','cutout'],true);
    drawCalls+=visualStats.drawCalls;triangles+=visualStats.triangles;
    const avatarStats=this.renderAvatars(cameraState,avatars,viewProjection,origin,lighting,{opaqueOnly:true});
    drawCalls+=avatarStats.drawCalls;triangles+=avatarStats.triangles;
    if(typeof gl.blendFunc === "function")gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);gl.depthMask(false);
    if (this.options.environmentEffects) {
      for(const visual of [false,true]){const shadowStats=this.renderMeshPass(worldChunks,origin,['shadow'],visual);drawCalls+=shadowStats.drawCalls;triangles+=shadowStats.triangles;}
    }
    gl.disable(gl.BLEND);gl.depthMask(true);
    const projectedShadowStats=this.renderProjectedShadows(avatars,viewProjection,origin,lighting);
    drawCalls+=projectedShadowStats.drawCalls;triangles+=projectedShadowStats.triangles;
    const blendStats=this.renderTransparentScene(cameraState,worldChunks,avatars,viewProjection,origin,lighting,previewChunks);
    drawCalls+=blendStats.drawCalls;triangles+=blendStats.triangles;

    const overlayStats = this.renderVoxelOverlays(viewProjection, origin, overlays);
    drawCalls += overlayStats.drawCalls;
    triangles += overlayStats.triangles;
    bufferMemory += overlayStats.bufferMemory;

    this.stageStats.record("draw-submit-cpu",performance.now()-drawSubmitStartedAt);
    this.stats = {
      backend: "webgl2",
      drawCalls,
      visibleChunks: renderedChunks,
      terrainDrawCalls: terrainStats.drawCalls+visualStats.drawCalls,
      triangles,
      // Count all resident resources, including screen-excluded buffers and shared avatars once.
      bufferMemory: this.resourceLedger.snapshot().bufferBytes,
      ...this.resourceLedger.snapshot(),
      ...(this.gpuTimer?.snapshot() ?? { gpuTimeMs: null, gpuTimerStatus: "disabled", gpuQueriesPending: 0 }),
      cpuDrawSubmitMs: performance.now()-drawSubmitStartedAt,
      uploadDiagnostics: {...this.uploadDiagnostics},
      cpuMeshBytes:this.residentCpuMeshBytes(),
      gpuChunks: this.regionBuffers.size + this.visualRegionBuffers.size + this.chunkBuffers.size + this.visualChunkBuffers.size,
      width: this.canvas.width,
      height: this.canvas.height,
      dpr: this.clampedDpr(),
      underwater: underwater || this.underwaterBlend >= 0.5,
      underwaterBlend: this.underwaterBlend,
    };
    this.gpuTimer?.end();
    this.frustumFilterCache = null;
    return this.stats;
  }

  renderClouds(viewProjection, origin, lighting) {
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0};
    const gl = this.gl;
    if (!this.cloudLayer) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const stats = this.cloudLayer.render({ viewProjection, cameraOrigin: origin, lighting });
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    return stats;
  }

  cloudViewProjection(cameraState) {
    const far = Math.max(
      Number(cameraState?.far) || 0,
      Number(this.options.cloudRadius) + Number(this.options.cloudFarPadding),
    );
    return cameraViewProjection({ ...cameraState, far });
  }

  renderSkyGradient(cameraState, lighting) {
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0};
    const gl = this.gl;
    if (!this.skyGradient) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    const stats = this.skyGradient.render({ cameraState, lighting });
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    return stats;
  }

  renderSunDisc(viewProjection, cameraState, lighting) {
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0};
    const gl = this.gl;
    if (!this.sunDisc || !lighting?.sunDiscOpacity) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const stats = this.sunDisc.render({ viewProjection, cameraState, lighting });
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    return stats;
  }

  renderMeshPass(chunks, origin, passes, visual=false) {
    const gl=this.gl;if(!gl || gl.isContextLost?.() || !this.program || this.contextLost || this.disposed)return {drawCalls:0,triangles:0,bufferMemory:0};
    const uniforms=this.solidUniforms??this.uniforms;
    gl.useProgram(this.solidProgram??this.program);gl.uniform1f(uniforms.uOpacity,1);this.textureArray?.bind(0);
    let drawCalls=0,triangles=0;
    for(const chunk of chunks){const entry=this.entryForChunk(chunk,visual);if(!entry?.handle)continue;
      const handle=entry.handle;gl.uniform3f(uniforms.uChunkOrigin,chunk.chunkX*chunk.chunkSize-origin.worldX,entry.originY-origin.worldY,chunk.chunkZ*chunk.chunkSize-origin.worldZ);gl.bindVertexArray(handle.vao);
      for(const pass of passes){const range=handle.drawRanges?.[pass] ?? (pass==='opaque'?{offset:0,count:handle.indexCount}:null);if(!range?.count)continue;
        if(uniforms.uSurfacePass)gl.uniform1f(uniforms.uSurfacePass,pass==='cutout'?1:0);
        gl.drawElements(gl.TRIANGLES,range.count,handle.indexType,range.offset*(handle.indexBytes??2));drawCalls++;triangles+=range.count/3;}
    }gl.bindVertexArray(null);return {drawCalls,triangles,bufferMemory:0};
  }
  renderVisualChunks(chunks, origin) {return this.renderMeshPass(chunks,origin,['opaque','cutout'],true);}

  renderTransparentScene(camera, chunks, avatars, vp, origin, lighting, previews=[]) {
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0};
    const gl=this.gl,queue=[];const forward=cameraForward(camera);
    const eye=[camera.localOffsetX||0,camera.localOffsetY||0,camera.localOffsetZ||0];
    const add=(item,center)=>{item.key=`${item.kind}:${item.entry?.id??item.avatar?.id??item.particle?.id??""}:${item.unit?.offset??item.range?.offset??0}`;item.depth=(center[0]-eye[0])*forward[0]+(center[1]-eye[1])*forward[1]+(center[2]-eye[2])*forward[2];item.order=queue.length;queue.push(item);};
    for(const chunk of [...chunks,...previews])for(const visual of [false,true]){const entry=this.entryForChunk(chunk,visual);if(!entry?.handle)continue;
      const offset=[chunk.chunkX*chunk.chunkSize-origin.worldX,entry.originY-origin.worldY,chunk.chunkZ*chunk.chunkSize-origin.worldZ];
      const preview=chunk.buildingPreview===true;
      for(const unit of entry.handle.blendUnits??[]){if(unit.pass!=="blend")continue;add({kind:'terrain',entry,unit,offset,opacity:preview?0.46:1},unit.center.map((v,k)=>v+offset[k]));}
      if(preview)for(const pass of ['opaque','cutout']){const range=entry.handle.drawRanges?.[pass];if(range?.count)add({kind:'terrain',entry,unit:range,offset,opacity:0.46},offset);}
    }
    for(const avatar of avatars){const entry=this.avatarBuffers.get(String(avatar.meshId||avatar.id));if(!entry?.handle)continue;
      const opacity=Math.max(0,Math.min(1,Number(avatar.opacity??1)||0));
      if(opacity<=0.001)continue;
      const snapshot=this.avatarFrameState(avatar,entry);
      const offset=[(avatar.worldX||0)+(avatar.localOffsetX||0)-origin.worldX,(avatar.worldY||0)+(avatar.localOffsetY||0)-origin.worldY,(avatar.worldZ||0)+(avatar.localOffsetZ||0)-origin.worldZ];
      const yaw=avatar.yaw||0,c=Math.cos(yaw),s=Math.sin(yaw);
      for(let i=0;i<entry.mesh.indices.length;i+=3){const ids=[entry.mesh.indices[i],entry.mesh.indices[i+1],entry.mesh.indices[i+2]],stride=(entry.mesh.vertexStrideBytes||40)/4;
        if(opacity>=0.999 && !ids.some(id=>snapshot.vertices[id*stride+9]<0.999 || (stride>=14&&snapshot.vertices[id*stride+13]>0.5)))continue;
        const center=[0,0,0];for(const id of ids){const o=id*stride;center[0]+=(c*snapshot.vertices[o]+s*snapshot.vertices[o+2])/3;center[1]+=snapshot.vertices[o+1]/3;center[2]+=(-s*snapshot.vertices[o]+c*snapshot.vertices[o+2])/3;}
        add({kind:'avatar',avatar,snapshot,range:{offset:i,count:3}},center.map((v,k)=>v+offset[k]));
      }
    }
    for(const particle of this.voxelParticles?.particles??[])add({kind:'particle',particle},[particle.x-origin.worldX,particle.y-origin.worldY,particle.z-origin.worldZ]);
    if(!queue.length)return {drawCalls:0,triangles:0,bufferMemory:0};
    queue.sort((a,b)=>b.depth-a.depth||a.key.localeCompare(b.key)||a.order-b.order);
    gl.enable(gl.DEPTH_TEST);gl.depthMask(false);gl.enable(gl.CULL_FACE);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    let drawCalls=0,triangles=0;
    let terrainActive = false, boundHandle = null, boundOffset = null, boundOpacity = null;
    const sameOffset = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      if (item.kind === 'terrain') {
        const { entry, unit, offset, opacity } = item;
        // Only merge adjacent ranges in the already sorted queue. Never reorder
        // triangles or cross an intervening avatar, particle, preview or origin.
        let count = unit.count;
        while (index + 1 < queue.length) {
          const next = queue[index + 1];
          if (next.kind !== 'terrain' || next.entry.handle !== entry.handle || next.opacity !== opacity
            || !sameOffset(next.offset, offset) || next.unit.offset !== unit.offset + count) break;
          count += next.unit.count;
          index++;
        }
        if (!terrainActive) {
          gl.useProgram(this.program);
          gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, vp);
          applyLightingUniforms(gl, this.uniforms, lighting);
          gl.uniform1f(this.uniforms.uSurfacePass, 0);
          this.textureArray?.bind(0);
          terrainActive = true; boundHandle = null; boundOffset = null; boundOpacity = null;
        }
        if (boundOpacity !== opacity) { gl.uniform1f(this.uniforms.uOpacity, opacity); boundOpacity = opacity; }
        if (!sameOffset(boundOffset, offset)) { gl.uniform3f(this.uniforms.uChunkOrigin, ...offset); boundOffset = offset; }
        if (boundHandle !== entry.handle) { gl.bindVertexArray(entry.handle.vao); boundHandle = entry.handle; }
        gl.drawElements(gl.TRIANGLES, count, entry.handle.indexType, unit.offset * (entry.handle.indexBytes ?? 2));
        drawCalls++; triangles += count / 3;
      } else {
        const stats = item.kind === 'avatar'
          ? this.renderAvatars(camera, [item.avatar], vp, origin, lighting, { transparentOnly: true, drawRange: item.range, vertexSnapshot: item.snapshot })
          : this.voxelParticles.render({ viewProjection: vp, origin, lighting, textureArray: this.textureArray, particles: [item.particle] });
        drawCalls += stats.drawCalls; triangles += stats.triangles;
        terrainActive = false;
        // Auxiliary helpers restore their own state; the queue owns blending.
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      }
    }
    gl.bindVertexArray(null);gl.depthMask(true);gl.disable(gl.BLEND);gl.enable(gl.CULL_FACE);return {drawCalls,triangles,bufferMemory:0};
  }

  renderBuildingPreviewChunks(visibleChunks, origin, opacity = 0.46) {
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0,renderedChunks:0};
    if (!visibleChunks?.length || !this.program) return { drawCalls: 0, triangles: 0, bufferMemory: 0, renderedChunks: 0 };
    const gl = this.gl;
    const alpha = Math.min(0.85, Math.max(0.08, Number(opacity) || 0.46));
    const logDraw = Boolean(this.renderLogger?.enabled);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.uOpacity, alpha);
    gl.uniform1f(this.uniforms.uSurfacePass,0);
    this.textureArray.bind(0);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    let drawCalls = 0;
    let triangles = 0;
    let bufferMemory = 0;
    const renderedChunkIds = new Set();
    const drawMeshes = (meshField, buffers, meshType) => {
      for (const chunk of visibleChunks) {
        if (!chunk?.[meshField]?.indexCount) continue;
        const entry = buffers.get(chunk.id);
        if (!entry?.handle) continue;
        const handle = entry.handle;
        gl.uniform3f(
          this.uniforms.uChunkOrigin,
          chunk.chunkX * chunk.chunkSize - origin.worldX,
          -origin.worldY,
          chunk.chunkZ * chunk.chunkSize - origin.worldZ,
        );
        gl.bindVertexArray(handle.vao);
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        drawCalls += 1;
        triangles += handle.triangleCount;
        bufferMemory += handle.byteLength;
        renderedChunkIds.add(chunk.id);
        if (logDraw) {
          this.logRenderEvent("chunk-draw", {
            frame: this.renderFrameId,
            chunkId: chunk.id,
            chunkX: chunk.chunkX,
            chunkZ: chunk.chunkZ,
            meshType,
            triangles: handle.triangleCount,
            bytes: handle.byteLength,
          });
        }
      }
    };
    drawMeshes("mesh", this.chunkBuffers, "building-preview");
    drawMeshes("visualMesh", this.visualChunkBuffers, "building-preview-visual");

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1f(this.uniforms.uOpacity, 1.0);
    return { drawCalls, triangles, bufferMemory, renderedChunks: renderedChunkIds.size };
  }

  renderVoxelOverlays(viewProjection, origin, overlays = []) {
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0};
    if (!this.voxelOverlay) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    return this.voxelOverlay.render({ viewProjection, origin, overlays });
  }

  renderVoxelParticles(viewProjection, origin, lighting = this.lighting) {
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0};
    const gl = this.gl;
    if (!this.voxelParticles || !this.voxelParticles.particles?.length) {
      return { drawCalls: 0, triangles: 0, bufferMemory: this.voxelParticles?.byteLength ?? 0 };
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const stats = this.voxelParticles.render({ viewProjection, origin, lighting, textureArray: this.textureArray });
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    return stats;
  }

  avatarFrameState(avatar,entry){
    this.avatarFrameStates ??= new Map();
    let snapshot=this.avatarFrameStates.get(avatar);
    if(!snapshot||snapshot.mesh!==entry.mesh){snapshot={mesh:entry.mesh,vertices:entry.mesh?.parts?.length?new Float32Array(updateAvatarMeshVertices(entry.mesh,avatar.animation)):entry.mesh?.vertices};this.avatarFrameStates.set(avatar,snapshot);}
    return snapshot;
  }
  renderAvatars(cameraState, avatars, viewProjection, origin, lighting = this.lighting, { opaqueOnly=false, transparentOnly=false, drawRange=null, vertexSnapshot=null }={}) {
    const gl = this.gl;
    if (this.contextLost||this.disposed||!gl||gl.isContextLost?.()||!avatars.length || !this.avatarProgram) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    gl.useProgram(this.avatarProgram);
    gl.uniformMatrix4fv(this.avatarUniforms.uViewProjection, false, viewProjection);
    gl.uniform1i(this.avatarUniforms.uTextureArray, 0);
    this.textureArray.bind(0);
    applyLightingUniforms(gl, this.avatarUniforms, lighting);
    let drawCalls = 0;
    let triangles = 0;
    let bufferMemory = 0;
    let transparentPass = false;
    const setTransparentPass = (transparent) => {
      if (transparent === transparentPass) return;
      transparentPass = transparent;
      if (transparent) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
    };
    for (const avatar of avatars) {
      const entry = this.avatarBuffers.get(String(avatar.meshId || avatar.id));
      if (!entry?.handle) continue;
      const handle = entry.handle;
      const snapshot=vertexSnapshot??this.avatarFrameState(avatar,entry);
      if (entry.mesh?.parts?.length && handle.animationSnapshot!==snapshot) {
        gl.bindBuffer(gl.ARRAY_BUFFER, handle.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, snapshot.vertices);
        handle.animationSnapshot=snapshot;
      }
      const worldX = Math.trunc(avatar.worldX || 0) + (avatar.localOffsetX || 0);
      const worldY = Math.trunc(avatar.worldY || 0) + (avatar.localOffsetY || 0);
      const worldZ = Math.trunc(avatar.worldZ || 0) + (avatar.localOffsetZ || 0);
      gl.uniform3f(
        this.avatarUniforms.uAvatarOrigin,
        worldX - origin.worldX,
        worldY - origin.worldY,
        worldZ - origin.worldZ,
      );
      gl.uniform1f(this.avatarUniforms.uAvatarYaw, avatar.yaw || 0);
      const opacity = Math.max(0, Math.min(1, Number(avatar.opacity ?? 1) || 0));
      if(opacity<=0.001)continue;
      gl.uniform1f(this.avatarUniforms.uAvatarOpacity, opacity);
      gl.bindVertexArray(handle.vao);
      if(drawRange){
        setTransparentPass(true);gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass,opacity<0.999?0:2);
        gl.drawElements(gl.TRIANGLES,drawRange.count,handle.indexType,drawRange.offset*(entry.mesh.indices.BYTES_PER_ELEMENT||2));drawCalls++;triangles+=drawRange.count/3;continue;
      }
      if (opacity < 0.999 && opaqueOnly) continue;
      if (transparentOnly && opacity >= 0.999 && !avatarHoldsTransparentBlock(avatar.animation)) continue;
      if (opacity < 0.999) {
        setTransparentPass(true);
        gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, 0);
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        drawCalls += 1;
        triangles += handle.triangleCount;
      } else if (opaqueOnly || avatarHoldsTransparentBlock(avatar.animation)) {
        if (!transparentOnly) {
        setTransparentPass(false);
        gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, 1);
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        drawCalls += 1; triangles += handle.triangleCount;
        }
        if (!opaqueOnly) {
        setTransparentPass(true);
        gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, 2);
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        drawCalls += 1; triangles += handle.triangleCount;
        }
      } else {
        setTransparentPass(false);
        gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, 0);
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        drawCalls += 1;
        triangles += handle.triangleCount;
      }
      bufferMemory += handle.byteLength;
    }
    if (transparentPass) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
    return { drawCalls, triangles, bufferMemory };
  }

  renderProjectedShadows(avatars, viewProjection, origin, lighting = this.lighting) {
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0};
    const gl = this.gl;
    if (!this.projectedShadowLayer || !avatars?.length) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const stats = this.projectedShadowLayer.render({ viewProjection, origin, lighting, casters: avatars });
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    return stats;
  }

  attachContextListeners() {
    if (this._contextListenersAttached) return;
    let contextLostAttached = false;
    try {
      this.canvas.addEventListener("webglcontextlost", this._onContextLost, false);
      contextLostAttached = true;
      this.canvas.addEventListener("webglcontextrestored", this._onContextRestored, false);
      this._contextListenersAttached = true;
    } catch (error) {
      if (contextLostAttached) {
        try {
          this.canvas.removeEventListener("webglcontextlost", this._onContextLost, false);
        } catch {
          // Preserve the listener installation error; cleanup is best effort.
        }
      }
      throw error;
    }
  }

  detachContextListeners() {
    if (!this._contextListenersAttached) return;
    try {
      this.canvas.removeEventListener("webglcontextlost", this._onContextLost, false);
    } catch {
      // Continue removing the remaining listener and resetting ownership state.
    }
    try {
      this.canvas.removeEventListener("webglcontextrestored", this._onContextRestored, false);
    } catch {
      // Listener cleanup is best effort during rollback and disposal.
    }
    this._contextListenersAttached = false;
  }

  releaseContextResources() {
    const safely = (callback) => {
      try {
        callback();
      } catch {
        // A failed delete must not prevent the rest of the owned resources from being released.
      }
    };
    for(const staging of this.uploadStaging.values())safely(()=>this.bufferManager?.disposeChunkBuffers(staging.transaction.handle));this.uploadStaging.clear();
    for (const entry of this.chunkBuffers.values()) safely(() => this.bufferManager?.disposeChunkBuffers(entry.handle));
    this.chunkBuffers.clear();
    for (const entry of this.visualChunkBuffers.values()) safely(() => this.bufferManager?.disposeChunkBuffers(entry.handle));
    this.visualChunkBuffers.clear();
    for (const entry of this.regionBuffers.values()) for (const member of entry.members?.values() ?? []) safely(() => this.bufferManager?.disposeChunkBuffers(member.handle));
    this.regionBuffers.clear();
    for (const entry of this.visualRegionBuffers.values()) for (const member of entry.members?.values() ?? []) safely(() => this.bufferManager?.disposeChunkBuffers(member.handle));
    this.visualRegionBuffers.clear();
    for (const entry of this.avatarBuffers.values()) safely(() => this.disposeAvatarBuffers(entry.handle));
    this.avatarBuffers.clear();
    this.avatarResourceCache=new WeakMap();this.cpuMeshBytesDirty=true;
    this.regionGroupCache.clear();
    this.frustumFilterCache = null;
    safely(() => this.cloudLayer?.dispose());
    this.cloudLayer = null;
    safely(() => this.skyGradient?.dispose());
    this.skyGradient = null;
    safely(() => this.sunDisc?.dispose());
    this.sunDisc = null;
    safely(() => this.projectedShadowLayer?.dispose());
    this.projectedShadowLayer = null;
    safely(() => this.voxelOverlay?.dispose());
    this.voxelOverlay = null;
    safely(() => this.voxelParticles?.dispose());
    this.voxelParticles = null;
    safely(() => this.textureArray?.dispose());
    if (this.program && this.gl) safely(() => this.gl.deleteProgram(this.program));
    if (this.solidProgram && this.gl) safely(() => this.gl.deleteProgram(this.solidProgram));
    if (this.avatarProgram && this.gl) safely(() => this.gl.deleteProgram(this.avatarProgram));
    safely(() => this.gpuTimer?.dispose({lost:this.contextLost})); this.gpuTimer=null;
    this.resourceLedger.reset(this.contextGeneration);
    this.gl = null;
    this.program = null;
    this.solidProgram = null;
    this.solidUniforms = null;
    this.avatarProgram = null;
    this.uniforms = null;
    this.avatarUniforms = null;
    this.bufferManager = null;
    this.textureArray = null;
    this.initialized = false;
    this.stats = emptyStats();
  }

  dispose() {
    if(this.disposed)return;
    this.disposed=true;
    this.releaseContextResources();
    this.avatarMeshes.clear(); this.retryUploads.clear(); this.pendingUploadSince.clear();this.pendingMeshSources.clear();this.avatarFrameStates.clear();
    this.detachContextListeners();
  }

  createAvatarBuffers(mesh) {
    const gl = this.gl;
    assertGpuUpload(gl,"before avatar upload");
    let vao=null,vbo=null,ibo=null;
    try {
    vao=gl.createVertexArray();if(!vao)throw new Error("WebGL avatar VAO allocation returned null");
    vbo=gl.createBuffer();if(!vbo)throw new Error("WebGL avatar VBO allocation returned null");
    ibo=gl.createBuffer();if(!ibo)throw new Error("WebGL avatar IBO allocation returned null");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, mesh.parts?.length ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    const stride = mesh.vertexStrideBytes || 40;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
    if (stride >= 52) {
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 40);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 48);
    } else {
      gl.disableVertexAttribArray(3);
      gl.vertexAttrib2f(3, 0, 0);
      gl.disableVertexAttribArray(4);
      gl.vertexAttrib1f(4, -1);
    }
    if (stride >= 56) {
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 52);
    } else {
      gl.disableVertexAttribArray(5);
      gl.vertexAttrib1f(5, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    assertGpuUpload(gl,"avatar upload");
    return {
      vao,
      vbo,
      ibo,
      indexCount: mesh.indexCount,
      indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      triangleCount: mesh.triangleCount,
      byteLength: mesh.vertices.byteLength + mesh.indices.byteLength,
    };
    } catch(error) {this.disposeAvatarBuffers({vao,vbo,ibo});throw error;}
    finally {gl.bindVertexArray(null);}
  }

  disposeAvatarBuffers(handle) {
    const gl = this.gl;
    if (!handle || !gl) return;
    if(handle.avatarRefs!==undefined){handle.avatarRefs--;if(handle.avatarRefs>0)return;}
    if(handle.vbo)gl.deleteBuffer(handle.vbo);
    if(handle.ibo)gl.deleteBuffer(handle.ibo);
    if(handle.vao)gl.deleteVertexArray(handle.vao);
  }
}

export function detectWebGl2Support() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
    if (!gl) return { supported: false, reason: "webgl2-missing", label: "WebGL2 is not available in this browser." };
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      supported: true,
      renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : "unknown",
      vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : "unknown",
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
      maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    };
  } catch (error) {
    return { supported: false, reason: "webgl2-error", label: error?.message || "WebGL2 detection failed.", error };
  }
}

export function cameraIsInsideFluid(cameraState = {}, visibleChunks = []) {
  if (typeof cameraState?.underwater === "boolean") return cameraState.underwater;
  const worldX = Math.floor((Number(cameraState?.worldX) || 0) + (Number(cameraState?.localOffsetX) || 0));
  const worldY = Math.floor((Number(cameraState?.worldY) || 0) + (Number(cameraState?.localOffsetY) || 0));
  const worldZ = Math.floor((Number(cameraState?.worldZ) || 0) + (Number(cameraState?.localOffsetZ) || 0));
  for (const chunk of visibleChunks ?? []) {
    if (!chunk || chunk.buildingPreview === true || typeof chunk.getFinalBlock !== "function") continue;
    const size = Math.max(1, Math.trunc(Number(chunk.chunkSize) || 0));
    const chunkX = Math.trunc(Number(chunk.chunkX));
    const chunkZ = Math.trunc(Number(chunk.chunkZ));
    if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) continue;
    if (Math.floor(worldX / size) !== chunkX || Math.floor(worldZ / size) !== chunkZ) continue;
    const minY = Math.trunc(Number(chunk.minY) || 0);
    const height = Math.max(0, Math.trunc(Number(chunk.height) || 0));
    if (worldY < minY || worldY >= minY + height) return false;
    const localX = worldX - chunkX * size;
    const localZ = worldZ - chunkZ * size;
    const blockId = chunk.getFinalBlock(localX, worldY, localZ);
    return blockId === BLOCK_ID.water || blockId === BLOCK_ID.swampWater || blockId === BLOCK_ID.toxicWater;
  }
  return false;
}

export function advanceUnderwaterBlend(current, underwater, elapsedMs) {
  const value = Math.max(0, Math.min(1, Number(current) || 0));
  const target = underwater ? 1 : 0;
  const elapsed = Math.max(0, Math.min(250, Number(elapsedMs) || 0)) / 1000;
  if (elapsed <= 0 || value === target) return value;
  const rate = target > value ? UNDERWATER_ENTER_RATE : UNDERWATER_EXIT_RATE;
  const next = target + (value - target) * Math.exp(-rate * elapsed);
  return Math.abs(next - target) < 0.001 ? target : next;
}

function collectUniforms(gl, program) {
  const names = [
    "uViewProjection",
    "uChunkOrigin",
    "uCameraLocalEye",
    "uWaterOriginPhase",
    "uWaterCellOrigin[0]",
    "uWaterCellPhase[0]",
    "uSurfacePass",
    "uCaveAmbientFloor",
    "uLocalLightColor",
    "uTileScale",
    "uTextureArray",
    "uSunDirection",
    "uSunColor",
    "uSkyLightColor",
    "uGroundLightColor",
    "uLightParams",
    "uTime",
    "uOpacity",
    "uUnderwater",
  ];
  const uniforms = {};
  for (const name of names) uniforms[name.replace("[0]", "")] = gl.getUniformLocation(program, name);
  return uniforms;
}

function collectAvatarUniforms(gl, program) {
  const names = [
    "uViewProjection",
    "uAvatarOrigin",
    "uAvatarYaw",
    "uAvatarOpacity",
    "uAvatarSurfacePass",
    "uTextureArray",
    "uSunDirection",
    "uSunColor",
    "uSkyLightColor",
    "uGroundLightColor",
    "uLightParams",
  ];
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}

function committedMeshVersion(chunk, visual = false) {
  const value = visual ? chunk?.visualMeshVersion : chunk?.meshVersion;
  if (Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return Math.trunc(Number(chunk?.version) || 0);
}

function retireCommittedEmptyChunkBuffers(renderer, chunks) {
  for (const chunk of chunks) {
    if (!chunk) continue;
    retire(false);
    retire(true);

    function retire(visual) {
      const mesh = visual ? chunk?.visualMesh : chunk?.mesh;
      const revision = committedMeshVersion(chunk, visual);
      if (revision < 0 || mesh?.indexCount) return;
      const buffers = visual ? renderer.visualChunkBuffers : renderer.chunkBuffers;
      const regions=visual?renderer.visualRegionBuffers:renderer.regionBuffers;
      const region=regions.get(regionIdForChunk(chunk,renderer.options.regionChunkSize));
      const member=region?.members?.get(chunk.id);
      if(member){renderer.bufferManager?.disposeChunkBuffers(member.handle);region.members.delete(chunk.id);region.chunkIds.delete(chunk.id);if(!region.members.size)regions.delete(region.id);}
      const existing = buffers.get(chunk.id);
      if (!existing) return;
      renderer.bufferManager?.disposeChunkBuffers(existing.handle);
      buffers.delete(chunk.id);
      if (visual) chunk.visualGpuUploaded = false;
      else chunk.gpuUploaded = false;
    }
  }
}

function regionGroupCacheKey(chunks, regionChunkSize = 4, meshField = "mesh") {
  const size = Math.max(1, Math.trunc(regionChunkSize || 1));
  const parts = [meshField, size];
  for (const chunk of chunks) {
    if (!regionBatchEligible(chunk)) continue;
    const mesh = chunk?.[meshField];
    if (!mesh?.indexCount) continue;
    parts.push(chunk.id, meshIdentity(chunk, meshField === "visualMesh"));
  }
  return parts.join("|");
}

function groupChunksByRegion(chunks, regionChunkSize = 4, meshField = "mesh") {
  const size = Math.max(1, Math.trunc(regionChunkSize || 1));
  const regions = new Map();
  let order = 0;
  for (const chunk of chunks) {
    if (!regionBatchEligible(chunk)) continue;
    if (!chunk?.[meshField]?.indexCount) continue;
    const regionX = divFloor(chunk.chunkX, size);
    const regionZ = divFloor(chunk.chunkZ, size);
    const id = `${regionX},${regionZ}`;
    let region = regions.get(id);
    if (!region) {
      region = {
        id,
        regionX,
        regionZ,
        regionChunkSize: size,
        originChunkX: regionX * size,
        originChunkZ: regionZ * size,
        chunkSize: chunk.chunkSize,
        meshField,
        order,
        chunks: [],
      };
      regions.set(id, region);
    }
    region.order = Math.min(region.order, order);
    region.chunks.push(chunk);
    order += 1;
  }
  const out = Array.from(regions.values());
  for (const region of out) region.chunks.sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
  out.sort((a, b) => a.order - b.order || a.regionZ - b.regionZ || a.regionX - b.regionX);
  return out;
}

function regionIdForChunk(chunk, regionChunkSize = 4) {
  const size = Math.max(1, Math.trunc(regionChunkSize || 1));
  return `${divFloor(chunk.chunkX, size)},${divFloor(chunk.chunkZ, size)}`;
}

function regionBatchEligible(chunk) {
  return chunk?.regionBatchEligible !== false && chunk?.parentId == null && chunk?.parentChunkId == null && chunk?.originY == null;
}

function filterChunksByRenderRadius(chunks, cameraState, viewDistance) {
  const list = Array.isArray(chunks) ? chunks : Array.from(chunks ?? []);
  const limit = Math.trunc(Number(viewDistance) || 0);
  if (!limit || !list.length) return list;
  const chunkSize = list[0]?.chunkSize || 16;
  const center = renderCenterChunk(cameraState, chunkSize);
  let filtered = null;
  for (let index = 0; index < list.length; index += 1) {
    const chunk = list[index];
    const visible = Math.max(Math.abs(chunk.chunkX - center.chunkX), Math.abs(chunk.chunkZ - center.chunkZ)) <= limit;
    if (!filtered && visible) continue;
    if (!filtered) filtered = list.slice(0, index);
    if (visible) filtered.push(chunk);
  }
  return filtered ?? list;
}

function captureFrustumCamera(cameraState = {}) {
  const camera = cameraState ?? {};
  return {
    worldX: camera.worldX,
    worldY: camera.worldY,
    worldZ: camera.worldZ,
    localOffsetX: camera.localOffsetX,
    localOffsetY: camera.localOffsetY,
    localOffsetZ: camera.localOffsetZ,
    targetWorldX: camera.targetWorldX,
    targetWorldY: camera.targetWorldY,
    targetWorldZ: camera.targetWorldZ,
    targetLocalOffsetX: camera.targetLocalOffsetX,
    targetLocalOffsetY: camera.targetLocalOffsetY,
    targetLocalOffsetZ: camera.targetLocalOffsetZ,
    yaw: camera.yaw,
    pitch: camera.pitch,
    fov: camera.fov,
    aspect: camera.aspect,
    near: camera.near,
    far: camera.far,
  };
}

function sameFrustumCamera(left, right = {}) {
  const camera = right ?? {};
  return Boolean(left)
    && left.worldX === camera.worldX
    && left.worldY === camera.worldY
    && left.worldZ === camera.worldZ
    && left.localOffsetX === camera.localOffsetX
    && left.localOffsetY === camera.localOffsetY
    && left.localOffsetZ === camera.localOffsetZ
    && left.targetWorldX === camera.targetWorldX
    && left.targetWorldY === camera.targetWorldY
    && left.targetWorldZ === camera.targetWorldZ
    && left.targetLocalOffsetX === camera.targetLocalOffsetX
    && left.targetLocalOffsetY === camera.targetLocalOffsetY
    && left.targetLocalOffsetZ === camera.targetLocalOffsetZ
    && left.yaw === camera.yaw
    && left.pitch === camera.pitch
    && left.fov === camera.fov
    && left.aspect === camera.aspect
    && left.near === camera.near
    && left.far === camera.far;
}

function renderCenterChunk(cameraState, chunkSize) {
  const size = Math.max(1, Math.trunc(chunkSize || 16));
  if (Number.isFinite(cameraState?.targetWorldX) && Number.isFinite(cameraState?.targetWorldZ)) {
    const x = Math.trunc(cameraState.targetWorldX || 0) + (cameraState.targetLocalOffsetX || 0);
    const z = Math.trunc(cameraState.targetWorldZ || 0) + (cameraState.targetLocalOffsetZ || 0);
    return { chunkX: Math.floor(x / size), chunkZ: Math.floor(z / size) };
  }
  const x = Math.trunc(cameraState?.worldX || 0) + (cameraState?.localOffsetX || 0);
  const z = Math.trunc(cameraState?.worldZ || 0) + (cameraState?.localOffsetZ || 0);
  return { chunkX: Math.floor(x / size), chunkZ: Math.floor(z / size) };
}

function divFloor(value, divisor) {
  return Math.floor(Math.trunc(value) / Math.trunc(divisor));
}

function webGlContextDetails(gl) {
  if (!gl) return { available: false };
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    available: true,
    version: gl.getParameter(gl.VERSION),
    shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  };
}

function restoreCanvasDimensions(canvas, dimensions) {
  try {
    if (canvas.width !== dimensions.width) canvas.width = dimensions.width;
  } catch {
    // Preserve the initialization error; DOM restoration is best effort.
  }
  try {
    if (canvas.height !== dimensions.height) canvas.height = dimensions.height;
  } catch {
    // Preserve the initialization error; DOM restoration is best effort.
  }
}

function defaultUploadBudget() {
  return isCoarsePointer() ? 3 : 8;
}

function isCoarsePointer() {
  return globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
}

function emptyStats() {
  return { backend: "webgl2", drawCalls: 0, visibleChunks: 0, triangles: 0, bufferMemory: 0, gpuChunks: 0, width: 0, height: 0, dpr: 1, underwater: false, underwaterBlend: 0 };
}

const gpuObjectTokens=new WeakMap();let nextGpuObjectToken=1;
function objectToken(object){if(!object||typeof object!=="object")return 0;if(!gpuObjectTokens.has(object))gpuObjectTokens.set(object,nextGpuObjectToken++);return gpuObjectTokens.get(object);}
function meshIdentity(chunk, visual=false){const mesh=chunk?.[visual?"visualMesh":"mesh"];return `${objectToken(chunk)}:${chunk?.generation??0}:${committedMeshVersion(chunk,visual)}:${visual?chunk?.visualCommitToken??0:chunk?.meshCommitToken??0}:${objectToken(mesh)}:${objectToken(mesh?.vertices)}:${objectToken(mesh?.indices)}`;}
export function flattenRenderSections(chunks){const out=[];for(const chunk of chunks??[]){if(chunk?.renderSections instanceof Map && chunk.renderSections.size){for(const section of chunk.renderSections.values()){if(section.parentId==null)section.parentId=chunk.id;out.push(section);}}else out.push(chunk);}return out;}
