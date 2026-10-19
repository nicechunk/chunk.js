import assert from "node:assert/strict";
import test from "node:test";
import { renderResolution } from "../renderer/render-resolution.js";

test("pixel cap bounds work at high DPR, 4K, ultrawide and portrait sizes", () => {
  for (const [width, height] of [[1920, 1080], [3840, 2160], [3440, 1440], [390, 844], [1, 6000]]) {
    const size = renderResolution(width, height, 3, 1280 * 720);
    assert.ok(size.width * size.height <= 1280 * 720);
    const scale = Math.min(3, Math.sqrt(1280 * 720 / (width * height)));
    assert.ok(Math.abs(size.width - width * scale) <= 1);
    assert.ok(Math.abs(size.height - height * scale) <= 1);
    assert.ok(size.width >= 1 && size.height >= 1);
  }
});

test("small canvases retain their pixels and unlimited callers retain DPR", () => {
  assert.deepEqual(renderResolution(640, 360, 1, 1280 * 720), { width: 640, height: 360 });
  assert.deepEqual(renderResolution(390, 844, 1, 1280 * 720), { width: 390, height: 844 });
  assert.deepEqual(renderResolution(100, 200, 1.75), { width: 175, height: 350 });
  assert.deepEqual(renderResolution(0, 0, 0), { width: 1, height: 1 });
});
