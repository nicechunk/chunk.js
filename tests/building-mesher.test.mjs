import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildingChunkCollisionTopAt,
  buildingChunkHasCollisionAt,
  createBuildingChunkMeshes,
} from "../construction/building-mesher.js";
import { createBuildingPlacement, parseNcm3Building } from "../construction/building-parser.js";
import { createBlueprint, encodeNcm3 } from "../ncm/blueprint-codec.js";

const CASES = Object.freeze([
  Object.freeze({
    id: "cross",
    name: "cross-chunk opaque",
    expected: "403da144b4addda0760599b9937f2c5a368eac358ecb28651564c88312a60c36",
    blueprint: () => createBlueprint({ x: 3, y: 2, z: 2 }, "cross")
      .box(64, 0, 0, 0, 3, 2, 2),
    foundation: { minX: 15, minZ: -1, surfaceY: 4, width: 3, depth: 2 },
    quarterTurns: 0,
  }),
  Object.freeze({
    id: "mixed",
    name: "mixed glass and opaque",
    expected: "6ec5529699212a66c58f6bc6bf1dc7be83bd53ae9650faed6273c4a358f76cf1",
    blueprint: () => createBlueprint({ x: 8, y: 5, z: 7 }, "mixed")
      .box(64, 0, 0, 0, 8, 1, 7)
      .box(62, 0, 1, 0, 1, 4, 7)
      .box(58, 7, 1, 0, 1, 4, 7)
      .box(96, 1, 4, 1, 6, 1, 5),
    foundation: { minX: -19, minZ: 14, surfaceY: 111, width: 9, depth: 10 },
    quarterTurns: 1,
  }),
  Object.freeze({
    id: "sparse",
    name: "sparse rotated structure",
    expected: "8b3d48062288d85d9273e10eaa74cf33c230eb89d7d735790383bfd42284feaa",
    blueprint: () => createBlueprint({ x: 16, y: 12, z: 16 }, "sparse")
      .repeat(55, 0, 0, 0, 1, 12, 1, 16, 1, 0, 1)
      .box(77, 2, 6, 2, 12, 1, 12),
    foundation: { minX: 31, minZ: 31, surfaceY: -12, width: 16, depth: 16 },
    quarterTurns: 3,
  }),
]);

for (const fixture of CASES) {
  test(`building mesher preserves deterministic renderer bytes for ${fixture.name}`, () => {
    const building = parseNcm3Building(encodeNcm3(fixture.blueprint()), { id: fixture.id });
    const placement = createBuildingPlacement(building, { id: "foundation", ...fixture.foundation }, {
      quarterTurns: fixture.quarterTurns,
      placementId: fixture.id,
    });
    const chunks = createBuildingChunkMeshes(placement, { revision: 7 });
    assert.equal(meshDigest(chunks), fixture.expected);
    const compactPlacement = createBuildingPlacement(building, { id: "foundation", ...fixture.foundation }, {
      quarterTurns: fixture.quarterTurns,
      placementId: fixture.id,
      materializeWorldVoxels: false,
    });
    assert.equal(compactPlacement.worldVoxels, null);
    assert.equal(meshDigest(createBuildingChunkMeshes(compactPlacement, { revision: 7 })), fixture.expected);
  });
}

test("building sunlight is blocked by opaque voxels and attenuated by window glass", () => {
  const open = targetFaceLight(0);
  const opaque = targetFaceLight(64);
  const glass = targetFaceLight(58);

  assert.equal(open.sun, 15, "an unobstructed sun-facing surface should receive full direct light");
  assert.equal(opaque.sun, 0, "an opaque building voxel should block direct sunlight");
  assert.ok(glass.sun > 0 && glass.sun < open.sun, "clear glass should transmit attenuated direct sunlight");
});

test("sealed rooms stay dark while doors and windows admit graded sky light", () => {
  const sealed = interiorWallLight(roomBlueprint(null), "sealed-room");
  const door = interiorWallLight(roomBlueprint(0), "door-room");
  const glass = interiorWallLight(roomBlueprint(58), "window-room");

  assert.ok(sealed.length > 0);
  assert.ok(sealed.every((sample) => sample.sky === 0 && sample.sun === 0));
  assert.ok(Math.max(...door.map((sample) => sample.sky)) > 0, "an open door should spread sky light into the room");
  assert.ok(Math.max(...glass.map((sample) => sample.sky)) > 0, "a glass window should spread sky light into the room");
  assert.ok(
    Math.max(...glass.map((sample) => sample.sky)) < Math.max(...door.map((sample) => sample.sky)),
    "glass should admit less indirect light than an open doorway",
  );
});

test("baked building light softens opaque shadow edges with a surface Gaussian", () => {
  const blueprint = createBlueprint({ x: 16, y: 5, z: 16 }, "soft-shadow")
    .box(64, 0, 0, 0, 16, 1, 16)
    .box(64, 0, 4, 8, 8, 1, 8);
  const samples = faceLights(buildingChunks(blueprint, "soft-shadow"), (face) => (
    face.y === 1 && face.normalY === 127
  ));
  const sunLevels = new Set(samples.map((sample) => sample.sun));

  assert.ok(sunLevels.has(0), "the roof should retain a fully occluded shadow core");
  assert.ok(sunLevels.has(15), "unoccluded floor should retain full sunlight");
  assert.ok(
    [...sunLevels].some((level) => level > 0 && level < 15),
    "the hard shadow boundary should contain Gaussian-filtered intermediate levels",
  );
});

