import assert from "node:assert/strict";

import { VoxelParticleLayer } from "../renderer/voxel-particle-layer.js";
import { createVoxelFracturePieces } from "../renderer/voxel-fracture.js";
import { BLOCK_ID, MATERIAL_ID } from "../world/block-registry.js";
import { materialDef } from "../world/material-registry.js";

assertCubeFracturePreservesVolumeAndMaterials();
assertCactusFractureUsesModelSilhouette();
assertFractureIsDeterministic();
assertGravityBounceAndLifetime();

console.log("chunk.js voxel fracture tests passed");

function assertCubeFracturePreservesVolumeAndMaterials() {
  const grass = createVoxelFracturePieces({
    blockId: BLOCK_ID.grass,
    worldX: 12,
    worldY: 104,
    worldZ: -7,
  });
  assert.equal(grass.length, 27, "a terrain cube should fracture into a complete 3x3x3 piece set");
  assert.ok(Math.abs(totalVolume(grass) - 1) < 1e-9, "terrain fragments should initially fill the source cube");
  assertBounds(grass, [0, 1], [0, 1], [0, 1]);
  const grassTopLayer = materialDef(MATERIAL_ID.grassTop).textureLayer;
  const grassSideLayer = materialDef(MATERIAL_ID.grassSide).textureLayer;
  const dirtLayer = materialDef(MATERIAL_ID.dirt).textureLayer;
  assert.equal(grass.filter((piece) => piece.topLayer === grassTopLayer).length, 9, "only source-surface fragments should retain grass on their top face");
  assert.equal(grass.filter((piece) => piece.topLayer === dirtLayer).length, 18, "interior upward fracture faces should expose soil");
  assert.ok(grass.some((piece) => piece.sideLayer === grassSideLayer));
  assert.ok(grass.some((piece) => piece.sideLayer === dirtLayer), "fully internal side faces should expose soil");

  const trunk = createVoxelFracturePieces({ blockId: BLOCK_ID.trunk, worldX: 0, worldY: 0, worldZ: 0 });
  assert.equal(trunk.length, 24, "wood should use elongated shard proportions without exceeding the per-block budget");
  assert.ok(Math.abs(totalVolume(trunk) - 1) < 1e-9);
}

function assertCactusFractureUsesModelSilhouette() {
  const cactus = createVoxelFracturePieces({
    blockId: BLOCK_ID.cactus,
    worldX: 21,
    worldY: 100,
    worldZ: 18,
  });
  const bounds = pieceBounds(cactus);
  assert.ok(cactus.length >= 14 && cactus.length <= 20, "the five-part cactus should split along its actual model parts");
  assert.ok(bounds.maxY > 1.8, "the fracture silhouette must preserve the current double-height cactus model");
  assert.ok(totalVolume(cactus) < 0.9, "the cactus must not fracture as a hidden full terrain cube");
  assert.ok(cactus.every((piece) => piece.sideLayer === materialDef(MATERIAL_ID.cactus).textureLayer));
}

function assertFractureIsDeterministic() {
  const options = { blockId: BLOCK_ID.stone, worldX: -18, worldY: 94, worldZ: 37 };
  assert.deepEqual(createVoxelFracturePieces(options), createVoxelFracturePieces(options));
}

function assertGravityBounceAndLifetime() {
  const layer = new VoxelParticleLayer(null, { maxParticles: 64 });
  const emitted = layer.emitFracture({
    worldX: 0,
    worldY: 2,
    worldZ: 0,
    blockId: BLOCK_ID.stone,
  });
  assert.equal(emitted, 27);
  assert.equal(layer.particles.length, 27);
  const tracked = [...layer.particles];
  const expectedBounces = new Map(tracked.map((particle) => [particle, particle.bouncesRemaining]));
  const collision = {
    groundHeightAt: (_x, _z, upperY, lowerY) => upperY >= 2 && lowerY <= 2 ? 2 : null,
  };
  for (let frame = 0; frame < 360; frame += 1) layer.update(1 / 60, collision);
  assert.equal(layer.particles.length, 0, "settled fracture pieces should fade and leave the fixed pool");
  for (const particle of tracked) {
    assert.ok(expectedBounces.get(particle) >= 2 && expectedBounces.get(particle) <= 4);
    assert.equal(particle.bounceCount, expectedBounces.get(particle), "each piece should complete its configured physical bounces");
  }
}

function totalVolume(pieces) {
  return pieces.reduce((sum, piece) => sum + piece.sizeX * piece.sizeY * piece.sizeZ, 0);
}

function assertBounds(pieces, expectedX, expectedY, expectedZ) {
  const bounds = pieceBounds(pieces);
  assert.ok(Math.abs(bounds.minX - expectedX[0]) < 1e-9 && Math.abs(bounds.maxX - expectedX[1]) < 1e-9);
  assert.ok(Math.abs(bounds.minY - expectedY[0]) < 1e-9 && Math.abs(bounds.maxY - expectedY[1]) < 1e-9);
  assert.ok(Math.abs(bounds.minZ - expectedZ[0]) < 1e-9 && Math.abs(bounds.maxZ - expectedZ[1]) < 1e-9);
}

function pieceBounds(pieces) {
  return pieces.reduce((bounds, piece) => ({
    minX: Math.min(bounds.minX, piece.centerX - piece.sizeX * 0.5),
    maxX: Math.max(bounds.maxX, piece.centerX + piece.sizeX * 0.5),
    minY: Math.min(bounds.minY, piece.centerY - piece.sizeY * 0.5),
    maxY: Math.max(bounds.maxY, piece.centerY + piece.sizeY * 0.5),
    minZ: Math.min(bounds.minZ, piece.centerZ - piece.sizeZ * 0.5),
    maxZ: Math.max(bounds.maxZ, piece.centerZ + piece.sizeZ * 0.5),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  });
}
