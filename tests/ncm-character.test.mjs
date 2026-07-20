import assert from "node:assert/strict";
import {
  NCM4_ACTION_IDS,
  NCM4_ACTIONS,
  NCM4_BONE_IDS,
  NCM4_BONES,
  NCM4_MAX_PAYLOAD_BYTES,
  NCM4_ROTATION_STEP_RADIANS,
  NCM4_TICKS_PER_SECOND,
  decodeNcm4,
  encodeNcm4,
  ncm4Crc32c,
  ncm4PayloadByteLength,
} from "../ncm/character-codec.js";

assert.equal(NCM4_BONES.length, 20);
assert.equal(NCM4_BONES[NCM4_BONE_IDS.head].parent, NCM4_BONE_IDS.neck);
assert.equal(NCM4_ACTION_IDS.greet_customer, 1);
assert.deepEqual(
  NCM4_ACTIONS.map(({ name }) => name),
  ["idle", "greet_customer", "show_goods", "record_price", "complete_trade"],
);
assert.equal(
  ncm4Crc32c(new TextEncoder().encode("123456789")),
  0xe3069283,
  "CRC32C must use the Castagnoli test vector",
);

const palette = [
  "#24150f", "#5d3522", "#9a6746", "#f0c9ad",
  "#fff7e6", "#202127", "#3d3f49", "#8e919b",
  "#d5b35b", "#6f3b24", "#b5683d", "#f4d9a5",
];

const pivots = [
  [0, 0, 0], [0, 8, 0], [0, 11, 0], [0, 18, 0], [0, 23, 0],
  [0, 25.5, 0], [-5, 20, 0], [-8, 17, 0], [-9, 13, 0],
  [5, 20, 0], [8, 17, 0], [9, 13, 0], [-2.5, 8, 0], [-2.5, 4, 0],
  [-2.5, 0.5, 1], [2.5, 8, 0], [2.5, 4, 0], [2.5, 0.5, 1],
  [0, 19, 3], [0, 9, 1],
];

const cuboids = Array.from({ length: 112 }, (_, index) => ({
  paletteIndex: index % palette.length,
  bone: index % NCM4_BONES.length,
  group: index < 76 ? 0 : 1 + (index % 3),
  origin: [(index % 15) - 7, Math.floor(index / 15) * 3, (Math.floor(index / 5) % 7) - 3],
  size: [1 + (index % 5), 1 + (index % 4), 1 + (index % 3)],
}));

function clip(name, visibleGroups, armBone, phase) {
  return {
    name,
    durationTicks: 30,
    ticksPerSecond: NCM4_TICKS_PER_SECOND,
    loop: true,
    visibleGroups,
    keyframes: [0, 10, 20, 30].map((tick, index) => ({
      tick,
      rotations: {
        chest: [0, (index - 1.5) * 0.025, 0],
        head: [0, (index - 1.5) * -0.04, 0],
        [armBone]: [Math.sin((index + phase) * Math.PI / 3) * 0.72, 0, phase * 0.08],
      },
    })),
  };
}

const model = {
  unit: 16,
  palette,
  pivots,
  cuboids,
  actions: [
    clip("complete_trade", [0, 3], "right_upper_arm", 3),
    clip("record_price", [0, 2], "right_lower_arm", 2),
    clip("show_goods", [0, 1], "left_upper_arm", 1),
    clip("greet_customer", [0], "right_upper_arm", 0),
  ],
};

const code = encodeNcm4(model);
assert.match(code, /^NCM4:[A-Za-z0-9_-]+$/);
assert.ok(!code.includes("="), "NCM4 Base64URL must be unpadded");
assert.ok(ncm4PayloadByteLength(code) <= 1300, "the complex animated fixture should leave chain headroom");
assert.ok(Buffer.byteLength(code, "utf8") <= 2048, "the canonical envelope must fit the chain text field");

