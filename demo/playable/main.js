import { DEFAULT_MESH_BUDGET_MS, DEFAULT_VIEW_DISTANCE } from "../../core/constants.js";
import { ChunkManager } from "../../chunk/chunk-manager.js";
import { FrameStatsCounter } from "../../debug/stats.js";
import { RenderLog } from "../../debug/render-log.js";
import { inspectBlock } from "../../debug/block-inspector.js";
import { ThirdPersonPlayerControls } from "../../input/controls.js";
import {
  createCollisionBox,
  maxCollisionHorizontalExtent,
  prepareCollisionBoxes,
  preparedCollisionBoxIntersectsBlock,
  preparedCollisionFootprintIntersectsBlock,
} from "../../input/collision.js";
import { raycastBlock } from "../../input/raycast.js";
import { loadPeasantGuyAvatarMesh } from "../../renderer/avatar-mesh.js";
import { cameraForward, createCameraState } from "../../renderer/camera.js";
import { WebGL2VoxelRenderer, detectWebGl2Support } from "../../renderer/webgl2-renderer.js";
import {
  BLOCK_ID,
  blockDef,
  isBlockingBlock,
  isFluidBlock,
  isMineableBlock,
} from "../../world/block-registry.js";

const params = new URLSearchParams(location.search);
const PLAYABLE_MAX_VIEW_DISTANCE = 20;
const PLAYABLE_PRELOAD_MARGIN = 2;
const queryPose = parsePoseText(params.get("pose") || "");
const PLAYABLE_WORLD_SEED = "nicechunk-mainnet-001";
const viewDistance = clampInt(Number(params.get("view")) || queryPose?.viewDistance || DEFAULT_VIEW_DISTANCE, 2, PLAYABLE_MAX_VIEW_DISTANCE);
const meshBudgetMs = clampInt(Number(params.get("budget")) || DEFAULT_MESH_BUDGET_MS, 2, 14);
const POSITION_STORAGE_KEY = "nicechunk.chunkjs.playable.position.v1";
const POSITION_SAVE_INTERVAL_MS = 650;
const savedSpawn = (queryPose || hasSpawnParam()) ? null : loadSavedPlayerPosition();
const spawnState = queryPose ?? savedSpawn;
const spawnX = spawnCoord("x", spawnState?.worldX ?? 0);
const spawnYOverride = spawnCoordOrNull("y", spawnState?.worldY);
const spawnZ = spawnCoord("z", spawnState?.worldZ ?? 0);
const spawnFlightEnabled = Boolean(spawnState?.flightEnabled || params.get("fly") === "1" || params.get("flight") === "1");
const BLOCK_SIZE_METERS = 0.4;
const AVATAR_HEIGHT_METERS = 1.75;
const AVATAR_HEIGHT_BLOCKS = AVATAR_HEIGHT_METERS / BLOCK_SIZE_METERS;
const PEASANT_GUY_SOURCE_HEIGHT_BLOCKS = 2.52;
const AVATAR_VISUAL_SCALE = AVATAR_HEIGHT_BLOCKS / PEASANT_GUY_SOURCE_HEIGHT_BLOCKS;
const PLAYER_CORE_WIDTH_METERS = 0.5;
const PLAYER_CORE_DEPTH_METERS = 0.38;
const PLAYER_COLLISION_SKIN_METERS = 0.01;
const PLAYER_FOOT_CLEARANCE_METERS = 0.008;
const PLAYER_COLLISION_SKIN_BLOCKS = metersToBlocks(PLAYER_COLLISION_SKIN_METERS);
const PLAYER_FOOT_CLEARANCE_BLOCKS = metersToBlocks(PLAYER_FOOT_CLEARANCE_METERS);
const DEFAULT_PLAYER_COLLISION_BOX = createCollisionBox({
  name: "player-body",
  halfWidth: metersToBlocks(PLAYER_CORE_WIDTH_METERS) * 0.5 + PLAYER_COLLISION_SKIN_BLOCKS,
  halfDepth: metersToBlocks(PLAYER_CORE_DEPTH_METERS) * 0.5 + PLAYER_COLLISION_SKIN_BLOCKS,
  height: AVATAR_HEIGHT_BLOCKS - PLAYER_FOOT_CLEARANCE_BLOCKS,
  offsetY: PLAYER_FOOT_CLEARANCE_BLOCKS,
});
const PLAYER_RADIUS = maxCollisionHorizontalExtent([DEFAULT_PLAYER_COLLISION_BOX]);
const PLAYER_BODY_HEIGHT = DEFAULT_PLAYER_COLLISION_BOX.offsetY + DEFAULT_PLAYER_COLLISION_BOX.height;
const PLAYER_GRAVITY = 24;
const PLAYER_JUMP_IMPULSE = 9.2;
const PLAYER_COLLISION_STEP = 0.14;
const PLAYER_COLLISION_EPSILON = 0.0015;
const PLAYER_GROUND_SNAP_UP = 0.22;
const PLAYER_STEP_HEIGHT_BLOCKS = 1.05;
const CAMERA_DISTANCE = metersToBlocks(3.36);
const CAMERA_FOCUS_HEIGHT_DESKTOP = metersToBlocks(1.5);
const CAMERA_FOCUS_HEIGHT_MOBILE = metersToBlocks(1.65);
const CAMERA_LIFT_DESKTOP = metersToBlocks(0.84);
const CAMERA_LIFT_MOBILE = metersToBlocks(1.52);
const CAMERA_PITCH_MIN = -0.92;
const CAMERA_PITCH_MAX = 0.42;
const DEFAULT_CAMERA_PITCH = -0.42;
const AVATAR_FOOT_OFFSET = 0;
const elements = {
  canvas: document.querySelector("#worldCanvas"),
  fps: document.querySelector("#fpsValue"),
  build: document.querySelector("#buildValue"),
  chunks: document.querySelector("#chunkValue"),
  visible: document.querySelector("#visibleValue"),
  triangles: document.querySelector("#triangleValue"),
  draw: document.querySelector("#drawValue"),
  gpu: document.querySelector("#gpuValue"),
  position: document.querySelector("#positionValue"),
  hit: document.querySelector("#hitValue"),
  avatar: document.querySelector("#avatarValue"),
  pose: document.querySelector("#poseValue"),
  poseInput: document.querySelector("#poseInput"),
  copyPose: document.querySelector("#copyPoseButton"),
  loadPose: document.querySelector("#loadPoseButton"),
  viewRangeInput: document.querySelector("#viewRangeInput"),
  viewRangeValue: document.querySelector("#viewRangeValue"),
  status: document.querySelector("#statusText"),
  joystick: document.querySelector("#joystick"),
  joystickKnob: document.querySelector("#joystickKnob"),
  hud: document.querySelector("#debugHud"),
  hudToggle: document.querySelector("#hudToggle"),
  mine: document.querySelector("#mineButton"),
  confirm: document.querySelector("#confirmButton"),
  rollback: document.querySelector("#rollbackButton"),
  flightToggle: document.querySelector("#flightToggleButton"),
  flightUp: document.querySelector("#flightUpButton"),
  flightDown: document.querySelector("#flightDownButton"),
  renderLogToggle: document.querySelector("#renderLogToggleButton"),
  renderLogCopy: document.querySelector("#copyRenderLogButton"),
  renderLogClear: document.querySelector("#clearRenderLogButton"),
  renderLogPreview: document.querySelector("#renderLogPreview"),
};

