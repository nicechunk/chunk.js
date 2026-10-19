import assert from "node:assert/strict";
import test from "node:test";
import { ChunkState } from "../chunk/chunk-state.js";
import { meshChunkOpaque, meshChunkOpaqueSteps, meshChunkOpaqueFast, meshChunkOpaqueFastSteps,
  meshChunkVisual, meshChunkVisualSteps, packChunkVertices, packChunkVerticesSteps,
  buildGeneratedVisualCandidates, buildGeneratedVisualCandidatesSteps } from "../chunk/chunk-mesher.js";
import { BLOCK_ID } from "../world/block-registry.js";

function dense(size = 16) {
  const blocks = new Uint16Array(size * size * 16);
  for (let i = 0; i < blocks.length; i++) blocks[i] = i % 7 === 0 ? BLOCK_ID.air : i % 3 === 0 ? BLOCK_ID.water : BLOCK_ID.stone;
  return new ChunkState({chunkX: -2, chunkZ: -1, chunkSize: size, minY: -8, height: 16,
    shadows: false, baseBlocks: blocks, worldSeed: new Uint8Array(32)});
}
function complete(iterator, onYield = () => {}) {
  let step;
  do {
    step = iterator.next();
    if (!step.done) {
      assert.deepEqual(Object.keys(step.value).sort(), ["phase", "workUnits"]);
      assert.equal(typeof step.value.phase, "string");
      assert.ok(step.value.workUnits > 0);
      onYield(step.value);
    }
  } while (!step.done);
  return step.value;
}

for (const [name, sync, steps] of [["opaque", meshChunkOpaque, meshChunkOpaqueSteps],
  ["visual", meshChunkVisual, meshChunkVisualSteps], ["fast fallback", meshChunkOpaqueFast, meshChunkOpaqueFastSteps]]) {
  test(`${name} yields private progress and returns identical final attributes`, () => {
    const chunk = dense(), reference = sync(chunk), phases = new Set();
    const mesh = complete(steps(chunk, {workBudget: 32}), progress => phases.add(progress.phase));
    assert.deepEqual(mesh, reference);
    assert.ok(phases.size >= 3);
    assert.ok(phases.has("pack-vertices"));
    assert.ok(phases.has("pack-indices"));
  });
}

test("opaque slices bound reads even through empty cells and cancellation never publishes", () => {
  const chunk = dense(), original = chunk.getFinalBlock.bind(chunk);
  let reads = 0, yields = 0;
  chunk.getFinalBlock = (...p) => {reads++; return original(...p);};
  chunk.mesh = {old: true};
  const iterator = meshChunkOpaqueSteps(chunk, {workBudget: 16});
  let result;
  do {
    reads = 0; result = iterator.next();
    assert.ok(reads <= 16 * 7, `slice made ${reads} voxel reads`);
    if (!result.done) {assert.deepEqual(chunk.mesh, {old: true}); yields++;}
  } while (!result.done);
  assert.ok(yields > 10);
  const cancelled = meshChunkVisualSteps(chunk, {workBudget: 8});
  assert.equal(cancelled.next().done, false);
  assert.equal(cancelled.return().done, true);
  assert.equal(cancelled.next().done, true);
  assert.deepEqual(chunk.mesh, {old: true});
});

test("interleaved builds never share output, greedy rows or packed storage", () => {
  const a = dense(4), b = dense(3), one = meshChunkOpaqueSteps(a, {workBudget: 8}), two = meshChunkOpaqueSteps(b, {workBudget: 17});
  let left = one.next(), right = two.next();
  while (!left.done || !right.done) {
    if (!left.done) left = one.next();
    if (!right.done) right = two.next();
  }
  assert.deepEqual(left.value, meshChunkOpaque(a));
  assert.deepEqual(right.value, meshChunkOpaque(b));
  assert.notEqual(left.value.vertices.buffer, right.value.vertices.buffer);
});

test("edited profile work includes cooperative canonical delta ordering", () => {
  const size = 16, profile = {surfaceY: new Int16Array(size * size).fill(4),
    surfaceBlock: new Uint16Array(size * size).fill(BLOCK_ID.stone),
    waterY: new Int16Array(size * size).fill(-32768), noWater: -32768,
    minY: -8, height: 16, maxBuildY: 7};
  const chunk = new ChunkState({chunkX: 0, chunkZ: 0, chunkSize: size, minY: -8, height: 16,
    shadows: false, baseProfile: profile, baseBlockResolver: (_x, y) => y <= 4 ? BLOCK_ID.stone : BLOCK_ID.air});
  const edits = [];
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) edits.push({worldX: x, worldY: 0, worldZ: z, blockId: BLOCK_ID.air});
  chunk.applyChainDelta(edits, {protectUntilSnapshot: false});
  const phases = new Set();
  const actual = complete(meshChunkOpaqueFastSteps(chunk, {neighborDeltas: [], workBudget: 16}), progress => phases.add(progress.phase));
  assert.deepEqual(actual, meshChunkOpaqueFast(chunk, {neighborDeltas: []}));
  assert.ok(phases.has("opaque-candidate-order"));
  const view = Object.create(chunk); view.baseProfile = null;
  view.generatedVisualProfile = {profile, editedColumns: new Set(Array.from({length: 256}, (_, i) => i))};
  let slices = 0;
  const candidates = complete(buildGeneratedVisualCandidatesSteps(view, {workBudget: 16}), () => slices++);
  assert.deepEqual(candidates, buildGeneratedVisualCandidates(view));
  assert.ok(slices > 1);
});

test("packing slices preserve scale/origin/flags and reject invalid work budgets", () => {
  const input = Array.from({length: 1024}, (_, i) => ({p: [i / 64, 320 + i / 128, -i / 256], n: [0, 127, 0], uv: [i, -i], layer: 99, ao: i & 255, flags: 0x80}));
  let slices = 0;
  const actual = complete(packChunkVerticesSteps(input, 320, {workBudget: 64}), () => slices++);
  assert.deepEqual(actual, packChunkVertices(input, 320));
  assert.ok(slices > 10);
  for (const workBudget of [0, -1, 4097, 1.5, NaN]) {
    assert.throws(() => meshChunkOpaqueSteps(dense(1), {workBudget}).next(), RangeError);
  }
});
