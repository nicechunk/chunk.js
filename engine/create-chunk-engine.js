import { ChunkManager } from "../chunk/chunk-manager.js";
import { createCameraState } from "../renderer/camera.js";
import { detectWebGl2Support, WebGL2VoxelRenderer } from "../renderer/webgl2-renderer.js";
import { FrameStatsCounter } from "../debug/stats.js";

export async function createChunkEngine(options = {}) {
  if (!options || typeof options !== "object") throw new TypeError("createChunkEngine options must be an object.");
  const { canvas, viewDistance = 3, meshBudgetMs = 6, onStats, onStatus } = options;
  if (!canvas) throw new Error("createChunkEngine requires a canvas.");
  if (typeof meshBudgetMs !== "number" || !Number.isFinite(meshBudgetMs) || meshBudgetMs < 0) {
    throw new RangeError("createChunkEngine meshBudgetMs must be a finite non-negative number.");
  }
  if (onStats != null && typeof onStats !== "function") {
    throw new TypeError("createChunkEngine onStats must be a function when provided.");
  }
  if (onStatus != null && typeof onStatus !== "function") {
    throw new TypeError("createChunkEngine onStatus must be a function when provided.");
  }
  const support = detectWebGl2Support();
  if (!support.supported) {
    onStatus?.({ stage: "unsupported", backend: "webgl2", support });
    return unsupported(support);
  }

  const chunks = new ChunkManager({ viewDistance });
  let renderer = null;
  let camera;
  try {
    chunks.updatePlayerPosition(0, 24, 0);
    camera = createCameraState({ worldX: 0, worldY: chunks.surfaceYAt(0, 0) + 18, worldZ: -28, localOffsetX: 0.5, localOffsetY: 0.5, localOffsetZ: 0.5, yaw: 0, pitch: 0.55, far: 360 });
    renderer = new WebGL2VoxelRenderer(canvas, { viewDistance });
    renderer.init();
  } catch (error) {
    disposeChunkEngineResources(chunks, renderer);
    throw error;
  }
  const stats = new FrameStatsCounter();
  let running = false;
  let paused = false;
  let destroyed = false;
  let raf = 0;
  let startTime = performance.now();

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (!paused) camera.yaw = Math.sin((now - startTime) * 0.00016) * 0.45;
    chunks.updatePlayerPosition(camera.worldX, camera.worldY, camera.worldZ, cameraLoadDirection(camera));
    chunks.rebuildDirtyChunks(meshBudgetMs);
    const visible = chunks.getVisibleChunks(camera);
    renderer.pruneChunks(new Set(chunks.chunks.keys()));
    renderer.prepareChunksForRender(visible);
    const renderStats = renderer.render(camera, visible);
    const worldStats = chunks.stats();
    const sample = stats.frame(now, {
      backend: "webgl2",
      blocks: 0,
      vertices: worldStats.vertices,
      indices: renderStats.triangles * 3,
      triangles: renderStats.triangles,
      drawCalls: renderStats.drawCalls,
    });
    if (sample) onStats?.(sample);
  }

  return {
    supported: true,
    backend: "webgl2",
    support,
    chunks,
    camera,
    renderer,
    start() {
      if (destroyed) throw new Error("Cannot start a destroyed Chunk.js engine.");
      if (running) return;
      running = true;
      startTime = performance.now();
      stats.reset(startTime);
      try {
        onStatus?.({ stage: paused ? "paused" : "running", backend: "webgl2", support });
        raf = requestAnimationFrame(frame);
      } catch (error) {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        throw error;
      }
    },
    stop() {
      if (destroyed || !running) return;
      running = false;
      cancelAnimationFrame(raf);
      raf = 0;
      onStatus?.({ stage: "paused", backend: "webgl2", support });
    },
    setPaused(value) {
      if (destroyed) return;
      const nextPaused = Boolean(value);
      if (paused === nextPaused) return;
      paused = nextPaused;
      if (running) onStatus?.({ stage: paused ? "paused" : "running", backend: "webgl2", support });
    },
    resetCamera() {
      if (destroyed) return;
      camera.worldX = 0;
      camera.worldY = chunks.surfaceYAt(0, 0) + 18;
      camera.worldZ = -28;
      camera.localOffsetX = 0.5;
      camera.localOffsetY = 0.5;
      camera.localOffsetZ = 0.5;
      camera.yaw = 0;
      camera.pitch = 0.55;
      startTime = performance.now();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      running = false;
      cancelAnimationFrame(raf);
      raf = 0;
      disposeChunkEngineResources(chunks, renderer);
      onStatus?.({ stage: "destroyed", backend: "webgl2", support });
    },
  };
}

function disposeChunkEngineResources(chunks, renderer) {
  try {
    chunks?.dispose?.();
  } finally {
    renderer?.dispose?.();
  }
}

function unsupported(support) {
  return {
    supported: false,
    backend: "none",
    support,
    start() {},
    stop() {},
    setPaused() {},
    resetCamera() {},
    destroy() {},
  };
}

function cameraLoadDirection(cameraState) {
  return {
    directionX: Math.sin(cameraState.yaw) * Math.cos(cameraState.pitch),
    directionZ: Math.cos(cameraState.yaw) * Math.cos(cameraState.pitch),
  };
}