let renderer = null;
let chunks = null;
let camera = null;
let controls = null;
let player = null;
let lastFrame = performance.now();
let lastHit = null;
let lastPositionSaveAt = 0;
let lastPositionSaveKey = "";
let txSerial = 1;
let avatar = null;
let cameraFocusReady = false;
let cameraFocusX = 0;
let cameraFocusY = 0;
let cameraFocusZ = 0;
let flightVerticalIntent = 0;
const pendingTx = [];
const fps = new FrameStatsCounter();
const renderLog = new RenderLog({ maxEntries: 2200 });

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
  chunks = new ChunkManager({ viewDistance, preloadMargin: PLAYABLE_PRELOAD_MARGIN, workerCount: preferredWorkerCount(), maxQueuedBuilds: maxBuildQueueForViewDistance(viewDistance) });
  chunks.setRenderLogger(renderLog);
  chunks.updatePlayerPosition(spawnX, 112, spawnZ);
  const spawnY = Number.isFinite(spawnYOverride) ? spawnYOverride : chunks.surfaceYAt(spawnX, spawnZ);
  const localOffsetX = Number.isFinite(spawnState?.localOffsetX) && !hasSpawnParam("x") ? clamp(spawnState.localOffsetX, 0, 0.999999) : 0.5;
  const localOffsetY = Number.isFinite(spawnState?.localOffsetY) && !hasSpawnParam("y") ? clamp(spawnState.localOffsetY, 0, 0.999999) : 0;
  const localOffsetZ = Number.isFinite(spawnState?.localOffsetZ) && !hasSpawnParam("z") ? clamp(spawnState.localOffsetZ, 0, 0.999999) : 0.5;
  const savedYaw = Number.isFinite(spawnState?.controlYaw) ? spawnState.controlYaw : Math.PI;
  const savedPitch = clamp(Number.isFinite(spawnState?.cameraPitch) ? spawnState.cameraPitch : DEFAULT_CAMERA_PITCH, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
  player = {
    worldX: spawnX,
    worldY: spawnY,
    worldZ: spawnZ,
    localOffsetX,
    localOffsetY,
    localOffsetZ,
    controlYaw: savedYaw,
    avatarYaw: Number.isFinite(spawnState?.avatarYaw) ? spawnState.avatarYaw : savedYaw,
    yaw: Number.isFinite(spawnState?.avatarYaw) ? spawnState.avatarYaw : savedYaw,
    cameraPitch: savedPitch,
    velocityY: 0,
    grounded: true,
    flightEnabled: spawnFlightEnabled,
    collisionBoxes: [DEFAULT_PLAYER_COLLISION_BOX],
    equipmentCollisionBoxes: [],
    radius: PLAYER_RADIUS,
    bodyHeight: PLAYER_BODY_HEIGHT,
  };
  camera = createCameraState({ worldX: spawnX, worldY: spawnY + 6, worldZ: spawnZ - 10, localOffsetX: 0.5, localOffsetY: 0.5, localOffsetZ: 0.5, yaw: player.controlYaw + Math.PI, pitch: savedPitch, far: viewFarPlane(viewDistance) });
  syncCameraToPlayer(1 / 60, { force: true });
  renderer = new WebGL2VoxelRenderer(elements.canvas, { viewDistance, textureTileSize: 32, textureSeed: PLAYABLE_WORLD_SEED });
  renderer.setRenderLogger(renderLog);
  renderer.init();
  elements.viewRangeInput.value = String(viewDistance);
  updateViewRangeLabel(viewDistance);
  await loadAvatar();
  resolvePlayerPenetration();
  controls = new ThirdPersonPlayerControls(elements.canvas, camera, player, { speed: 14.8, pitchMin: CAMERA_PITCH_MIN, pitchMax: CAMERA_PITCH_MAX });
  bindInput();
  updateFlightUi();
  bindPositionPersistence();
  savePlayerPosition(performance.now(), { force: true });
  fps.reset(performance.now());
  elements.status.textContent = `Running seed ${PLAYABLE_WORLD_SEED}. Canonical terrain + baked TextureArray + visual water/cloud/trees. Non-tree surface decorations remain disabled until rules are supplied. View distance ${viewDistance}, mesh budget ${meshBudgetMs}ms, workers ${chunks.workerCount}.`;
  requestAnimationFrame(frame);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
  lastFrame = now;
  controls.update(dt);
  chunks.setBuildConcurrencyLimit(frameBuildConcurrencyLimit());
  applyPlayerPhysics(dt);
  savePlayerPosition(now);
  syncCameraToPlayer(dt);
  syncAvatarToPlayer(now);
  chunks.updatePlayerPosition(player.worldX, player.worldY, player.worldZ, cameraLoadDirection(camera));
  chunks.rebuildDirtyChunks(meshBudgetMs);
  removeUnloadedGpuChunks();
  const visibleChunks = chunks.getVisibleChunks(camera);
  const movingNow = isMotionActive();
  const uploadChunks = visibleChunks;
  const uploadStats = renderer.prepareChunksForRender(uploadChunks, {
    maxUploads: frameUploadBudget(),
    deferRegionUploads: movingNow,
  });
  const renderStats = renderer.render(camera, visibleChunks, avatar ? [avatar] : []);
  lastHit = raycastBlock(camera, null, 8, chunks);
  const sample = fps.frame(now, renderStats);
  if (sample) updateHud(sample, renderStats, uploadStats);
}

function bindInput() {
  addEventListener("keydown", (event) => {
    if (event.code === "KeyF") minePending();
    if (event.code === "Enter") confirmLast();
    if (event.code === "Backspace") {
      event.preventDefault();
      rollbackLast();
    }
  });
  elements.mine.addEventListener("click", minePending);
  elements.confirm.addEventListener("click", confirmLast);
  elements.rollback.addEventListener("click", rollbackLast);
  elements.flightToggle?.addEventListener("click", () => setFlightEnabled(!player.flightEnabled));
  bindFlightHoldButton(elements.flightUp, 1);
  bindFlightHoldButton(elements.flightDown, -1);
  elements.renderLogToggle?.addEventListener("click", toggleRenderLog);
  elements.renderLogCopy?.addEventListener("click", copyRenderLog);
  elements.renderLogClear?.addEventListener("click", clearRenderLog);
  elements.copyPose?.addEventListener("click", copyPoseSnapshot);
  elements.loadPose?.addEventListener("click", loadPoseSnapshot);
  elements.poseInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadPoseSnapshot();
  });
  elements.viewRangeInput.addEventListener("input", () => setViewDistance(clampInt(Number(elements.viewRangeInput.value), 2, PLAYABLE_MAX_VIEW_DISTANCE)));
  bindHudToggle();
  bindJoystick();
}

