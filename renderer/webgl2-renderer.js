import { DEFAULT_VIEW_DISTANCE, MAX_DESKTOP_DPR, MAX_MOBILE_DPR } from "../core/constants.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { cameraForward, cameraOrigin, cameraViewProjection } from "./camera.js";
import { filterChunksByCameraFrustum, cameraRenderCenterChunk, prepareCameraFrustum, chunkIntersectsCameraFrustum } from "./frustum.js";
import { avatarHoldsTransparentBlock, updateAvatarMeshVertices } from "./avatar-mesh.js";
import { BufferManager } from "./buffer-manager.js";
import { SortedIndexStream, configureAvatarVertexArray } from "./sorted-index-stream.js";
import { selectVisibleAvatars } from "./avatar-visibility.js";
import { RenderFrameInputs } from "./render-frame-inputs.js";
import { AsyncGpuTimer, GpuResourceLedger, instrumentGl, assertGpuUpload } from "./gpu-diagnostics.js";
import { waterPrecisionUniforms } from "./water-precision.js";
import { RenderStageStats } from "../debug/stats.js";
import { CloudLayer } from "./cloud-layer.js";
import { applyLightingUniforms, createUnderwaterLighting, createWorldLighting } from "./lighting.js";
import { createProgram, FAST_FLUID_FRAGMENT_SHADER, OPAQUE_FRAGMENT_SHADER, SOLID_FRAGMENT_SHADER, OPAQUE_VERTEX_SHADER, shaderForShadowPolicy } from "./shader-manager.js";
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
      shadows: options.shadows ?? true,
      multiDraw: options.multiDraw ?? true,
      sharedChunkBuffers: options.sharedChunkBuffers ?? false,
      maxSharedChunkBufferBytes: options.maxSharedChunkBufferBytes ?? 32 * 1024 * 1024,
      gpuTiming: options.gpuTiming ?? true,
      deferredChunkUploads: options.deferredChunkUploads ?? false,
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
      maxPrefetchGpuBytes: options.maxPrefetchGpuBytes ?? 32 * 1024 * 1024,
      maxPrefetchUploadsPerFrame: options.maxPrefetchUploadsPerFrame ?? 2,
      prefetchIntervalMs: options.prefetchIntervalMs ?? 100,
      prefetchWithFrameInFlight: options.prefetchWithFrameInFlight ?? false,
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
    this.dynamicUploadStages = [];
    this.uploadValidationFence = null;
    this.frameCompletionFences = [];
    this.lastUploadAttemptBytes=0;
    this.resourceLedger = new GpuResourceLedger();
    this.gpuTimer = null;
    this.stageStats=new RenderStageStats();
    this.cpuMeshBytesDirty=true;
    this.cachedCpuMeshBytes=0;
    this.uploadDiagnostics = { failed: 0, bytes: 0, cpuMs: 0, oldestPendingMs: 0 };
    this.pendingUploadSince = new Map();
    this.uploadWaitFrames = new Map();
    this.pendingMeshSources = new Map();
    this.prefetchQueueVersion = 0;
    this.prefetchQueueCache = null;
    this.observedChunkCommits = new WeakMap();
    this.lastPrefetchAt = -Infinity;
    this.avatarFrameStates = new Map();
    this.avatarInstances = new Map();
    this.visibleAvatars = [];
    this.sortedIndexStream = null;
    this.transparentQueue = [];
    this.transparentItemPool = [];
    this.transparentSegments = [];
    this.transparentSegmentPool = [];
    this.orderedParticles = [];
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
    this.renderFrameInputs = new RenderFrameInputs();
    this.viewportRevision = 0;
    this.observedCanvasSize = null;
    this.canvasResizeObserver = null;
    this.canvasResizeDirty = true;
    this.avatarRestorePrepared = false;
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
    this.releaseAvatarInstances(null, { lost: true });
    this.sortedIndexStream?.dispose({ lost: true }); this.sortedIndexStream = null;
    this.clearFramePools();
    this.bufferManager?.dispose?.({lost:true});
    this.resourceLedger.reset(this.contextGeneration);
    this.chunkBuffers.clear(); this.visualChunkBuffers.clear();
    this.regionBuffers.clear(); this.visualRegionBuffers.clear(); this.avatarBuffers.clear();
    this.regionGroupCache.clear(); this.frustumFilterCache = null;
    this.preparedRenderFrame = null;
    this.renderFrameInputs.clear();
    this.avatarResourceCache = new WeakMap();
    this.retryUploads.clear(); this.uploadStaging.clear();
    this.pendingMeshSources.clear(); this.pendingUploadSince.clear(); this.uploadWaitFrames.clear();
    this.prefetchQueueCache = null;
    this.observedChunkCommits = new WeakMap();
    this.uploadValidationFence = null;
    this.dynamicUploadStages.length = 0;
    this.frameCompletionFences.length = 0;
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
      this.multiDraw = this.options.multiDraw ? gl.getExtension?.("WEBGL_multi_draw") : null;
      this.multiDrawCounts = new Int32Array(32);
      this.multiDrawOffsets = new Int32Array(32);
      this.gpuTimer = this.options.gpuTiming ? new AsyncGpuTimer(gl, { generation: this.contextGeneration }) : null;
      runStage("shader programs", () => {
        const shader=source=>shaderForShadowPolicy(source,this.options.shadows);
        this.program = createProgram(gl, shader(OPAQUE_VERTEX_SHADER),
          shader(this.options.waterEffects ? OPAQUE_FRAGMENT_SHADER : FAST_FLUID_FRAGMENT_SHADER));
        this.solidProgram = createProgram(gl, shader(OPAQUE_VERTEX_SHADER), shader(SOLID_FRAGMENT_SHADER));
        this.avatarProgram = createProgram(gl, AVATAR_VERTEX_SHADER, AVATAR_FRAGMENT_SHADER);
        this.uniforms = collectUniforms(gl, this.program);
        this.solidUniforms = collectUniforms(gl, this.solidProgram);
        this.avatarUniforms = collectAvatarUniforms(gl, this.avatarProgram);
      });
      this.bufferManager = new BufferManager(gl, {shared:this.options.sharedChunkBuffers,maxSharedBytes:this.options.maxSharedChunkBufferBytes,
        canReuseSharedSlices:()=>!this.frameCompletionFences.length&&!this.uploadValidationFence});
      gl.vertexAttribI4i?.(8,0,0,0,0);
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
        if (this.options.shadows) {
          this.projectedShadowLayer = new ProjectedShadowLayer(gl, {
            maxCasters: this.options.maxDynamicShadowCasters ?? 8,
          });
          runStage("projected shadows", () => this.projectedShadowLayer.init());
        }
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
      : (this.canvasResizeObserver && this.observedCanvasSize ? this.observedCanvasSize : this.canvas.getBoundingClientRect?.()) ?? {
          width: this.canvas.clientWidth || 1,
          height: this.canvas.clientHeight || 1,
        };
    const cssWidth = Math.max(1, Math.floor(width ?? rect.width ?? 1));
    const cssHeight = Math.max(1, Math.floor(height ?? rect.height ?? 1));
    this.observedCanvasSize = { width: cssWidth, height: cssHeight };
    this.canvasResizeDirty = false;
    const pixelRatio = this.clampedDpr(dpr);
    const { width: targetWidth, height: targetHeight } = renderResolution(cssWidth, cssHeight, pixelRatio, this.options.maxRenderPixels);
    if (this.canvas.width === targetWidth && this.canvas.height === targetHeight) return false;
    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    gl.viewport(0, 0, targetWidth, targetHeight);
    this.viewportRevision = (this.viewportRevision ?? 0) + 1;
    return true;
  }

  observeCanvasResize() {
    if (this.canvasResizeObserver || !this.options.autoResizeEachFrame || typeof globalThis.ResizeObserver !== 'function') return;
    let observer;
    try {
      observer = new globalThis.ResizeObserver(entries => {
        const rect = entries.find(entry => entry.target === this.canvas)?.contentRect;
        if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
        if (rect.width === this.observedCanvasSize?.width && rect.height === this.observedCanvasSize?.height) return;
        this.observedCanvasSize = { width: rect.width, height: rect.height };
        this.canvasResizeDirty = true;
      });
      observer.observe(this.canvas);
      this.canvasResizeObserver = observer;
    } catch { observer?.disconnect(); }
  }

  prepareViewport(cameraState, prepared = null) {
    this.observeCanvasResize();
    const pixelRatio = this.clampedDpr();
    const unchanged = prepared && !this.canvasResizeDirty && prepared.viewportRevision === this.viewportRevision
      && prepared.width === this.canvas.width && prepared.height === this.canvas.height && prepared.pixelRatio === pixelRatio;
    // Without ResizeObserver, preparation owns the single layout read for this
    // frame. Explicit resize, observed changes and DPR changes still invalidate it.
    if (this.options.autoResizeEachFrame && !unchanged) this.resize(null, null, pixelRatio);
    if (cameraState) cameraState.aspect = Math.max(1, this.canvas.width) / Math.max(1, this.canvas.height);
    return { viewportRevision: this.viewportRevision, width: this.canvas.width, height: this.canvas.height, pixelRatio };
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
    const addMesh=(mesh)=>{if(!mesh||meshes.has(mesh))return;meshes.add(mesh);for(const a of [mesh.vertices,mesh.runtimeVertices,mesh.indices,...meshDrawRangeArrays(mesh)])if(a?.buffer&&!arrays.has(a.buffer)){arrays.add(a.buffer);cpuMeshBytes+=a.buffer.byteLength;}};
    for(const mesh of this.avatarMeshes.values())addMesh(mesh);
    for(const snapshot of this.avatarInstances.values())for(const data of [snapshot.vertices,snapshot.pendingVertices,snapshot.committedVertices])if(data?.buffer&&!arrays.has(data.buffer)){arrays.add(data.buffer);cpuMeshBytes+=data.buffer.byteLength;}
    for(const {chunk,visual}of this.pendingMeshSources.values())addMesh(chunk?.[visual?"visualMesh":"mesh"]);
    for(const groups of this.regionGroupCache.values())for(const group of groups)for(const chunk of group.chunks)addMesh(chunk?.[group.meshField??"mesh"]);
    const addEntry=entry=>{addMesh(entry.mesh);if(entries.length<maxEntries)entries.push({id:entry.id,instanceGeneration:entry.instanceGeneration,worldRevision:entry.source?.version,dataRevision:entry.source?.dataRevision,meshRevision:entry.version,haloRevision:entry.source?.haloRevision,lightRevision:entry.source?.lightRevision,gpuToken:entry.token,contextGeneration:entry.generation,meshReadyAt:entry.meshReadyAt,gpuReadyAt:entry.gpuReadyAt,firstDrawAt:entry.firstDrawAt});};
    for(const map of [this.chunkBuffers,this.visualChunkBuffers])for(const e of map.values())addEntry(e);
    for(const map of [this.regionBuffers,this.visualRegionBuffers])for(const region of map.values())for(const e of region.members?.values()??[])addEntry(e);
    for(const stage of this.uploadStaging.values()){const t=stage.transaction;addMesh(stage.mesh);pendingUploadBytes+=t.vertices.byteLength-t.vertexOffset+t.indices.byteLength-t.indexOffset+(t.origins?t.origins.byteLength-t.originOffset:0);}
    return {...this.resourceLedger.snapshot(),...this.gpuTimer?.snapshot(),...this.bufferManager?.shared?.snapshot(),cpuStages:this.stageStats.snapshot(),cpuTextureTileCache:materialTileCacheStats(),cpuMeshBytes,cpuSortedIndexBytes:this.sortedIndexStream?.capacityBytes??0,sortedIndices:this.sortedIndexStream?.snapshot()??null,pendingUploadBytes,regionCacheEntries:this.regionGroupCache.size,pendingUploads:this.pendingUploadSince.size,uploadStaging:this.uploadStaging.size,dynamicUploadsPending:this.dynamicUploadStages.length,upload:{...this.uploadDiagnostics},entries};
  }

  setRenderLogger(logger) {
    this.renderLogger = logger || null;
  }

  logRenderEvent(type, data = {}) {
    this.renderLogger?.record?.(type, data);
  }

  clearFramePools() {
    for (const name of ['transparentQueue','transparentItemPool','transparentSegments','transparentSegmentPool',
      'orderedParticles','visibleAvatars','pendingFirstDrawEntries']) if (this[name]) this[name].length = 0;
    this.transparentKeyCache = new WeakMap();
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

  deferredUploadsSupported() {
    return this.options.deferredChunkUploads && typeof this.gl?.fenceSync === "function"
      && typeof this.gl?.clientWaitSync === "function" && typeof this.gl?.deleteSync === "function";
  }

  canPrepareFrame() {
    if (!this.gpuReady()) return false;
    // Check readiness before the host does camera visibility, draw-list work or
    // overlays. Physics and authority updates can keep running on every callback.
    // Do not consume GL errors or commit uploads here; prepare owns validation.
    if (this.uploadValidationFence) return this.gl.clientWaitSync(this.uploadValidationFence, 0, 0) !== this.gl.TIMEOUT_EXPIRED;
    if (this.deferredUploadsSupported()) this.pollFrameCompletion();
    return this.frameCompletionFences.length < 2;
  }

  hasUnvalidatedUploads() {
    if (this.dynamicUploadStages.length) return true;
    for(const stage of this.uploadStaging.values())if(stage.awaitingValidation)return true;
    return false;
  }

  queueDynamicUpload(stage) {
    this.dynamicUploadStages.push({...stage,generation:this.contextGeneration});
  }

  pollFrameCompletion() {
    const gl=this.gl;
    while(this.frameCompletionFences.length) {
      const fence=this.frameCompletionFences[0];
      const status=gl.clientWaitSync(fence,0,0);
      if(status===gl.TIMEOUT_EXPIRED)break;
      gl.deleteSync(fence);this.frameCompletionFences.shift();
    }
  }

  fenceSubmittedFrame() {
    if(!this.deferredUploadsSupported())return;
    const fence=this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE,0);
    if(fence){this.frameCompletionFences.push(fence);if(!this.hasUnvalidatedUploads())this.gl.flush();}
  }

  // Wait only by polling with timeout zero. No later draw/upload is submitted
  // behind this fence, so the eventual error check cannot wait on a newer frame.
  // Old committed handles stay visible until the entire upload batch validates.
  settleDeferredUploads() {
    const fence = this.uploadValidationFence;
    if (!fence) return { waiting: false, validated: false, uploaded: 0 };
    const gl = this.gl;
    const status = gl.clientWaitSync(fence, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) return { waiting: true, validated: false, uploaded: 0 };
    gl.deleteSync(fence);
    this.uploadValidationFence = null;
    let error = null, uploaded = 0;
    try {
      if (status === gl.WAIT_FAILED) throw new Error("GPU upload fence failed");
      assertGpuUpload(gl, "completed asynchronous scene uploads");
    } catch (failure) { error = failure; }
    for (const [key, stage] of this.uploadStaging) {
      if (!stage.awaitingValidation) continue;
      stage.awaitingValidation = false;
      const current = stage.generation === this.contextGeneration
        && stage.token === meshIdentity(stage.source, stage.visual);
      if (error || !current) {
        this.bufferManager.disposeChunkBuffers(stage.transaction.handle,{failed:Boolean(error)});
        this.uploadStaging.delete(key);
        if (error) this.noteUploadFailure(stage.source, stage.visual, error);
        continue;
      }
      if (stage.transaction.done) {
        this.commitChannelUpload(stage.source, stage.visual, stage.mesh, stage.transaction.handle,
          stage.generation, null, stage.region);
        this.uploadStaging.delete(key);
        uploaded++;
      }
    }
    const dynamic = this.dynamicUploadStages.splice(0);
    for (const stage of dynamic) {
      if (error || stage.generation !== this.contextGeneration) stage.abort(error ?? new Error('Obsolete dynamic upload generation'));
      else stage.commit();
    }
    return { waiting: false, validated: true, uploaded };
  }

  sealDeferredUploads() {
    if (this.uploadValidationFence || !this.hasUnvalidatedUploads()) return;
    const gl = this.gl;
    try {
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!fence) throw new Error("GPU upload fence allocation returned null");
      this.uploadValidationFence = fence;
      gl.flush();
    } catch (error) {
      for (const [key, stage] of this.uploadStaging) if (stage.awaitingValidation) {
        this.bufferManager.disposeChunkBuffers(stage.transaction.handle);
        this.uploadStaging.delete(key);
        this.noteUploadFailure(stage.source, stage.visual, error);
      }
      for (const stage of this.dynamicUploadStages.splice(0)) stage.abort(error);
      if(this.uploadValidationFence)gl.deleteSync(this.uploadValidationFence);
      this.uploadValidationFence = null;
    }
  }

  noteUploadFailure(chunk, visual, error) {
    chunk[visual ? "visualGpuUploaded" : "gpuUploaded"] = false;
    this.retryUploads.set(`${visual ? "visual" : "opaque"}:${chunk.id}`, performance.now() + this.options.uploadRetryMs);
    this.uploadDiagnostics.failed++;
    this.lastUploadError = error;
    this.logRenderEvent("upload-error", { chunkId: chunk.id, message: String(error?.message ?? error) });
  }

  commitChannelUpload(chunk, visual, mesh, handle, generation, target = null, region = null) {
    this.bufferManager.commitChunkBuffers?.(handle);
    const regions = visual ? this.visualRegionBuffers : this.regionBuffers;
    const previousRegion = region ? regions.get(region.id) : null;
    const buffers = region ? new Map(previousRegion?.members ?? [])
      : target ?? (visual ? this.visualChunkBuffers : this.chunkBuffers);
    const existing = buffers.get(chunk.id);
    const key = `${visual ? "visual" : "opaque"}:${chunk.id}`;
    const entry = { id: chunk.id, source: chunk, mesh, token: meshIdentity(chunk, visual),
      version: committedMeshVersion(chunk, visual), instanceGeneration: chunk.generation ?? 0, generation,
      chunkX: chunk.chunkX, chunkZ: chunk.chunkZ, originY: mesh.originY ?? chunk.originY ?? 0,
      parentId: chunk.parentId ?? chunk.parentChunkId ?? chunk.id, handle, visual,
      meshReadyAt: chunk[visual ? 'visualMeshReadyAt' : 'meshReadyAt'] ?? null,
      gpuReadyAt: performance.now(), firstDrawAt: null, firstDrawQueuedTo: null };
    buffers.set(chunk.id, entry);
    if (region) regions.set(region.id, { ...region, members: buffers,
      chunkIds: new Set(buffers.keys()), chunkVersions: new Map([...buffers].map(([id, member]) => [id, member.version])),
      signature: [...buffers.values()].map(member => member.token).join('|'), handle: buffers.values().next().value?.handle });
    this.cpuMeshBytesDirty = true;
    this.lastUploadError = null;
    if (existing) this.bufferManager.disposeChunkBuffers(existing.handle);
    chunk[visual ? "visualGpuUploaded" : "gpuUploaded"] = true;
    this.retryUploads.delete(key);
    this.pendingUploadSince.delete(key);
    this.uploadWaitFrames.delete(key);
    this.pendingMeshSources.delete(key);
    this.uploadDiagnostics.bytes += handle.byteLength;
    if (this.renderLogger?.enabled) this.logRenderEvent('mesh-gpu-ready', {chunkId:entry.id,visual,token:entry.token,
      meshReadyAt:entry.meshReadyAt,gpuReadyAt:entry.gpuReadyAt,
      cpuToGpuMs:entry.meshReadyAt == null ? null : Math.max(0,entry.gpuReadyAt-entry.meshReadyAt)});
    return entry;
  }

  noteEntryFirstDraw(entry) {
    const request = entry.source?.presentationRequest;
    if (request && request.firstDrawSubmitted == null && entry.version >= request.dataRevision) {
      request.firstDrawSubmitted = performance.now();
      request.pairToFirstDrawMs = request.pairValidatedAt == null ? null : request.firstDrawSubmitted - request.pairValidatedAt;
      request.interestToFirstDrawMs = request.interestEntered == null ? null : request.firstDrawSubmitted - request.interestEntered;
      if (this.renderLogger?.enabled) this.logRenderEvent("chain-presentation-first-draw", { chunkId: entry.id, ...request });
    }
    if (entry.firstDrawAt != null) return;
    entry.firstDrawAt = performance.now();
    if (this.renderLogger?.enabled) this.logRenderEvent('mesh-first-draw', {chunkId:entry.id,visual:entry.visual,
      token:entry.token,meshReadyAt:entry.meshReadyAt,gpuReadyAt:entry.gpuReadyAt,firstDrawAt:entry.firstDrawAt,
      cpuToFirstDrawMs:entry.meshReadyAt == null ? null : Math.max(0,entry.firstDrawAt-entry.meshReadyAt),
      gpuToFirstDrawMs:Math.max(0,entry.firstDrawAt-entry.gpuReadyAt)});
  }

  uploadChannel(chunk, visual = false, target = null, maxBytes = Infinity, region = null) {
    this.lastUploadAttemptBytes=0;
    if(this.uploadValidationFence)return null;
    const mesh = chunk?.[visual ? "visualMesh" : "mesh"];
    if (!mesh?.indexCount || !this.gpuReady()) return null;
    const key = `${visual ? "visual" : "opaque"}:${chunk.id}`;
    if ((this.retryUploads.get(key) ?? 0) > performance.now()) return null;
    const startedAt = performance.now();
    const buffers = target ?? (visual ? this.visualChunkBuffers : this.chunkBuffers);
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
        if(!staging){staging={token,generation,transaction:this.bufferManager.beginChunkBuffers(mesh,sharedPlacement(chunk,mesh,this.options.sharedChunkBuffers)),source:chunk,mesh,visual,region};this.uploadStaging.set(key,staging);}
        const deferred = this.deferredUploadsSupported();
        const progress=this.bufferManager.advanceChunkBuffers(staging.transaction,Math.max(1,maxBytes),{validate:!deferred});
        this.lastUploadAttemptBytes=progress.uploadedBytes;
        if(deferred){staging.awaitingValidation=true;return null;}
        if(!progress.done)return null;
        handle=staging.transaction.handle;this.uploadStaging.delete(key);
      }else{handle = this.bufferManager.createChunkBuffers(mesh,sharedPlacement(chunk,mesh,this.options.sharedChunkBuffers));this.lastUploadAttemptBytes=handle.byteLength;}

      if (this.contextLost || this.disposed || generation !== this.contextGeneration || this.gl.isContextLost?.()) {
        throw new Error("GPU context changed during upload");
      }
      const entry = this.commitChannelUpload(chunk,visual,mesh,handle,generation,buffers);
      this.uploadDiagnostics.cpuMs += performance.now() - startedAt;
      this.stageStats.record("chunk-upload-cpu",performance.now()-startedAt);
      this.logRenderEvent("chunk-upload", { chunkId: chunk.id, meshType: visual ? "visual" : "opaque", bytes: handle.byteLength,
        elapsedMs: performance.now() - startedAt, token: entry.token, contextGeneration: generation });
      return entry;
    } catch (error) {
      if (handle) this.bufferManager?.disposeChunkBuffers(handle,{failed:true});
      const staging=this.uploadStaging.get(key);if(staging){this.bufferManager?.disposeChunkBuffers(staging.transaction.handle,{failed:true});this.uploadStaging.delete(key);}
      this.noteUploadFailure(chunk,visual,error);
      return null;
    }
  }
  uploadChunk(chunk) { return this.uploadChannel(chunk); }
  uploadVisualChunk(chunk) { return this.uploadChannel(chunk, true); }
  updateChunk(chunk) { const old = this.chunkBuffers.get(chunk?.id); return old?.generation===this.contextGeneration && old?.token === meshIdentity(chunk, false) && chunk.gpuUploaded ? old : this.uploadChunk(chunk); }
  updateVisualChunk(chunk) { const old = this.visualChunkBuffers.get(chunk?.id); return old?.generation===this.contextGeneration && old?.token === meshIdentity(chunk, true) && chunk.visualGpuUploaded ? old : this.uploadVisualChunk(chunk); }

  removeChunk(chunkId) {
    this.cpuMeshBytesDirty=true;
    this.observedChunkCommits = new WeakMap();
    this.prefetchQueueCache = null;
    this.preparedRenderFrame = null;
    this.renderFrameInputs?.clear();
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
    for(const key of this.pendingUploadSince.keys())if(key.endsWith(`:${chunkId}`)||key.includes(`:${chunkId}@`)){this.pendingUploadSince.delete(key);this.pendingMeshSources.delete(key);this.uploadWaitFrames?.delete(key);}
    this.frustumFilterCache = null;
  }
  pruneChunks(liveChunkIds) {
    const live = liveChunkIds instanceof Set ? liveChunkIds : new Set(liveChunkIds ?? []);
    const dead = new Set();
    for (const buffers of [this.chunkBuffers, this.visualChunkBuffers]) for (const [id, entry] of buffers) if (!live.has(id) && !live.has(entry.parentId)) dead.add(entry.parentId ?? id);
    for (const regions of [this.regionBuffers, this.visualRegionBuffers]) for (const region of regions.values()) for (const [id,entry] of region.members ?? []) if (!live.has(id) && !live.has(entry.parentId)) dead.add(entry.parentId ?? id);
    for (const { source } of this.uploadStaging.values()) if(!live.has(source.id) && !live.has(source.parentId))dead.add(source.parentId ?? source.id);
    for (const { chunk, parent } of this.pendingMeshSources.values()) if(!live.has(chunk.id) && !live.has(parent?.id ?? chunk.parentId))dead.add(parent?.id ?? chunk.parentId ?? chunk.id);
    for (const id of dead) this.removeChunk(id);
    for (const [key,groups] of this.regionGroupCache) if(groups.some(group=>group.chunks.some(c=>!live.has(c.id)&&!live.has(c.parentId)))) this.regionGroupCache.delete(key);
  }

  observeChunkCommits(chunks) {
    for (const chunk of chunks) {
      if (!chunk) continue;
      const revision = chunk.renderSectionCommitRevision;
      const prior = this.observedChunkCommits.get(chunk);
      // Managed columns publish an immutable active list with their summary.
      // Legacy/building callers may mutate channels directly and are rechecked.
      if (revision != null && prior?.revision === revision && prior.generation === this.contextGeneration
        && prior.mesh === chunk.mesh && prior.visualMesh === chunk.visualMesh) continue;
      const sections = chunk.renderSections?.size ? [...chunk.renderSections.values()] : [chunk];
      retireCommittedEmptyChunkBuffers(this, sections);
      for (const section of chunk.renderActiveSections ?? sections) for (const visual of [false,true]) {
        const mesh = section?.[visual ? "visualMesh" : "mesh"];
        if (!mesh?.indexCount) continue;
        const entry = this.entryForChunk(section,visual);
        if (entry?.token === meshIdentity(section,visual) && section[visual ? "visualGpuUploaded" : "gpuUploaded"]) continue;
        const key = `${visual ? 'visual' : 'opaque'}:${section.id}`;
        if (!this.pendingUploadSince.has(key)) this.pendingUploadSince.set(key,performance.now());
        this.pendingMeshSources.set(key,{chunk:section,visual,parent:chunk});
        this.prefetchQueueVersion++;
      }
      if (revision != null) this.observedChunkCommits.set(chunk,{revision,generation:this.contextGeneration,mesh:chunk.mesh,visualMesh:chunk.visualMesh});
    }
  }

  prepareChunksForRender(visibleChunks = [], { maxUploads = this.options.maxChunkUploadsPerFrame, cameraState = null, residencyChunks = [], allowBackgroundUploads = true, backgroundUploadBudget = null, prefetchFocus = null, deadline = Infinity } = {}) {
    this.preparedRenderFrame = null;
    this.avatarRestorePrepared = true;
    this.uploadWaitFrames ??= new Map();
    if (!this.gpuReady()) return { uploaded: 0, pendingUploads: 0, paused: true };
    const viewport = this.prepareViewport(cameraState);
    const settlement = this.settleDeferredUploads();
    if(settlement.waiting) return { uploaded: settlement.uploaded,
      pendingUploads: this.pendingUploadSince.size, uploadedBytes: 0, validationPending: settlement.waiting };
    if(this.deferredUploadsSupported()) {
      this.pollFrameCompletion();
      if(this.frameCompletionFences.length>=2)return {uploaded:0,pendingUploads:this.pendingUploadSince.size,uploadedBytes:0,frameDeferred:true};
    }
    const startedAt = performance.now(), limit = Math.max(0, Math.trunc(maxUploads ?? 0));
    const externalDeadline = Number.isFinite(deadline) ? deadline : Infinity;
    const uploadDeadline = Math.min(startedAt + this.options.maxUploadCpuMs, externalDeadline);
    if (performance.now() < uploadDeadline) this.restoreAvatarUploads({deadline:uploadDeadline});
    this.bufferManager.reclaimSharedChunks?.();
    const visibleSet = new Set(visibleChunks), residentSet = new Set(residencyChunks);
    this.observeChunkCommits(visibleSet);
    this.observeChunkCommits(residentSet);
    const visibilityStartedAt = performance.now();
    const chunks = this.filterChunksForCamera(filterChunksByRenderRadius(flattenRenderSections(visibleChunks,{includeEmpty:false}),cameraState,this.options.viewDistance),cameraState);
    this.stageStats?.record('section-visibility-cpu',performance.now()-visibilityStartedAt);
    const visibleSections = new Map(chunks.map((chunk,index)=>[chunk,index]));
    (this.renderFrameInputs ??= new RenderFrameInputs()).capture(visibleChunks);
    this.preparedRenderFrame = {input:visibleChunks,camera:captureFrustumCamera(cameraState),chunks,viewDistance:this.options.viewDistance,...viewport};
    const candidates = [];
    const center = cameraState ? cameraRenderCenterChunk(cameraState) : null;
    const backgroundLimit = Math.min(limit, Math.max(0, Math.trunc(backgroundUploadBudget?.maxUploads ?? this.options.maxPrefetchUploadsPerFrame)));
    const backgroundBytes = Math.min(this.options.maxUploadBytesPerFrame, Math.max(0, backgroundUploadBudget?.maxBytes ?? this.options.maxUploadBytesPerFrame));
    const backgroundCpuMs = Math.min(this.options.maxUploadCpuMs, Math.max(0, backgroundUploadBudget?.maxCpuMs ?? this.options.maxUploadCpuMs));
    const intervalMs = Math.max(0, backgroundUploadBudget?.intervalMs ?? this.options.prefetchIntervalMs);
    const allowPrefetch = allowBackgroundUploads && backgroundLimit > 0 && backgroundBytes > 0 && backgroundCpuMs > 0
      && performance.now()-this.lastPrefetchAt >= intervalMs
      && (this.options.prefetchWithFrameInFlight || !this.frameCompletionFences.length);
    const focusX = Number.isFinite(prefetchFocus?.prefetchWorldX) ? Math.floor(prefetchFocus.prefetchWorldX / 16) : center?.chunkX;
    const focusZ = Number.isFinite(prefetchFocus?.prefetchWorldZ) ? Math.floor(prefetchFocus.prefetchWorldZ / 16) : center?.chunkZ;
    const forward = cameraState ? cameraForward(cameraState) : null;
    const viewKey = forward ? [Math.round(Math.atan2(forward[0],forward[2])*12/Math.PI),Math.round(forward[1]*10),
      Math.floor((cameraState.worldY||0)/4),cameraState.fov,cameraState.aspect,cameraState.far].join(':') : '';
    // The foreground is already ordered. Avoid scanning and sorting the whole
    // preload ring on every camera frame to find these few urgent channels.
    for (const chunk of chunks) for (const visual of [false,true]) {
      const key = `${visual ? 'visual' : 'opaque'}:${chunk.id}`;
      if (this.pendingMeshSources.get(key)?.chunk === chunk) candidates.push({key,chunk,visual,visible:true});
    }
    // Input order supplies screen/distance priority. Accumulated frame debt
    // gives waiting visual and large staged channels real completion turns,
    // including a low-Hz host where wall-clock-only heuristics are too coarse.
    const now = performance.now();
    for (const candidate of candidates) {
      const debt = this.uploadWaitFrames.get(candidate.key) ?? 0;
      const age = now - (this.pendingUploadSince.get(candidate.key) ?? now);
      candidate.priority = (visibleSections.get(candidate.chunk) ?? 0) * 2 + (candidate.visual ? 1 : 0)
        - debt * 4 - age / 16 - (candidate.chunk.localPlacement ? 256 : 0);
      this.uploadWaitFrames.set(candidate.key,debt+1);
    }
    candidates.sort((a,b)=>a.priority-b.priority);
    if (allowPrefetch && this.resourceLedger.bufferBytes < this.options.maxPrefetchGpuBytes) {
      let cache=this.prefetchQueueCache;
      if (!cache || cache.version!==this.prefetchQueueVersion || cache.x!==center?.chunkX || cache.z!==center?.chunkZ
        || cache.focusX!==focusX || cache.focusZ!==focusZ || cache.viewKey!==viewKey) {
        const ordered=[];
        const forecastCamera=cameraState?captureFrustumCamera(cameraState):null;
        if(forecastCamera) {
          const dx=((focusX??center.chunkX)-center.chunkX)*16,dz=((focusZ??center.chunkZ)-center.chunkZ)*16;
          forecastCamera.worldX+=dx;forecastCamera.worldZ+=dz;
          if(Number.isFinite(forecastCamera.targetWorldX))forecastCamera.targetWorldX+=dx;
          if(Number.isFinite(forecastCamera.targetWorldZ))forecastCamera.targetWorldZ+=dz;
          // Only the speculative upload order uses the wider projection.
          forecastCamera.fov=Math.min(110,(Number(cameraState.fov)||58)+24);
        }
        const forecastFrustum=forecastCamera?prepareCameraFrustum(forecastCamera):null;
        for (const [key,source] of this.pendingMeshSources) {
          const {chunk,visual}=source;
          if (!chunk?.[visual?'visualMesh':'mesh']?.indexCount) continue;
          const distance=center?Math.max(Math.abs(chunk.chunkX-center.chunkX),Math.abs(chunk.chunkZ-center.chunkZ)):0;
          const predicted=focusX==null||focusZ==null?distance:Math.max(Math.abs(chunk.chunkX-focusX),Math.abs(chunk.chunkZ-focusZ));
          const imminent=forecastCamera&&chunkIntersectsCameraFrustum(chunk,forecastCamera,forecastFrustum);
          ordered.push({...source,key,visible:false,distance:Math.min(distance,predicted+0.25)-(imminent?10000:0),order:ordered.length});
        }
        ordered.sort((a,b)=>a.distance-b.distance||a.order-b.order);
        cache=this.prefetchQueueCache={version:this.prefetchQueueVersion,x:center?.chunkX,z:center?.chunkZ,focusX,focusZ,viewKey,ordered};
      }
      for (const candidate of cache.ordered) {
        if (visibleSections.has(candidate.chunk) || !residentSet.has(candidate.parent??candidate.chunk)) continue;
        if (this.pendingMeshSources.get(candidate.key)?.chunk!==candidate.chunk) continue;
        candidates.push(candidate);
      }
    }
    let uploaded=settlement.uploaded, bytes=0, attempts=0,pendingUploads=0, oldestPendingMs=0;
    // A task is one chunk/section channel. Region membership never causes repacking.
    // Finish both channels of nearer sections before distant opaque work. A
    // completed validation can feed this frame's bounded batch immediately;
    // no draw/upload occurs behind an outstanding validation fence.
    let prefetchUploads=0, prefetchBytes=0, backgroundStartedAt=null;
    for (const {key,chunk,visual,visible} of candidates) {
      const mesh=chunk?.[visual?'visualMesh':'mesh']; if(!mesh?.indexCount)continue;
      const existing=this.entryForChunk(chunk,visual);
      if(existing?.token===meshIdentity(chunk,visual) && chunk[visual?'visualGpuUploaded':'gpuUploaded'])continue;
      if ((this.retryUploads.get(key) ?? 0) > performance.now()) { if (visible) pendingUploads++; continue; }
      const overBudget=attempts>=limit || bytes>=this.options.maxUploadBytesPerFrame
        || (performance.now()>=uploadDeadline && (attempts>0 || externalDeadline<Infinity));
      if(overBudget) {if(!visible)break;pendingUploads++;oldestPendingMs=Math.max(oldestPendingMs,performance.now()-this.pendingUploadSince.get(key));continue;}
      if (!visible && (prefetchUploads >= backgroundLimit || prefetchBytes >= backgroundBytes
        || (backgroundStartedAt !== null && performance.now()-backgroundStartedAt >= backgroundCpuMs))) break;
      if (!visible && this.resourceLedger.bufferBytes + mesh.vertices.byteLength + mesh.indices.byteLength > this.options.maxPrefetchGpuBytes) continue;
      const region = this.options.useRegionBatching && regionBatchEligible(chunk) ? this.getRegionGroups([chunk],visual?'visualMesh':'mesh')[0] : null;
      if (!visible && backgroundStartedAt === null) backgroundStartedAt=performance.now();
      const remainingBytes=Math.max(1,Math.min(this.options.maxUploadBytesPerFrame-bytes, visible ? Infinity : backgroundBytes-prefetchBytes));
      const result=region?this.uploadRegion(region,undefined,{visual,maxBytes:remainingBytes}):this.uploadChannel(chunk,visual,null,remainingBytes);
      attempts++;bytes+=this.lastUploadAttemptBytes;
      if (visible && this.lastUploadAttemptBytes > 0) {
        if (this.pendingMeshSources.has(key)) this.uploadWaitFrames.set(key,0);
        else this.uploadWaitFrames.delete(key);
      }
      if (!visible) {prefetchUploads++;prefetchBytes+=this.lastUploadAttemptBytes;}
      if(result)uploaded++;else {if(visible)pendingUploads++;oldestPendingMs=Math.max(oldestPendingMs,performance.now()-(this.pendingUploadSince.get(key)??performance.now()));}
    }
    if (prefetchUploads) this.lastPrefetchAt=performance.now();
    this.uploadDiagnostics.oldestPendingMs=oldestPendingMs;
    return {uploaded,pendingUploads,prefetchUploads,prefetchBytes,uploadedBytes:bytes,cpuMs:performance.now()-startedAt,oldestPendingMs};
  }

  uploadRegion(region, signature = null, { visual = false, maxBytes=Infinity } = {}) {
    if(!region?.chunks?.length || !this.gpuReady()) return null;
    if(Number.isFinite(maxBytes) && this.deferredUploadsSupported()) {
      for(const chunk of region.chunks)this.uploadChannel(chunk,visual,null,maxBytes,region);
      return null;
    }
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
    // A synchronous avatar upload must not consume a pending terrain error or
    // enqueue work after its completion fence. CPU registrations remain queued.
    if(this.uploadValidationFence || this.hasUnvalidatedUploads())return null;
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
      if(existing){this.releaseAvatarInstances(key);this.disposeAvatarBuffers(existing.handle);}
      this.retryUploads.delete(retryKey);this.lastUploadError=null;return entry;
    } catch(error) {this.lastUploadError=error;this.uploadDiagnostics.failed++;this.retryUploads.set(retryKey,performance.now()+this.options.uploadRetryMs);return null;}
  }
  restoreAvatarUploads({deadline=Infinity}={}) {
    if(this.contextLost||this.disposed||!this.initialized)return;
    if(this.uploadValidationFence || this.hasUnvalidatedUploads())return;
    let attempted=0,bytes=0;
    for(const [id,mesh]of this.avatarMeshes){const entry=this.avatarBuffers.get(id);if(entry?.mesh===mesh&&entry.generation===this.contextGeneration)continue;
      if(performance.now()>=deadline)break;
      if((this.retryUploads.get(`avatar:${id}`)??0)>performance.now())continue;
      if(attempted>=2 || (attempted>0&&bytes+mesh.vertices.byteLength+mesh.indices.byteLength>this.options.maxUploadBytesPerFrame))break;
      this.uploadAvatarMesh(id,mesh);attempted++;bytes+=mesh.vertices.byteLength+mesh.indices.byteLength;
    }
  }
  removeAvatarMesh(id) {this.cpuMeshBytesDirty=true;const key=String(id);this.releaseAvatarInstances(key);this.avatarMeshes.delete(key);const old=this.avatarBuffers.get(key);if(old)this.disposeAvatarBuffers(old.handle);this.avatarBuffers.delete(key);this.retryUploads.delete(`avatar:${key}`);}

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
    // Keep at most two frames in flight. Without this bound the browser can
    // accumulate seconds of old camera frames before the next upload fence.
    // Polling never waits; controls/physics continue on animation callbacks.
    if(this.deferredUploadsSupported())this.pollFrameCompletion();
    if(this.uploadValidationFence) return { ...this.stats, renderDeferred: true, cpuDrawSubmitMs: 0 };
    if(this.frameCompletionFences.length>=2)return { ...this.stats, renderDeferred:true, cpuDrawSubmitMs:0 };
    if (!this.avatarRestorePrepared) this.restoreAvatarUploads({deadline:performance.now()+this.options.maxUploadCpuMs});
    this.avatarRestorePrepared = false;
    const drawSubmitStartedAt=performance.now();
    this.gpuTimer?.begin();
    const gl = this.gl;
    const prepared = this.preparedRenderFrame;
    const viewport = this.prepareViewport(cameraState, prepared);
    this.preparedRenderFrame = null;
    const renderChunks = prepared?.input === visibleChunks && prepared.viewDistance === this.options.viewDistance
      && prepared.width === viewport.width && prepared.height === viewport.height
      && this.renderFrameInputs.matches(visibleChunks) && sameFrustumCamera(prepared.camera,cameraState) ? prepared.chunks : this.filterChunksForCamera(
      filterChunksByRenderRadius(flattenRenderSections(visibleChunks, { includeEmpty: false }), cameraState, this.options.viewDistance),
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
    const visibleAvatars = selectVisibleAvatars(avatars,cameraState,
      avatar=>this.avatarBuffers.get(String(avatar.meshId||avatar.id)),this.visibleAvatars);
    this.releaseAvatarInstances(null,{live:new Set(visibleAvatars.map(avatar=>this.avatarInstanceKey(avatar)))});
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
    const avatarStats=this.renderAvatars(cameraState,visibleAvatars,viewProjection,origin,lighting,{opaqueOnly:true});
    drawCalls+=avatarStats.drawCalls;triangles+=avatarStats.triangles;
    if(typeof gl.blendFunc === "function")gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);gl.depthMask(false);
    if (this.options.environmentEffects && this.options.shadows) {
      for(const visual of [false,true]){const shadowStats=this.renderMeshPass(worldChunks,origin,['shadow'],visual);drawCalls+=shadowStats.drawCalls;triangles+=shadowStats.triangles;}
    }
    gl.disable(gl.BLEND);gl.depthMask(true);
    const projectedShadowStats=this.renderProjectedShadows(avatars,viewProjection,origin,lighting,cameraState);
    drawCalls+=projectedShadowStats.drawCalls;triangles+=projectedShadowStats.triangles;
    const blendStats=this.renderTransparentScene(cameraState,worldChunks,visibleAvatars,viewProjection,origin,lighting,previewChunks);
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
      cpuSortedIndexBytes:this.sortedIndexStream?.capacityBytes??0,
      ...this.bufferManager?.shared?.snapshot(),
      gpuChunks: this.regionBuffers.size + this.visualRegionBuffers.size + this.chunkBuffers.size + this.visualChunkBuffers.size,
      width: this.canvas.width,
      height: this.canvas.height,
      dpr: this.clampedDpr(),
      underwater: underwater || this.underwaterBlend >= 0.5,
      underwaterBlend: this.underwaterBlend,
    };
    this.gpuTimer?.end();
    this.fenceSubmittedFrame();
    // Draw the last committed scene before sealing the new upload batch. This
    // preserves a frame during streaming instead of holding the canvas still
    // merely because a replacement is waiting to become publishable.
    this.sealDeferredUploads();
    this.stats.gpuFramesPending=this.frameCompletionFences.length;
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
    let drawCalls=0,triangles=0,pendingPage=null,runs=0;
    const firstDrawEntries = this.pendingFirstDrawEntries ??= []; firstDrawEntries.length = 0;
    const combined = passes.length===2 && passes[0]==='opaque' && passes[1]==='cutout';
    const flush=()=>{
      if(!runs)return;
      if(uniforms.uUseChunkOffset)gl.uniform1i(uniforms.uUseChunkOffset,1);
      if(uniforms.uSurfacePass)gl.uniform1f(uniforms.uSurfacePass,-1);
      gl.uniform3f(uniforms.uChunkOrigin,pendingPage.x-origin.worldX,pendingPage.y-origin.worldY,pendingPage.z-origin.worldZ);
      gl.bindVertexArray(pendingPage.vao);
      if(runs>1 && typeof this.multiDraw?.multiDrawElementsWEBGL==='function'){
        this.multiDraw.multiDrawElementsWEBGL(gl.TRIANGLES,this.multiDrawCounts,0,pendingPage.indexType,this.multiDrawOffsets,0,runs);drawCalls++;
      }else for(let i=0;i<runs;i++){gl.drawElements(gl.TRIANGLES,this.multiDrawCounts[i],pendingPage.indexType,this.multiDrawOffsets[i]);drawCalls++;}
      for (const entry of firstDrawEntries) this.noteEntryFirstDraw(entry);
      firstDrawEntries.length = 0;
      runs=0;pendingPage=null;
    };
    for(const chunk of chunks){const entry=this.entryForChunk(chunk,visual);if(!entry?.handle)continue;
      const handle=entry.handle;
      let eligible=false;
      for (const pass of passes) if (handle.drawRanges?.[pass]?.count || (!handle.drawRanges && pass==='opaque' && handle.indexCount)) { eligible=true;break; }
      if (!eligible) continue;
      if(handle.sharedPage && combined){
        if(pendingPage && pendingPage!==handle.sharedPage)flush();
        pendingPage=handle.sharedPage;
        if (entry.firstDrawAt == null || entry.source?.presentationRequest?.firstDrawSubmitted === null) firstDrawEntries.push(entry);
        for(const pass of passes){const range=handle.drawRanges[pass];if(!range?.count)continue;
          const offset=range.offset*pendingPage.indexBytes;
          if(runs && this.multiDrawOffsets[runs-1]+this.multiDrawCounts[runs-1]*pendingPage.indexBytes===offset)this.multiDrawCounts[runs-1]+=range.count;
          else{ensureMultiDrawCapacity(this,runs+1);this.multiDrawCounts[runs]=range.count;this.multiDrawOffsets[runs++]=offset;}
          triangles+=range.count/3;
        }
        continue;
      }
      flush();
      if(uniforms.uUseChunkOffset)gl.uniform1i(uniforms.uUseChunkOffset,handle.sharedPage?1:0);
      const offset=shaderChunkOffset(handle,origin,[chunk.chunkX*chunk.chunkSize-origin.worldX,entry.originY-origin.worldY,chunk.chunkZ*chunk.chunkSize-origin.worldZ]);
      gl.uniform3f(uniforms.uChunkOrigin,...offset);gl.bindVertexArray(handle.vao);
      for(const pass of passes){const range=handle.drawRanges?.[pass] ?? (pass==='opaque'?{offset:0,count:handle.indexCount}:null);if(!range?.count)continue;
        if(uniforms.uSurfacePass)gl.uniform1f(uniforms.uSurfacePass,pass==='cutout'?1:0);
        gl.drawElements(gl.TRIANGLES,range.count,handle.indexType,range.offset*(handle.indexBytes??2));drawCalls++;triangles+=range.count/3;}
      this.noteEntryFirstDraw(entry);
    }flush();gl.bindVertexArray(null);return {drawCalls,triangles,bufferMemory:0};
  }
  renderVisualChunks(chunks, origin) {return this.renderMeshPass(chunks,origin,['opaque','cutout'],true);}

  renderTransparentScene(camera, chunks, avatars, vp, origin, lighting, previews = []) {
    if (this.contextLost || this.disposed || !this.gl || this.gl.isContextLost?.()) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    const gl = this.gl, queue = this.transparentQueue ??= [], pool = this.transparentItemPool ??= [];
    const queueStartedAt = performance.now();
    const forward = cameraForward(camera), eyeX = camera.localOffsetX || 0,
      eyeY = camera.localOffsetY || 0, eyeZ = camera.localOffsetZ || 0;
    queue.length = 0;
    this.transparentKeyCache ??= new WeakMap();
    const keyFor = (owner, kind, id, offset) => {
      let keys = this.transparentKeyCache.get(owner);
      if (!keys) { keys = new Map(); this.transparentKeyCache.set(owner, keys); }
      let key = keys.get(offset);
      if (key == null) { key = `${kind}:${id ?? ""}:${offset}`; keys.set(offset, key); }
      return key;
    };
    const add = (kind, owner, id, offset, x, y, z) => {
      const order = queue.length, item = pool[order] ?? (pool[order] = {});
      item.kind = kind; item.key = keyFor(owner, kind, id, offset); item.order = order;
      item.depth = (x - eyeX) * forward[0] + (y - eyeY) * forward[1] + (z - eyeZ) * forward[2];
      item.entry = item.avatar = item.snapshot = item.particle = null;
      queue.push(item); return item;
    };
    const terrain = list => {
      for (const chunk of list) for (const visual of [false, true]) {
        const entry = this.entryForChunk(chunk, visual); if (!entry?.handle) continue;
        const handle = entry.handle, x = chunk.chunkX * chunk.chunkSize - origin.worldX,
          y = entry.originY - origin.worldY, z = chunk.chunkZ * chunk.chunkSize - origin.worldZ;
        const offset = shaderChunkOffset(handle, origin, [x, y, z]), preview = chunk.buildingPreview === true;
        const units = preview ? previewSortUnits(entry) : handle.blendUnits ?? [];
        for (const unit of units) {
          if (unit.pass !== 'blend' && !preview) continue;
          const item = add('terrain', entry, entry.id, unit.sortOffset ?? unit.offset,
            unit.center[0] + x, unit.center[1] + y, unit.center[2] + z);
          item.entry = entry; item.handle = handle; item.unit = unit; item.offset = offset; item.opacity = preview ? .46 : 1;
        }
      }
    };
    terrain(chunks); terrain(previews);
    for (const avatar of avatars) {
      const entry = this.avatarBuffers.get(String(avatar.meshId || avatar.id)); if (!entry?.handle) continue;
      const opacity = Math.max(0, Math.min(1, Number(avatar.opacity ?? 1) || 0)); if (opacity <= .001) continue;
      const snapshot = this.avatarFrameState(avatar, entry), handle = this.avatarRenderHandle(avatar, entry, snapshot);
      if (!handle) continue;
      const vertices = snapshot.vertices, indices = handle.drawIndices ?? entry.mesh.indices,
        stride = (entry.mesh.vertexStrideBytes || 40) / 4;
      const x = (avatar.worldX || 0) + (avatar.localOffsetX || 0) - origin.worldX,
        y = (avatar.worldY || 0) + (avatar.localOffsetY || 0) - origin.worldY,
        z = (avatar.worldZ || 0) + (avatar.localOffsetZ || 0) - origin.worldZ;
      const yaw = avatar.yaw || 0, c = Math.cos(yaw), sin = Math.sin(yaw);
      const drawState = snapshot.drawState, ranged = drawState?.valid;
      const ranges = opacity >= .999 ? drawState?.blend : drawState?.visible;
      const rangeCount = ranged ? (opacity >= .999 ? drawState.blendCount : drawState.visibleCount) : 1;
      for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
        const rangeStart = ranged ? ranges[rangeIndex].offset : 0;
        const rangeEnd = ranged ? rangeStart + ranges[rangeIndex].count : indices.length;
        for (let i = rangeStart; i < rangeEnd; i += 3) {
        const a = indices[i] * stride, b = indices[i + 1] * stride, d = indices[i + 2] * stride;
        // A texture replaces surface alpha in the shader. Only the untextured
        // path can prove zero vertex alpha to be invisible (including tools).
        if (vertices[a + 9] === 0 && vertices[b + 9] === 0 && vertices[d + 9] === 0
          && (stride < 13 || vertices[a + 12] < 0 && vertices[b + 12] < 0 && vertices[d + 12] < 0)) continue;
        if (opacity >= .999 && !(vertices[a + 9] < .999 || vertices[b + 9] < .999 || vertices[d + 9] < .999
          || stride >= 14 && (vertices[a + 13] > .5 || vertices[b + 13] > .5 || vertices[d + 13] > .5))) continue;
        // Keep the historical per-vertex arithmetic order as well as the stable
        // key: tiny rounding differences can otherwise reorder coplanar faces.
        let cx = 0, cy = 0, cz = 0;
        for (let vertex = 0; vertex < 3; vertex++) {
          const at = indices[i + vertex] * stride;
          cx += (c * vertices[at] + sin * vertices[at + 2]) / 3;
          cy += vertices[at + 1] / 3;
          cz += (-sin * vertices[at] + c * vertices[at + 2]) / 3;
        }
        const item = add('avatar', snapshot, avatar.id, i, cx + x, cy + y, cz + z);
        item.avatar = avatar; item.snapshot = snapshot; item.handle = handle; item.opacity = opacity;
        item.unit = item.avatarRange ?? (item.avatarRange = {}); item.unit.offset = i; item.unit.count = 3;
        }
      }
    }
    const particles = this.voxelParticles?.particles ?? [];
    for (let i = 0; i < Math.min(particles.length, this.voxelParticles?.maxParticles ?? particles.length); i++) {
      const particle = particles[i], item = add('particle', particle, particle.id, 0,
        particle.x - origin.worldX, particle.y - origin.worldY, particle.z - origin.worldZ);
      item.particle = particle;
    }
    queue.sort((a, b) => b.depth - a.depth || a.key.localeCompare(b.key) || a.order - b.order);
    this.stageStats?.record('transparent-queue-sort-cpu',performance.now()-queueStartedAt);
    const streamStartedAt = performance.now();
    const stream = this.sortedIndexStream ?? (this.sortedIndexStream = new SortedIndexStream(gl,{
      deferValidation:this.deferredUploadsSupported()?stage=>this.queueDynamicUpload(stage):null,
    }));
    stream.beginFrame();
    const segments = this.transparentSegments ??= [], segmentPool = this.transparentSegmentPool ??= [],
      orderedParticles = this.orderedParticles ??= [];
    segments.length = 0; orderedParticles.length = 0;
    const sameOffset = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i], owner = item.handle?.sharedPage ?? item.handle;
      let segment = segments[segments.length - 1];
      const compatible = segment?.kind === item.kind && (item.kind === 'particle'
        || item.kind === 'terrain' && segment.owner === owner && segment.opacity === item.opacity && sameOffset(segment.offset, item.offset)
        || item.kind === 'avatar' && segment.avatar === item.avatar && segment.handle === item.handle && segment.opacity === item.opacity);
      if (!compatible) {
        segment = segmentPool[segments.length] ?? (segmentPool[segments.length] = {});
        segment.kind = item.kind; segment.owner = owner; segment.handle = item.handle; segment.offset = item.offset;
        segment.avatar = item.avatar; segment.opacity = item.opacity; segment.first = i; segment.last = i;
        segment.count = 0; segment.sorted = null; segment.sortedFailed = false; segment.particleStart = orderedParticles.length;
        (segment.firstDrawEntries ??= []).length = 0;
        segments.push(segment);
      }
      segment.last = i;
      if (item.entry && (item.entry.firstDrawAt == null || item.entry.source?.presentationRequest?.firstDrawSubmitted === null) && item.entry.firstDrawQueuedTo !== segment) {
        segment.firstDrawEntries.push(item.entry); item.entry.firstDrawQueuedTo = segment;
      }
      if (item.kind === 'particle') { orderedParticles.push(item.particle); segment.count++; continue; }
      const count = item.unit.count, sourceOffset = item.unit.offset - (item.handle.indexStart ?? 0);
      if (!segment.sortedFailed) {
        const appended = stream.append(item.handle, item.kind === 'avatar' ? 'avatar' : 'terrain', sourceOffset, count);
        if (appended) { if (!segment.sorted) { segment.sorted = appended; segment.sortedOffset = appended.appendOffset; } }
        else { segment.sorted = null; segment.sortedFailed = true; }
      }
      segment.count += count;
    }
    stream.upload();
    this.voxelParticles?.prepareInstances(orderedParticles, origin);
    this.stageStats?.record('transparent-stream-upload-cpu',performance.now()-streamStartedAt);
    if (stream.lastError) this.lastSortedIndexError = stream.lastError;
    gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    let drawCalls = 0, triangles = 0, active = null, boundVao = null, boundOffset = null,
      boundOpacity = null, boundShared = null, boundAvatar = null;
    for (const segment of segments) {
      if (segment.kind === 'particle') {
        const stats = this.voxelParticles.renderPrepared({ viewProjection: vp, lighting, textureArray: this.textureArray,
          start: segment.particleStart, count: segment.count, bindUniforms: active !== 'particle' });
        drawCalls += stats.drawCalls; triangles += stats.triangles;
        active = 'particle'; boundVao = null; continue;
      }
      const avatarPass = segment.kind === 'avatar';
      if (active !== segment.kind) {
        const program = avatarPass ? this.avatarProgram : this.program,
          uniforms = avatarPass ? this.avatarUniforms : this.uniforms;
        gl.useProgram(program); gl.uniformMatrix4fv(uniforms.uViewProjection, false, vp);
        applyLightingUniforms(gl, uniforms, lighting); this.textureArray?.bind(0);
        if (avatarPass) gl.uniform1i(uniforms.uTextureArray, 0); else gl.uniform1f(uniforms.uSurfacePass, 0);
        active = segment.kind; boundVao = null; boundOffset = null; boundOpacity = null; boundShared = null; boundAvatar = null;
      }
      const handle = segment.handle;
      if (avatarPass) {
        if (boundAvatar !== segment.avatar) {
          const avatar = segment.avatar;
          gl.uniform3f(this.avatarUniforms.uAvatarOrigin, Math.trunc(avatar.worldX || 0) + (avatar.localOffsetX || 0) - origin.worldX,
            Math.trunc(avatar.worldY || 0) + (avatar.localOffsetY || 0) - origin.worldY, Math.trunc(avatar.worldZ || 0) + (avatar.localOffsetZ || 0) - origin.worldZ);
          gl.uniform1f(this.avatarUniforms.uAvatarYaw, avatar.yaw || 0);
          gl.uniform1f(this.avatarUniforms.uAvatarOpacity, segment.opacity);
          gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, segment.opacity < .999 ? 0 : 2);
          boundAvatar = segment.avatar;
        }
      } else {
        if (boundOpacity !== segment.opacity) { gl.uniform1f(this.uniforms.uOpacity, segment.opacity); boundOpacity = segment.opacity; }
        if (!sameOffset(boundOffset, segment.offset)) { gl.uniform3f(this.uniforms.uChunkOrigin, ...segment.offset); boundOffset = segment.offset; }
        const shared = Boolean(handle.sharedPage);
        if (boundShared !== shared) { if (this.uniforms.uUseChunkOffset) gl.uniform1i(this.uniforms.uUseChunkOffset, shared ? 1 : 0); boundShared = shared; }
      }
      gl.enable(gl.CULL_FACE);
      if (segment.sorted?.ready) {
        if (boundVao !== segment.sorted.vao) { gl.bindVertexArray(segment.sorted.vao); boundVao = segment.sorted.vao; }
        gl.drawElements(gl.TRIANGLES, segment.count, segment.sorted.indexType, segment.sortedOffset * segment.sorted.indexBytes);
        drawCalls++; triangles += segment.count / 3;
      } else {
        if (boundVao !== handle.vao) { gl.bindVertexArray(handle.vao); boundVao = handle.vao; }
        for (let i = segment.first; i <= segment.last; i++) {
          const unit = queue[i].unit;
          gl.drawElements(gl.TRIANGLES, unit.count, handle.indexType, unit.offset * (handle.indexBytes ?? 2));
          drawCalls++; triangles += unit.count / 3;
        }
      }
      for (const entry of segment.firstDrawEntries) { this.noteEntryFirstDraw(entry); entry.firstDrawQueuedTo = null; }
      segment.firstDrawEntries.length = 0;
    }
    stream.endFrame();
    // Pools retain capacity, never unloaded world/model ownership indefinitely.
    for (let i = queue.length; i < pool.length; i++) { pool[i].entry = pool[i].avatar = pool[i].snapshot = pool[i].particle = pool[i].handle = pool[i].unit = null; }
    if (pool.length > queue.length * 2 + 1024) pool.length = queue.length + 1024;
    for (let i = segments.length; i < segmentPool.length; i++) segmentPool[i].owner = segmentPool[i].handle = segmentPool[i].avatar = segmentPool[i].sorted = null;
    if (segmentPool.length > segments.length * 2 + 64) segmentPool.length = segments.length + 64;
    gl.bindVertexArray(null); gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
    return { drawCalls, triangles, bufferMemory: 0 };
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
        if(this.uniforms.uUseChunkOffset)gl.uniform1i(this.uniforms.uUseChunkOffset,handle.sharedPage?1:0);
        const offset=shaderChunkOffset(handle,origin,[chunk.chunkX*chunk.chunkSize-origin.worldX,-origin.worldY,chunk.chunkZ*chunk.chunkSize-origin.worldZ]);
        gl.uniform3f(this.uniforms.uChunkOrigin,...offset);
        gl.bindVertexArray(handle.vao);
        gl.drawElements(gl.TRIANGLES,handle.indexCount,handle.indexType,(handle.indexStart??0)*(handle.indexBytes??2));
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

  avatarInstanceKey(avatar) { return avatar.id == null ? avatar : String(avatar.id); }

  releaseAvatarInstances(modelKey = null, { lost = false, live = null } = {}) {
    for (const [key, instance] of this.avatarInstances ?? []) {
      if (modelKey != null && instance.modelKey !== modelKey || live?.has(key)) continue;
      instance.released = true;
      for (const handle of [instance.handle, instance.stagingHandle, instance.pendingHandle]) if (handle) {
        if (!lost) { this.gl?.deleteBuffer(handle.vbo); this.gl?.deleteVertexArray(handle.vao); }
      }
      this.avatarInstances.delete(key);
      this.avatarFrameStates.delete(key);
      this.cpuMeshBytesDirty = true;
    }
  }

  avatarFrameState(avatar, entry) {
    if (!entry.mesh) return { vertices: null, handle: entry.handle };
    this.avatarFrameStates ??= new Map();
    this.avatarInstances ??= new Map();
    const key = this.avatarInstanceKey(avatar), modelKey = String(avatar.meshId || avatar.id);
    let snapshot = this.avatarFrameStates.get(key);
    if (snapshot?.mesh === entry.mesh && snapshot.staticHandle === entry.handle) { snapshot.modelKey = modelKey; return snapshot; }
    snapshot = this.avatarInstances.get(key);
    if (snapshot && (snapshot.mesh !== entry.mesh || snapshot.staticHandle !== entry.handle
      || snapshot.generation !== this.contextGeneration)) {
      snapshot.released = true;
      for (const handle of [snapshot.handle, snapshot.stagingHandle, snapshot.pendingHandle]) if (handle) {
        this.gl.deleteBuffer(handle.vbo); this.gl.deleteVertexArray(handle.vao);
      }
      this.avatarInstances.delete(key); snapshot = null;
    }
    if (!snapshot) {
      const animated = Boolean(entry.mesh.parts?.length);
      const committed = animated ? new Float32Array(entry.mesh.vertices) : entry.mesh.vertices;
      snapshot = { mesh: entry.mesh, staticHandle: entry.handle, modelKey, generation: this.contextGeneration,
        revision: 0, gpuRevision: -1, handle: null, stagingHandle: null,
        vertices: committed,
        pendingVertices: animated ? new Float32Array(entry.mesh.vertices.length) : null,
        committedVertices: animated ? committed : null, retryAfter: 0,
        pendingDrawState: {visible:[],blend:[],visibleCount:0,blendCount:0,valid:false},
        committedDrawState: {visible:[],blend:[],visibleCount:0,blendCount:0,valid:false}, drawState: null };
      this.avatarInstances.set(key, snapshot);
      this.cpuMeshBytesDirty = true;
    }
    snapshot.modelKey = modelKey;
    if (snapshot.awaitingValidation) {
      snapshot.vertices = snapshot.committedVertices;
      snapshot.drawState = snapshot.committedDrawState;
      this.avatarFrameStates.set(key,snapshot);
      return snapshot;
    }
    if (entry.mesh.parts?.length) {
      const poseStartedAt = performance.now();
      snapshot.pendingVertices.set(updateAvatarMeshVertices(entry.mesh, avatar.animation, snapshot.pendingDrawState));
      snapshot.vertices = snapshot.pendingVertices;
      snapshot.drawState = snapshot.pendingDrawState;
      this.stageStats?.record('avatar-pose-cpu',performance.now()-poseStartedAt);
    }
    snapshot.revision++;
    this.avatarFrameStates.set(key, snapshot);
    return snapshot;
  }

  avatarRenderHandle(avatar, entry, snapshot) {
    if (!entry.mesh?.parts?.length) return entry.handle;
    if (snapshot.awaitingValidation) return snapshot.handle;
    if (snapshot.gpuRevision === snapshot.revision) return snapshot.handle ?? entry.handle;
    if (performance.now() < snapshot.retryAfter) {
      snapshot.vertices = snapshot.committedVertices ?? entry.mesh.vertices;
      snapshot.drawState = snapshot.committedDrawState;
      return snapshot.handle ?? (this.deferredUploadsSupported()?null:entry.handle);
    }
    const gl = this.gl;
    const uploadStartedAt = performance.now();
    let staging = snapshot.stagingHandle, created = false;
    try {
      if (!staging) {
        created = true;
        staging = { vao: null, vbo: null, ibo: entry.handle.ibo, drawIndices: entry.mesh.indices, sortOwner: snapshot,
          stride: entry.mesh.vertexStrideBytes || 40, indexCount: entry.handle.indexCount,
          indexType: entry.handle.indexType, indexBytes: entry.mesh.indices.BYTES_PER_ELEMENT,
          triangleCount: entry.handle.triangleCount, byteLength: entry.mesh.vertices.byteLength };
        staging.vao = gl.createVertexArray(); if (!staging.vao) throw Error('Avatar instance VAO allocation returned null');
        staging.vbo = gl.createBuffer(); if (!staging.vbo) throw Error('Avatar instance VBO allocation returned null');
        configureAvatarVertexArray(gl, staging.vbo, staging.ibo, staging.stride, staging.vao);
        gl.bufferData(gl.ARRAY_BUFFER, snapshot.pendingVertices.byteLength, gl.DYNAMIC_DRAW);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, staging.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, snapshot.pendingVertices);
      if (this.deferredUploadsSupported()) {
        snapshot.awaitingValidation = true;
        snapshot.pendingHandle = staging;
        snapshot.stagingHandle = null;
        this.queueDynamicUpload({
          commit:()=>{
            if (snapshot.released) return;
            snapshot.pendingHandle = null;
            snapshot.awaitingValidation = false;
            this.commitAvatarPose(snapshot,staging);
          },
          abort:error=>{
            if (snapshot.released) return;
            gl.deleteBuffer(staging.vbo);gl.deleteVertexArray(staging.vao);
            snapshot.pendingHandle = null;
            snapshot.awaitingValidation = false;
            snapshot.retryAfter = performance.now()+this.options.uploadRetryMs;
            this.lastAvatarUploadError = error;
          },
        });
        // A first instance has no verified pose yet. Omit it for this frame:
        // the shared registration can contain hidden equipment and is not a
        // valid fallback for this entity's pending visibility/animation state.
        snapshot.vertices = snapshot.committedVertices;
        snapshot.drawState = snapshot.committedDrawState;
        this.stageStats?.record('avatar-pose-upload-cpu',performance.now()-uploadStartedAt);
        return snapshot.handle;
      }
      assertGpuUpload(gl, 'avatar instance pose');
      this.commitAvatarPose(snapshot,staging);
      this.stageStats?.record('avatar-pose-upload-cpu',performance.now()-uploadStartedAt);
      return snapshot.handle;
    } catch (error) {
      if (created && staging) { if (staging.vao) gl.deleteVertexArray(staging.vao); if (staging.vbo) gl.deleteBuffer(staging.vbo); }
      snapshot.retryAfter = performance.now() + this.options.uploadRetryMs;
      snapshot.vertices = snapshot.committedVertices ?? entry.mesh.vertices;
      snapshot.drawState = snapshot.committedDrawState;
      this.lastAvatarUploadError = error;
      return snapshot.handle ?? (this.deferredUploadsSupported()?null:entry.handle);
    } finally { gl.bindVertexArray(null); }
  }

  commitAvatarPose(snapshot,staging) {
    const previous = snapshot.handle;
    snapshot.handle = staging;snapshot.stagingHandle = previous;
    const oldVertices = snapshot.committedVertices ?? snapshot.vertices;
    snapshot.committedVertices = snapshot.pendingVertices;
    snapshot.vertices = snapshot.committedVertices;
    snapshot.pendingVertices = oldVertices;
    const priorDrawState = snapshot.committedDrawState;
    snapshot.committedDrawState = snapshot.pendingDrawState;
    snapshot.pendingDrawState = priorDrawState;
    snapshot.drawState = snapshot.committedDrawState;
    snapshot.gpuRevision = snapshot.revision;
    snapshot.retryAfter = 0;
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
      const snapshot=vertexSnapshot??this.avatarFrameState(avatar,entry);
      const handle = this.avatarRenderHandle(avatar,entry,snapshot);
      if (!handle) continue;
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
      const drawVisible = () => {
        const state = snapshot.drawState;
        if (state?.valid) for (let index = 0; index < state.visibleCount; index++) {
          const range = state.visible[index];
          gl.drawElements(gl.TRIANGLES,range.count,handle.indexType,range.offset*(handle.indexBytes??2));
          drawCalls++;triangles+=range.count/3;
        }
        else {
          gl.drawElements(gl.TRIANGLES,handle.indexCount,handle.indexType,0);
          drawCalls++;triangles+=handle.triangleCount;
        }
      };
      if(drawRange){
        setTransparentPass(true);gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass,opacity<0.999?0:2);
        gl.drawElements(gl.TRIANGLES,drawRange.count,handle.indexType,drawRange.offset*(entry.mesh.indices.BYTES_PER_ELEMENT||2));drawCalls++;triangles+=drawRange.count/3;continue;
      }
      if (opacity < 0.999 && opaqueOnly) continue;
      if (transparentOnly && opacity >= 0.999 && !avatarHoldsTransparentBlock(avatar.animation)) continue;
      if (opacity < 0.999) {
        setTransparentPass(true);
        gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, 0);
        drawVisible();
      } else if (opaqueOnly || avatarHoldsTransparentBlock(avatar.animation)) {
        if (!transparentOnly) {
        setTransparentPass(false);
        gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, 1);
        drawVisible();
        }
        if (!opaqueOnly) {
        setTransparentPass(true);
        gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, 2);
        drawVisible();
        }
      } else {
        setTransparentPass(false);
        gl.uniform1f(this.avatarUniforms.uAvatarSurfacePass, 0);
        drawVisible();
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

  renderProjectedShadows(avatars, viewProjection, origin, lighting = this.lighting, cameraState = null) {
    if (!this.options.shadows) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    if(this.contextLost||this.disposed||!this.gl||this.gl.isContextLost?.())return {drawCalls:0,triangles:0,bufferMemory:0};
    const gl = this.gl;
    if (!this.projectedShadowLayer || !avatars?.length) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const stats = this.projectedShadowLayer.render({ viewProjection, origin, lighting, casters: avatars, cameraState });
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
    this.multiDraw = null;
    const safely = (callback) => {
      try {
        callback();
      } catch {
        // A failed delete must not prevent the rest of the owned resources from being released.
      }
    };
    if(this.uploadValidationFence && !this.contextLost)safely(()=>this.gl?.deleteSync(this.uploadValidationFence));
    this.uploadValidationFence = null;
    this.dynamicUploadStages.length = 0;
    if(!this.contextLost)for(const fence of this.frameCompletionFences)safely(()=>this.gl?.deleteSync(fence));
    this.frameCompletionFences.length=0;
    for(const staging of this.uploadStaging.values())safely(()=>this.bufferManager?.disposeChunkBuffers(staging.transaction.handle));this.uploadStaging.clear();
    for (const entry of this.chunkBuffers.values()) safely(() => this.bufferManager?.disposeChunkBuffers(entry.handle));
    this.chunkBuffers.clear();
    for (const entry of this.visualChunkBuffers.values()) safely(() => this.bufferManager?.disposeChunkBuffers(entry.handle));
    this.visualChunkBuffers.clear();
    for (const entry of this.regionBuffers.values()) for (const member of entry.members?.values() ?? []) safely(() => this.bufferManager?.disposeChunkBuffers(member.handle));
    this.regionBuffers.clear();
    for (const entry of this.visualRegionBuffers.values()) for (const member of entry.members?.values() ?? []) safely(() => this.bufferManager?.disposeChunkBuffers(member.handle));
    this.visualRegionBuffers.clear();
    safely(() => this.bufferManager?.dispose?.({lost:this.contextLost}));
    safely(() => this.releaseAvatarInstances(null,{lost:this.contextLost}));
    safely(() => this.sortedIndexStream?.dispose({lost:this.contextLost})); this.sortedIndexStream=null;
    this.clearFramePools();
    for (const entry of this.avatarBuffers.values()) safely(() => this.disposeAvatarBuffers(entry.handle));
    this.avatarBuffers.clear();
    this.avatarResourceCache=new WeakMap();this.cpuMeshBytesDirty=true;
    this.regionGroupCache.clear();
    this.frustumFilterCache = null;
    this.preparedRenderFrame = null;
    this.renderFrameInputs?.clear();
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
    this.avatarMeshes.clear(); this.retryUploads.clear(); this.pendingUploadSince.clear();this.uploadWaitFrames.clear();this.pendingMeshSources.clear();this.prefetchQueueCache=null;this.avatarFrameStates.clear();
    this.avatarSnapshotCache = new WeakMap();
    this.canvasResizeObserver?.disconnect(); this.canvasResizeObserver = null;
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
      indexBytes: mesh.indices.BYTES_PER_ELEMENT,
      drawIndices: mesh.indices,
      drawVertices: mesh.vertices,
      stride,
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

function previewSortUnits(entry) {
  if (entry.previewSortedHandle === entry.handle) return entry.previewSortedUnits;
  const handle = entry.handle, vertices = handle.drawVertices ?? entry.mesh.vertices,
    indices = handle.drawIndices ?? entry.mesh.indices, start = handle.indexStart ?? 0,
    vertexStart = handle.vertexStart ?? 0, units = [];
  const data = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  for (const pass of ['opaque', 'cutout', 'blend']) {
    const range = handle.drawRanges?.[pass]; if (!range?.count) continue;
    for (let i = range.offset; i < range.offset + range.count; i += 3) {
      const center = [0, 0, 0];
      for (let corner = 0; corner < 3; corner++) {
        const offset = (indices[i - start + corner] - vertexStart) * 20,
          scale = Math.max(1, data.getInt16(offset + 6, true));
        for (let axis = 0; axis < 3; axis++) center[axis] += data.getInt16(offset + axis * 2, true) / scale / 3;
      }
      units.push({ pass, offset: i, sortOffset: i - start, count: 3, center });
    }
  }
  entry.previewSortedHandle = handle; entry.previewSortedUnits = units;
  return units;
}

function sharedPlacement(chunk,mesh,enabled) {
  if(!enabled || chunk.buildingPreview || !Number.isSafeInteger(chunk.chunkSize) || chunk.chunkSize<=0)return null;
  return {x:chunk.chunkX*chunk.chunkSize,y:mesh.originY??chunk.originY??0,z:chunk.chunkZ*chunk.chunkSize};
}
function shaderChunkOffset(handle,origin,fallback) {
  const page=handle.sharedPage;
  return page?[page.x-origin.worldX,page.y-origin.worldY,page.z-origin.worldZ]:fallback;
}
function ensureMultiDrawCapacity(renderer,count) {
  if(count<=renderer.multiDrawCounts.length)return;
  const length=Math.max(count,renderer.multiDrawCounts.length*2);
  const counts=new Int32Array(length),offsets=new Int32Array(length);
  counts.set(renderer.multiDrawCounts);offsets.set(renderer.multiDrawOffsets);
  renderer.multiDrawCounts=counts;renderer.multiDrawOffsets=offsets;
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
    "uUseChunkOffset",
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
  const retired=renderer.emptyChannelRetirements??=new WeakMap();
  for (const chunk of chunks) {
    if (!chunk) continue;
    retire(false);
    retire(true);

    function retire(visual) {
      const mesh = visual ? chunk?.visualMesh : chunk?.mesh;
      const revision = committedMeshVersion(chunk, visual);
      if (revision < 0 || mesh?.indexCount) {const prior=retired.get(chunk);if(prior)prior[visual?1:0]=null;return;}
      let state=retired.get(chunk);
      const prior=state?.[visual?1:0];
      if(prior&&prior.mesh===mesh&&prior.revision===revision&&prior.generation===renderer.contextGeneration)return;
      if(!state){state=[];retired.set(chunk,state);}
      state[visual?1:0]={mesh,revision,generation:renderer.contextGeneration};
      const buffers = visual ? renderer.visualChunkBuffers : renderer.chunkBuffers;
      const regions=visual?renderer.visualRegionBuffers:renderer.regionBuffers;
      const key=`${visual?'visual':'opaque'}:${chunk.id}`;
      const staged=renderer.uploadStaging.get(key);
      if(staged){renderer.bufferManager?.disposeChunkBuffers(staged.transaction.handle);renderer.uploadStaging.delete(key);}
      renderer.pendingUploadSince.delete(key);renderer.pendingMeshSources.delete(key);renderer.uploadWaitFrames?.delete(key);renderer.retryUploads.delete(key);
      const region=regionBatchEligible(chunk)?regions.get(regionIdForChunk(chunk,renderer.options.regionChunkSize)):null;
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
  return cameraRenderCenterChunk(cameraState, chunkSize);
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
export function flattenRenderSections(chunks,{includeEmpty=true}={}){const out=[];for(const chunk of chunks??[]){if(chunk?.renderSections instanceof Map && chunk.renderSections.size){for(const section of (!includeEmpty&&chunk.renderActiveSections || chunk.renderSections.values())){if(!includeEmpty&&!section.mesh?.indexCount&&!section.visualMesh?.indexCount)continue;if(section.parentId==null)section.parentId=chunk.id;out.push(section);}}else out.push(chunk);}return out;}
