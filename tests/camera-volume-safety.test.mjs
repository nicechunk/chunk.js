import assert from "node:assert/strict";
import test from "node:test";
import { resolveCameraCollisionSegment } from "../input/camera-collision.js";

test("camera volume cannot extend into a wall beyond its requested eye", () => {
  const result = resolveCameraCollisionSegment(0.5, 2.5, 0.5, 3.9, 2.5, 0.5,
    (x) => x === 4, { radius: 0.24, skin: 0.01 });
  assert.ok(result.x + 0.24 < 4, `camera volume penetrated wall: ${result.x}`);
});

test("camera start in a solid cannot be reported as a safe result", () => {
  const result = resolveCameraCollisionSegment(1.5, 2.5, 0.5, 5.5, 2.5, 0.5,
    (x) => x === 1, { radius: 0.24 });
  assert.equal(result.startBlocked, true);
  assert.equal(result.safe, false);
});

test("invalid camera start uses only a verified fallback, including zero-length segments", () => {
  const result = resolveCameraCollisionSegment(1.5, 2.5, 0.5, 1.5, 2.5, 0.5,
    (x) => x === 1, { radius: 0.24, fallbackPosition: [0.5, 2.5, 0.5] });
  assert.equal(result.safe, true);
  assert.equal(result.usedFallback, true);
  assert.equal(result.x, 0.5);
});

test("camera volume catches voxel corner gaps between the former sample rays", () => {
  // A corner can intersect a swept box while lying outside the old 9-ray ring.
  const result = resolveCameraCollisionSegment(0.5, 0.84, 0.84, 5.5, 0.84, 0.84,
    (x, y, z) => x === 3 && y === 1 && z === 1,
    { radius: 0.24, skin: 0.01 });
  assert.ok(result.x + 0.24 < 3);
});