function setFlightEnabled(enabled) {
  if (!player) return;
  player.flightEnabled = Boolean(enabled);
  player.velocityY = 0;
  player.grounded = !player.flightEnabled;
  flightVerticalIntent = 0;
  updateFlightUi();
  savePlayerPosition(performance.now(), { force: true });
  elements.status.textContent = player.flightEnabled
    ? "Flight enabled. Space rises, C/Ctrl descends, Shift keeps 5x speed."
    : "Flight disabled. Gravity and terrain collision restored.";
}

function updateFlightUi() {
  if (!elements.flightToggle || !player) return;
  elements.flightToggle.textContent = player.flightEnabled ? "Flight On" : "Flight Off";
  elements.flightToggle.setAttribute("aria-pressed", player.flightEnabled ? "true" : "false");
}

function bindFlightHoldButton(button, direction) {
  if (!button) return;
  const start = (event) => {
    event.preventDefault();
    if (!player?.flightEnabled) setFlightEnabled(true);
    flightVerticalIntent = direction;
    button.setPointerCapture?.(event.pointerId);
  };
  const stop = (event) => {
    if (event?.pointerId !== undefined) button.releasePointerCapture?.(event.pointerId);
    if (flightVerticalIntent === direction) flightVerticalIntent = 0;
  };
  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("pointerleave", stop);
}

function bindHudToggle() {
  if (!elements.hud || !elements.hudToggle) return;
  const setExpanded = (expanded) => {
    elements.hud.classList.toggle("is-expanded", expanded);
    elements.hudToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    const label = elements.hudToggle.querySelector("b");
    if (label) label.textContent = expanded ? "Hide" : "Details";
  };
  setExpanded(!isMobileViewport());
  elements.hudToggle.addEventListener("click", () => {
    setExpanded(!elements.hud.classList.contains("is-expanded"));
  });
}

function bindPositionPersistence() {
  addEventListener("pagehide", () => savePlayerPosition(performance.now(), { force: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") savePlayerPosition(performance.now(), { force: true });
  });
}

async function loadAvatar() {
  try {
    const mesh = await loadPeasantGuyAvatarMesh({ scale: AVATAR_VISUAL_SCALE });
    renderer.uploadAvatarMesh("peasant-guy", mesh);
    setPlayerCollisionBoxes([collisionBoxFromAvatarMesh(mesh)]);
    avatar = { id: "peasant-guy", worldX: player.worldX, worldY: player.worldY, worldZ: player.worldZ, localOffsetX: player.localOffsetX, localOffsetY: 0, localOffsetZ: player.localOffsetZ, yaw: player.avatarYaw, animation: { moving: false, timeMs: performance.now() } };
    const body = player.collisionBoxes[0];
    elements.avatar.textContent = `${mesh.name} · ${mesh.bounds.height.toFixed(2)} blocks / ${AVATAR_HEIGHT_METERS.toFixed(2)}m · collision ${(body.halfWidth * 2 * BLOCK_SIZE_METERS).toFixed(2)}x${(body.halfDepth * 2 * BLOCK_SIZE_METERS).toFixed(2)}m · ${Math.round(mesh.triangleCount)} tris`;
  } catch (error) {
    console.error(error);
    elements.avatar.textContent = "failed";
  }
}

function collisionBoxFromAvatarMesh(mesh) {
  const coreParts = (mesh?.parts ?? []).filter((part) => part?.bone !== "left_arm" && part?.bone !== "right_arm");
  const bounds = boundsOfAvatarParts(coreParts.length ? coreParts : mesh?.parts ?? []);
  if (!bounds) return DEFAULT_PLAYER_COLLISION_BOX;
  return createCollisionBox({
    name: "player-body",
    halfWidth: Math.max(0.08, (bounds.maxX - bounds.minX) * 0.5 + PLAYER_COLLISION_SKIN_BLOCKS),
    halfDepth: Math.max(0.08, (bounds.maxZ - bounds.minZ) * 0.5 + PLAYER_COLLISION_SKIN_BLOCKS),
    height: Math.max(0.2, bounds.maxY - bounds.minY - PLAYER_FOOT_CLEARANCE_BLOCKS),
    offsetX: 0,
    offsetY: bounds.minY + PLAYER_FOOT_CLEARANCE_BLOCKS,
    offsetZ: 0,
  });
}

function boundsOfAvatarParts(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const part of parts) {
    bounds.minX = Math.min(bounds.minX, part.cx - part.sx * 0.5);
    bounds.maxX = Math.max(bounds.maxX, part.cx + part.sx * 0.5);
    bounds.minY = Math.min(bounds.minY, part.cy - part.sy * 0.5);
    bounds.maxY = Math.max(bounds.maxY, part.cy + part.sy * 0.5);
    bounds.minZ = Math.min(bounds.minZ, part.cz - part.sz * 0.5);
    bounds.maxZ = Math.max(bounds.maxZ, part.cz + part.sz * 0.5);
  }
  return Number.isFinite(bounds.minX) ? bounds : null;
}

function setPlayerCollisionBoxes(boxes) {
  const valid = (boxes ?? []).filter((box) => box && box.halfWidth > 0 && box.halfDepth > 0 && box.height > 0);
  player.collisionBoxes = valid.length ? valid : [DEFAULT_PLAYER_COLLISION_BOX];
  player.radius = maxCollisionHorizontalExtent(playerCollisionBoxes(), playerCollisionYaw());
  player.bodyHeight = player.collisionBoxes.reduce((maxY, box) => Math.max(maxY, box.offsetY + box.height), 0);
}

function setViewDistance(nextValue) {
  const next = clampInt(nextValue, 2, PLAYABLE_MAX_VIEW_DISTANCE);
  chunks.maxQueuedBuilds = maxBuildQueueForViewDistance(next);
  chunks.setViewDistance(next, { preloadMargin: PLAYABLE_PRELOAD_MARGIN });
  renderer.options.viewDistance = next;
  camera.far = viewFarPlane(next);
  chunks.unloadFarChunks(chunks.centerChunkX, chunks.centerChunkZ);
  removeUnloadedGpuChunks();
  updateViewRangeLabel(next);
  elements.status.textContent = `Render range set to ${next} chunks. Dirty chunks rebuild within ${meshBudgetMs}ms/frame.`;
}

