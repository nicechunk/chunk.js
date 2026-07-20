import { mat4LookAt, mat4Multiply, mat4Perspective } from "../core/math.js";

export function createCameraState(options = {}) {
  return {
    worldX: Math.trunc(options.worldX ?? 0),
    worldY: Math.trunc(options.worldY ?? 24),
    worldZ: Math.trunc(options.worldZ ?? 0),
    localOffsetX: Number(options.localOffsetX ?? 0),
    localOffsetY: Number(options.localOffsetY ?? 0),
    localOffsetZ: Number(options.localOffsetZ ?? 0),
    yaw: Number(options.yaw ?? -0.7),
    pitch: Number(options.pitch ?? 0.45),
    fov: Number(options.fov ?? 58),
    aspect: Number(options.aspect ?? 1),
    near: Number(options.near ?? 0.08),
    far: Number(options.far ?? 420),
    targetWorldX: Number.isFinite(options.targetWorldX) ? Math.trunc(options.targetWorldX) : null,
    targetWorldY: Number.isFinite(options.targetWorldY) ? Math.trunc(options.targetWorldY) : null,
    targetWorldZ: Number.isFinite(options.targetWorldZ) ? Math.trunc(options.targetWorldZ) : null,
    targetLocalOffsetX: Number(options.targetLocalOffsetX ?? 0),
    targetLocalOffsetY: Number(options.targetLocalOffsetY ?? 0),
    targetLocalOffsetZ: Number(options.targetLocalOffsetZ ?? 0),
  };
}

export function cameraOrigin(cameraState) {
  return {
    worldX: Math.trunc(cameraState.worldX || 0),
    worldY: Math.trunc(cameraState.worldY || 0),
    worldZ: Math.trunc(cameraState.worldZ || 0),
  };
}

export function cameraFloatPosition(cameraState) {
  return [
    cameraState.localOffsetX || 0,
    cameraState.localOffsetY || 0,
    cameraState.localOffsetZ || 0,
  ];
}

export function cameraHasTarget(cameraState) {
  return Number.isFinite(cameraState.targetWorldX)
    && Number.isFinite(cameraState.targetWorldY)
    && Number.isFinite(cameraState.targetWorldZ);
}

export function cameraTargetFloatPosition(cameraState) {
  if (!cameraHasTarget(cameraState)) return null;
  return [
    cameraState.targetWorldX - Math.trunc(cameraState.worldX || 0) + (cameraState.targetLocalOffsetX || 0),
    cameraState.targetWorldY - Math.trunc(cameraState.worldY || 0) + (cameraState.targetLocalOffsetY || 0),
    cameraState.targetWorldZ - Math.trunc(cameraState.worldZ || 0) + (cameraState.targetLocalOffsetZ || 0),
  ];
}

export function cameraForward(cameraState) {
  const eye = cameraFloatPosition(cameraState);
  const target = cameraTargetFloatPosition(cameraState);
  if (target) {
    const dx = target[0] - eye[0];
    const dy = target[1] - eye[1];
    const dz = target[2] - eye[2];
    const length = Math.hypot(dx, dy, dz);
    if (length > 0.000001) return [dx / length, dy / length, dz / length];
  }
  const cp = Math.cos(cameraState.pitch);
  return [Math.sin(cameraState.yaw) * cp, -Math.sin(cameraState.pitch), Math.cos(cameraState.yaw) * cp];
}

export function cameraViewProjection(cameraState) {
  const eye = cameraFloatPosition(cameraState);
  const forward = cameraForward(cameraState);
  const target = cameraTargetFloatPosition(cameraState) ?? [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]];
  const projection = mat4Perspective((cameraState.fov * Math.PI) / 180, cameraState.aspect, cameraState.near, cameraState.far);
  const view = mat4LookAt(eye, target, [0, 1, 0]);
  return mat4Multiply(projection, view);
}
