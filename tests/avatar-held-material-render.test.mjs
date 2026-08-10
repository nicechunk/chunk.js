import assert from "node:assert/strict";

import { WebGL2VoxelRenderer } from "../renderer/webgl2-renderer.js";
import { BLOCK_ID } from "../world/block-registry.js";

const calls = [];
let currentSurfacePass = null;
const gl = {
  ARRAY_BUFFER: 0x8892,
  BLEND: 0x0be2,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  TRIANGLES: 0x0004,
  useProgram() {},
  uniformMatrix4fv() {},
  uniform1i() {},
  uniform3f() {},
  uniform1f(location, value) {
    if (location === "surface-pass") currentSurfacePass = value;
  },
  bindBuffer() {},
  bufferSubData() {},
  bindVertexArray() {},
  enable(value) { calls.push(["enable", value]); },
  disable(value) { calls.push(["disable", value]); },
  blendFunc(source, destination) { calls.push(["blend", source, destination]); },
  depthMask(value) { calls.push(["depth-mask", value]); },
  drawElements() { calls.push(["draw", currentSurfacePass]); },
};

const renderer = Object.create(WebGL2VoxelRenderer.prototype);
renderer.gl = gl;
renderer.avatarProgram = {};
renderer.avatarUniforms = {
  uViewProjection: "view-projection",
  uTextureArray: "texture-array",
  uAvatarOrigin: "avatar-origin",
  uAvatarYaw: "avatar-yaw",
  uAvatarOpacity: "avatar-opacity",
  uAvatarSurfacePass: "surface-pass",
};
renderer.textureArray = { bind() {} };
renderer.avatarBuffers = new Map([
  ["avatar", {
    mesh: null,
    handle: {
      vao: {},
      indexCount: 36,
      indexType: 0x1403,
      triangleCount: 12,
      byteLength: 256,
    },
  }],
]);

assert.deepEqual(drawPasses(BLOCK_ID.grass), [0], "an opaque held block must stay in one avatar draw pass");
assert.deepEqual(drawPasses(BLOCK_ID.ice), [1, 2], "held ice must split opaque avatar and transparent block surfaces");
assert.deepEqual(
  drawPasses(BLOCK_ID.ice, 0.5),
  [0],
  "an avatar-wide fade must keep one blended pass instead of applying opacity twice",
);

console.log("avatar held material render tests passed");

function drawPasses(blockId, opacity = 1) {
  calls.length = 0;
  currentSurfacePass = null;
  const stats = renderer.renderAvatars(
    {},
    [{
      id: "avatar",
      worldX: 0,
      worldY: 0,
      worldZ: 0,
      opacity,
      animation: {
        equipment: {
          rightHand: "block",
          equipmentId: "held_block",
          blockId,
        },
      },
    }],
    new Float32Array(16),
    { worldX: 0, worldY: 0, worldZ: 0 },
    null,
  );
  const passes = calls.filter(([name]) => name === "draw").map(([, pass]) => pass);
  assert.equal(stats.drawCalls, passes.length);
  assert.equal(stats.triangles, passes.length * 12);
  if (calls.some(([name, value]) => name === "enable" && value === gl.BLEND)) {
    assert.equal(calls.at(-1)?.[0], "depth-mask", "rendering must restore depth writes after a blended pass");
    assert.equal(calls.at(-1)?.[1], true);
  }
  return passes;
}