function frameUploadBudget() {
  const currentFps = fps.fps || 60;
  const sprinting = controls?.keys?.has("ShiftLeft") || controls?.keys?.has("ShiftRight");
  const base = renderer?.options?.maxChunkUploadsPerFrame ?? 3;
  if (currentFps < 36) return 1;
  if (isMotionActive() || controls?.move?.moving) {
    if (currentFps > 55) return sprinting ? 4 : 5;
    return sprinting ? 3 : 2;
  }
  if (currentFps > 55) return Math.max(base, 7);
  if (currentFps > 45) return Math.max(base, 4);
  return 2;
}

function frameBuildConcurrencyLimit() {
  if (!chunks?.useWorkers) return 0;
  const currentFps = fps.fps || 60;
  const sprinting = controls?.keys?.has("ShiftLeft") || controls?.keys?.has("ShiftRight");
  const moving = isMotionActive();
  const workers = chunks.workerCount || 1;
  if (chunks.buildQueue.length > Math.max(2, workers)) return workers;
  if (currentFps < 36) return 1;
  if (sprinting) return Math.min(workers, currentFps > 52 ? 2 : 1);
  if (moving) return Math.min(workers, currentFps > 55 ? 2 : 1);
  if (currentFps > 55) return workers;
  if (currentFps > 45) return Math.min(workers, 2);
  return 1;
}

function preferredWorkerCount() {
  const cores = Number(navigator.hardwareConcurrency) || 4;
  const coarse = globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  if (coarse) return Math.max(1, Math.min(3, cores - 1));
  return Math.max(1, Math.min(6, cores - 2));
}

function isMotionActive() {
  return Boolean(controls?.move?.moving || flightVerticalMotionActive() || Math.abs(player?.velocityY || 0) > 0.01);
}

function applyPlayerPhysics(dt) {
  if (player.flightEnabled) {
    applyPlayerFlight(dt);
    return;
  }
  const horizontalMoved = movePlayerHorizontally(controls.move.dx || 0, controls.move.dz || 0);
  controls.move.actualMoving = horizontalMoved;
  controls.move.moving = controls.move.moving && horizontalMoved;
  if (horizontalMoved && Number.isFinite(controls.move.yaw)) {
    player.avatarYaw = controls.move.yaw;
    player.yaw = player.avatarYaw;
  }

  const [x, y, z] = playerWorldFloat();
  const ground = groundYAt(x, z, { maxTopY: y + PLAYER_GROUND_SNAP_UP });
  const canJump = player.grounded || (player.velocityY <= 0 && y <= ground + 0.065);
  const jumpRequested = controls.consumeJump();
  if (jumpRequested && canJump) {
    player.velocityY = PLAYER_JUMP_IMPULSE;
    player.grounded = false;
  } else if (player.velocityY <= 0 && y <= ground + 0.045) {
    setPlayerWorldFloat(x, ground, z);
    player.velocityY = 0;
    player.grounded = true;
    return;
  }

  player.velocityY -= PLAYER_GRAVITY * dt;
  movePlayerVertically(player.velocityY * dt);
  resolvePlayerPenetration();
}

function applyPlayerFlight(dt) {
  controls.consumeJump();
  const horizontalMoved = movePlayerHorizontally(controls.move.dx || 0, controls.move.dz || 0);
  const vertical = flightVerticalInput();
  if (Math.abs(vertical) > 0.001) {
    const speed = controls.speed * ((controls.keys.has("ShiftLeft") || controls.keys.has("ShiftRight")) ? controls.sprintMultiplier : 1);
    movePlayerVertically(vertical * speed * dt);
  }
  controls.move.actualMoving = horizontalMoved || Math.abs(vertical) > 0.001;
  controls.move.moving = Boolean(controls.move.moving || Math.abs(vertical) > 0.001);
  if (horizontalMoved && Number.isFinite(controls.move.yaw)) {
    player.avatarYaw = controls.move.yaw;
    player.yaw = player.avatarYaw;
  }
  player.velocityY = 0;
  player.grounded = false;
}

function flightVerticalInput() {
  let vertical = flightVerticalIntent;
  if (controls?.keys?.has("Space")) vertical += 1;
  if (controls?.keys?.has("KeyC") || controls?.keys?.has("ControlLeft") || controls?.keys?.has("ControlRight")) vertical -= 1;
  return clamp(vertical, -1, 1);
}

function flightVerticalMotionActive() {
  return Boolean(player?.flightEnabled && Math.abs(flightVerticalInput()) > 0.001);
}

function syncAvatarToPlayer(now) {
  if (!avatar) return;
  const bob = controls.move.moving ? Math.abs(Math.sin(now * 0.011 * 0.5)) * 0.035 : 0;
  const [px, py, pz] = playerWorldFloat();
  const shadowWorldY = groundYAt(px, pz, { maxTopY: py + PLAYER_GROUND_SNAP_UP });
  avatar.worldX = player.worldX;
  avatar.worldY = player.worldY;
  avatar.worldZ = player.worldZ;
  avatar.localOffsetX = player.localOffsetX;
  avatar.localOffsetY = bob - AVATAR_FOOT_OFFSET;
  avatar.localOffsetZ = player.localOffsetZ;
  avatar.yaw = player.avatarYaw;
  avatar.animation = { moving: controls.move.actualMoving, timeMs: now };
  avatar.shadowWorldY = shadowWorldY;
  avatar.shadowCasterHeight = AVATAR_HEIGHT_BLOCKS;
  avatar.shadowRadiusX = Math.max(0.34, PLAYER_RADIUS * 0.92);
  avatar.shadowRadiusZ = Math.max(0.30, PLAYER_RADIUS * 0.78);
  avatar.shadowAlpha = 0.44;
}

