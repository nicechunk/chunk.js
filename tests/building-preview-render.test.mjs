import assert from "node:assert/strict";
import test from "node:test";

import { WebGL2VoxelRenderer } from "../renderer/webgl2-renderer.js";
import { OPAQUE_FRAGMENT_SHADER } from "../renderer/shader-manager.js";

test("building previews use a translucent pass without writing depth", () => {
  const opacityValues = [];
  const depthMasks = [];
  const enabled = [];
  const disabled = [];
  let draws = 0;
  const gl = {
    DEPTH_TEST: 1,
    CULL_FACE: 2,
    BLEND: 3,
    SRC_ALPHA: 4,
    ONE_MINUS_SRC_ALPHA: 5,
    TRIANGLES: 6,
    useProgram() {},
    uniform1f(_location, value) { opacityValues.push(value); },
    uniform2f() {},
    uniform3f() {},
    enable(value) { enabled.push(value); },
    disable(value) { disabled.push(value); },
    blendFunc() {},
    depthMask(value) { depthMasks.push(value); },
    bindVertexArray() {},
    drawElements() { draws += 1; },
  };
  const renderer = new WebGL2VoxelRenderer({ addEventListener() {}, removeEventListener() {} });
  renderer.gl = gl;
  renderer.program = {};
  renderer.uniforms = { uOpacity: {}, uWorldOrigin: {}, uChunkOrigin: {} };
  renderer.textureArray = { bind() {} };
  renderer.chunkBuffers.set("preview", { handle: meshHandle() });
  renderer.visualChunkBuffers.set("preview", { handle: meshHandle() });

  const stats = renderer.renderBuildingPreviewChunks([{
    id: "preview",
    buildingPreview: true,
    chunkX: 2,
    chunkZ: 3,
    chunkSize: 16,
    mesh: { indexCount: 6 },
    visualMesh: { indexCount: 6 },
  }], { worldX: 10, worldY: 4, worldZ: 12 });

  assert.equal(draws, 2);
  assert.equal(stats.drawCalls, 2);
  assert.deepEqual(opacityValues, [0.46, 1]);
  assert.deepEqual(depthMasks, [false, true]);
  assert.ok(enabled.includes(gl.BLEND));
  assert.ok(disabled.includes(gl.BLEND));
  assert.match(OPAQUE_FRAGMENT_SHADER, /texel\.a \* uOpacity/);
});

function meshHandle() {
  return {
    vao: {},
    indexCount: 6,
    indexType: 0,
    triangleCount: 2,
    byteLength: 128,
  };
}
