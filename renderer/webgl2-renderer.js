import { DEFAULT_VIEW_DISTANCE, MAX_DESKTOP_DPR, MAX_MOBILE_DPR } from "../core/constants.js";
import { cameraOrigin, cameraViewProjection } from "./camera.js";
import { filterChunksByCameraFrustum } from "./frustum.js";
import { updateAvatarMeshVertices } from "./avatar-mesh.js";
import { BufferManager } from "./buffer-manager.js";
import { CloudLayer } from "./cloud-layer.js";
import { applyLightingUniforms, createWorldLighting } from "./lighting.js";
import { createProgram, OPAQUE_FRAGMENT_SHADER, OPAQUE_VERTEX_SHADER } from "./shader-manager.js";
import { ProjectedShadowLayer } from "./projected-shadow-layer.js";
import { SkyGradient } from "./sky-gradient.js";
import { SunDisc } from "./sun-disc.js";
import { TextureArrayManager } from "./texture-array-manager.js";
import { VoxelOverlay } from "./voxel-overlay.js";
import { VoxelParticleLayer } from "./voxel-particle-layer.js";

const AVATAR_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;

uniform mat4 uViewProjection;
uniform vec3 uAvatarOrigin;
uniform float uAvatarYaw;

out vec3 vNormal;
out vec4 vColor;
out float vFogDepth;

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
  vFogDepth = max(0.0, gl_Position.w);
}
`;

const AVATAR_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyLightColor;
uniform vec3 uGroundLightColor;
uniform vec3 uFogColor;
uniform vec2 uFogNearFar;
uniform vec4 uLightParams;
uniform float uAvatarOpacity;

in vec3 vNormal;
in vec4 vColor;
in float vFogDepth;

out vec4 outColor;

void main() {
  vec3 normal = normalize(vNormal);
  float sun = max(dot(normal, normalize(uSunDirection)), 0.0);
  float hemiUp = normal.y * 0.5 + 0.5;
  vec3 ambient = uSkyLightColor * uLightParams.x;
  vec3 hemi = mix(uGroundLightColor, uSkyLightColor, hemiUp) * uLightParams.z;
  vec3 direct = uSunColor * (sun * uLightParams.y);
  vec3 color = vColor.rgb * (ambient + hemi + direct) * uLightParams.w;
  float fog = smoothstep(uFogNearFar.x, uFogNearFar.y, vFogDepth);
  outColor = vec4(mix(color, uFogColor, fog), vColor.a * uAvatarOpacity);
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
    };
    this.onInitStage = typeof options.onInitStage === "function" ? options.onInitStage : null;
    this.gl = null;
    this.program = null;
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
    this._contextListenersAttached = false;
    this._onContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.initialized = false;
    };
    this._onContextRestored = () => {
      this.contextLost = false;
      this.chunkBuffers.clear();
      this.visualChunkBuffers.clear();
      this.regionBuffers.clear();
      this.visualRegionBuffers.clear();
      this.avatarBuffers.clear();
      this.regionGroupCache.clear();
      this.frustumFilterCache = null;
      this.init();
    };
    this.attachContextListeners();
  }

  init() {
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
      const gl = runStage("context", () => this.canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: true,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
      }), (context) => webGlContextDetails(context));
      if (!gl) throw new Error("WebGL2 is not available in this browser.");
      this.gl = gl;
      runStage("shader programs", () => {
        this.program = createProgram(gl, OPAQUE_VERTEX_SHADER, OPAQUE_FRAGMENT_SHADER);
        this.avatarProgram = createProgram(gl, AVATAR_VERTEX_SHADER, AVATAR_FRAGMENT_SHADER);
        this.uniforms = collectUniforms(gl, this.program);
        this.avatarUniforms = collectAvatarUniforms(gl, this.avatarProgram);
      });
      this.bufferManager = new BufferManager(gl);
      this.textureArray = new TextureArrayManager(gl, {
        tileSize: this.options.textureTileSize,
        seed: this.options.textureSeed,
      });
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      runStage("baked texture array", () => this.textureArray.createTextureArray(), () => ({
        layers: this.textureArray.layerCount,
        tileSize: this.textureArray.tileSize,
      }));
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
      this.initialized = true;
      return this;
    } catch (error) {
      this.releaseContextResources();
      restoreCanvasDimensions(this.canvas, canvasDimensions);
      this.detachContextListeners();
      throw error;
    }
  }

  resize(width = null, height = null, dpr = null) {
    const gl = this.gl;
    if (!gl) return false;
    const rect = this.canvas.getBoundingClientRect?.() ?? { width: this.canvas.clientWidth || 1, height: this.canvas.clientHeight || 1 };
    const cssWidth = Math.max(1, Math.floor(width ?? rect.width ?? 1));
    const cssHeight = Math.max(1, Math.floor(height ?? rect.height ?? 1));
    const pixelRatio = this.clampedDpr(dpr);
    const targetWidth = Math.max(1, Math.floor(cssWidth * pixelRatio));
    const targetHeight = Math.max(1, Math.floor(cssHeight * pixelRatio));
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

  uploadChunk(chunkState) {
    if (!chunkState?.mesh || !chunkState.mesh.indexCount) return null;
    if (!this.initialized) this.init();
    const startedAt = performance.now();
    const existing = this.chunkBuffers.get(chunkState.id);
    const handle = this.bufferManager.createChunkBuffers(chunkState.mesh);
    const entry = {
      id: chunkState.id,
      version: committedMeshVersion(chunkState, false),
      chunkX: chunkState.chunkX,
      chunkZ: chunkState.chunkZ,
      handle,
    };
    this.chunkBuffers.set(chunkState.id, entry);
    if (existing) this.bufferManager.disposeChunkBuffers(existing.handle);
    chunkState.gpuUploaded = true;
    this.logRenderEvent("chunk-upload", {
      chunkId: chunkState.id,
      chunkX: chunkState.chunkX,
      chunkZ: chunkState.chunkZ,
      meshType: "opaque",
      elapsedMs: performance.now() - startedAt,
      triangles: chunkState.mesh.triangleCount || 0,
      bytes: handle.byteLength || 0,
    });
    return entry;
  }

  updateChunk(chunkState) {
    if (!chunkState?.mesh || !chunkState.mesh.indexCount) return null;
    const existing = this.chunkBuffers.get(chunkState.id);
    if (!existing || existing.version !== committedMeshVersion(chunkState, false) || !chunkState.gpuUploaded) return this.uploadChunk(chunkState);
    return existing;
  }

  removeChunk(chunkId) {
    const existing = this.chunkBuffers.get(chunkId);
    if (existing) {
      this.bufferManager?.disposeChunkBuffers(existing.handle);
      this.chunkBuffers.delete(chunkId);
    }
    const visual = this.visualChunkBuffers.get(chunkId);
    if (visual) {
      this.bufferManager?.disposeChunkBuffers(visual.handle);
      this.visualChunkBuffers.delete(chunkId);
    }
    for (const [regionId, region] of Array.from(this.regionBuffers.entries())) {
      if (!region.chunkIds?.has(chunkId)) continue;
      this.bufferManager?.disposeChunkBuffers(region.handle);
      this.regionBuffers.delete(regionId);
    }
    for (const [regionId, region] of Array.from(this.visualRegionBuffers.entries())) {
      if (!region.chunkIds?.has(chunkId)) continue;
      this.bufferManager?.disposeChunkBuffers(region.handle);
      this.visualRegionBuffers.delete(regionId);
    }
  }

  pruneChunks(liveChunkIds) {
    const live = liveChunkIds instanceof Set ? liveChunkIds : new Set(liveChunkIds ?? []);
    for (const id of Array.from(this.chunkBuffers.keys())) {
      if (!live.has(id)) this.removeChunk(id);
    }
    for (const id of Array.from(this.visualChunkBuffers.keys())) {
      if (!live.has(id)) this.removeChunk(id);
    }
    for (const [regionId, region] of Array.from(this.regionBuffers.entries())) {
      for (const chunkId of region.chunkIds ?? []) {
        if (live.has(chunkId)) continue;
        this.bufferManager?.disposeChunkBuffers(region.handle);
        this.regionBuffers.delete(regionId);
        break;
      }
    }
    for (const [regionId, region] of Array.from(this.visualRegionBuffers.entries())) {
      for (const chunkId of region.chunkIds ?? []) {
        if (live.has(chunkId)) continue;
        this.bufferManager?.disposeChunkBuffers(region.handle);
        this.visualRegionBuffers.delete(regionId);
        break;
      }
    }
  }

  uploadVisualChunk(chunkState) {
    if (!chunkState?.visualMesh || !chunkState.visualMesh.indexCount) return null;
    if (!this.initialized) this.init();
    const startedAt = performance.now();
    const existing = this.visualChunkBuffers.get(chunkState.id);
    const handle = this.bufferManager.createChunkBuffers(chunkState.visualMesh);
    const entry = {
      id: chunkState.id,
      version: committedMeshVersion(chunkState, true),
      chunkX: chunkState.chunkX,
      chunkZ: chunkState.chunkZ,
      handle,
    };
    this.visualChunkBuffers.set(chunkState.id, entry);
    if (existing) this.bufferManager.disposeChunkBuffers(existing.handle);
    chunkState.visualGpuUploaded = true;
    this.logRenderEvent("chunk-upload", {
      chunkId: chunkState.id,
      chunkX: chunkState.chunkX,
      chunkZ: chunkState.chunkZ,
      meshType: "visual",
      elapsedMs: performance.now() - startedAt,
      triangles: chunkState.visualMesh.triangleCount || 0,
      bytes: handle.byteLength || 0,
    });
    return entry;
  }

  updateVisualChunk(chunkState) {
    if (!chunkState?.visualMesh || !chunkState.visualMesh.indexCount) return null;
    const existing = this.visualChunkBuffers.get(chunkState.id);
    if (!existing || existing.version !== committedMeshVersion(chunkState, true) || !chunkState.visualGpuUploaded) return this.uploadVisualChunk(chunkState);
    return existing;
  }

  prepareChunksForRender(visibleChunks = [], {
    maxUploads = this.options.maxChunkUploadsPerFrame,
    deferRegionUploads = false,
    cameraState = null,
  } = {}) {
    if (!this.initialized) this.init();
    const chunks = this.filterChunksForCamera(visibleChunks, cameraState);
    retireCommittedEmptyChunkBuffers(this, chunks);
    const limit = Math.max(0, Math.trunc(maxUploads ?? 0));
    let uploaded = 0;
    let pendingUploads = 0;
    let priorityVisualUploads = 0;
    const priorityVisualLimit = Math.min(limit, Math.max(1, Math.floor(limit / 2)));
    const pendingKeys = new Set();
    const addPending = (key) => {
      if (pendingKeys.has(key)) return;
      pendingKeys.add(key);
      pendingUploads += 1;
    };
    const markUploaded = (key) => {
      if (!pendingKeys.delete(key)) return;
      pendingUploads = Math.max(0, pendingUploads - 1);
    };
    if (this.options.useRegionBatching) {
      if (deferRegionUploads) {
        // A stale region is still drawn as one indivisible GPU buffer and would
        // hide newer per-chunk staging buffers. Replace already-visible stale
        // regions first so confirmed world edits remain visible while streaming.
        const opaqueRegions = this.getRegionGroups(chunks, "mesh");
        const visualRegions = this.getRegionGroups(chunks, "visualMesh");
        for (const region of opaqueRegions) {
          const existing = this.regionBuffers.get(region.id);
          if (!existing?.handle) continue;
          const signature = regionSignature(region.chunks, "mesh");
          if (existing.signature === signature) continue;
          if (uploaded >= limit) {
            addPending(`opaque-region:${region.id}`);
            continue;
          }
          markUploaded(`opaque-region:${region.id}`);
          this.uploadRegion(region, signature);
          uploaded += 1;
        }
        for (const region of visualRegions) {
          const existing = this.visualRegionBuffers.get(region.id);
          if (!existing?.handle || !regionOpaqueReady(this, region)) continue;
          const signature = regionSignature(region.chunks, "visualMesh");
          if (existing.signature === signature) continue;
          if (uploaded >= limit || priorityVisualUploads >= priorityVisualLimit) {
            addPending(`visual-region:${region.id}`);
            continue;
          }
          markUploaded(`visual-region:${region.id}`);
          this.uploadRegion(region, signature, { visual: true });
          uploaded += 1;
          priorityVisualUploads += 1;
        }
        for (const chunk of chunks) {
          if (!chunk?.visualMesh?.indexCount) continue;
          if (!opaqueReadyForChunk(this, chunk)) continue;
          if (chunkCoveredByRegion(this.visualRegionBuffers, chunk, this.options.regionChunkSize, true)) continue;
          if (!needsUpload(this.visualChunkBuffers, chunk, true)) continue;
          if (uploaded >= limit || priorityVisualUploads >= priorityVisualLimit) {
            addPending(`visual:${chunk.id}`);
            continue;
          }
          markUploaded(`visual:${chunk.id}`);
          this.updateVisualChunk(chunk);
          uploaded += 1;
          priorityVisualUploads += 1;
        }
        for (const chunk of chunks) {
          if (!chunk?.mesh?.indexCount) continue;
          if (chunkCoveredByRegion(this.regionBuffers, chunk, this.options.regionChunkSize)) continue;
          if (!needsUpload(this.chunkBuffers, chunk, false)) continue;
          if (uploaded >= limit) {
            addPending(`opaque:${chunk.id}`);
            continue;
          }
          markUploaded(`opaque:${chunk.id}`);
          this.updateChunk(chunk);
          uploaded += 1;
        }
        for (const chunk of chunks) {
          if (!chunk?.visualMesh?.indexCount) continue;
          if (chunkCoveredByRegion(this.visualRegionBuffers, chunk, this.options.regionChunkSize, true)) continue;
          if (!needsUpload(this.visualChunkBuffers, chunk, true)) continue;
          if (uploaded >= limit) {
            addPending(`visual:${chunk.id}`);
            continue;
          }
          markUploaded(`visual:${chunk.id}`);
          this.updateVisualChunk(chunk);
          uploaded += 1;
        }
        return { uploaded, pendingUploads };
      }
      const regions = this.getRegionGroups(chunks, "mesh");
      const visualRegions = this.getRegionGroups(chunks, "visualMesh");
      const individualChunks = chunks.filter((chunk) => !regionBatchEligible(chunk));
      for (const chunk of individualChunks) {
        if (!chunk?.visualMesh?.indexCount) continue;
        if (!opaqueReadyForChunk(this, chunk)) continue;
        if (!needsUpload(this.visualChunkBuffers, chunk, true)) continue;
        if (uploaded >= limit || priorityVisualUploads >= priorityVisualLimit) {
          addPending(`visual:${chunk.id}`);
          continue;
        }
        markUploaded(`visual:${chunk.id}`);
        this.updateVisualChunk(chunk);
        uploaded += 1;
        priorityVisualUploads += 1;
      }
      for (const region of visualRegions) {
        if (!region.chunks.length || !regionOpaqueReady(this, region)) continue;
        const existing = this.visualRegionBuffers.get(region.id);
        const signature = regionSignature(region.chunks, "visualMesh");
        if (existing?.signature === signature) continue;
        if (uploaded >= limit || priorityVisualUploads >= priorityVisualLimit) {
          addPending(`visual-region:${region.id}`);
          continue;
        }
        markUploaded(`visual-region:${region.id}`);
        this.uploadRegion(region, signature, { visual: true });
        uploaded += 1;
        priorityVisualUploads += 1;
      }
      for (const region of regions) {
        if (!region.chunks.length) continue;
        const existing = this.regionBuffers.get(region.id);
        const signature = regionSignature(region.chunks, "mesh");
        if (existing?.signature === signature) continue;
        if (uploaded >= limit) {
          addPending(`opaque-region:${region.id}`);
          continue;
        }
        markUploaded(`opaque-region:${region.id}`);
        this.uploadRegion(region, signature);
        uploaded += 1;
      }
      for (const chunk of individualChunks) {
        if (!chunk?.mesh?.indexCount) continue;
        if (!needsUpload(this.chunkBuffers, chunk, false)) continue;
        if (uploaded >= limit) {
          addPending(`opaque:${chunk.id}`);
          continue;
        }
        markUploaded(`opaque:${chunk.id}`);
        this.updateChunk(chunk);
        uploaded += 1;
      }
      for (const region of visualRegions) {
        if (!region.chunks.length) continue;
        const existing = this.visualRegionBuffers.get(region.id);
        const signature = regionSignature(region.chunks, "visualMesh");
        if (existing?.signature === signature) continue;
        if (uploaded >= limit) {
          addPending(`visual-region:${region.id}`);
          continue;
        }
        markUploaded(`visual-region:${region.id}`);
        this.uploadRegion(region, signature, { visual: true });
        uploaded += 1;
      }
      for (const chunk of individualChunks) {
        if (!chunk?.visualMesh?.indexCount) continue;
        if (!needsUpload(this.visualChunkBuffers, chunk, true)) continue;
        if (uploaded >= limit) {
          addPending(`visual:${chunk.id}`);
          continue;
        }
        markUploaded(`visual:${chunk.id}`);
        this.updateVisualChunk(chunk);
        uploaded += 1;
      }
      return { uploaded, pendingUploads };
    }
    for (const chunk of chunks) {
      if (!chunk?.visualMesh?.indexCount) continue;
      if (!opaqueReadyForChunk(this, chunk)) continue;
      if (!needsUpload(this.visualChunkBuffers, chunk, true)) continue;
      if (uploaded >= limit || priorityVisualUploads >= priorityVisualLimit) {
        addPending(`visual:${chunk.id}`);
        continue;
      }
      markUploaded(`visual:${chunk.id}`);
      this.updateVisualChunk(chunk);
      uploaded += 1;
      priorityVisualUploads += 1;
    }
    for (const chunk of chunks) {
      if (!chunk?.mesh?.indexCount) continue;
      if (!needsUpload(this.chunkBuffers, chunk, false)) continue;
      if (uploaded >= limit) {
        addPending(`opaque:${chunk.id}`);
        continue;
      }
      markUploaded(`opaque:${chunk.id}`);
      this.updateChunk(chunk);
      uploaded += 1;
    }
    for (const chunk of chunks) {
      if (!chunk?.visualMesh?.indexCount) continue;
      if (!needsUpload(this.visualChunkBuffers, chunk, true)) continue;
      if (uploaded >= limit) {
        addPending(`visual:${chunk.id}`);
        continue;
      }
      markUploaded(`visual:${chunk.id}`);
      this.updateVisualChunk(chunk);
      uploaded += 1;
    }
    return { uploaded, pendingUploads };
  }

  uploadRegion(region, signature = regionSignature(region.chunks, region.meshField), { visual = false } = {}) {
    if (!region?.chunks?.length) return null;
    if (!this.initialized) this.init();
    const startedAt = performance.now();
    const mesh = combineChunkMeshes(region, region.meshField);
    if (!mesh?.indexCount) return null;
    const target = visual ? this.visualRegionBuffers : this.regionBuffers;
    const existing = target.get(region.id);
    const handle = this.bufferManager.createChunkBuffers(mesh);
    const entry = {
      id: region.id,
      signature,
      regionX: region.regionX,
      regionZ: region.regionZ,
      originChunkX: region.originChunkX,
      originChunkZ: region.originChunkZ,
      chunkIds: new Set(region.chunks.map((chunk) => chunk.id)),
      chunkVersions: new Map(region.chunks.map((chunk) => [chunk.id, committedMeshVersion(chunk, visual)])),
      handle,
    };
    target.set(region.id, entry);
    if (existing) this.bufferManager.disposeChunkBuffers(existing.handle);
    for (const chunk of region.chunks) {
      const stagingBuffers = visual ? this.visualChunkBuffers : this.chunkBuffers;
      const staging = stagingBuffers.get(chunk.id);
      if (staging) {
        this.bufferManager.disposeChunkBuffers(staging.handle);
        stagingBuffers.delete(chunk.id);
      }
      if (visual) chunk.visualGpuUploaded = true;
      else chunk.gpuUploaded = true;
    }
    const elapsedMs = performance.now() - startedAt;
    this.logRenderEvent("region-upload", {
      regionId: region.id,
      meshType: visual ? "visual" : "opaque",
      elapsedMs,
      triangles: mesh.triangleCount || 0,
      bytes: handle.byteLength || mesh.byteLength || 0,
      chunkIds: region.chunks.map((chunk) => chunk.id),
      estimatedChunkMs: estimateChunkCosts(region.chunks, region.meshField, elapsedMs),
    });
    return entry;
  }

  uploadAvatarMesh(id, mesh) {
    if (!mesh?.vertices || !mesh?.indices) return null;
    if (!this.initialized) this.init();
    const key = String(id || mesh.name || "avatar");
    const existing = this.avatarBuffers.get(key);
    if (existing) this.disposeAvatarBuffers(existing.handle);
    const handle = this.createAvatarBuffers(mesh);
    const entry = { id: key, handle, mesh };
    this.avatarBuffers.set(key, entry);
    return entry;
  }

  removeAvatarMesh(id) {
    const key = String(id);
    const existing = this.avatarBuffers.get(key);
    if (!existing) return;
    this.disposeAvatarBuffers(existing.handle);
    this.avatarBuffers.delete(key);
  }

  emitVoxelParticles(kind, options = {}) {
    if (!this.initialized) this.init();
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
    if (!this.initialized) this.init();
    if (this.contextLost || !this.gl || !this.program) return this.stats;
    const gl = this.gl;
    this.resize();
    cameraState.aspect = Math.max(1, this.canvas.width) / Math.max(1, this.canvas.height);
    const renderChunks = this.filterChunksForCamera(
      filterChunksByRenderRadius(visibleChunks, cameraState, this.options.viewDistance),
      cameraState,
    );
    const previewChunks = renderChunks.filter((chunk) => chunk?.buildingPreview === true);
    const worldChunks = previewChunks.length
      ? renderChunks.filter((chunk) => chunk?.buildingPreview !== true)
      : renderChunks;
    const logDraw = Boolean(this.renderLogger?.enabled);
    const frameId = ++this.renderFrameId;
    if (logDraw) this.renderLogger.beginFrame({ visibleChunks: renderChunks.length });
    const viewProjection = cameraViewProjection(cameraState);
    const origin = cameraOrigin(cameraState);
    const lighting = this.lighting;
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
    const cloudStats = this.renderClouds(this.cloudViewProjection(cameraState), origin, lighting);
    drawCalls += cloudStats.drawCalls;
    triangles += cloudStats.triangles;
    bufferMemory += cloudStats.bufferMemory;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, viewProjection);
    gl.uniform1f(this.uniforms.uTileScale, 1.0);
    gl.uniform1f(this.uniforms.uOpacity, 1.0);
    applyLightingUniforms(gl, this.uniforms, lighting);
    gl.uniform1f(this.uniforms.uTime, performance.now() * 0.001);
    gl.uniform2f(this.uniforms.uWorldOrigin, origin.worldX, origin.worldZ);
    this.textureArray.bind(0);

    let renderedChunks = renderChunks.length;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    if (this.options.useRegionBatching) {
      const renderedChunkIds = new Set();
      for (const region of this.getRegionGroups(worldChunks, "mesh")) {
        const entry = this.regionBuffers.get(region.id);
        if (!entry?.handle) continue;
        const drawableChunkIds = regionDrawableChunkIds(entry, region.chunks);
        if (!drawableChunkIds.size) continue;
        const handle = entry.handle;
        const originX = entry.originChunkX * region.chunkSize - origin.worldX;
        const originY = -origin.worldY;
        const originZ = entry.originChunkZ * region.chunkSize - origin.worldZ;
        gl.uniform3f(this.uniforms.uChunkOrigin, originX, originY, originZ);
        gl.bindVertexArray(handle.vao);
        const drawStartedAt = logDraw ? performance.now() : 0;
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        if (logDraw) {
          this.logRenderEvent("region-draw", {
            frame: frameId,
            regionId: region.id,
            meshType: "opaque",
            elapsedMs: performance.now() - drawStartedAt,
            triangles: handle.triangleCount,
            bytes: handle.byteLength,
            chunkIds: Array.from(entry.chunkIds ?? []),
            estimatedChunkMs: estimateRegionEntryChunkCosts(entry, worldChunks, "mesh", performance.now() - drawStartedAt),
          });
        }
        drawCalls += 1;
        triangles += handle.triangleCount;
        bufferMemory += handle.byteLength;
        for (const id of drawableChunkIds) renderedChunkIds.add(id);
      }
      for (const chunk of worldChunks) {
        if (renderedChunkIds.has(chunk.id) || !chunk?.mesh) continue;
        const entry = this.chunkBuffers.get(chunk.id);
        if (!entry?.handle) continue;
        const handle = entry.handle;
        const originX = chunk.chunkX * chunk.chunkSize - origin.worldX;
        const originY = -origin.worldY;
        const originZ = chunk.chunkZ * chunk.chunkSize - origin.worldZ;
        gl.uniform3f(this.uniforms.uChunkOrigin, originX, originY, originZ);
        gl.bindVertexArray(handle.vao);
        const drawStartedAt = logDraw ? performance.now() : 0;
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        if (logDraw) {
          this.logRenderEvent("chunk-draw", {
            frame: frameId,
            chunkId: chunk.id,
            chunkX: chunk.chunkX,
            chunkZ: chunk.chunkZ,
            meshType: "opaque",
            elapsedMs: performance.now() - drawStartedAt,
            triangles: handle.triangleCount,
            bytes: handle.byteLength,
          });
        }
        drawCalls += 1;
        triangles += handle.triangleCount;
        bufferMemory += handle.byteLength;
      }
    } else {
      renderedChunks = 0;
      for (const chunk of worldChunks) {
        if (!chunk?.mesh) continue;
        const entry = this.chunkBuffers.get(chunk.id);
        if (!entry?.handle) continue;
        const handle = entry.handle;
        const originX = chunk.chunkX * chunk.chunkSize - origin.worldX;
        const originY = -origin.worldY;
        const originZ = chunk.chunkZ * chunk.chunkSize - origin.worldZ;
        gl.uniform3f(this.uniforms.uChunkOrigin, originX, originY, originZ);
        gl.bindVertexArray(handle.vao);
        const drawStartedAt = logDraw ? performance.now() : 0;
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        if (logDraw) {
          this.logRenderEvent("chunk-draw", {
            frame: frameId,
            chunkId: chunk.id,
            chunkX: chunk.chunkX,
            chunkZ: chunk.chunkZ,
            meshType: "opaque",
            elapsedMs: performance.now() - drawStartedAt,
            triangles: handle.triangleCount,
            bytes: handle.byteLength,
          });
        }
        drawCalls += 1;
        triangles += handle.triangleCount;
        bufferMemory += handle.byteLength;
        renderedChunks += 1;
      }
    }
    gl.bindVertexArray(null);

    const projectedShadowStats = this.renderProjectedShadows(avatars, viewProjection, origin, lighting);
    drawCalls += projectedShadowStats.drawCalls;
    triangles += projectedShadowStats.triangles;
    bufferMemory += projectedShadowStats.bufferMemory;

    const avatarStats = this.renderAvatars(cameraState, avatars, viewProjection, origin, lighting);
    drawCalls += avatarStats.drawCalls;
    triangles += avatarStats.triangles;
    bufferMemory += avatarStats.bufferMemory;

    const visualStats = this.renderVisualChunks(worldChunks, origin);
    drawCalls += visualStats.drawCalls;
    triangles += visualStats.triangles;
    bufferMemory += visualStats.bufferMemory;

    const buildingPreviewStats = this.renderBuildingPreviewChunks(previewChunks, origin);
    drawCalls += buildingPreviewStats.drawCalls;
    triangles += buildingPreviewStats.triangles;
    bufferMemory += buildingPreviewStats.bufferMemory;
    if (!this.options.useRegionBatching) renderedChunks += buildingPreviewStats.renderedChunks;

    const particleStats = this.renderVoxelParticles(viewProjection, origin, lighting);
    drawCalls += particleStats.drawCalls;
    triangles += particleStats.triangles;
    bufferMemory += particleStats.bufferMemory;

    const overlayStats = this.renderVoxelOverlays(viewProjection, origin, overlays);
    drawCalls += overlayStats.drawCalls;
    triangles += overlayStats.triangles;
    bufferMemory += overlayStats.bufferMemory;

    this.stats = {
      backend: "webgl2",
      drawCalls,
      visibleChunks: renderedChunks,
      triangles,
      bufferMemory,
      gpuChunks: this.regionBuffers.size + this.visualRegionBuffers.size + this.chunkBuffers.size + this.visualChunkBuffers.size,
      width: this.canvas.width,
      height: this.canvas.height,
      dpr: this.clampedDpr(),
    };
    this.frustumFilterCache = null;
    return this.stats;
  }

  renderClouds(viewProjection, origin, lighting) {
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

  renderVisualChunks(visibleChunks, origin) {
    const gl = this.gl;
    if (!this.program) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    const logDraw = Boolean(this.renderLogger?.enabled);
    const frameId = this.renderFrameId;
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.uOpacity, 1.0);
    gl.uniform2f(this.uniforms.uWorldOrigin, origin.worldX, origin.worldZ);
    this.textureArray.bind(0);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    let drawCalls = 0;
    let triangles = 0;
    let bufferMemory = 0;
    if (this.options.useRegionBatching) {
      const renderedChunkIds = new Set();
      for (const region of this.getRegionGroups(visibleChunks, "visualMesh")) {
        const entry = this.visualRegionBuffers.get(region.id);
        if (!entry?.handle) continue;
        const drawableChunkIds = regionDrawableChunkIds(entry, region.chunks);
        if (!drawableChunkIds.size) continue;
        const handle = entry.handle;
        const originX = entry.originChunkX * region.chunkSize - origin.worldX;
        const originY = -origin.worldY;
        const originZ = entry.originChunkZ * region.chunkSize - origin.worldZ;
        gl.uniform3f(this.uniforms.uChunkOrigin, originX, originY, originZ);
        gl.bindVertexArray(handle.vao);
        const drawStartedAt = logDraw ? performance.now() : 0;
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        if (logDraw) {
          this.logRenderEvent("region-draw", {
            frame: frameId,
            regionId: region.id,
            meshType: "visual",
            elapsedMs: performance.now() - drawStartedAt,
            triangles: handle.triangleCount,
            bytes: handle.byteLength,
            chunkIds: Array.from(entry.chunkIds ?? []),
            estimatedChunkMs: estimateRegionEntryChunkCosts(entry, visibleChunks, "visualMesh", performance.now() - drawStartedAt),
          });
        }
        drawCalls += 1;
        triangles += handle.triangleCount;
        bufferMemory += handle.byteLength;
        for (const id of drawableChunkIds) renderedChunkIds.add(id);
      }
      for (const chunk of visibleChunks) {
        if (renderedChunkIds.has(chunk.id) || !chunk?.visualMesh?.indexCount) continue;
        const entry = this.visualChunkBuffers.get(chunk.id);
        if (!entry?.handle) continue;
        const handle = entry.handle;
        const originX = chunk.chunkX * chunk.chunkSize - origin.worldX;
        const originY = -origin.worldY;
        const originZ = chunk.chunkZ * chunk.chunkSize - origin.worldZ;
        gl.uniform3f(this.uniforms.uChunkOrigin, originX, originY, originZ);
        gl.bindVertexArray(handle.vao);
        const drawStartedAt = logDraw ? performance.now() : 0;
        gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
        if (logDraw) {
          this.logRenderEvent("chunk-draw", {
            frame: frameId,
            chunkId: chunk.id,
            chunkX: chunk.chunkX,
            chunkZ: chunk.chunkZ,
            meshType: "visual",
            elapsedMs: performance.now() - drawStartedAt,
            triangles: handle.triangleCount,
            bytes: handle.byteLength,
          });
        }
        drawCalls += 1;
        triangles += handle.triangleCount;
        bufferMemory += handle.byteLength;
      }
      gl.bindVertexArray(null);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      return { drawCalls, triangles, bufferMemory };
    }
    for (const chunk of visibleChunks) {
      if (!chunk?.visualMesh?.indexCount) continue;
      const entry = this.visualChunkBuffers.get(chunk.id);
      if (!entry?.handle) continue;
      const handle = entry.handle;
      const originX = chunk.chunkX * chunk.chunkSize - origin.worldX;
      const originY = -origin.worldY;
      const originZ = chunk.chunkZ * chunk.chunkSize - origin.worldZ;
      gl.uniform3f(this.uniforms.uChunkOrigin, originX, originY, originZ);
      gl.bindVertexArray(handle.vao);
      const drawStartedAt = logDraw ? performance.now() : 0;
      gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
      if (logDraw) {
        this.logRenderEvent("chunk-draw", {
          frame: frameId,
          chunkId: chunk.id,
          chunkX: chunk.chunkX,
          chunkZ: chunk.chunkZ,
          meshType: "visual",
          elapsedMs: performance.now() - drawStartedAt,
          triangles: handle.triangleCount,
          bytes: handle.byteLength,
        });
      }
      drawCalls += 1;
      triangles += handle.triangleCount;
      bufferMemory += handle.byteLength;
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    return { drawCalls, triangles, bufferMemory };
  }

  renderBuildingPreviewChunks(visibleChunks, origin, opacity = 0.46) {
    if (!visibleChunks?.length || !this.program) return { drawCalls: 0, triangles: 0, bufferMemory: 0, renderedChunks: 0 };
    const gl = this.gl;
    const alpha = Math.min(0.85, Math.max(0.08, Number(opacity) || 0.46));
    const logDraw = Boolean(this.renderLogger?.enabled);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.uOpacity, alpha);
    gl.uniform2f(this.uniforms.uWorldOrigin, origin.worldX, origin.worldZ);
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
    if (!this.voxelOverlay || !overlays?.length) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    return this.voxelOverlay.render({ viewProjection, origin, overlays });
  }

  renderVoxelParticles(viewProjection, origin, lighting = this.lighting) {
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

  renderAvatars(cameraState, avatars, viewProjection, origin, lighting = this.lighting) {
    const gl = this.gl;
    if (!avatars.length || !this.avatarProgram) return { drawCalls: 0, triangles: 0, bufferMemory: 0 };
    gl.useProgram(this.avatarProgram);
    gl.uniformMatrix4fv(this.avatarUniforms.uViewProjection, false, viewProjection);
    applyLightingUniforms(gl, this.avatarUniforms, lighting);
    let drawCalls = 0;
    let triangles = 0;
    let bufferMemory = 0;
    let transparentPass = false;
    for (const avatar of avatars) {
      const entry = this.avatarBuffers.get(String(avatar.meshId || avatar.id));
      if (!entry?.handle) continue;
      const handle = entry.handle;
      if (entry.mesh?.parts?.length) {
        const vertices = updateAvatarMeshVertices(entry.mesh, avatar.animation);
        gl.bindBuffer(gl.ARRAY_BUFFER, handle.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
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
      const transparent = opacity < 0.999;
      if (transparent !== transparentPass) {
        transparentPass = transparent;
        if (transparent) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        }
      }
      gl.uniform1f(this.avatarUniforms.uAvatarOpacity, opacity);
      gl.bindVertexArray(handle.vao);
      gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
      drawCalls += 1;
      triangles += handle.triangleCount;
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
    for (const entry of this.chunkBuffers.values()) safely(() => this.bufferManager?.disposeChunkBuffers(entry.handle));
    this.chunkBuffers.clear();
    for (const entry of this.visualChunkBuffers.values()) safely(() => this.bufferManager?.disposeChunkBuffers(entry.handle));
    this.visualChunkBuffers.clear();
    for (const entry of this.regionBuffers.values()) safely(() => this.bufferManager?.disposeChunkBuffers(entry.handle));
    this.regionBuffers.clear();
    for (const entry of this.visualRegionBuffers.values()) safely(() => this.bufferManager?.disposeChunkBuffers(entry.handle));
    this.visualRegionBuffers.clear();
    for (const entry of this.avatarBuffers.values()) safely(() => this.disposeAvatarBuffers(entry.handle));
    this.avatarBuffers.clear();
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
    if (this.avatarProgram && this.gl) safely(() => this.gl.deleteProgram(this.avatarProgram));
    this.gl = null;
    this.program = null;
    this.avatarProgram = null;
    this.uniforms = null;
    this.avatarUniforms = null;
    this.bufferManager = null;
    this.textureArray = null;
    this.initialized = false;
    this.stats = emptyStats();
  }

  dispose() {
    this.releaseContextResources();
    this.detachContextListeners();
  }

  createAvatarBuffers(mesh) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
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
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      vao,
      vbo,
      ibo,
      indexCount: mesh.indexCount,
      indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      triangleCount: mesh.triangleCount,
      byteLength: mesh.vertices.byteLength + mesh.indices.byteLength,
    };
  }

  disposeAvatarBuffers(handle) {
    const gl = this.gl;
    if (!handle || !gl) return;
    gl.deleteBuffer(handle.vbo);
    gl.deleteBuffer(handle.ibo);
    gl.deleteVertexArray(handle.vao);
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

function collectUniforms(gl, program) {
  const names = [
    "uViewProjection",
    "uChunkOrigin",
    "uWorldOrigin",
    "uTileScale",
    "uTextureArray",
    "uSunDirection",
    "uSunColor",
    "uSkyLightColor",
    "uGroundLightColor",
    "uFogColor",
    "uFogNearFar",
    "uLightParams",
    "uTime",
    "uOpacity",
  ];
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}

function collectAvatarUniforms(gl, program) {
  const names = [
    "uViewProjection",
    "uAvatarOrigin",
    "uAvatarYaw",
    "uAvatarOpacity",
    "uSunDirection",
    "uSunColor",
    "uSkyLightColor",
    "uGroundLightColor",
    "uFogColor",
    "uFogNearFar",
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
      const existing = buffers.get(chunk.id);
      if (!existing) return;
      renderer.bufferManager?.disposeChunkBuffers(existing.handle);
      buffers.delete(chunk.id);
      if (visual) chunk.visualGpuUploaded = false;
      else chunk.gpuUploaded = false;
    }
  }
}

function needsUpload(bufferMap, chunk, visual) {
  const entry = bufferMap.get(chunk.id);
  const uploaded = visual ? chunk.visualGpuUploaded : chunk.gpuUploaded;
  return !entry || entry.version !== committedMeshVersion(chunk, visual) || !uploaded;
}

function chunkCoveredByRegion(regionBuffers, chunk, regionChunkSize = 4, visual = false) {
  if (!chunk || !regionBatchEligible(chunk)) return false;
  const entry = regionBuffers.get(regionIdForChunk(chunk, regionChunkSize));
  if (!entry?.chunkIds?.has(chunk.id)) return false;
  if (entry.chunkVersions instanceof Map) return entry.chunkVersions.get(chunk.id) === committedMeshVersion(chunk, visual);
  return true;
}

function opaqueReadyForChunk(renderer, chunk) {
  if (!chunk?.mesh?.indexCount) return false;
  if (chunkCoveredByRegion(renderer.regionBuffers, chunk, renderer.options.regionChunkSize)) return true;
  const entry = renderer.chunkBuffers.get(chunk.id);
  return Boolean(entry?.handle && entry.version === committedMeshVersion(chunk, false) && chunk.gpuUploaded);
}

function regionOpaqueReady(renderer, region) {
  if (!region?.chunks?.length) return false;
  for (const chunk of region.chunks) {
    if (!opaqueReadyForChunk(renderer, chunk)) return false;
  }
  return true;
}

function regionGroupCacheKey(chunks, regionChunkSize = 4, meshField = "mesh") {
  const size = Math.max(1, Math.trunc(regionChunkSize || 1));
  const parts = [meshField, size];
  for (const chunk of chunks) {
    if (!regionBatchEligible(chunk)) continue;
    const mesh = chunk?.[meshField];
    if (!mesh?.indexCount) continue;
    parts.push(chunk.id, committedMeshVersion(chunk, meshField === "visualMesh"), mesh.indexCount, mesh.vertexCount || 0);
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

function combineChunkMeshes(region, meshField = "mesh") {
  let vertexCount = 0;
  let indexCount = 0;
  let triangleCount = 0;
  let byteLength = 0;
  const stride = 20;
  for (const chunk of region.chunks) {
    const mesh = chunk[meshField];
    vertexCount += mesh.vertexCount || 0;
    indexCount += mesh.indexCount || 0;
    triangleCount += mesh.triangleCount || 0;
    byteLength += mesh.vertices.byteLength + mesh.indices.byteLength;
  }
  if (!vertexCount || !indexCount) return null;
  const vertices = new Uint8Array(vertexCount * stride);
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const outView = new DataView(vertices.buffer);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const chunk of region.chunks) {
    const mesh = chunk[meshField];
    const vertexByteOffset = vertexOffset * stride;
    vertices.set(mesh.vertices, vertexByteOffset);
    const localX = (chunk.chunkX - region.originChunkX) * chunk.chunkSize;
    const localZ = (chunk.chunkZ - region.originChunkZ) * chunk.chunkSize;
    for (let i = 0; i < mesh.vertexCount; i += 1) {
      const offset = vertexByteOffset + i * stride;
      const scale = outView.getInt16(offset + 6, true) || 1;
      outView.setInt16(offset, outView.getInt16(offset, true) + localX * scale, true);
      outView.setInt16(offset + 4, outView.getInt16(offset + 4, true) + localZ * scale, true);
      offsetVertexUvForRegion(outView, offset, localX, localZ);
    }
    for (let i = 0; i < mesh.indices.length; i += 1) indices[indexOffset + i] = mesh.indices[i] + vertexOffset;
    vertexOffset += mesh.vertexCount;
    indexOffset += mesh.indices.length;
  }
  return {
    vertices,
    indices,
    vertexCount,
    indexCount,
    triangleCount,
    quadCount: indexCount / 6,
    blockCount: region.chunks.reduce((sum, chunk) => sum + (chunk[meshField]?.blockCount || 0), 0),
    vertexStrideBytes: stride,
    byteLength,
    region: true,
  };
}

function offsetVertexUvForRegion(view, offset, localX, localZ) {
  if (view.getUint16(offset + 18, true) & 4) return;
  const nx = view.getInt8(offset + 8);
  const ny = view.getInt8(offset + 9);
  const nz = view.getInt8(offset + 10);
  let addU = 0;
  let addV = 0;
  if (Math.abs(ny) >= Math.abs(nx) && Math.abs(ny) >= Math.abs(nz)) {
    addU = localX;
    addV = localZ;
  } else if (Math.abs(nx) >= Math.abs(nz)) {
    addU = localZ;
  } else {
    addU = localX;
  }
  if (addU) view.setUint16(offset + 12, (view.getUint16(offset + 12, true) + addU) & 0xffff, true);
  if (addV) view.setUint16(offset + 14, (view.getUint16(offset + 14, true) + addV) & 0xffff, true);
}

function regionSignature(chunks, meshField = "mesh") {
  const visual = meshField === "visualMesh";
  return chunks.map((chunk) => `${chunk.id}:${committedMeshVersion(chunk, visual)}:${chunk[meshField]?.indexCount || 0}`).join("|");
}

function regionDrawableChunkIds(entry, currentChunks) {
  const out = new Set();
  if (!entry?.chunkIds?.size || !Array.isArray(currentChunks) || !currentChunks.length) return out;
  for (const chunk of currentChunks) {
    if (!chunk?.id || !regionBatchEligible(chunk) || !entry.chunkIds.has(chunk.id)) continue;
    // Keep the last complete region visible until its replacement upload has
    // succeeded. The batch is indivisible, so rejecting one stale member would
    // blank every neighboring chunk in the same region.
    out.add(chunk.id);
  }
  return out;
}

function regionBatchEligible(chunk) {
  return chunk?.regionBatchEligible !== false;
}

function estimateChunkCosts(chunks, meshField, elapsedMs) {
  if (!Array.isArray(chunks) || !chunks.length || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return [];
  let totalWeight = 0;
  const weighted = chunks.map((chunk) => {
    const mesh = chunk?.[meshField];
    const weight = Math.max(1, mesh?.triangleCount || mesh?.indexCount || 1);
    totalWeight += weight;
    return { id: chunk.id, weight };
  });
  return weighted.map((item) => ({ id: item.id, ms: elapsedMs * item.weight / Math.max(1, totalWeight) }));
}

function estimateRegionEntryChunkCosts(entry, visibleChunks, meshField, elapsedMs) {
  if (!entry?.chunkIds?.size) return [];
  const covered = [];
  for (const chunk of visibleChunks ?? []) {
    if (entry.chunkIds.has(chunk.id)) covered.push(chunk);
  }
  return estimateChunkCosts(covered, meshField, elapsedMs);
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
  return { backend: "webgl2", drawCalls: 0, visibleChunks: 0, triangles: 0, bufferMemory: 0, gpuChunks: 0, width: 0, height: 0, dpr: 1 };
}