const decoded = decodeNcm4(code);
assert.equal(decoded.format, "NCM4");
assert.equal(decoded.version, 1);
assert.equal(decoded.unit, model.unit);
assert.equal(decoded.rotationUnit, "radians");
assert.deepEqual(decoded.palette, palette);
assert.deepEqual(decoded.pivots, pivots);
assert.equal(decoded.cuboids.length, cuboids.length);
assert.deepEqual(decoded.cuboids[37].origin, cuboids[37].origin);
assert.deepEqual(decoded.cuboids[37].size, cuboids[37].size);
assert.equal(decoded.cuboids[37].boneName, NCM4_BONES[cuboids[37].bone].name);
assert.equal(decoded.clips, decoded.actions, "clips is the compatibility alias for actions");
assert.deepEqual(
  decoded.actions.map(({ name }) => name),
  ["greet_customer", "show_goods", "record_price", "complete_trade"],
  "actions are canonically ordered by their fixed ID",
);
assert.deepEqual(decoded.actions[1].visibleGroups, [0, 1]);
assert.equal(decoded.actions[1].visibleGroupMask, 0b0011);
assert.ok(
  Math.abs(decoded.actions[0].keyframes[1].rotations[2].rotation[0] - (Math.sin(Math.PI / 3) * 0.72))
    <= (NCM4_ROTATION_STEP_RADIANS / 2) + Number.EPSILON,
  "Euler values are decoded in radians after int8 quantization",
);
assert.equal(decoded.payloadBytes, ncm4PayloadByteLength(code));
assert.equal(encodeNcm4(decoded), code, "decode/encode must preserve the canonical payload exactly");

assert.throws(() => decodeNcm4(` ${code}`), /canonical NCM4/);
assert.throws(() => decodeNcm4(code.replace(/^NCM4:/, "ncm4:")), /canonical NCM4/);
assert.throws(() => decodeNcm4(`${code}=`), /Base64URL/);

const raw = rawFromCode(code);
const crcCorruption = new Uint8Array(raw);
crcCorruption[10] ^= 1;
assert.throws(() => decodeNcm4(codeFromRaw(crcCorruption)), /CRC32C checksum mismatch/);

const reservedFlagsBody = raw.slice(0, -4);
reservedFlagsBody[1] = 1;
assert.throws(() => decodeNcm4(codeFromBody(reservedFlagsBody)), /reserved flags/);

const trailingBody = new Uint8Array(raw.length - 4 + 1);
trailingBody.set(raw.subarray(0, -4));
trailingBody[trailingBody.length - 1] = 0;
assert.throws(() => decodeNcm4(codeFromBody(trailingBody)), /trailing NCM4 bytes/);

const body = raw.slice(0, -4);
assert.equal(body[2], model.unit, "fixture unit should occupy a single canonical varint byte");
const nonCanonicalVarintBody = new Uint8Array(body.length + 1);
nonCanonicalVarintBody.set(body.subarray(0, 2));
nonCanonicalVarintBody[2] = body[2] | 0x80;
nonCanonicalVarintBody[3] = 0;
nonCanonicalVarintBody.set(body.subarray(3), 4);
assert.throws(() => decodeNcm4(codeFromBody(nonCanonicalVarintBody)), /varint is not canonical/);

const invalidVersionBody = raw.slice(0, -4);
invalidVersionBody[0] = 2;
assert.throws(() => decodeNcm4(codeFromBody(invalidVersionBody)), /Unsupported NCM4 version/);

const tinyCode = encodeNcm4({
  unit: 1,
  palette: ["#ffffff"],
  pivots: NCM4_BONES.map(() => [0, 0, 0]),
  cuboids: [{ paletteIndex: 0, bone: 0, group: 0, origin: [0, 0, 0], size: [1, 1, 1] }],
  actions: [{
    name: "greet_customer",
    durationTicks: 10,
    visibleGroups: [0],
    keyframes: [{ tick: 0, rotations: [{ bone: 0, rotation: [0, 0, 0] }] }],
  }],
});
const tinyBody = rawFromCode(tinyCode).slice(0, -4);
assert.equal(tinyBody[77] & 0x1f, NCM4_ACTION_IDS.greet_customer, "tiny fixture action offset changed");
assert.equal(tinyBody[81], 0, "tiny fixture first keyframe offset changed");
assert.equal(tinyBody[83], 0, "tiny fixture rotation bone offset changed");

const reservedActionBody = tinyBody.slice();
reservedActionBody[77] |= 0x20;
assert.throws(() => decodeNcm4(codeFromBody(reservedActionBody)), /action header contains reserved bits/);

const unknownActionBody = tinyBody.slice();
unknownActionBody[77] = (unknownActionBody[77] & 0x80) | 0x1f;
assert.throws(() => decodeNcm4(codeFromBody(unknownActionBody)), /Unknown NCM4 action ID/);

const invalidFirstTickBody = tinyBody.slice();
invalidFirstTickBody[81] = 1;
assert.throws(() => decodeNcm4(codeFromBody(invalidFirstTickBody)), /first NCM4 keyframe/);

