import assert from "node:assert/strict";
import {
  analyzeNcm3Envelope,
  createBlueprint,
  decodeBlueprintAccount,
  decodeNcm3,
  describeBlueprint,
  encodeNcm3,
  NCM3_MAX_PAYLOAD_BYTES,
  NCM3_MAX_VOXELS,
  payloadByteLength,
  voxelize,
} from "../ncm/blueprint-codec.js";

const blueprint = createBlueprint({ x: 24, y: 22, z: 18 }, "Codec fixture")
  .box(3, 3, 0, 2, 16, 2, 13)
  .box(10, 4, 2, 3, 14, 9, 1)
  .gableFillZ(10, 4, 11, 3, 1, 11)
  .gableZ(96, 3, 10, 2, 16, 13)
  .gableTrimZ(22, 3, 10, 2, 16, 13);

const code = encodeNcm3(blueprint);
const decoded = decodeNcm3(code);
assert.equal(encodeNcm3(decoded), code, "NCM3 must remain canonical after decoding");
assert.deepEqual(decoded.size, blueprint.size);
assert.deepEqual(
  describeBlueprint(decoded).map((command) => command.op),
  ["BOX", "BOX", "GABLE_FILL_Z", "GABLE_Z", "GABLE_TRIM_Z"],
);
assert.deepEqual([...voxelize(decoded)], [...voxelize(blueprint)]);
assert.ok(payloadByteLength(code) < 256);
assert.throws(() => decodeNcm3(` ${code}`), /Expected an NCM3 payload/);
assert.throws(() => decodeNcm3(`${code}=`), /Base64URL/);
assert.throws(
  () => decodeNcm3(`NCM3:${"A".repeat(Math.ceil(NCM3_MAX_PAYLOAD_BYTES * 4 / 3) + 1)}`),
  /payload exceeds the safety limit/,
);
assert.throws(
  () => decodeNcm3(codeFromRaw([1, 0x81, 0, 1, 1, 0])),
  /varint is not canonical/,
  "overlong NCM3 varints must be rejected",
);
assert.throws(
  () => decodeNcm3(codeFromRaw([1, 1, 1, 1, 0xff, 0xff, 0xff, 0xff, 0x0f])),
  /command limit exceeded/,
  "the maximum u32 must remain unsigned instead of wrapping to -1",
);
assert.throws(
  () => decodeNcm3(codeFromRaw([1, 1, 1, 1, 0x80, 0x80, 0x80, 0x80, 0x10])),
  /varint is too large/,
  "NCM3 varints must reject values above u32",
);

const rawAccount = new TextEncoder().encode(code);
assert.equal((await decodeBlueprintAccount(rawAccount)).code, code);
assert.equal((await decodeBlueprintAccount(rawAccount.buffer)).code, code);
assert.equal((await decodeBlueprintAccount(
  new DataView(rawAccount.buffer, rawAccount.byteOffset, rawAccount.byteLength),
)).code, code);
for (const invalidAccountInput of [1_000_000, { length: 1_000_000 }, [1, 2, 3]]) {
  await assert.rejects(
    () => decodeBlueprintAccount(invalidAccountInput),
    /ArrayBuffer or ArrayBufferView/,
    "blueprint account decoding must reject non-BufferSource inputs",
  );
}
await assert.rejects(
  () => decodeBlueprintAccount(new ArrayBuffer(NCM3_MAX_PAYLOAD_BYTES * 2)),
  /exceeds the safety limit/,
);

const unsafe = createBlueprint({ x: 8, y: 8, z: 8 });
unsafe.repeat(1, 0, 0, 0, 1, 1, 1, 999_999, 1, 0, 0);
assert.throws(() => encodeNcm3(unsafe), /safety bounds/);

for (const material of [55, 77, 96, 101]) {
  const materialBlueprint = createBlueprint({ x: 1, y: 1, z: 1 }).box(material, 0, 0, 0);
  assert.equal(decodeNcm3(encodeNcm3(materialBlueprint)).commands[0].material, material);
}
for (const material of [53, 54, 78]) {
  const internalMaterial = createBlueprint({ x: 1, y: 1, z: 1 }).box(material, 0, 0, 0);
  assert.throws(() => encodeNcm3(internalMaterial), /Unknown canonical material ID/);
}

const chainBudgetOverflow = createBlueprint({ x: 256, y: 256, z: 1 });
chainBudgetOverflow.repeat(55, 0, 0, 0, 256, 256, 1, 5, 0, 0, 0);
assert.throws(() => encodeNcm3(chainBudgetOverflow), /operation budget exceeded/);

const exactEdgeBox = createBlueprint({ x: 8, y: 8, z: 8 }).box(3, 6, 5, 4, 2, 3, 4);
assert.doesNotThrow(() => encodeNcm3(exactEdgeBox));
for (const box of [
  [7, 0, 0, 2, 1, 1],
  [0, 7, 0, 1, 2, 1],
  [0, 0, 7, 1, 1, 2],
]) {
  assert.throws(
    () => encodeNcm3(createBlueprint({ x: 8, y: 8, z: 8 }).box(3, ...box)),
    /outside the declared blueprint dimensions/,
  );
}

