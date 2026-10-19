import assert from "node:assert/strict";
import test from "node:test";
import { createBlueprint, encodeNcm3, expandBlueprint, expandBlueprintSteps, voxelize, voxelizeSteps } from "../ncm/blueprint-codec.js";
import { parseNcm3Building, parseNcm3BuildingSteps, createBuildingPlacement, createBuildingPlacementSteps } from "../construction/building-parser.js";
import { createBuildingChunkMeshes, createBuildingChunkMeshesSteps } from "../construction/building-mesher.js";

function finish(iterator, onYield = () => {}) {
  let result;
  do {
    result = iterator.next();
    if (!result.done) {
      assert.deepEqual(Object.keys(result.value).sort(), ["phase", "workUnits"]);
      assert.ok(result.value.workUnits > 0);
      onYield(result.value);
    }
  } while (!result.done);
  return result.value;
}

function buildingCode(size = 16) {
  return encodeNcm3(createBlueprint({x: size, y: 8, z: size}, "cooperative-room")
    .box(64, 0, 0, 0, size, 1, size)
    .box(62, 0, 1, 0, 1, 6, size)
    .box(58, size - 1, 1, 0, 1, 6, size)
    .box(96, 1, 7, 1, size - 2, 1, size - 2));
}
const foundation = {id: "negative-crossing", minX: -19, minZ: 14, surfaceY: 111, width: 32, depth: 32};

test("large blueprint painting yields without changing overwrite order or limits", () => {
  const blueprint = createBlueprint({x: 32, y: 16, z: 32}, "paint")
    .box(64, 0, 0, 0, 32, 16, 32)
    .box(58, 31, 0, 0, 1, 16, 32);
  const commands = structuredClone(blueprint.commands);
  let slices = 0;
  const actual = finish(voxelizeSteps(blueprint, undefined, {workBudget: 64}), () => slices++);
  assert.ok(slices > 200);
  assert.deepEqual(actual, voxelize(blueprint));
  assert.equal(actual.size, 16384);
  assert.equal(actual.get("31,0,0").material, 58);
  assert.equal(actual.get("30,0,0").material, 64);
  assert.deepEqual(blueprint.commands, commands);
  assert.deepEqual(finish(expandBlueprintSteps(blueprint, {workBudget: 1})), expandBlueprint(blueprint));
  const cancelled = voxelizeSteps(blueprint, undefined, {workBudget: 16});
  assert.equal(cancelled.next().done, false);
  cancelled.return();
  assert.equal(cancelled.next().done, true);
  assert.deepEqual(blueprint.commands, commands);
});

test("parser analysis, code IDs and materialized/compact placement preserve exact output across yields", () => {
  const code = buildingCode(32), options = {id: "room", name: "Room"};
  const phases = new Set();
  const building = finish(parseNcm3BuildingSteps(code, {...options, workBudget: 32}), progress => phases.add(progress.phase));
  assert.deepEqual(building, parseNcm3Building(code, options));
  assert.ok(phases.has("blueprint-voxels"));
  assert.ok(phases.has("building-content-bounds"));
  for (const materializeWorldVoxels of [true, false]) for (const quarterTurns of [0, 1, 2, 3]) {
    const placementOptions = {quarterTurns, placementId: "room-placement", materializeWorldVoxels};
    const actual = finish(createBuildingPlacementSteps(building, foundation, {...placementOptions, workBudget: 32}));
    assert.deepEqual(actual, createBuildingPlacement(building, foundation, placementOptions));
  }
});

test("building mesh slices include skylight, Gaussian ray traversal, greedy and private packing", () => {
  const building = parseNcm3Building(buildingCode());
  const placement = createBuildingPlacement(building, foundation, {quarterTurns: 1, materializeWorldVoxels: false});
  const phases = new Set();
  const actual = finish(createBuildingChunkMeshesSteps(placement, {revision: 7, workBudget: 8}), progress => phases.add(progress.phase));
  assert.deepEqual(actual, createBuildingChunkMeshes(placement, {revision: 7}));
  for (const phase of ["building-placement-voxels", "building-sky-columns", "building-sky-spread", "building-light-ray", "building-greedy-faces", "building-pack-vertices", "building-pack-indices"]) assert.ok(phases.has(phase), phase);
  const before = [...building.voxels];
  const cancelled = createBuildingChunkMeshesSteps(placement, {workBudget: 8});
  for (let i = 0; i < 4; i++) assert.equal(cancelled.next().done, false);
  assert.equal(cancelled.return().done, true);
  assert.deepEqual([...building.voxels], before);
});

test("sparse large bounds use sliced fallback light rays and independent interleaved writers", () => {
  const blueprint = createBlueprint({x: 256, y: 256, z: 256}, "sparse-rays").box(64, 0, 0, 0, 1, 1, 1);
  const building = parseNcm3Building(encodeNcm3(blueprint));
  const ground = {id: "large", minX: -128, minZ: -128, surfaceY: 0, width: 256, depth: 256};
  const placement = createBuildingPlacement(building, ground, {materializeWorldVoxels: false});
  const first = createBuildingChunkMeshesSteps(placement, {workBudget: 4});
  const otherPlacement = createBuildingPlacement(building, {...ground, minX: 1024}, {materializeWorldVoxels: true});
  const second = createBuildingChunkMeshesSteps(otherPlacement, {workBudget: 7});
  const phases = new Set();
  let a = first.next(), b = second.next();
  while (!a.done || !b.done) {
    if (!a.done) {phases.add(a.value.phase); a = first.next();}
    if (!b.done) b = second.next();
  }
  assert.ok(phases.has("building-light-ray"));
  assert.deepEqual(a.value, createBuildingChunkMeshes(placement));
  assert.deepEqual(b.value, createBuildingChunkMeshes(otherPlacement));
  assert.notEqual(a.value[0].mesh.vertices.buffer, b.value[0].mesh.vertices.buffer);
});

test("step parsers retain format and operation safety failures", () => {
  assert.throws(() => finish(parseNcm3BuildingSteps("NCM3:bad")));
  assert.throws(() => finish(voxelizeSteps([{material: 64, x: 0, y: 0, z: 0, w: 256, h: 256, d: 256}], {x: 256, y: 256, z: 256})), /operation budget/);
  assert.throws(() => finish(createBuildingChunkMeshesSteps({}, {workBudget: 0})), RangeError);
});
