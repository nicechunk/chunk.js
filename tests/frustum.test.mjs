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

test("building frustum culling keeps AABB intersections at camera edges", () => {
  const camera = forwardCamera({ aspect: 1 });
  assert.equal(chunkIntersectsCameraFrustum(buildingChunk(1, 2), camera), true);
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

test("high-altitude downward view keeps the audit screen-space counterexample", () => {
  const camera = forwardCamera({ worldX: 0, worldY: 226, worldZ: 0,
    yaw: 0, pitch: 0.92, fov: 58, far: 420 });
  const chunk = { ...buildingChunk(7, 1), minY: -32, height: 353 };
  assert.equal(chunkIntersectsCameraFrustum(chunk, camera), true);
});

test("committed visual bounds outside the nominal chunk remain visible", async () => {
  const { chunkWorldBounds } = await import("../renderer/frustum.js");
  const mesh = { bounds: { minX: -2, maxX: 2, minY: 0, maxY: 1, minZ: 0, maxZ: 1 } };
  const visual = { bounds: { minX: 0, maxX: 20, minY: 0, maxY: 40, minZ: -2, maxZ: 3 } };
  const chunk = { ...buildingChunk(-1, -2), mesh, visualMesh: visual };
  assert.deepEqual(chunkWorldBounds(chunk), { minX: -18, maxX: 4, minY: 0, maxY: 40, minZ: -34, maxZ: -29 });
});

test("projection AABB culling is conservative for visible points across pitch, aspect and negative coordinates", async () => {
  const { aabbIntersectsCameraFrustum } = await import("../renderer/frustum.js");
  const { cameraViewProjection, cameraOrigin } = await import("../renderer/camera.js");
  for (const aspect of [9/19, 1, 16/9]) for (const pitch of [-1.5, -0.92, 0, 0.92, 1.5]) {
    const camera = forwardCamera({ worldX: -145, worldY: 226, worldZ: -86, aspect, pitch, yaw: -1.7, far: 500 });
    const m = cameraViewProjection(camera), origin = cameraOrigin(camera);
    for (let x = -270; x <= 10; x += 17) for (let y = -32; y <= 320; y += 31) for (let z = -200; z <= 30; z += 19) {
      const p = [x-origin.worldX,y-origin.worldY,z-origin.worldZ,1];
      const clip = [0,1,2,3].map((row) => m[row]*p[0]+m[4+row]*p[1]+m[8+row]*p[2]+m[12+row]);
      if (clip[3] <= 0 || clip.slice(0,3).some((value) => Math.abs(value) > clip[3])) continue;
      assert.equal(aabbIntersectsCameraFrustum({ minX:x-1,maxX:x+1,minY:y-1,maxY:y+1,minZ:z-1,maxZ:z+1 },camera),true);
    }
  }
});


test("manager prefilter cannot discard the high-altitude screen-space counterexample", async () => {
  const { ChunkManager } = await import("../chunk/chunk-manager.js");
  const manager = new ChunkManager({ viewDistance: 7, useWorkers: false });
  const chunk = { ...buildingChunk(7, 1), minY: -32, height: 353,
    mesh: { bounds: { minX:0,maxX:16,minY:85,maxY:87,minZ:0,maxZ:16 } } };
  manager.chunks.set(chunk.id, chunk);
  const camera = forwardCamera({ worldX:0, worldY:226, worldZ:0, yaw:0, pitch:0.92, fov:58, far:420 });
  assert.ok(manager.getVisibleChunks(camera).includes(chunk));
  manager.dispose?.();
});


test("section visibility never materializes a lazy whole-chunk summary", async () => {
  const { chunkWorldBounds } = await import("../renderer/frustum.js");
  const summary = { sectionSummary: true, get vertices() { throw Error("unexpected full-chunk packing"); } };
  const bounds = {minX:0,maxX:16,minY:0,maxY:16,minZ:0,maxZ:16};
  const chunk = { ...buildingChunk(0,0), mesh: summary, visualMesh: summary,
    renderSections: new Map([[0,{mesh:{bounds,originY:-32}}]]) };
  assert.deepEqual(chunkWorldBounds(chunk),{minX:0,maxX:16,minY:-32,maxY:-16,minZ:0,maxZ:16});
});


test("legacy Float32 mesh bounds use its declared interleaved layout", async () => {
  const {chunkWorldBounds}=await import("../renderer/frustum.js");
  const vertices=new Float32Array(20);
  vertices.set([-2,-17,3],0);vertices.set([18,9,20],10);
  const chunk={...buildingChunk(-1,-2),mesh:{vertices,vertexCount:2,vertexStrideBytes:40,originY:32}};
  assert.deepEqual(chunkWorldBounds(chunk),{minX:-18,maxX:2,minY:15,maxY:41,minZ:-29,maxZ:-12});
});