assert.doesNotThrow(() => encodeNcm3(
  createBlueprint({ x: 8, y: 4, z: 4 }).repeat(3, 6, 0, 0, 2, 1, 1, 4, -2, 0, 0),
));
assert.throws(() => encodeNcm3(
  createBlueprint({ x: 8, y: 4, z: 4 }).repeat(3, 5, 0, 0, 2, 1, 1, 4, -2, 0, 0),
), /Repeated x geometry/);
assert.throws(() => encodeNcm3(
  createBlueprint({ x: 8, y: 4, z: 4 }).repeat(3, 1, 0, 0, 2, 1, 1, 4, 2, 0, 0),
), /Repeated x geometry/);

assert.doesNotThrow(() => encodeNcm3(
  createBlueprint({ x: 8, y: 4, z: 8 }).gable(3, 0, 0, 0, 8, 8),
));
assert.throws(() => encodeNcm3(
  createBlueprint({ x: 8, y: 3, z: 8 }).gable(3, 0, 0, 0, 8, 8),
), /outside the declared blueprint dimensions/);
assert.throws(() => encodeNcm3(
  createBlueprint({ x: 8, y: 3, z: 8 }).gableZ(3, 0, 0, 0, 8, 8),
), /outside the declared blueprint dimensions/);

assert.doesNotThrow(() => encodeNcm3(
  createBlueprint({ x: 8, y: 6, z: 8 }).tree(22, 23, 3, 0, 3, 6, 3),
));
assert.throws(() => encodeNcm3(
  createBlueprint({ x: 8, y: 6, z: 8 }).tree(22, 23, 2, 0, 3, 6, 3),
), /outside the declared blueprint dimensions/);
assert.throws(() => encodeNcm3(
  createBlueprint({ x: 8, y: 4, z: 8 }).tree(22, 23, 3, 0, 3, 2, 4),
), /outside the declared blueprint dimensions/);

assert.doesNotThrow(() => encodeNcm3(
  createBlueprint({ x: 8, y: 5, z: 8 }).fence(22, 0, 0, 0, 8, 0, 2),
));
assert.doesNotThrow(() => encodeNcm3(
  createBlueprint({ x: 8, y: 5, z: 8 }).fence(22, 0, 0, 0, 8, 1, 2),
));
assert.throws(() => encodeNcm3(
  createBlueprint({ x: 8, y: 4, z: 8 }).fence(22, 0, 0, 0, 8, 0, 2),
), /outside the declared blueprint dimensions/);

assert.throws(
  () => voxelize([{ material: 3, x: -1, y: 0, z: 0, w: 2, h: 1, d: 1 }], { x: 2, y: 2, z: 2 }),
  /outside the declared blueprint dimensions/,
);

const envelopeCases = [
  {
    name: "BOX",
    blueprint: createBlueprint({ x: 12, y: 10, z: 12 }).box(64, 2, 1, 3, 4, 3, 2),
    operationUpperBound: 24,
    bounds: bounds(2, 1, 3, 5, 3, 4),
    materials: [64],
  },
  {
    name: "REPEAT_BOX with a negative step",
    blueprint: createBlueprint({ x: 12, y: 8, z: 10 }).repeat(64, 8, 1, 2, 2, 2, 1, 3, -3, 0, 0),
    operationUpperBound: 12,
    bounds: bounds(2, 1, 2, 9, 2, 2),
    materials: [64],
  },
  {
    name: "GABLE",
    blueprint: createBlueprint({ x: 12, y: 8, z: 10 }).gable(64, 2, 1, 3, 5, 4),
    operationUpperBound: 24,
    bounds: bounds(2, 1, 3, 6, 3, 6),
    materials: [64],
  },
  {
    name: "GABLE_TRIM",
    blueprint: createBlueprint({ x: 12, y: 8, z: 10 }).gableTrim(64, 2, 1, 3, 5, 4),
    operationUpperBound: 12,
    bounds: bounds(2, 1, 3, 6, 3, 6),
    materials: [64],
  },
  {
    name: "GABLE_FILL",
    blueprint: createBlueprint({ x: 12, y: 8, z: 10 }).gableFill(64, 2, 1, 3, 5, 4),
    operationUpperBound: 60,
    bounds: bounds(2, 1, 3, 6, 3, 6),
    materials: [64],
  },
  {
    name: "GABLE_Z",
    blueprint: createBlueprint({ x: 12, y: 8, z: 12 }).gableZ(64, 3, 1, 2, 4, 5),
    operationUpperBound: 24,
    bounds: bounds(3, 1, 2, 6, 3, 6),
    materials: [64],
  },
  {
    name: "GABLE_TRIM_Z",
    blueprint: createBlueprint({ x: 12, y: 8, z: 12 }).gableTrimZ(64, 3, 1, 2, 4, 5),
    operationUpperBound: 12,
    bounds: bounds(3, 1, 2, 6, 3, 6),
    materials: [64],
  },
  {
    name: "GABLE_FILL_Z",
    blueprint: createBlueprint({ x: 12, y: 8, z: 12 }).gableFillZ(64, 3, 1, 2, 4, 5),
    operationUpperBound: 60,
    bounds: bounds(3, 1, 2, 6, 3, 6),
    materials: [64],
  },
  {
    name: "TREE",
    blueprint: createBlueprint({ x: 16, y: 12, z: 16 }).tree(22, 23, 6, 1, 6, 7, 3),
    operationUpperBound: 212,
    bounds: bounds(3, 1, 3, 10, 7, 10),
    materials: [22, 23],
  },
  {
    name: "FENCE along X",
    blueprint: createBlueprint({ x: 12, y: 8, z: 12 }).fence(64, 2, 1, 3, 7, 0, 3),
    operationUpperBound: 34,
    bounds: bounds(2, 1, 3, 8, 5, 3),
    materials: [64],
  },
  {
    name: "FENCE along Z",
    blueprint: createBlueprint({ x: 12, y: 8, z: 12 }).fence(64, 3, 2, 1, 8, 1, 4),
    operationUpperBound: 31,
    bounds: bounds(3, 2, 1, 3, 6, 8),
    materials: [64],
  },
];

