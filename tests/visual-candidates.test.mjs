import assert from "node:assert/strict";
import test from "node:test";
import { ChunkState } from "../chunk/chunk-state.js";
import { buildGeneratedVisualCandidates, meshChunkVisual } from "../chunk/chunk-mesher.js";
import { buildRenderSection, ensureRenderSections } from "../chunk/render-sections.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { compileSurfaceDecorationRules, SURFACE_DECORATION_ID } from "../world/surface-decoration-rules.js";
import { decodedVertices } from "./helpers/face-oracle.mjs";

const emptyRules = compileSurfaceDecorationRules([]);
function fixture({size = 4, surface = 4, water = null, rules = emptyRules, shadows = false} = {}) {
  const profile = {surfaceY: new Int16Array(size * size).fill(surface),
    surfaceBlock: new Uint16Array(size * size).fill(BLOCK_ID.stone),
    waterY: new Int16Array(size * size).fill(water ?? -32768),
    noWater: -32768, minY: -16, height: 64, maxBuildY: 47, generationVersion: 5};
  return new ChunkState({chunkX: -2, chunkZ: -3, chunkSize: size, height: 64, minY: -16,
    worldSeed: new Uint8Array(32), generationVersion: 5, shadows,
    baseProfile: profile, surfaceDecorationRules: rules,
    baseBlockResolver: (_x, y) => y <= surface ? BLOCK_ID.stone : BLOCK_ID.air});
}
function edit(chunk, x, y, z, blockId) {
  chunk.applyChainDelta([{worldX: chunk.chunkX * chunk.chunkSize + x, worldY: y,
    worldZ: chunk.chunkZ * chunk.chunkSize + z, blockId}], {protectUntilSnapshot: false});
}
function viewFor(chunk, minY, optimized) {
  const view = Object.create(chunk);
  view.minY = minY; view.height = 16; view.renderOriginY = minY; view.baseProfile = null;
  view.getFinalBlock = chunk.getFinalBlock.bind(chunk);
  view.getBaseBlock = chunk.getBaseBlock.bind(chunk);
  view.getFinalDeltaMap = chunk.getFinalDeltaMap.bind(chunk);
  view.treeInstances = chunk.treeInstances.filter(tree => Math.floor(tree.baseY / 16) === Math.floor(minY / 16));
  if (optimized) {
    const editedColumns = new Set([...chunk.getFinalDeltaMap().values()].map(delta => delta.localX + delta.localZ * chunk.chunkSize));
    view.generatedVisualProfile = {profile: chunk.baseProfile, editedColumns};
    view.visualCandidates = buildGeneratedVisualCandidates(view);
  }
  return view;
}
function compare(chunk, minY = 0, halo = null) {
  const referenceView = viewFor(chunk, minY, false);
  const candidateView = viewFor(chunk, minY, true);
  const getBlockAtWorld = halo ?? ((x, y, z) => {
    const lx = x - chunk.chunkX * chunk.chunkSize, lz = z - chunk.chunkZ * chunk.chunkSize;
    if (lx >= 0 && lz >= 0 && lx < chunk.chunkSize && lz < chunk.chunkSize) return chunk.getFinalBlock(lx, y, lz);
    return y <= chunk.baseProfile.surfaceY[0] ? BLOCK_ID.stone : BLOCK_ID.air;
  });
  const access = {getBlockAtWorld, getColumnTopAtWorld: () => chunk.baseProfile.surfaceY[0]};
  const reference = meshChunkVisual(referenceView, access);
  const actual = meshChunkVisual(candidateView, access);
  // This compares the complete packed attributes, including UVs, material,
  // normals, shade, flags, fractional positions and index order, not counts.
  assert.deepEqual(actual.vertices, reference.vertices);
  assert.deepEqual(actual.indices, reference.indices);
  for (const key of ["originY", "blockCount", "quadCount", "vertexCount", "indexCount"]) assert.equal(actual[key], reference[key], key);
  return {view: candidateView, actual};
}
function pebbleRules(surfaceBlockId = BLOCK_ID.stone) {
  return compileSurfaceDecorationRules([{ruleId: 1, decorationId: SURFACE_DECORATION_ID.pebbleGray,
    surfaceBlockId, dropBlockId: BLOCK_ID.stone, rollStartBps: 0, rollEndBps: 10000}]);
}

