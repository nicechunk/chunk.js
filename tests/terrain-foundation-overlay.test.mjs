import assert from "node:assert/strict";
import test from "node:test";

import { ChunkManager } from "../chunk/chunk-manager.js";
import { VoxelOverlay, buildTerrainFoundationGeometry } from "../renderer/voxel-overlay.js";

test("terrain foundation geometry follows per-chunk heights in one batched mesh", () => {
  const heights = new Float32Array([0, 2, 1, 3]);
  const geometry = buildTerrainFoundationGeometry({
    columns: 2,
    rows: 2,
    cellSize: 16,
    heights,
    width: 32,
    depth: 32,
  });

  assert.equal(geometry.fill.count, 4 * 6, "each Chunk should contribute one top tile");
  assert.ok(geometry.walls.count > 4 * 6, "height changes should add stepped side walls");
  assert.ok(geometry.grid.count > 0, "Chunk boundaries should remain visible");
  assert.ok(geometry.edges.count > 0, "the region perimeter should remain visible");
  assert.ok([...geometry.vertices].every(Number.isFinite), "terrain geometry must not contain invalid coordinates");

  const fillY = new Set();
  const fillEnd = (geometry.fill.first + geometry.fill.count) * 3;
  for (let index = geometry.fill.first * 3 + 1; index < fillEnd; index += 3) {
    fillY.add(geometry.vertices[index]);
  }
  assert.deepEqual([...fillY].sort((left, right) => left - right), [0, 1, 2, 3]);
});

test("maximum land selection stays within a bounded overlay buffer", () => {
  const columns = 64;
  const rows = 64;
  const heights = Float32Array.from({ length: columns * rows }, (_value, index) => index % 7);
  const geometry = buildTerrainFoundationGeometry({
    columns,
    rows,
    cellSize: 16,
    heights,
    width: columns * 16,
    depth: rows * 16,
  });

  assert.ok(geometry.vertices.byteLength < 6 * 1024 * 1024, "4,096 Chunk overlays should stay below 6 MiB");
  assert.equal(geometry.fill.count, columns * rows * 6);
});

test("terrain selection buffers expire after the overlay becomes inactive", () => {
  const deleted = [];
  const overlay = new VoxelOverlay({
    deleteBuffer: (buffer) => deleted.push(["buffer", buffer]),
    deleteVertexArray: (vao) => deleted.push(["vao", vao]),
  });
  overlay.program = {};
  overlay.foundationGeometry.set("terrain:selection", {
    vao: "selection-vao",
    vbo: "selection-vbo",
    vertices: new Float32Array(12),
    lastUsedFrame: 0,
  });
  overlay.foundationByteLength = 48;

  for (let frame = 0; frame <= 300; frame += 1) overlay.render({ overlays: [] });

  assert.equal(overlay.foundationGeometry.size, 0);
  assert.equal(overlay.foundationByteLength, 0);
  assert.deepEqual(deleted, [
    ["buffer", "selection-vbo"],
    ["vao", "selection-vao"],
  ]);
});

test("ChunkManager exposes generated water height for terrain-aware overlays", () => {
  const chunks = new ChunkManager({
    worldSeed: "terrain-overlay-water",
    chunkSize: 1,
    minY: -12,
    height: 2,
    seaLevel: 20,
    maxTerrainHeight: 100,
    useWorkers: false,
  });
  const surface = chunks.getOpaqueColumnTopAtWorld(0, 0);

  assert.equal(surface, -12);
  assert.equal(chunks.getWaterLevelAtWorld(0, 0, surface), -11);
  assert.equal(chunks.getWaterLevelAtWorld(0, 0), -11);
});
