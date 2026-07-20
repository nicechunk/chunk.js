import assert from "node:assert/strict";
import {
  createBlueprint,
  decodeNcm3,
  describeBlueprint,
  encodeNcm3,
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

console.log("NCM3 blueprint codec tests passed");