function syncCameraToPlayer(dt = 1 / 60, { force = false } = {}) {
  const [px, py, pz] = playerWorldFloat();
  const mobileCamera = isMobileViewport();
  const targetY = py + (mobileCamera ? CAMERA_FOCUS_HEIGHT_MOBILE : CAMERA_FOCUS_HEIGHT_DESKTOP);
  if (force || !cameraFocusReady || distanceSquared(cameraFocusX, cameraFocusY, cameraFocusZ, px, targetY, pz) > 256) {
    cameraFocusX = px;
    cameraFocusY = targetY;
    cameraFocusZ = pz;
    cameraFocusReady = true;
  } else {
    const horizontalAlpha = 1 - Math.exp(-dt * 14);
    const verticalAlpha = 1 - Math.exp(-dt * 7);
    cameraFocusX = lerp(cameraFocusX, px, horizontalAlpha);
    cameraFocusZ = lerp(cameraFocusZ, pz, horizontalAlpha);
    cameraFocusY = lerp(cameraFocusY, targetY, verticalAlpha);
  }
  const pitch = clamp(Number.isFinite(player.cameraPitch) ? player.cameraPitch : camera.pitch, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
  player.cameraPitch = pitch;
  camera.pitch = pitch;
  const horizontal = Math.cos(pitch) * CAMERA_DISTANCE;
  const controlYaw = Number.isFinite(player.controlYaw) ? player.controlYaw : player.yaw;
  camera.yaw = controlYaw + Math.PI;
  const desiredX = cameraFocusX + Math.sin(controlYaw) * horizontal;
  const desiredY = cameraFocusY + Math.sin(-pitch) * CAMERA_DISTANCE + (mobileCamera ? CAMERA_LIFT_MOBILE : CAMERA_LIFT_DESKTOP);
  const desiredZ = cameraFocusZ + Math.cos(controlYaw) * horizontal;
  setCameraLookTargetWorldFloat(cameraFocusX, cameraFocusY, cameraFocusZ);
  if (force) {
    setCameraWorldFloat(desiredX, desiredY, desiredZ);
    setCameraLookTargetWorldFloat(cameraFocusX, cameraFocusY, cameraFocusZ);
    return;
  }
  const [cx, cy, cz] = cameraWorldFloat();
  const positionAlpha = 1 - Math.exp(-dt * 9);
  setCameraWorldFloat(
    lerp(cx, desiredX, positionAlpha),
    lerp(cy, desiredY, positionAlpha),
    lerp(cz, desiredZ, positionAlpha),
  );
}

function setCameraWorldFloat(x, y, z) {
  camera.worldX = Math.floor(x);
  camera.worldY = Math.floor(y);
  camera.worldZ = Math.floor(z);
  camera.localOffsetX = x - camera.worldX;
  camera.localOffsetY = y - camera.worldY;
  camera.localOffsetZ = z - camera.worldZ;
}

function setCameraLookTargetWorldFloat(x, y, z) {
  camera.targetWorldX = Math.floor(x);
  camera.targetWorldY = Math.floor(y);
  camera.targetWorldZ = Math.floor(z);
  camera.targetLocalOffsetX = x - camera.targetWorldX;
  camera.targetLocalOffsetY = y - camera.targetWorldY;
  camera.targetLocalOffsetZ = z - camera.targetWorldZ;
}

function playerWorldFloat() {
  return [
    Math.trunc(player.worldX || 0) + (player.localOffsetX || 0),
    Math.trunc(player.worldY || 0) + (player.localOffsetY || 0),
    Math.trunc(player.worldZ || 0) + (player.localOffsetZ || 0),
  ];
}

function cameraWorldFloat() {
  return [
    Math.trunc(camera.worldX || 0) + (camera.localOffsetX || 0),
    Math.trunc(camera.worldY || 0) + (camera.localOffsetY || 0),
    Math.trunc(camera.worldZ || 0) + (camera.localOffsetZ || 0),
  ];
}

function setPlayerWorldFloat(x, y, z) {
  player.worldX = Math.floor(x);
  player.worldY = Math.floor(y);
  player.worldZ = Math.floor(z);
  player.localOffsetX = x - player.worldX;
  player.localOffsetY = y - player.worldY;
  player.localOffsetZ = z - player.worldZ;
}

function savePlayerPosition(now = performance.now(), { force = false } = {}) {
  if (!player) return false;
  const key = [
    player.worldX,
    player.worldY,
    player.worldZ,
    fixed3(player.localOffsetX),
    fixed3(player.localOffsetY),
    fixed3(player.localOffsetZ),
    fixed3(player.avatarYaw),
    fixed3(player.controlYaw),
    fixed3(player.cameraPitch ?? camera?.pitch),
    player.flightEnabled ? "fly1" : "fly0",
  ].join(":");
  if (!force && key === lastPositionSaveKey) return false;
  if (!force && now - lastPositionSaveAt < POSITION_SAVE_INTERVAL_MS) return false;
  const payload = {
    version: 1,
    seed: PLAYABLE_WORLD_SEED,
    savedAt: Date.now(),
    worldX: Math.trunc(player.worldX || 0),
    worldY: Math.trunc(player.worldY || 0),
    worldZ: Math.trunc(player.worldZ || 0),
    localOffsetX: clamp(Number(player.localOffsetX) || 0, 0, 0.999999),
    localOffsetY: clamp(Number(player.localOffsetY) || 0, 0, 0.999999),
    localOffsetZ: clamp(Number(player.localOffsetZ) || 0, 0, 0.999999),
    controlYaw: Number.isFinite(player.controlYaw) ? player.controlYaw : player.yaw,
    avatarYaw: Number.isFinite(player.avatarYaw) ? player.avatarYaw : player.yaw,
    cameraPitch: Number.isFinite(player.cameraPitch ?? camera?.pitch) ? clamp(player.cameraPitch ?? camera.pitch, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX) : DEFAULT_CAMERA_PITCH,
    flightEnabled: Boolean(player.flightEnabled),
  };
  try {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(payload));
    lastPositionSaveAt = now;
    lastPositionSaveKey = key;
    return true;
  } catch {
    return false;
  }
}

function currentPoseSnapshot() {
  if (!player) return null;
  const [px, py, pz] = playerWorldFloat();
  return {
    worldX: Math.floor(px),
    worldY: Math.floor(py),
    worldZ: Math.floor(pz),
    localOffsetX: px - Math.floor(px),
    localOffsetY: py - Math.floor(py),
    localOffsetZ: pz - Math.floor(pz),
    fullX: px,
    fullY: py,
    fullZ: pz,
    avatarYaw: Number.isFinite(player.avatarYaw) ? player.avatarYaw : player.yaw,
    controlYaw: Number.isFinite(player.controlYaw) ? player.controlYaw : player.yaw,
    cameraPitch: Number.isFinite(player.cameraPitch) ? player.cameraPitch : camera?.pitch,
    viewDistance: Number(elements.viewRangeInput?.value) || viewDistance,
    flightEnabled: Boolean(player.flightEnabled),
  };
}

function poseSnapshotText(snapshot = currentPoseSnapshot()) {
  if (!snapshot) return "";
  return [
    `x=${fixed3(snapshot.fullX ?? (snapshot.worldX + snapshot.localOffsetX))}`,
    `y=${fixed3(snapshot.fullY ?? (snapshot.worldY + snapshot.localOffsetY))}`,
    `z=${fixed3(snapshot.fullZ ?? (snapshot.worldZ + snapshot.localOffsetZ))}`,
    `ay=${fixed3(snapshot.avatarYaw)}`,
    `cy=${fixed3(snapshot.controlYaw)}`,
    `cp=${fixed3(snapshot.cameraPitch)}`,
    `view=${Math.trunc(snapshot.viewDistance || viewDistance)}`,
    `fly=${snapshot.flightEnabled ? 1 : 0}`,
  ].join(" ");
}

function poseSummaryText(snapshot = currentPoseSnapshot()) {
  if (!snapshot) return "-";
  const x = snapshot.fullX ?? (snapshot.worldX + snapshot.localOffsetX);
  const y = snapshot.fullY ?? (snapshot.worldY + snapshot.localOffsetY);
  const z = snapshot.fullZ ?? (snapshot.worldZ + snapshot.localOffsetZ);
  return `pos ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)} · avatar ${radToDeg(snapshot.avatarYaw).toFixed(0)}° · camera ${radToDeg(snapshot.controlYaw).toFixed(0)}°/${radToDeg(snapshot.cameraPitch).toFixed(0)}°`;
}