test("building collision masks follow material physics across rotated negative chunk boundaries", () => {
  const building = parseNcm3Building(encodeNcm3(
    createBlueprint({ x: 4, y: 1, z: 2 }, "collision-materials")
      .box(64, 0, 0, 0, 1, 1, 1)
      .box(58, 1, 0, 0, 1, 1, 1)
      .box(17, 2, 0, 0, 1, 1, 1)
      .box(28, 3, 0, 0, 1, 1, 1),
  ), { id: "collision-materials" });
  const placement = createBuildingPlacement(building, {
    id: "negative-boundary",
    minX: -17,
    minZ: 15,
    surfaceY: 7,
    width: 2,
    depth: 4,
  }, { quarterTurns: 1, placementId: "collision-materials" });
  const chunks = createBuildingChunkMeshes(placement, { revision: 3 });
  const voxelsByMaterial = new Map([...placement.worldVoxels.values()]
    .map((voxel) => [voxel.material, voxel]));

  assert.ok(chunks.some((chunk) => chunk.chunkZ === 0));
  assert.ok(chunks.some((chunk) => chunk.chunkZ === 1));
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.collisionBlockCount, 0), 2);
  assertCollision(64, true);
  assertCollision(58, true);
  assertCollision(17, false);
  assertCollision(28, false);

  const stone = voxelsByMaterial.get(64);
  const stoneChunk = chunkAt(stone.x, stone.z);
  assert.equal(buildingChunkCollisionTopAt(stoneChunk, stone.x, stone.z), stone.y + 1);
  assert.equal(buildingChunkCollisionTopAt(stoneChunk, stone.x, stone.z, stone.y - 1), -Infinity);

  function assertCollision(material, expected) {
    const voxel = voxelsByMaterial.get(material);
    assert.equal(
      buildingChunkHasCollisionAt(chunkAt(voxel.x, voxel.z), voxel.x, voxel.y, voxel.z),
      expected,
      `material ${material} collision mismatch`,
    );
  }

  function chunkAt(worldX, worldZ) {
    const chunkX = Math.floor(worldX / 16);
    const chunkZ = Math.floor(worldZ / 16);
    return chunks.find((chunk) => chunk.chunkX === chunkX && chunk.chunkZ === chunkZ);
  }
});

function meshDigest(chunks) {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    hash.update(chunk.id);
    for (const mesh of [chunk.mesh, chunk.visualMesh]) {
      if (!mesh) {
        hash.update("null");
        continue;
      }
      hash.update(mesh.vertices);
      hash.update(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
      hash.update(JSON.stringify([
        mesh.vertexCount,
        mesh.indexCount,
        mesh.quadCount,
        mesh.blockCount,
        mesh.visual,
      ]));
    }
  }
  return hash.digest("hex");
}

function targetFaceLight(obstacleMaterial) {
  let blueprint = createBlueprint({ x: 5, y: 2, z: 2 }, `sun-${obstacleMaterial}`)
    .box(64, 4, 0, 0, 1, 1, 1);
  if (obstacleMaterial) blueprint = blueprint.box(obstacleMaterial, 2, 1, 1, 1, 1, 1);
  const samples = faceLights(buildingChunks(blueprint, `sun-${obstacleMaterial}`), (face) => (
    face.x === 4 && face.normalX === -127
  ));
  assert.equal(samples.length, 1);
  return samples[0];
}

function roomBlueprint(openingMaterial) {
  let blueprint = createBlueprint({ x: 7, y: 5, z: 7 }, `room-${openingMaterial}`)
    .box(64, 0, 0, 0, 7, 1, 7)
    .box(64, 0, 4, 0, 7, 1, 7)
    .box(64, 0, 1, 0, 1, 3, 7)
    .box(64, 6, 1, 0, 1, 3, 7)
    .box(64, 1, 1, 6, 5, 3, 1);
  if (openingMaterial === null) return blueprint.box(64, 1, 1, 0, 5, 3, 1);
  blueprint = blueprint
    .box(64, 1, 1, 0, 2, 3, 1)
    .box(64, 4, 1, 0, 2, 3, 1)
    .box(64, 3, 3, 0, 1, 1, 1);
  return openingMaterial ? blueprint.box(openingMaterial, 3, 1, 0, 1, 2, 1) : blueprint;
}

function interiorWallLight(blueprint, id) {
  return faceLights(buildingChunks(blueprint, id), (face) => face.x === 6 && face.normalX === -127);
}

function buildingChunks(blueprint, id) {
  const building = parseNcm3Building(encodeNcm3(blueprint), { id });
  const placement = createBuildingPlacement(building, {
    id: `${id}-foundation`,
    minX: 0,
    minZ: 0,
    surfaceY: 0,
    width: blueprint.size.x,
    depth: blueprint.size.z,
  }, { placementId: id });
  return createBuildingChunkMeshes(placement);
}

function faceLights(chunks, predicate) {
  const samples = [];
  for (const chunk of chunks) {
    for (const mesh of [chunk.mesh, chunk.visualMesh]) {
      if (!mesh) continue;
      const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
      for (let vertex = 0; vertex < mesh.vertexCount; vertex += 4) {
        const offset = vertex * mesh.vertexStrideBytes;
        const flags = view.getUint16(offset + 18, true);
        const face = {
          x: view.getInt16(offset, true),
          y: view.getInt16(offset + 2, true),
          z: view.getInt16(offset + 4, true),
          normalX: view.getInt8(offset + 8),
          normalY: view.getInt8(offset + 9),
          normalZ: view.getInt8(offset + 10),
          sun: (flags >>> 12) & 0x0f,
          sky: (flags >>> 8) & 0x0f,
        };
        assert.ok(flags & 0x80, "building vertices should carry baked-light metadata");
        if (predicate(face)) samples.push(face);
      }
    }
  }
  return samples;
}