test("zero visual summaries do no voxel work, including empty rules, unrelated rules and pickup masks", () => {
  for (const mode of ["empty", "edited", "unrelated", "picked", "capped"]) {
    const chunk = fixture({size: 16, surface: 0, water: mode === "capped" ? 12 : null,
      rules: mode === "unrelated" ? pebbleRules(BLOCK_ID.grass) : mode === "picked" ? pebbleRules() : emptyRules});
    if (mode === "edited" || mode === "capped") for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) edit(chunk, x, mode === "capped" ? 13 : -1, z, mode === "capped" ? BLOCK_ID.stone : BLOCK_ID.air);
    if (mode === "picked") chunk.pickedSurfaceColumns = Array.from({length: 256}, (_, i) => i);
    const {view, actual} = compare(chunk);
    assert.equal(view.visualCandidates.empty, true, mode);
    assert.equal(actual.vertexCount, 0, mode);
    view.getFinalBlock = () => {throw new Error(`Unexpected final-state query: ${mode}`);};
    const result = meshChunkVisual(view, {getBlockAtWorld: () => {throw new Error("Unexpected halo query");}});
    assert.equal(result.vertexCount, 0);
  }
});

test("final edits preserve underground details, same-value plants, transparent corners and full halo checks", () => {
  const chunk = fixture({rules: pebbleRules()});
  for (const [x, y, z, id] of [[0, -2, 0, BLOCK_ID.air], [0, -3, 0, BLOCK_ID.air],
    [1, 5, 1, BLOCK_ID.cotton], [0, 6, 0, BLOCK_ID.ice], [3, 15, 3, BLOCK_ID.flowerWhite]]) edit(chunk, x, y, z, id);
  compare(chunk, -16);
  const before = compare(chunk).actual;
  edit(chunk, 1, 5, 1, BLOCK_ID.cotton);
  assert.deepEqual(compare(chunk).actual.vertices, before.vertices);
  compare(chunk, 0, (_x, y) => y === 6 ? BLOCK_ID.ice : BLOCK_ID.air);
});

test("water removal, caps and reopening preserve surfaces on either side of a section boundary", () => {
  const chunk = fixture({surface: -1, water: 25});
  for (const id of [BLOCK_ID.air, BLOCK_ID.stone, BLOCK_ID.water, BLOCK_ID.air]) {
    edit(chunk, 0, 16, 0, id);
    edit(chunk, 3, 25, 3, id);
    compare(chunk, 0);
    compare(chunk, 16);
  }
  edit(chunk, 3, 24, 3, BLOCK_ID.air);
  edit(chunk, 3, 23, 3, BLOCK_ID.air);
  compare(chunk, 16);
});

for (const size of [1, 16, 31, 32, 33, 64]) test(`candidate and complete scan match at size ${size}`, () => {
  const chunk = fixture({size, rules: pebbleRules()});
  edit(chunk, size - 1, 5, size - 1, BLOCK_ID.cotton);
  edit(chunk, 0, -1, 0, BLOCK_ID.water);
  edit(chunk, 0, 0, 0, BLOCK_ID.air);
  chunk.pickedSurfaceColumns = [Math.floor(size * size / 2)];
  compare(chunk);
});

test("shadow projections keep the complete path and opaque cross-section models remain owned", () => {
  const chunk = fixture({shadows: true});
  chunk.treeInstances = [{x: chunk.chunkX * 4, z: chunk.chunkZ * 4, baseY: 15, trunkHeight: 6, pine: false}];
  edit(chunk, 3, 15, 3, BLOCK_ID.cactus);
  assert.equal(compare(chunk).view.visualCandidates.empty, false);
  chunk.shadows = false;
  const sections = ensureRenderSections(chunk);
  const section = sections.get(1);
  const result = buildRenderSection(chunk, section, {generatedTerrain: true, getBlockAtWorld: () => BLOCK_ID.air, neighborDeltas: []});
  assert.equal(result.visualError, null);
  assert.equal(result.visualMesh.vertexCount, 0);
  assert.ok(result.mesh.vertexCount > 0);
  assert.ok(Math.max(...decodedVertices(result.mesh).map(vertex => vertex.p[1])) > 16, "models owned below the boundary retain their upper geometry");
});

test("uncertified inputs retain the full traversal and candidate preparation does not mutate inputs", () => {
  const chunk = fixture();
  assert.equal(buildGeneratedVisualCandidates(chunk), null);
  const view = viewFor(chunk, 0, true);
  const map = [...chunk.getFinalDeltaMap()], surfaces = chunk.baseProfile.surfaceY.slice();
  const masks = chunk.pickedSurfaceColumns.slice();
  buildGeneratedVisualCandidates(view);
  assert.deepEqual([...chunk.getFinalDeltaMap()], map);
  assert.deepEqual(chunk.baseProfile.surfaceY, surfaces);
  assert.deepEqual(chunk.pickedSurfaceColumns, masks);
  view.baseBlocks = new Uint16Array(16 * 4 * 4);
  assert.equal(buildGeneratedVisualCandidates(view), null);
  view.baseBlocks = null; view.generationVersion = 4;
  assert.equal(buildGeneratedVisualCandidates(view), null);
});
