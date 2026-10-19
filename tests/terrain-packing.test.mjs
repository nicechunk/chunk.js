import assert from "node:assert/strict";
import test from "node:test";
import { packChunkVertices, POSITION_PACK_SCALE } from "../chunk/chunk-mesher.js";

const vertex = p => ({p, n: [-127, 0, 127], uv: [-1, 65538], layer: 102, ao: 227, flags: 0x8123});
function fields(bytes, index = 0) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), o = index * 20;
  return {position: [data.getInt16(o, true), data.getInt16(o + 2, true), data.getInt16(o + 4, true)],
    scale: data.getInt16(o + 6, true), normal: [data.getInt8(o + 8), data.getInt8(o + 9), data.getInt8(o + 10)],
    ao: data.getUint8(o + 11), uv: [data.getUint16(o + 12, true), data.getUint16(o + 14, true)],
    layer: data.getUint16(o + 16, true), flags: data.getUint16(o + 18, true)};
}

test("terrain packing keeps fractional scale, origin, material, normals, UV and flags", () => {
  const input = [vertex([1 / 64, 320 + 3 / 64, -2 / 64])];
  const bytes = packChunkVertices(input, 320);
  assert.equal(bytes.length, 20);
  assert.equal(bytes.positionOriginY, 320);
  assert.deepEqual(fields(bytes), {position: [1, 3, -2], scale: POSITION_PACK_SCALE,
    normal: [-127, 0, 127], ao: 227, uv: [65535, 2], layer: 102, flags: 0x8123});
  assert.deepEqual(input[0].p, [1 / 64, 320 + 3 / 64, -2 / 64]);
});

test("scale selection obeys signed range after rounding on all three axes", () => {
  for (const [p, expected] of [[[511.984375, 0, -512], 64], [[511.9921875, 0, 0], 32],
    [[-512.015625, 0, 0], 32], [[0, 511.9921875, 0], 32], [[0, 0, 1024], 16]]) {
    assert.equal(fields(packChunkVertices([vertex(p)], 0)).scale, expected);
  }
});

test("automatic origins support legal high and negative world heights and empty arrays", () => {
  for (const [y, origin] of [[-32768, -32768], [-513, -528], [-512, 0], [319, 0], [320, 0], [512, 512], [32767, 32752]]) {
    const bytes = packChunkVertices([vertex([0, y, 0])]);
    assert.equal(bytes.positionOriginY, origin);
    const packed = fields(bytes);
    assert.equal(packed.position[1] / packed.scale + origin, y);
  }
  assert.equal(packChunkVertices([], 320).positionOriginY, 320);
  assert.equal(packChunkVertices([]).length, 0);
});

test("non-finite and unrepresentable final coordinates fail rather than wrap", () => {
  for (const p of [[Infinity, 0, 0], [0, NaN, 0], [0, 0, -Infinity], [32768, 0, 0], [-32769, 0, 0]]) {
    assert.throws(() => packChunkVertices([vertex(p)], 0), RangeError);
  }
});