const invalidRotationBoneBody = tinyBody.slice();
invalidRotationBoneBody[83] = NCM4_BONES.length;
assert.throws(() => decodeNcm4(codeFromBody(invalidRotationBoneBody)), /rotation bone index is out of range/);

const unusedActionGroupBody = tinyBody.slice();
unusedActionGroupBody[79] = 3;
assert.throws(() => decodeNcm4(codeFromBody(unusedActionGroupBody)), /unused geometry group/);

const paddingCode = encodeNcm4({
  unit: 1,
  palette: ["#ffffff"],
  pivots: NCM4_BONES.map(() => [0, 0, 0]),
  cuboids: [{ paletteIndex: 0, bone: 0, group: 0, origin: [1, 0, 0], size: [1, 1, 1] }],
  actions: [],
});
const paddingBody = rawFromCode(paddingCode).slice(0, -4);
assert.equal(paddingBody[71], 2, "padding fixture x bit width changed");
const nonZeroPaddingBody = paddingBody.slice();
nonZeroPaddingBody[77] |= 0x80;
assert.throws(() => decodeNcm4(codeFromBody(nonZeroPaddingBody)), /padding bits must be zero/);

const inflatedBitWidthBody = paddingBody.slice();
inflatedBitWidthBody[71] = 3;
assert.throws(() => decodeNcm4(codeFromBody(inflatedBitWidthBody)), /x bit width is not canonical/);

assert.throws(
  () => encodeNcm4({ ...model, palette: [palette[0], palette[0]] }),
  /palette colors must be unique/,
);
assert.throws(
  () => encodeNcm4({ ...model, pivots: pivots.map((pivot, index) => index === 0 ? [0.25, 0, 0] : pivot) }),
  /half-grid coordinates/,
);
assert.throws(
  () => encodeNcm4({ ...model, cuboids: cuboids.map((cuboid) => ({ ...cuboid, group: 1 })) }),
  /body geometry in group 0/,
);
assert.throws(
  () => encodeNcm4({
    ...model,
    actions: [{ ...model.actions[0], visibleGroups: [0, 9] }],
  }),
  /unused geometry group/,
);
assert.throws(
  () => encodeNcm4({
    ...model,
    actions: [{ ...model.actions[0], keyframes: model.actions[0].keyframes.map((frame, index) => ({ ...frame, tick: index === 0 ? 1 : frame.tick })) }],
  }),
  /first NCM4 keyframe/,
);
assert.throws(
  () => encodeNcm4({
    ...model,
    actions: [{ ...model.actions[0], keyframes: [model.actions[0].keyframes[0], model.actions[0].keyframes[2], model.actions[0].keyframes[1]] }],
  }),
  /ticks must be strictly increasing/,
);
assert.throws(
  () => encodeNcm4({ ...model, actions: [model.actions[0], { ...model.actions[0] }] }),
  /Duplicate NCM4 action/,
);
assert.throws(
  () => encodeNcm4({ ...model, actions: [{ ...model.actions[0], ticksPerSecond: 24 }] }),
  /fixed 30 ticks per second/,
);
assert.throws(
  () => encodeNcm4({
    ...model,
    actions: [{
      ...model.actions[0],
      keyframes: [{ tick: 0, rotations: [{ bone: "head", rotation: [Math.PI + 0.1, 0, 0] }] }],
    }],
  }),
  /\[-pi, pi\]/,
);

const oversizedCuboids = Array.from({ length: 512 }, (_, index) => ({
  paletteIndex: index % palette.length,
  bone: index % NCM4_BONES.length,
  group: 0,
  origin: [index % 2 ? 32767 : -32768, index % 3 ? 32767 : -32768, index % 5 ? 32767 : -32768],
  size: [256, 256, 256],
}));
assert.throws(
  () => encodeNcm4({ ...model, cuboids: oversizedCuboids, actions: [] }),
  new RegExp(`on-chain limit is ${NCM4_MAX_PAYLOAD_BYTES} bytes`),
);

function rawFromCode(value) {
  return new Uint8Array(Buffer.from(value.slice("NCM4:".length), "base64url"));
}

function codeFromRaw(value) {
  return `NCM4:${Buffer.from(value).toString("base64url")}`;
}

function codeFromBody(value) {
  const next = new Uint8Array(value.length + 4);
  next.set(value);
  new DataView(next.buffer).setUint32(value.length, ncm4Crc32c(value), true);
  return codeFromRaw(next);
}

console.log(`NCM4 character codec tests passed (${ncm4PayloadByteLength(code)} raw bytes)`);