async function copyPoseSnapshot() {
  const text = poseSnapshotText();
  if (!text) return;
  if (elements.poseInput) {
    elements.poseInput.value = text;
    elements.poseInput.select?.();
  }
  try {
    await navigator.clipboard?.writeText(text);
    elements.status.textContent = "Pose copied. Paste this line later to restore the exact debug view.";
  } catch {
    elements.status.textContent = "Pose copied into the input field. Clipboard API was unavailable.";
  }
}

function toggleRenderLog() {
  const enabled = renderLog.toggle();
  if (elements.renderLogToggle) elements.renderLogToggle.textContent = enabled ? "On" : "Off";
  updateRenderLogPreview();
  elements.status.textContent = enabled
    ? "Render log enabled. It records chunk build, upload, and CPU draw timings."
    : "Render log disabled. Normal runtime overhead is back to near zero.";
}

async function copyRenderLog() {
  const text = renderLog.toText();
  if (elements.renderLogPreview) elements.renderLogPreview.textContent = renderLog.summary();
  try {
    await navigator.clipboard?.writeText(text);
    elements.status.textContent = `Render log copied (${renderLog.count()} entries).`;
  } catch {
    elements.status.textContent = "Render log copy failed: Clipboard API was unavailable.";
  }
}

function clearRenderLog() {
  renderLog.clear();
  updateRenderLogPreview();
  elements.status.textContent = "Render log cleared.";
}

function updateRenderLogPreview() {
  if (!elements.renderLogPreview) return;
  elements.renderLogPreview.textContent = renderLog.summary();
  if (elements.renderLogToggle) elements.renderLogToggle.textContent = renderLog.enabled ? "On" : "Off";
}

function loadPoseSnapshot() {
  const pose = parsePoseText(elements.poseInput?.value || "");
  if (!pose) {
    elements.status.textContent = "Pose load failed: paste a line like x=0.5 y=98 z=0.5 ay=3.14 cy=3.14 cp=-0.42.";
    return;
  }
  applyPoseSnapshot(pose);
  elements.status.textContent = `Pose loaded: ${poseSummaryText(pose)}.`;
}

