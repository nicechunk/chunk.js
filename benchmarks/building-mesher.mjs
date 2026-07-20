import { performance } from "node:perf_hooks";

import { createBuildingChunkMeshes } from "../construction/building-mesher.js";
import { createBuildingPlacement, parseNcm3Building } from "../construction/building-parser.js";
import { createBlueprint, encodeNcm3 } from "../ncm/blueprint-codec.js";

const iterations = positiveInteger(process.argv[2] ?? 3);
const cases = [
  ["dense-32x24x32", createBlueprint({ x: 32, y: 24, z: 32 }, "dense").box(64, 0, 0, 0, 32, 24, 32)],
  ["hollow-48x24x48", createBlueprint({ x: 48, y: 24, z: 48 }, "hollow")
    .box(64, 0, 0, 0, 48, 1, 48)
    .box(64, 0, 23, 0, 48, 1, 48)
    .box(62, 0, 1, 0, 1, 22, 48)
    .box(62, 47, 1, 0, 1, 22, 48)
    .box(55, 1, 1, 0, 46, 22, 1)
    .box(55, 1, 1, 47, 46, 22, 1)],
  ["mixed-32x16x32", createBlueprint({ x: 32, y: 16, z: 32 }, "mixed")
    .box(64, 0, 0, 0, 32, 16, 16)
    .box(58, 0, 0, 16, 32, 16, 16)],
  ["dense-64x24x64", createBlueprint({ x: 64, y: 24, z: 64 }, "large").box(64, 0, 0, 0, 64, 24, 64)],
];

const results = [];
for (const [name, blueprint] of cases) {
  const samples = [];
  const code = encodeNcm3(blueprint);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    globalThis.gc?.();
    await new Promise((resolve) => setImmediate(resolve));
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const building = parseNcm3Building(code, { id: name });
    const parsedAt = performance.now();
    const placement = createBuildingPlacement(building, {
      id: "benchmark-foundation",
      minX: 13,
      minZ: -7,
      surfaceY: 80,
      width: blueprint.size.x,
      depth: blueprint.size.z,
    }, { materializeWorldVoxels: false });
    const placedAt = performance.now();
    const chunks = createBuildingChunkMeshes(placement, { chunkSize: 16, revision: iteration + 1 });
    const finishedAt = performance.now();
    samples.push({
      parseMs: parsedAt - startedAt,
      placementMs: placedAt - parsedAt,
      meshMs: finishedAt - placedAt,
      eventLoopBlockMs: finishedAt - startedAt,
      heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
      voxelCount: building.voxelCount,
      chunkCount: chunks.length,
      quadCount: chunks.reduce((sum, chunk) => sum + chunk.mesh.quadCount + (chunk.visualMesh?.quadCount ?? 0), 0),
      vertexBytes: chunks.reduce((sum, chunk) => sum + chunk.mesh.vertices.byteLength + (chunk.visualMesh?.vertices.byteLength ?? 0), 0),
      indexBytes: chunks.reduce((sum, chunk) => sum + chunk.mesh.indices.byteLength + (chunk.visualMesh?.indices.byteLength ?? 0), 0),
    });
  }
  results.push({ name, iterations, ...medianSample(samples) });
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

function medianSample(samples) {
  const metrics = Object.keys(samples[0]);
  return Object.fromEntries(metrics.map((metric) => {
    const values = samples.map((sample) => sample[metric]).sort((left, right) => left - right);
    return [metric, values[Math.floor(values.length / 2)]];
  }));
}

function positiveInteger(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 3;
}
