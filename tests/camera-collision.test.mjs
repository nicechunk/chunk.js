import assert from "node:assert/strict";
import test from "node:test";

import { resolveCameraCollisionSegment } from "../input/camera-collision.js";

test("camera sweep leaves an unobstructed camera at its requested position", () => {
  const result = resolveCameraCollisionSegment(0.5, 2.5, 0.5, 8.5, 2.5, 0.5, () => false);

  assert.equal(result.collided, false);
  assert.equal(result.x, 8.5);
  assert.equal(result.y, 2.5);
  assert.equal(result.z, 0.5);
});

test("camera sweep stops before a blocking terrain wall", () => {
  const result = resolveCameraCollisionSegment(
    0.5,
    2.5,
    0.5,
    8.5,
    2.5,
    0.5,
    (x, y, z) => x === 4 && y >= 1 && y <= 3 && z >= -1 && z <= 1,
    { radius: 0.24, skin: 0.1, minimumDistance: 0.12 },
  );

  assert.equal(result.collided, true);
  assert.ok(result.x < 4, `camera x ${result.x} must remain in front of the wall`);
  assert.ok(Math.abs(result.x - 3.9) < 0.000001);
});

test("camera sweep radius catches terrain beside the center ray", () => {
  const result = resolveCameraCollisionSegment(
    0.5,
    2.5,
    0.82,
    8.5,
    2.5,
    0.82,
    (x, y, z) => x === 4 && y === 2 && z === 1,
    { radius: 0.24, skin: 0.1, minimumDistance: 0.12 },
  );

  assert.equal(result.collided, true);
  assert.ok(result.x < 4);
});

test("camera sweep ignores terrain beyond the requested camera position", () => {
  const result = resolveCameraCollisionSegment(
    0.5,
    2.5,
    0.5,
    3.5,
    2.5,
    0.5,
    (x) => x === 4,
  );

  assert.equal(result.collided, false);
  assert.equal(result.x, 3.5);
});

test("zero-radius safety checks trace the center only", () => {
  let visits = 0;
  resolveCameraCollisionSegment(
    0.5,
    2.5,
    0.5,
    8.5,
    2.5,
    0.5,
    () => {
      visits += 1;
      return false;
    },
    { radius: 0 },
  );

  assert.ok(visits <= 10, `center sweep should not repeat the same ray (${visits} visits)`);
});
