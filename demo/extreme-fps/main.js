import { ChunkManager } from "../../chunk/chunk-manager.js";
import { FrameStatsCounter } from "../../debug/stats.js";
import { createCameraState } from "../../renderer/camera.js";
import { WebGL2VoxelRenderer, detectWebGl2Support } from "../../renderer/webgl2-renderer.js";

const params = new URLSearchParams(location.search);
const viewDistance = clampInt(Number(params.get("view")) || 5, 2, 8);
const meshBudgetMs = clampInt(Number(params.get("budget")) || 10, 4, 20);
const elements = {
  canvas: document.querySelector("#engineCanvas"),
  fps: document.querySelector("#fpsValue"),
  peak: document.querySelector("#peakValue"),
  build: document.querySelector("#buildValue"),
  blocks: document.querySelector("#blockValue"),
  quads: document.querySelector("#quadValue"),
  triangles: document.querySelector("#triangleValue"),
  draw: document.querySelector("#drawValue"),
  status: document.querySelector("#statusText"),
};

let peakFps = 0;
let renderer = null;
let chunks = null;
let camera = null;
let lastFrame = performance.now();
let orbit = 0;
const stats = new FrameStatsCounter();

boot().catch((error) => {
  console.error(error);
  elements.status.textContent = `Failed: ${error?.message || error}`;
});

async function boot() {
  const support = detectWebGl2Support();
  if (!support.supported) {
    elements.status.textContent = `WebGL2 unavailable: ${support.label || support.reason}`;
    return;
  }
  chunks = new ChunkManager({ viewDistance });
  chunks.updatePlayerPosition(0, 24, 0);
  camera = createCameraState({ worldX: 0, worldY: chunks.surfaceYAt(0, 0) + 22, worldZ: -34, localOffsetX: 0.5, localOffsetY: 0.5, localOffsetZ: 0.5, yaw: 0, pitch: 0.58, far: 420 });
  renderer = new WebGL2VoxelRenderer(elements.canvas, { viewDistance, textureTileSize: 32 });
  renderer.init();
  stats.reset(performance.now());
  elements.status.textContent = `Streaming deterministic chunks. View ${viewDistance}, mesh budget ${meshBudgetMs}ms.`;
  requestAnimationFrame(frame);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  orbit += dt * 0.22;
  camera.yaw = Math.sin(orbit) * 0.55;
  chunks.updatePlayerPosition(camera.worldX, camera.worldY, camera.worldZ, cameraLoadDirection(camera));
  chunks.rebuildDirtyChunks(meshBudgetMs);
  const visible = chunks.getVisibleChunks(camera);
  renderer.pruneChunks(new Set(chunks.chunks.keys()));
  const uploadStats = renderer.prepareChunksForRender(visible);
  const renderStats = renderer.render(camera, visible);
  const worldStats = chunks.stats();
  const sample = stats.frame(now, renderStats);
  if (sample) {
    peakFps = Math.max(peakFps, sample.fps);
    elements.fps.textContent = `${sample.fps} FPS`;
    elements.peak.textContent = `${peakFps} FPS`;
    elements.build.textContent = `${worldStats.lastRebuildMs.toFixed(1)} ms`;
    elements.blocks.textContent = formatNumber(totalBlocks(visible));
    elements.quads.textContent = formatNumber(totalQuads(visible));
    elements.triangles.textContent = formatNumber(renderStats.triangles);
    elements.draw.textContent = formatNumber(renderStats.drawCalls);
    elements.status.textContent = `WebGL2 · ${renderStats.visibleChunks} visible chunks · ${(renderStats.bufferMemory / 1048576).toFixed(2)} MB visible buffers · Q ${worldStats.buildQueue}+${worldStats.inFlightBuilds} · U ${uploadStats.uploaded}/${uploadStats.pendingUploads}`;
  }
}

function totalBlocks(chunks) {
  return chunks.reduce((sum, chunk) => sum + (chunk.mesh?.blockCount || 0), 0);
}

function totalQuads(chunks) {
  return chunks.reduce((sum, chunk) => sum + (chunk.mesh?.quadCount || 0), 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value || 0));
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || min)));
}

function cameraLoadDirection(cameraState) {
  return {
    directionX: Math.sin(cameraState.yaw) * Math.cos(cameraState.pitch),
    directionZ: Math.cos(cameraState.yaw) * Math.cos(cameraState.pitch),
  };
}
