import assert from "node:assert/strict";

import { BLOCK_FLAGS } from "../core/constants.js";
import { ChunkState } from "../chunk/chunk-state.js";
import {
  CHUNK_VERTEX_STRIDE_BYTES,
  createSurfaceDecorationPreviewMesh,
  meshChunkVisual,
} from "../chunk/chunk-mesher.js";
import {
  BLOCK_ID,
  MATERIAL_ID,
  RESOURCE_ID,
  blockDef,
  isLowVegetationBlock,
  isMineableBlock,
  isVisualBlock,
} from "../world/block-registry.js";
import { materialDef } from "../world/material-registry.js";
import {
  DEFAULT_SURFACE_DECORATION_RULES,
  SURFACE_DECORATION_FLAGS,
  SURFACE_DECORATION_ID,
  compileSurfaceDecorationRules,
  resolveSurfaceDecoration,
  surfaceDecorationName,
} from "../world/surface-decoration-rules.js";

const entries = [
  ["cotton", 48, 23, 12, MATERIAL_ID.flowerWhite, "Cotton Plant"],
  ["flowerWhite", 49, 24, 13, MATERIAL_ID.flowerWhite, "White Flower"],
  ["flowerYellow", 50, 25, 14, MATERIAL_ID.flowerYellow, "Yellow Flower"],
  ["flowerRed", 51, 26, 15, MATERIAL_ID.flowerRed, "Red Flower"],
  ["flowerBlue", 52, 27, 16, MATERIAL_ID.flowerBlue, "Blue Flower"],
  ["flowerPink", 53, 28, 17, MATERIAL_ID.flowerPink, "Pink Flower"],
];

for (const [key, blockId, resourceId, decorationId, materialId, displayName] of entries) {
  assert.equal(BLOCK_ID[key], blockId, `${key} block ID must remain stable`);
  assert.equal(RESOURCE_ID[key], resourceId, `${key} resource ID must remain stable`);
  assert.equal(SURFACE_DECORATION_ID[key], decorationId, `${key} decoration ID must remain stable`);
  assert.equal(blockDef(blockId).resourceId, resourceId, `${key} must resolve its canonical resource`);
  assert.equal(blockDef(blockId).materialId, materialId, `${key} must select the intended existing material layer`);
  assert.equal(surfaceDecorationName(decorationId), displayName, `${key} must expose a stable item-preview name`);
  assert.equal(isLowVegetationBlock(blockId), true, `${key} must use merged vegetation geometry`);
  assert.equal(isVisualBlock(blockId), true, `${key} must render in the visual pass`);
  assert.equal(isMineableBlock(blockId), true, `${key} must remain mineable when explicitly placed`);
  assert.ok(blockDef(blockId).flags & BLOCK_FLAGS.CUTOUT, `${key} must use cutout vegetation flags`);
}

assert.equal(MATERIAL_ID.flowerPink, 52, "flower material IDs must remain independent from block IDs");
assert.equal(MATERIAL_ID.grassSide, 53, "block ID 53 must not overwrite material ID 53");
assert.equal(blockDef(BLOCK_ID.flowerPink).materialId, MATERIAL_ID.flowerPink, "pink flowers must not accidentally use the grass-side material");

const legacyRuleIds = [
  1, 2, 3, 4, 5, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33, 34, 35, 36,
  40, 41, 42, 43, 50, 51, 52, 53, 60, 61, 62, 63, 64, 70, 71, 72, 73,
];
assert.deepEqual(
  DEFAULT_SURFACE_DECORATION_RULES.slice(0, legacyRuleIds.length).map((rule) => rule.ruleId),
  legacyRuleIds,
  "existing surface-decoration fixtures must retain their original positions",
);

const appendedRules = DEFAULT_SURFACE_DECORATION_RULES.slice(legacyRuleIds.length);
assert.deepEqual(appendedRules.map((rule) => rule.ruleId), [74, 75, 76, 77, 78, 79]);
assert.deepEqual(appendedRules.map((rule) => rule.rollStartBps), [425, 455, 475, 495, 515, 535]);
assert.deepEqual(appendedRules.map((rule) => rule.rollEndBps), [455, 475, 495, 515, 535, 555]);
for (let index = 0; index < appendedRules.length; index += 1) {
  const rule = appendedRules[index];
  const [key, blockId, , decorationId] = entries[index];
  assert.equal(rule.decorationId, decorationId, `${key} must use its dedicated PDA decoration ID`);
  assert.equal(rule.surfaceBlockId, BLOCK_ID.grass, `${key} must consume only the unused grass roll band`);
  assert.equal(rule.dropBlockId, blockId, `${key} must drop its dedicated block identity`);
  assert.equal(rule.salt, 201, `${key} must share the existing grass roll without moving older rules`);
  assert.ok(rule.flags & SURFACE_DECORATION_FLAGS.SHADOW, `${key} must request its baked shadow`);
  assert.ok(rule.flags & SURFACE_DECORATION_FLAGS.MINEABLE, `${key} must remain mineable through its PDA rule`);
}