function applyPoseSnapshot(pose) {
  if (!pose || !player || !camera) return false;
  const x = pose.fullX ?? (pose.worldX + (pose.localOffsetX || 0));
  const y = pose.fullY ?? (pose.worldY + (pose.localOffsetY || 0));
  const z = pose.fullZ ?? (pose.worldZ + (pose.localOffsetZ || 0));
  setPlayerWorldFloat(x, y, z);
  if (Number.isFinite(pose.controlYaw)) player.controlYaw = pose.controlYaw;
  if (Number.isFinite(pose.avatarYaw)) {
    player.avatarYaw = pose.avatarYaw;
    player.yaw = pose.avatarYaw;
  }
  if (Number.isFinite(pose.cameraPitch)) player.cameraPitch = clamp(pose.cameraPitch, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
  if (typeof pose.flightEnabled === "boolean") {
    player.flightEnabled = pose.flightEnabled;
    player.velocityY = 0;
    player.grounded = !player.flightEnabled;
    flightVerticalIntent = 0;
    updateFlightUi();
  }
  if (Number.isFinite(pose.viewDistance)) setViewDistance(clampInt(pose.viewDistance, 2, PLAYABLE_MAX_VIEW_DISTANCE));
  cameraFocusReady = false;
  syncCameraToPlayer(1 / 60, { force: true });
  chunks.updatePlayerPosition(player.worldX, player.worldY, player.worldZ, cameraLoadDirection(camera));
  savePlayerPosition(performance.now(), { force: true });
  return true;
}

function loadSavedPlayerPosition() {
  let raw = null;
  try {
    raw = localStorage.getItem(POSITION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || saved.seed !== PLAYABLE_WORLD_SEED) return null;
    if (!Number.isFinite(saved.worldX) || !Number.isFinite(saved.worldY) || !Number.isFinite(saved.worldZ)) return null;
    return saved;
  } catch {
    return null;
  }
}

function movePlayerHorizontally(dx, dz) {
  const maxDelta = Math.max(Math.abs(dx), Math.abs(dz));
  if (maxDelta <= 0.000001) return false;
  const steps = Math.max(1, Math.ceil(maxDelta / PLAYER_COLLISION_STEP));
  const stepX = dx / steps;
  const stepZ = dz / steps;
  let moved = false;
  for (let i = 0; i < steps; i += 1) {
    moved = tryMovePlayerAxis(stepX, 0) || moved;
    moved = tryMovePlayerAxis(0, stepZ) || moved;
  }
  return moved;
}

function tryMovePlayerAxis(dx, dz) {
  if (Math.abs(dx) <= 0.000001 && Math.abs(dz) <= 0.000001) return false;
  const [x, y, z] = playerWorldFloat();
  const nextX = x + dx;
  const nextZ = z + dz;
  if (playerCollidesAt(nextX, y, nextZ)) return tryStepPlayerAxis(nextX, y, nextZ);
  setPlayerWorldFloat(nextX, y, nextZ);
  return true;
}

function tryStepPlayerAxis(nextX, y, nextZ) {
  if (!player.grounded) return false;
  const stepGround = groundYAt(nextX, nextZ, { maxTopY: y + PLAYER_STEP_HEIGHT_BLOCKS + PLAYER_GROUND_SNAP_UP });
  if (!Number.isFinite(stepGround)) return false;
  if (stepGround <= y + 0.03 || stepGround > y + PLAYER_STEP_HEIGHT_BLOCKS + 0.04) return false;
  if (playerCollidesAt(nextX, stepGround, nextZ)) return false;
  setPlayerWorldFloat(nextX, stepGround, nextZ);
  player.velocityY = 0;
  player.grounded = true;
  return true;
}

function movePlayerVertically(dy) {
  const maxDelta = Math.abs(dy);
  if (maxDelta <= 0.000001) return;
  const steps = Math.max(1, Math.ceil(maxDelta / PLAYER_COLLISION_STEP));
  const stepY = dy / steps;
  player.grounded = false;
  for (let i = 0; i < steps; i += 1) {
    const [x, y, z] = playerWorldFloat();
    const nextY = y + stepY;
    if (!playerCollidesAt(x, nextY, z)) {
      setPlayerWorldFloat(x, nextY, z);
      continue;
    }
    player.velocityY = 0;
    if (stepY < 0) {
      const ground = groundYAt(x, z, { maxTopY: y + PLAYER_GROUND_SNAP_UP });
      setPlayerWorldFloat(x, ground, z);
      player.grounded = true;
    }
    return;
  }
}

function resolvePlayerPenetration() {
  const [x, y, z] = playerWorldFloat();
  if (!playerCollidesAt(x, y, z)) return false;
  const escape = maxCollisionHorizontalExtent(playerCollisionBoxes(), playerCollisionYaw()) + metersToBlocks(0.04);
  const candidates = [
    [0, 0],
    [escape, 0],
    [-escape, 0],
    [0, escape],
    [0, -escape],
    [escape, escape],
    [-escape, escape],
    [escape, -escape],
    [-escape, -escape],
  ];
  for (const [ox, oz] of candidates) {
    const nx = x + ox;
    const nz = z + oz;
    const ny = Math.max(y, groundYAt(nx, nz, { maxTopY: y + PLAYER_GROUND_SNAP_UP }));
    if (!playerCollidesAt(nx, ny, nz)) {
      setPlayerWorldFloat(nx, ny, nz);
      player.velocityY = 0;
      player.grounded = true;
      return true;
    }
  }
  return false;
}

function groundYAt(x, z, options = {}) {
  const boxes = Number.isFinite(options.radius)
    ? [createCollisionBox({ halfWidth: options.radius, halfDepth: options.radius, height: PLAYER_BODY_HEIGHT })]
    : (options.collisionBoxes ?? playerCollisionBoxes());
  const preparedBoxes = prepareCollisionBoxes(boxes, x, 0, z, options.yaw ?? playerCollisionYaw());
  const maxTopY = Number.isFinite(options.maxTopY) ? options.maxTopY : Infinity;
  let ground = -Infinity;
  for (const box of preparedBoxes) {
    const minX = Math.floor(box.minX + PLAYER_COLLISION_EPSILON);
    const maxX = Math.floor(box.maxX - PLAYER_COLLISION_EPSILON);
    const minZ = Math.floor(box.minZ + PLAYER_COLLISION_EPSILON);
    const maxZ = Math.floor(box.maxZ - PLAYER_COLLISION_EPSILON);
    for (let bz = minZ; bz <= maxZ; bz += 1) {
      for (let bx = minX; bx <= maxX; bx += 1) {
        if (!preparedCollisionFootprintIntersectsBlock(box, bx, bz, PLAYER_COLLISION_EPSILON)) continue;
        ground = Math.max(ground, columnGroundYAt(bx, bz, maxTopY));
      }
    }
  }
  return Number.isFinite(ground) ? ground : chunks.minY + 1;
}

function columnGroundYAt(bx, bz, maxTopY = Infinity) {
  const worldTop = chunks.minY + chunks.height - 1;
  const cappedTop = Number.isFinite(maxTopY)
    ? Math.min(worldTop, Math.floor(maxTopY - 1 + PLAYER_COLLISION_EPSILON))
    : worldTop;
  for (let by = cappedTop; by >= chunks.minY; by -= 1) {
    if (isBlockingBlock(collisionBlockAt(bx, by, bz))) return by + 1;
  }
  return -Infinity;
}

function playerCollidesAt(x, y, z) {
  for (const box of prepareCollisionBoxes(playerCollisionBoxes(), x, y, z, playerCollisionYaw())) {
    const minX = Math.floor(box.minX + PLAYER_COLLISION_EPSILON);
    const maxX = Math.floor(box.maxX - PLAYER_COLLISION_EPSILON);
    const minY = Math.floor(box.minY + PLAYER_COLLISION_EPSILON);
    const maxY = Math.floor(box.maxY - PLAYER_COLLISION_EPSILON);
    const minZ = Math.floor(box.minZ + PLAYER_COLLISION_EPSILON);
    const maxZ = Math.floor(box.maxZ - PLAYER_COLLISION_EPSILON);
    for (let by = minY; by <= maxY; by += 1) {
      for (let bz = minZ; bz <= maxZ; bz += 1) {
        for (let bx = minX; bx <= maxX; bx += 1) {
          if (!isBlockingBlock(collisionBlockAt(bx, by, bz))) continue;
          if (preparedCollisionBoxIntersectsBlock(box, bx, by, bz, PLAYER_COLLISION_EPSILON)) return true;
        }
      }
    }
  }
  return false;
}

function playerCollisionBoxes() {
  const body = player?.collisionBoxes?.length ? player.collisionBoxes : [DEFAULT_PLAYER_COLLISION_BOX];
  const equipment = Array.isArray(player?.equipmentCollisionBoxes) ? player.equipmentCollisionBoxes : [];
  return equipment.length ? body.concat(equipment) : body;
}

function playerCollisionYaw() {
  // Keep collision stable while the visual avatar rotates. The body still uses
  // real model extents, but changing yaw must not push a stationary player into
  // nearby voxel corners and lock movement.
  return 0;
}

function collisionBlockAt(worldX, worldY, worldZ) {
  return chunks.getCollisionBlockAtWorld
    ? chunks.getCollisionBlockAtWorld(worldX, worldY, worldZ)
    : chunks.getBlockAtWorld(worldX, worldY, worldZ);
}

function updateViewRangeLabel(value) {
  elements.viewRangeValue.textContent = `${value} chunks`;
}

function viewFarPlane(distance) {
  return Math.max(460, Math.trunc(distance) * 48 + 160);
}

function maxBuildQueueForViewDistance(distance) {
  const preload = clampInt(distance, 2, PLAYABLE_MAX_VIEW_DISTANCE) + PLAYABLE_PRELOAD_MARGIN;
  const fullRing = preload * 2 + 1;
  return Math.max(768, fullRing * fullRing);
}

function bindJoystick() {
  const base = elements.joystick;
  const knob = elements.joystickKnob;
  if (!base || !knob) return;
  let activeId = null;
  const update = (event) => {
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const max = rect.width * 0.34;
    const dx = clamp(event.clientX - cx, -max, max);
    const dy = clamp(event.clientY - cy, -max, max);
    controls.setJoystick(dx / max, dy / max, true);
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  };
  const release = (event) => {
    if (event.pointerId !== activeId) return;
    activeId = null;
    controls.setJoystick(0, 0, false);
    knob.style.transform = "translate(-50%, -50%)";
  };
  base.addEventListener("pointerdown", (event) => {
    activeId = event.pointerId;
    base.setPointerCapture?.(event.pointerId);
    update(event);
  });
  base.addEventListener("pointermove", (event) => {
    if (event.pointerId === activeId) update(event);
  });
  base.addEventListener("pointerup", release);
  base.addEventListener("pointercancel", release);
}

function minePending() {
  const hit = lastHit?.hit ? lastHit : raycastBlock(camera, null, 8, chunks);
  if (!hit.hit) {
    elements.status.textContent = "No block in range.";
    return;
  }
  const def = blockDef(hit.blockId);
  if (hit.blockId === BLOCK_ID.air || isFluidBlock(hit.blockId) || !isMineableBlock(hit.blockId) || !def.hardness) {
    elements.status.textContent = `Target ${def.name} is not a mineable solid test block.`;
    return;
  }
  const txId = `local-pending-${txSerial++}`;
  chunks.applyPendingDelta([{ worldX: hit.worldX, worldY: hit.worldY, worldZ: hit.worldZ, blockId: BLOCK_ID.air }], txId);
  pendingTx.push(txId);
  elements.status.textContent = `Pending delta ${txId}: removed ${def.name} at ${hit.worldX}, ${hit.worldY}, ${hit.worldZ}.`;
}

function confirmLast() {
  const txId = pendingTx.pop();
  if (!txId) {
    elements.status.textContent = "No pending delta to confirm.";
    return;
  }
  chunks.confirmPendingDelta(txId);
  elements.status.textContent = `Confirmed ${txId}. Pending delta moved to chain delta.`;
}

function rollbackLast() {
  const txId = pendingTx.pop();
  if (!txId) {
    elements.status.textContent = "No pending delta to rollback.";
    return;
  }
  chunks.rollbackPendingDelta(txId);
  elements.status.textContent = `Rolled back ${txId}. Visual state restored from base/chain delta.`;
}

function removeUnloadedGpuChunks() {
  renderer.pruneChunks(new Set(chunks.chunks.keys()));
  const ids = new Set([...renderer.chunkBuffers.keys(), ...renderer.visualChunkBuffers.keys()]);
  for (const id of ids) {
    if (!chunks.chunks.has(id)) renderer.removeChunk(id);
  }
}

function updateHud(sample, renderStats, uploadStats = { uploaded: 0, pendingUploads: 0 }) {
  const worldStats = chunks.stats();
  elements.fps.textContent = `${sample.fps} FPS`;
  elements.build.textContent = `${worldStats.lastRebuildMs.toFixed(1)} ms / W ${worldStats.lastWorkerBuildMs.toFixed(1)} ms`;
  elements.chunks.textContent = `${worldStats.ready}/${worldStats.chunks} · GPU ${worldStats.uploaded} · Q ${worldStats.buildQueue}+${worldStats.inFlightBuilds} · U ${uploadStats.uploaded}/${uploadStats.pendingUploads}`;
  elements.visible.textContent = `${renderStats.visibleChunks}`;
  elements.triangles.textContent = formatNumber(renderStats.triangles);
  elements.draw.textContent = formatNumber(renderStats.drawCalls);
  elements.gpu.textContent = `${(renderStats.bufferMemory / 1048576).toFixed(2)} MB`;
  const [px, py, pz] = playerWorldFloat();
  elements.position.textContent = `${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)}`;
  const pose = currentPoseSnapshot();
  if (elements.pose) elements.pose.textContent = poseSummaryText(pose);
  if (elements.poseInput && document.activeElement !== elements.poseInput) elements.poseInput.value = poseSnapshotText(pose);
  updateRenderLogPreview();
  if (lastHit?.hit) {
    const info = inspectBlock(chunks, lastHit.worldX, lastHit.worldY, lastHit.worldZ);
    elements.hit.textContent = `${info.blockName} #${info.blockId} / R${info.resourceId} @ ${info.worldX},${info.worldY},${info.worldZ}`;
  } else {
    elements.hit.textContent = "-";
  }
}

function parsePoseText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let object = null;
  if (raw.startsWith("{")) {
    try {
      object = JSON.parse(raw);
    } catch {
      object = null;
    }
  }
  const values = object ? { ...object } : {};
  if (!object) {
    const pattern = /([a-zA-Z][a-zA-Z0-9_]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g;
    let match;
    while ((match = pattern.exec(raw))) values[match[1]] = Number(match[2]);
  }
  const x = numberFrom(values.x ?? values.px ?? values.worldX);
  const y = numberFrom(values.y ?? values.py ?? values.worldY);
  const z = numberFrom(values.z ?? values.pz ?? values.worldZ);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const splitX = splitWorldCoordinate(x);
  const splitY = splitWorldCoordinate(y);
  const splitZ = splitWorldCoordinate(z);
  const controlYaw = angleFrom(values.cy ?? values.cameraYaw ?? values.yaw ?? values.controlYaw);
  const avatarYaw = angleFrom(values.ay ?? values.avatarYaw ?? values.playerYaw ?? controlYaw);
  const cameraPitch = angleFrom(values.cp ?? values.cameraPitch ?? values.pitch);
  const flightEnabled = booleanFrom(values.fly ?? values.flight ?? values.flightEnabled);
  return {
    worldX: splitX.world,
    worldY: splitY.world,
    worldZ: splitZ.world,
    localOffsetX: splitX.local,
    localOffsetY: splitY.local,
    localOffsetZ: splitZ.local,
    fullX: x,
    fullY: y,
    fullZ: z,
    avatarYaw: Number.isFinite(avatarYaw) ? avatarYaw : undefined,
    controlYaw: Number.isFinite(controlYaw) ? controlYaw : undefined,
    cameraPitch: Number.isFinite(cameraPitch) ? clamp(cameraPitch, -0.92, 0.42) : undefined,
    viewDistance: Number.isFinite(values.view) ? clampInt(values.view, 2, PLAYABLE_MAX_VIEW_DISTANCE) : undefined,
    flightEnabled,
  };
}

function splitWorldCoordinate(value) {
  const world = Math.floor(Number(value) || 0);
  return { world, local: clamp((Number(value) || 0) - world, 0, 0.999999) };
}

function angleFrom(value) {
  const angle = numberFrom(value);
  if (!Number.isFinite(angle)) return NaN;
  return Math.abs(angle) > Math.PI * 2.5 ? angle * Math.PI / 180 : angle;
}

function numberFrom(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function booleanFrom(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "on") return true;
    if (normalized === "false" || normalized === "off") return false;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number !== 0 : undefined;
}

function radToDeg(value) {
  return Number.isFinite(value) ? value * 180 / Math.PI : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value || 0));
}

function hasSpawnParam(axis = null) {
  if (axis) return params.has(axis);
  return params.has("x") || params.has("y") || params.has("z");
}

function spawnCoord(axis, fallback) {
  if (params.has(axis)) return Math.trunc(Number(params.get(axis)) || 0);
  return Math.trunc(Number(fallback) || 0);
}

function spawnCoordOrNull(axis, fallback = null) {
  if (params.has(axis)) return Math.trunc(Number(params.get(axis)) || 0);
  return Number.isFinite(fallback) ? Math.trunc(fallback) : null;
}

function fixed3(value) {
  return Number.isFinite(value) ? Number(value).toFixed(3) : "0.000";
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function distanceSquared(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

function isMobileViewport() {
  return globalThis.matchMedia?.("(pointer: coarse)")?.matches || Math.min(globalThis.innerWidth || 0, globalThis.innerHeight || 0) <= 720;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || min)));
}

function metersToBlocks(value) {
  return Number(value) / BLOCK_SIZE_METERS;
}

function cameraLoadDirection(cameraState) {
  const forward = cameraForward(cameraState);
  return {
    directionX: forward[0],
    directionZ: forward[2],
  };
}