for (const fixture of envelopeCases) {
  const envelope = analyzeNcm3Envelope(encodeNcm3(fixture.blueprint));
  const voxels = voxelize(fixture.blueprint);
  assert.equal(envelope.commandCount, 1, `${fixture.name} command count`);
  assert.equal(envelope.operationUpperBound, fixture.operationUpperBound, `${fixture.name} write upper bound`);
  assert.deepEqual(envelope.contentBounds, fixture.bounds, `${fixture.name} exact content bounds`);
  assert.deepEqual(boundsOfVoxels(voxels), fixture.bounds, `${fixture.name} semantic fixture bounds`);
  assert.deepEqual(envelope.referencedMaterials, fixture.materials, `${fixture.name} referenced materials`);
  assert.ok(envelope.operationUpperBound >= voxels.size, `${fixture.name} upper bound must cover final voxels`);
  assert.equal(
    envelope.maxVoxelCount,
    Math.min(
      NCM3_MAX_VOXELS,
      fixture.blueprint.size.x * fixture.blueprint.size.y * fixture.blueprint.size.z,
      fixture.operationUpperBound,
    ),
    `${fixture.name} request-result voxel cap`,
  );
}

const overlappingWrites = createBlueprint({ x: 12, y: 1, z: 1 })
  .box(64, 2, 0, 0, 6, 1, 1)
  .box(55, 2, 0, 0, 6, 1, 1);
const overlappingEnvelope = analyzeNcm3Envelope(encodeNcm3(overlappingWrites));
assert.equal(overlappingEnvelope.commandCount, 2);
assert.equal(overlappingEnvelope.operationUpperBound, 12);
assert.equal(overlappingEnvelope.maxVoxelCount, 12);
assert.deepEqual(overlappingEnvelope.contentBounds, bounds(2, 0, 0, 7, 0, 0));
assert.deepEqual(overlappingEnvelope.referencedMaterials, [55, 64]);
assert.equal(voxelize(overlappingWrites).size, 6, "overlap must remain an upper bound rather than semantic replay");

const emptyEnvelope = analyzeNcm3Envelope(encodeNcm3(createBlueprint({ x: 4, y: 3, z: 2 })));
assert.equal(emptyEnvelope.commandCount, 0);
assert.equal(emptyEnvelope.operationUpperBound, 0);
assert.equal(emptyEnvelope.maxVoxelCount, 0);
assert.deepEqual(emptyEnvelope.referencedMaterials, []);
assert.deepEqual(emptyEnvelope.contentBounds, bounds(0, 0, 0, -1, -1, -1));

function codeFromRaw(bytes) {
  return `NCM3:${Buffer.from(bytes).toString("base64url")}`;
}

function bounds(minX, minY, minZ, maxX, maxY, maxZ) {
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    depth: maxZ - minZ + 1,
  };
}

function boundsOfVoxels(voxels) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const voxel of voxels.values()) {
    minX = Math.min(minX, voxel.x);
    minY = Math.min(minY, voxel.y);
    minZ = Math.min(minZ, voxel.z);
    maxX = Math.max(maxX, voxel.x);
    maxY = Math.max(maxY, voxel.y);
    maxZ = Math.max(maxZ, voxel.z);
  }
  return bounds(minX, minY, minZ, maxX, maxY, maxZ);
}

console.log("NCM3 blueprint codec tests passed");