const resolvedDecorationIds = new Set();
const compiledDefaultRules = compileSurfaceDecorationRules(DEFAULT_SURFACE_DECORATION_RULES);
for (let worldX = -50_000; worldX <= 50_000 && resolvedDecorationIds.size < entries.length; worldX += 1) {
  const resolved = resolveSurfaceDecoration({
    worldSeed: "cotton-flower-rule-coverage",
    worldX,
    surfaceY: 72,
    worldZ: 19,
    surfaceBlockId: BLOCK_ID.grass,
    rules: compiledDefaultRules,
  });
  if (resolved?.decorationId >= SURFACE_DECORATION_ID.cotton && resolved.decorationId <= SURFACE_DECORATION_ID.flowerPink) {
    resolvedDecorationIds.add(resolved.decorationId);
  }
}
assert.deepEqual(
  [...resolvedDecorationIds].sort((left, right) => left - right),
  entries.map((entry) => entry[3]),
  "every appended probability band must be reachable without disturbing older grass bands",
);

const grassLayer = materialDef(MATERIAL_ID.grassPlant).textureLayer;
const whiteLayer = materialDef(MATERIAL_ID.flowerWhite).textureLayer;
const cottonPreview = createSurfaceDecorationPreviewMesh({
  decorationId: SURFACE_DECORATION_ID.cotton,
  variantHash: 0xc0770a51,
  surfaceBlockId: BLOCK_ID.grass,
});
assert.equal(cottonPreview.vertices.length, 96, "cotton must stay at the 96-vertex low-poly budget");
assert.equal(cottonPreview.indices.length / 3, 48, "cotton must stay at the 48-triangle low-poly budget");
assert.deepEqual(layerSet(cottonPreview), [grassLayer, whiteLayer].sort((left, right) => left - right));
assert.ok(Math.max(...cottonPreview.vertices.map((vertex) => vertex.p[1])) > 0.5, "cotton bolls must remain visible above the stem");

const flowerLayerSignatures = new Set();
for (const [key, , , decorationId, materialId] of entries.slice(1)) {
  const preview = createSurfaceDecorationPreviewMesh({
    decorationId,
    variantHash: 0x6a91c8d4,
    surfaceBlockId: BLOCK_ID.grass,
  });
  const layers = layerSet(preview);
  assert.ok(preview.vertices.length > 0 && preview.indices.length > 0, `${key} item preview must reuse the world flower mesh`);
  assert.ok(preview.indices.length / 3 <= 64, `${key} must remain inside the low-poly flower budget`);
  assert.ok(layers.includes(materialDef(materialId).textureLayer), `${key} must use its own baked petal layer`);
  flowerLayerSignatures.add(layers.join(","));
}
assert.equal(flowerLayerSignatures.size, 5, "all five flowers must remain visually distinguishable by baked material layers");

for (const [key, blockId, , decorationId] of entries) {
  const placedMesh = meshPlacedVegetation(blockId, key);
  assert.ok(placedMesh.vertexCount > 0 && placedMesh.indexCount > 0, `${key} must render when represented as an explicit block`);

  const withoutShadow = meshDecoration(decorationId, 0, `shadow-${key}`);
  const withShadow = meshDecoration(decorationId, SURFACE_DECORATION_FLAGS.SHADOW, `shadow-${key}`);
  assert.equal(withShadow.vertexCount - withoutShadow.vertexCount, 4, `${key} must add one shared projected-shadow quad`);
  assert.equal(withShadow.indexCount - withoutShadow.indexCount, 12, `${key} shadow must remain double-sided`);
  assert.ok(packedLayerSet(withShadow.vertices).includes(materialDef(MATERIAL_ID.shadow).textureLayer), `${key} world shadow must use the baked shadow layer`);
}

console.log("cotton and five-color flower model tests passed");

function layerSet(mesh) {
  return [...new Set(mesh.vertices.map((vertex) => vertex.layer))].sort((left, right) => left - right);
}

function packedLayerSet(vertices) {
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const layers = new Set();
  for (let offset = 0; offset < vertices.byteLength; offset += CHUNK_VERTEX_STRIDE_BYTES) {
    layers.add(view.getUint16(offset + 16, true));
  }
  return [...layers].sort((left, right) => left - right);
}

function meshPlacedVegetation(blockId, worldSeed) {
  const baseBlocks = new Uint16Array(8);
  baseBlocks[1] = blockId;
  return meshChunkVisual(new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize: 1,
    height: 8,
    minY: 0,
    worldSeed,
    baseBlocks,
  }));
}

function meshDecoration(decorationId, flags, worldSeed) {
  const noWater = -32_768;
  const rules = compileSurfaceDecorationRules([{
    ruleId: decorationId,
    decorationId,
    surfaceBlockId: BLOCK_ID.grass,
    dropBlockId: entries.find((entry) => entry[3] === decorationId)?.[1] ?? BLOCK_ID.grassPlant,
    rollStartBps: 0,
    rollEndBps: 10_000,
    minY: 0,
    maxY: 16,
    salt: decorationId + 500,
    variant: 0,
    flags,
  }]);
  return meshChunkVisual(new ChunkState({
    chunkX: 0,
    chunkZ: 0,
    chunkSize: 1,
    height: 8,
    minY: 0,
    worldSeed,
    surfaceDecorationRules: rules,
    baseProfile: {
      surfaceY: Int16Array.of(4),
      waterY: Int16Array.of(noWater),
      surfaceBlock: Uint16Array.of(BLOCK_ID.grass),
      noWater,
      minY: 0,
      height: 8,
    },
    baseBlockResolver: (_x, y) => y < 4 ? BLOCK_ID.dirt : BLOCK_ID.air,
  }));
}
