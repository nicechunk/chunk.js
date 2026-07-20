import assert from "node:assert/strict";
import test from "node:test";

import { createCameraState } from "../renderer/camera.js";
import {
  chunkIntersectsCameraFrustum,
  filterChunksByCameraFrustum,
} from "../renderer/frustum.js";

function buildingChunk(chunkX, chunkZ, options = {}) {
  return {
    id: `${chunkX},${chunkZ}`,
    chunkX,
    chunkZ,
    chunkSize: 16,
    minY: options.minY ?? 0,
    height: options.height ?? 16,
    frustumCullEligible: true,
  };
}

function forwardCamera(options = {}) {
  return createCameraState({
    worldX: 8,
    worldY: 8,
    worldZ: 8,
    localOffsetX: 0,
    localOffsetY: 0,
    localOffsetZ: 0,
    yaw: 0,
    pitch: 0,
    fov: 60,
    aspect: 16 / 9,
    near: 0.08,
    far: 160,
    ...options,
  });
}

test("building frustum culling rejects chunks fully behind the camera", () => {
  const camera = forwardCamera();
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(0, 2), camera), true);
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(0, -3), camera), false);
});

test("building frustum culling keeps sphere intersections at camera edges", () => {
  const camera = forwardCamera({ aspect: 1 });
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(2, 2), camera), true);
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(5, 2), camera), false);
});

test("building frustum culling follows an explicit third-person target", () => {
  const camera = forwardCamera({
    targetWorldX: -24,
    targetWorldY: 8,
    targetWorldZ: 8,
  });
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(-2, 0), camera), true);
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(2, 0), camera), false);
});

test("building frustum culling preserves vertical orientation for pitched cameras", () => {
  const camera = forwardCamera({
    targetWorldX: 8,
    targetWorldY: 40,
    targetWorldZ: 40,
    aspect: 1,
  });
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(0, 2, { minY: 32 }), camera), true);
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(0, 2, { minY: -48 }), camera), false);
});

test("frustum filtering never removes terrain or chunks without safe bounds", () => {
  const camera = forwardCamera();
  const terrain = { id: "terrain", chunkX: 0, chunkZ: -4, chunkSize: 16 };
  const invalidBuilding = { ...buildingChunk(0, -4), height: 0 };
  const visible = filterChunksByCameraFrustum([
    terrain,
    invalidBuilding,
    buildingChunk(0, -4),
    buildingChunk(0, 2),
  ], camera);
  assert.deepEqual(visible.map((chunk) => chunk.id), ["terrain", "0,-4", "0,2"]);
});

test("precomputed building bounds preserve frustum decisions", () => {
  const camera = forwardCamera();
  const source = buildingChunk(0, 2, { minY: 4, height: 20 });
  const width = source.chunkSize + 0.5;
  const paddedHeight = source.height + 0.5;
  const prepared = {
    ...source,
    frustumBounds: {
      centerX: source.chunkX * source.chunkSize + source.chunkSize * 0.5,
      centerY: source.minY + source.height * 0.5,
      centerZ: source.chunkZ * source.chunkSize + source.chunkSize * 0.5,
      radius: Math.hypot(width, paddedHeight, width) * 0.5,
    },
  };
  assert.equal(chunkIntersectsCameraFrustum(prepared, camera), chunkIntersectsCameraFrustum(source, camera));
});
