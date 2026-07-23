import assert from "node:assert/strict";
import test from "node:test";

import { createBuildingMeshWorkerClient } from "../construction/building-mesh-client.js";
import { createBuildingMeshResult } from "../construction/building-mesh-result.js";
import { createBuildingChunkMeshes } from "../construction/building-mesher.js";
import {
  createBuildingPlacement,
  parseNcm3Building,
} from "../construction/building-parser.js";
import { createBlueprint, encodeNcm3 } from "../ncm/blueprint-codec.js";

const TEST_BUILDING_CODE = encodeNcm3(
  createBlueprint({ x: 2, y: 1, z: 1 }, "worker-result")
    .box(64, 0, 0, 0)
    .box(17, 1, 0, 0),
);
const ONE_VOXEL_BUILDING_CODE = encodeNcm3(
  createBlueprint({ x: 2, y: 1, z: 1 }, "one-voxel")
    .box(64, 0, 0, 0),
);
const WIDE_ENVELOPE_BUILDING_CODE = encodeNcm3(
  createBlueprint({ x: 16, y: 1, z: 1 }, "wide-envelope")
    .box(64, 0, 0, 0)
    .box(64, 15, 0, 0),
);
const PARTIAL_BOUNDS_BUILDING_CODE = encodeNcm3(
  createBlueprint({ x: 3, y: 1, z: 1 }, "partial-bounds")
    .box(64, 0, 0, 0, 2, 1, 1),
);
// Canonical raw NCM3 for one 256 x 256 x 256 BOX. Decoding must reject its
// declared operation volume before voxel materialization or meshing begins.
const OVERSIZED_BUILDING_CODE = "NCM3:AYACgAKAAgEBQAAAAP8B_wH_AQ";

test("building mesh client keeps one worker job active and prioritizes queued work", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const first = client.build(buildingRequest("active"), { priority: 0 });
  const low = client.build(buildingRequest("low"), { priority: 1 });
  const high = client.build(buildingRequest("high"), { priority: 10 });

  assert.deepEqual(workers[0].messages.map((message) => message.buildingId), ["active"]);
  workers[0].succeed(0);
  assert.deepEqual(workers[0].messages.map((message) => message.buildingId), ["active", "high"]);
  workers[0].succeed(1);
  assert.deepEqual(workers[0].messages.map((message) => message.buildingId), ["active", "high", "low"]);
  workers[0].succeed(2);

  assert.deepEqual(
    (await Promise.all([first, low, high])).map((result) => result.building.id),
    ["active", "low", "high"],
  );
  assert.deepEqual(client.stats(), { active: 0, queued: 0, workerMode: true, disposed: false });
  client.dispose();
});

test("aborting queued building work prevents it from reaching the worker", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const first = client.build(buildingRequest("active"));
  const controller = new AbortController();
  const canceled = client.build(buildingRequest("canceled"), { signal: controller.signal });
  controller.abort();

  await assert.rejects(canceled, (error) => error?.code === "building-mesh-aborted");
  assert.deepEqual(workers[0].messages.map((message) => message.buildingId), ["active"]);
  workers[0].succeed(0);
  await first;
  client.dispose();
});

test("aborting active building work terminates stale computation and resumes on a fresh worker", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const controller = new AbortController();
  const stale = client.build(buildingRequest("stale"), { signal: controller.signal, scope: "region-a" });
  const current = client.build(buildingRequest("current"), { scope: "region-b" });
  const staleHandler = workers[0].onmessage;
  const staleRequest = workers[0].messages[0];
  controller.abort();

  await assert.rejects(stale, (error) => error?.code === "building-mesh-aborted");
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  assert.deepEqual(workers[1].messages.map((message) => message.buildingId), ["current"]);
  staleHandler({ data: { requestId: staleRequest.requestId, ok: true, result: "late-stale-result" } });
  assert.equal(workers[1].terminated, false);
  assert.deepEqual(client.stats(), { active: 1, queued: 0, workerMode: true, disposed: false });
  workers[1].succeed(0);
  assert.equal((await current).building.id, "current");
  client.dispose();
});

test("an unknown building Worker request ID fails the active job instead of hanging it", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const active = client.build(buildingRequest("active"));
  const request = workers[0].messages[0];

  workers[0].respond({
    requestId: request.requestId + 1,
    ok: false,
    error: { code: "synthetic", message: "wrong request" },
  });

  await assert.rejects(active, (error) => error?.code === "building-mesh-worker-protocol");
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(client.stats(), { active: 0, queued: 0, workerMode: false, disposed: false });
  client.dispose();
});

test("a matched building Worker error response settles the active job", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const active = client.build(buildingRequest("active"));
  const request = workers[0].messages[0];

  workers[0].respond({
    requestId: request.requestId,
    ok: false,
    error: { code: "mesh-invalid", message: "invalid mesh input" },
  });

  await assert.rejects(active, (error) => error?.code === "mesh-invalid");
  assert.deepEqual(client.stats(), { active: 0, queued: 0, workerMode: true, disposed: false });
  client.dispose();
});

test("a malformed matched building Worker error payload still rejects the active job", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const active = client.build(buildingRequest("active"));
  const request = workers[0].messages[0];

  workers[0].respond({ requestId: request.requestId, ok: false, error: null });

  await assert.rejects(active, (error) => error?.code === "building-mesh-failed");
  assert.deepEqual(client.stats(), { active: 0, queued: 0, workerMode: true, disposed: false });
  client.dispose();
});

test("oversized building work fails at the NCM3 operation budget before fallback meshing", async () => {
  const client = createBuildingMeshWorkerClient({ useWorker: false });
  const request = buildingRequest("oversized", {
    code: OVERSIZED_BUILDING_CODE,
    foundation: {
      id: "oversized-foundation",
      minX: 0,
      minZ: 0,
      surfaceY: 0,
      width: 256,
      depth: 256,
    },
  });

  await assert.rejects(
    client.build(request),
    /Expanded voxel operation budget exceeded/,
  );
  assert.deepEqual(client.stats(), { active: 0, queued: 0, workerMode: false, disposed: false });
  client.dispose();
});

test("overlong building request labels are rejected before a Worker is created", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const active = client.build(buildingRequest("x".repeat(1_025)));

  await assert.rejects(active, (error) => error?.code === "building-mesh-input-invalid");
  assert.equal(workers.length, 0);
  assert.deepEqual(client.stats(), { active: 0, queued: 0, workerMode: true, disposed: false });
  client.dispose();
});

test("building request labels accept the documented 1,024-character boundary", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const request = buildingRequest("label-boundary", {
    buildingId: "b".repeat(1_024),
    placementId: "p".repeat(1_024),
    foundation: {
      ...requestFoundation("label-boundary", 2, 1),
      id: "f".repeat(1_024),
    },
  });
  const active = client.build(request);
  workers[0].succeed(0);

  const result = await active;
  assert.equal(result.building.id.length, 1_024);
  assert.equal(result.placement.id.length, 1_024);
  assert.equal(result.placement.foundation.id.length, 1_024);
  client.dispose();
});

test("a valid building Worker result is request-bound and accepted without copying its buffers", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const requestInput = buildingRequest("owned-result", { code: `\n ${TEST_BUILDING_CODE}\t` });
  const active = client.build(requestInput);
  const dispatched = workers[0].messages[0];
  const result = structuredClone(buildingResultFor(dispatched));
  const vertices = result.chunks[0].mesh.vertices;

  requestInput.foundation.minX = 99;
  workers[0].respond({ requestId: dispatched.requestId, ok: true, result });

  const resolved = await active;
  assert.strictEqual(resolved, result, "validation should return the received result object in place");
  assert.strictEqual(resolved.chunks[0].mesh.vertices, vertices, "validation must not copy an owned vertex buffer");
  assert.equal(resolved.building.id, "owned-result");
  assert.equal(resolved.building.canonicalCode, TEST_BUILDING_CODE, "request binding should use the parser's trimmed canonical input");
  assert.equal(workers[0].terminated, false);
  client.dispose();
});

test("building Worker summaries are bound to their decoded NCM3 command envelope", async (t) => {
  const cases = [
    {
      name: "non-empty input disguised as an empty result",
      request: buildingRequest("forged-empty", {
        code: ONE_VOXEL_BUILDING_CODE,
      }),
      mutate(result) {
        result.building.voxelCount = 0;
        result.building.contentBounds = emptyContentBounds();
        result.building.materials = [];
        result.placement.voxelCount = 0;
        result.chunks = [];
      },
      message: /contentBounds\.(?:maxX|width)\/request binding/,
    },
    {
      name: "declared size changed without changing the code",
      request: buildingRequest("forged-size", {
        code: PARTIAL_BOUNDS_BUILDING_CODE,
        foundation: requestFoundation("forged-size", 3, 1),
      }),
      mutate(result) {
        result.building.size.x = 4;
        result.placement.footprint.width = 4;
        result.placement.origin.x = -1;
        Object.assign(result.placement.bounds, { minX: -1, maxX: 2, width: 4 });
        result.placement.fitsFoundation = false;
      },
      message: /size\.x\/request binding/,
    },
    {
      name: "command count changed without changing the code",
      request: buildingRequest("forged-command-count"),
      mutate(result) {
        result.building.commandCount += 1;
      },
      message: /commandCount\/request binding/,
    },
    {
      name: "content bounds moved inside the declared size",
      request: buildingRequest("forged-content-bounds", {
        code: PARTIAL_BOUNDS_BUILDING_CODE,
        foundation: requestFoundation("forged-content-bounds", 3, 1),
      }),
      mutate(result) {
        Object.assign(result.building.contentBounds, { minX: 1, maxX: 2 });
      },
      message: /contentBounds\.minX\/request binding/,
    },
    {
      name: "known but unreferenced material substituted into the summary",
      request: buildingRequest("forged-material"),
      mutate(result) {
        result.building.materials = [55];
      },
      message: /materials are not referenced/,
    },
    {
      name: "voxel count amplified beyond decoded command writes",
      request: buildingRequest("forged-voxel-count", {
        code: WIDE_ENVELOPE_BUILDING_CODE,
        foundation: requestFoundation("forged-voxel-count", 16, 1),
      }),
      mutate(result) {
        result.building.voxelCount = 3;
        result.placement.voxelCount = 3;
      },
      message: /voxelCount exceeds its decoded command envelope/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const workers = [];
      const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
      const active = client.build(fixture.request);
      const dispatched = workers[0].messages[0];
      const result = structuredClone(buildingResultFor(dispatched));
      fixture.mutate(result);

      workers[0].respond({ requestId: dispatched.requestId, ok: true, result });

      await assert.rejects(active, (error) => (
        error?.code === "building-mesh-worker-protocol"
        && fixture.message.test(error.message)
      ));
      assert.equal(workers[0].terminated, true);
      client.dispose();
    });
  }
});

test("malformed successful building Worker results fail closed at the schema and buffer boundary", async (t) => {
  const cases = [
    ["missing result object", () => null],
    ["unexpected summary field", (result) => {
      result.debugVoxelMap = [];
      return result;
    }],
    ["result from another request", (result) => {
      result.building.id = "another-building";
      return result;
    }],
    ["canonical code id mismatch", (result) => {
      result.building.codeId = "00000000";
      return result;
    }],
    ["unknown material id", (result) => {
      result.building.materials[0] = 0xffff;
      return result;
    }],
    ["unexpected chunks array field", (result) => {
      result.chunks.debug = true;
      return result;
    }],
    ["wrong vertex view type", (result) => {
      const mesh = result.chunks[0].mesh;
      mesh.vertices = new Uint16Array(mesh.vertices.byteLength / Uint16Array.BYTES_PER_ELEMENT);
      return result;
    }],
    ["partial vertex buffer view", (result) => {
      const mesh = result.chunks[0].mesh;
      mesh.vertices = new Uint8Array(new ArrayBuffer(mesh.vertices.byteLength + 1), 1, mesh.vertices.byteLength);
      return result;
    }],
    ["shared vertex buffer", (result) => {
      const mesh = result.chunks[0].mesh;
      mesh.vertices = new Uint8Array(new SharedArrayBuffer(mesh.vertices.byteLength));
      return result;
    }],
    ["wrong index view type", (result) => {
      const mesh = result.chunks[0].mesh;
      mesh.indices = new Int32Array(mesh.indices.length);
      return result;
    }],
    ["index length mismatch", (result) => {
      const mesh = result.chunks[0].mesh;
      mesh.indices = new mesh.indices.constructor(mesh.indices.length - 1);
      return result;
    }],
    ["out-of-range index", (result) => {
      const mesh = result.chunks[0].mesh;
      mesh.indices[0] = mesh.vertexCount;
      return result;
    }],
    ["collision mask length mismatch", (result) => {
      const chunk = result.chunks[0];
      chunk.collisionMask = new Uint32Array(chunk.collisionMask.length - 1);
      return result;
    }],
    ["collision bit count mismatch", (result) => {
      result.chunks[0].collisionBlockCount += 1;
      return result;
    }],
    ["forged chunk voxel count", (result) => {
      const chunk = result.chunks[0];
      chunk.voxelCount = 1;
      chunk.visualBlockCount = 0;
      chunk.visualMesh = null;
      chunk.visualMeshVersion = -1;
      return result;
    }],
    ["forged chunk visual block count", (result) => {
      result.chunks[0].visualBlockCount -= 1;
      return result;
    }],
    ["chunk metadata mismatch", (result) => {
      result.chunks[0].chunkX += 1;
      return result;
    }],
    ["mesh version mismatch", (result) => {
      result.chunks[0].meshVersion += 1;
      return result;
    }],
    ["reused result buffer", (result) => {
      const mesh = result.chunks[0].mesh;
      mesh.indices = new Uint16Array(mesh.vertices.buffer);
      return result;
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const workers = [];
      const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
      const active = client.build(buildingRequest(`malformed-${name}`));
      const dispatched = workers[0].messages[0];
      const validResult = structuredClone(buildingResultFor(dispatched));
      const result = mutate(validResult);

      workers[0].respond({ requestId: dispatched.requestId, ok: true, result });

      await assert.rejects(active, (error) => (
        error?.code === "building-mesh-worker-protocol"
        && /Invalid building mesh result/.test(error.message)
      ));
      assert.equal(workers[0].terminated, true);
      assert.deepEqual(client.stats(), { active: 0, queued: 0, workerMode: false, disposed: false });
      client.dispose();
    });
  }
});

test("building Worker and main-thread fallback return the same validated result schema", async () => {
  const request = buildingRequest("parity");
  const workers = [];
  const workerClient = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const fallbackClient = createBuildingMeshWorkerClient({ useWorker: false });
  const workerResultPromise = workerClient.build(request);
  workers[0].succeed(0);

  const [workerResult, fallbackResult] = await Promise.all([
    workerResultPromise,
    fallbackClient.build(request),
  ]);
  assert.deepEqual(workerResult, fallbackResult);
  assertMutableResult(workerResult);
  assertMutableResult(fallbackResult);
  workerClient.dispose();
  fallbackClient.dispose();
});

test("building result summaries reuse mesher-owned typed arrays without freezing consumer state", () => {
  const parts = buildingPartsFor(buildingRequest("owned-summary"));
  const result = createBuildingMeshResult(parts.building, parts.placement, parts.chunks);
  const sourceChunk = parts.chunks[0];
  const summaryChunk = result.chunks[0];

  assert.notStrictEqual(result.building, parts.building);
  assert.notStrictEqual(result.placement, parts.placement);
  assert.notStrictEqual(summaryChunk, sourceChunk);
  assert.notStrictEqual(summaryChunk.mesh, sourceChunk.mesh);
  assert.strictEqual(summaryChunk.collisionMask, sourceChunk.collisionMask);
  assert.strictEqual(summaryChunk.mesh.vertices, sourceChunk.mesh.vertices);
  assert.strictEqual(summaryChunk.mesh.indices, sourceChunk.mesh.indices);
  if (sourceChunk.visualMesh) {
    assert.strictEqual(summaryChunk.visualMesh.vertices, sourceChunk.visualMesh.vertices);
    assert.strictEqual(summaryChunk.visualMesh.indices, sourceChunk.visualMesh.indices);
  }
  assertMutableResult(result);
});

test("a fully occluded visual voxel is valid even when it emits no visual mesh", async () => {
  const client = createBuildingMeshWorkerClient({ useWorker: false });
  const code = encodeNcm3(
    createBlueprint({ x: 3, y: 3, z: 3 }, "occluded-visual")
      .box(64, 0, 0, 0, 3, 3, 3)
      .box(58, 1, 1, 1),
  );
  const result = await client.build(buildingRequest("occluded-visual", {
    code,
    foundation: requestFoundation("occluded-visual", 3, 3),
  }));

  assert.equal(result.building.voxelCount, 27);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].voxelCount, 27);
  assert.equal(result.chunks[0].mesh.blockCount, 26);
  assert.equal(result.chunks[0].visualBlockCount, 1);
  assert.equal(result.chunks[0].visualMesh, null);
  client.dispose();
});

test("valid opaque, collision, and visual counts accumulate across multiple building chunks", async () => {
  const client = createBuildingMeshWorkerClient({ useWorker: false });
  const code = encodeNcm3(
    createBlueprint({ x: 3, y: 1, z: 1 }, "multi-chunk-counts")
      .box(64, 0, 0, 0)
      .box(58, 1, 0, 0)
      .box(64, 2, 0, 0),
  );
  const result = await client.build(buildingRequest("multi-chunk-counts", {
    code,
    foundation: {
      ...requestFoundation("multi-chunk-counts", 3, 1),
      minX: 15,
    },
  }));

  assert.equal(result.chunks.length, 2);
  assert.ok(result.chunks.every((chunk) => chunk.voxelCount > 0));
  assert.equal(result.chunks.reduce((sum, chunk) => sum + chunk.voxelCount, 0), 3);
  assert.equal(result.chunks.reduce((sum, chunk) => sum + chunk.collisionBlockCount, 0), 3);
  assert.equal(result.chunks.reduce((sum, chunk) => sum + chunk.mesh.blockCount, 0), 2);
  assert.equal(result.chunks.reduce((sum, chunk) => sum + chunk.visualBlockCount, 0), 1);
  assert.ok(result.chunks.some((chunk) => chunk.visualMesh?.blockCount === 1));
  client.dispose();
});

test("reported material classes bind global opaque, visual, and collision totals", async (t) => {
  const fixtures = [
    {
      name: "opaque",
      material: 64,
      expected: { opaque: 1, visual: 0, collision: 1 },
      mutate: clearCollision,
      message: /colliding\/non-colliding block counts/,
    },
    {
      name: "transparent glass",
      material: 58,
      expected: { opaque: 0, visual: 1, collision: 1 },
      mutate: forceOpaqueClassification,
      message: /opaque\/visual block counts/,
    },
    {
      name: "fluid",
      material: 17,
      expected: { opaque: 0, visual: 1, collision: 0 },
      mutate: forceCollision,
      message: /colliding\/non-colliding block counts/,
    },
    {
      name: "cutout",
      material: 28,
      expected: { opaque: 0, visual: 1, collision: 0 },
      mutate: forceOpaqueClassification,
      message: /opaque\/visual block counts/,
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const request = singleMaterialRequest(`material-class-${fixture.name}`, fixture.material);
      const fallbackClient = createBuildingMeshWorkerClient({ useWorker: false });
      const validResult = await fallbackClient.build(request);
      assert.deepEqual({
        opaque: validResult.chunks.reduce((sum, chunk) => sum + chunk.mesh.blockCount, 0),
        visual: validResult.chunks.reduce((sum, chunk) => sum + chunk.visualBlockCount, 0),
        collision: validResult.chunks.reduce((sum, chunk) => sum + chunk.collisionBlockCount, 0),
      }, fixture.expected);
      fallbackClient.dispose();

      const workers = [];
      const workerClient = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
      const active = workerClient.build(request);
      const dispatched = workers[0].messages[0];
      const forgedResult = structuredClone(buildingResultFor(dispatched));
      fixture.mutate(forgedResult.chunks[0]);
      workers[0].respond({ requestId: dispatched.requestId, ok: true, result: forgedResult });

      await assert.rejects(active, (error) => (
        error?.code === "building-mesh-worker-protocol"
        && fixture.message.test(error.message)
      ));
      assert.equal(workers[0].terminated, true);
      workerClient.dispose();
    });
  }
});

test("main-thread building fallback returns the same stable summary schema as the worker", async () => {
  const client = createBuildingMeshWorkerClient({ useWorker: false });
  const code = encodeNcm3(
    createBlueprint({ x: 2, y: 2, z: 2 }, "schema")
      .box(64, 0, 0, 0, 2, 2, 2),
  );
  const result = await client.build({
    code,
    buildingId: "schema-building",
    placementId: "schema-placement",
    foundation: {
      id: "schema-foundation",
      minX: 0,
      minZ: 0,
      surfaceY: 2,
      width: 2,
      depth: 2,
      hostOnlyMetadata: { mustNotCrossWorkerBoundary: true },
    },
    chunkSize: 16,
    revision: 1,
  });

  assert.deepEqual(Object.keys(result).sort(), ["building", "chunks", "placement"]);
  assert.deepEqual(Object.keys(result.building).sort(), [
    "canonical",
    "canonicalCode",
    "codeId",
    "commandCount",
    "contentBounds",
    "format",
    "formatVersion",
    "id",
    "materials",
    "name",
    "payloadBytes",
    "scale",
    "size",
    "voxelCount",
  ]);
  assert.deepEqual(Object.keys(result.placement).sort(), [
    "bounds",
    "fitsFoundation",
    "footprint",
    "foundation",
    "id",
    "offsetX",
    "offsetZ",
    "origin",
    "quarterTurns",
    "scale",
    "voxelCount",
  ]);
  assert.equal("sourceCode" in result.building, false);
  assert.equal("worldVoxels" in result.placement, false);
  assert.deepEqual(Object.keys(result.placement.foundation).sort(), [
    "depth",
    "id",
    "maxX",
    "maxZ",
    "minX",
    "minZ",
    "surfaceY",
    "width",
  ]);
  assert.equal("hostOnlyMetadata" in result.placement.foundation, false);
  assert.ok(result.chunks.length > 0);
  client.dispose();
});

function buildingRequest(label, overrides = {}) {
  return {
    code: TEST_BUILDING_CODE,
    buildingId: label,
    placementId: `placement-${label}`,
    foundation: {
      id: `foundation-${label}`,
      minX: 0,
      minZ: 0,
      surfaceY: 2,
      width: 2,
      depth: 1,
    },
    chunkSize: 16,
    revision: 3,
    ...overrides,
  };
}

function buildingResultFor(request) {
  const { building, placement, chunks } = buildingPartsFor(request);
  return createBuildingMeshResult(building, placement, chunks);
}

function buildingPartsFor(request) {
  const building = parseNcm3Building(request.code, { id: request.buildingId || "" });
  const placement = createBuildingPlacement(building, request.foundation, {
    quarterTurns: request.quarterTurns,
    placementId: request.placementId,
    materializeWorldVoxels: false,
    allowFoundationOverflow: request.allowFoundationOverflow === true,
    offsetX: request.offsetX,
    offsetZ: request.offsetZ,
  });
  const chunks = createBuildingChunkMeshes(placement, {
    chunkSize: request.chunkSize,
    revision: request.revision,
  });
  return { building, placement, chunks };
}

function requestFoundation(label, width, depth) {
  return {
    id: `foundation-${label}`,
    minX: 0,
    minZ: 0,
    surfaceY: 2,
    width,
    depth,
  };
}

function singleMaterialRequest(label, material) {
  return buildingRequest(label, {
    code: encodeNcm3(createBlueprint({ x: 1, y: 1, z: 1 }, label).box(material, 0, 0, 0)),
    foundation: requestFoundation(label, 1, 1),
  });
}

function clearCollision(chunk) {
  chunk.collisionMask.fill(0);
  chunk.collisionBlockCount = 0;
}

function forceCollision(chunk) {
  chunk.collisionMask[0] |= 1;
  chunk.collisionBlockCount = 1;
}

function forceOpaqueClassification(chunk) {
  chunk.mesh.blockCount = chunk.voxelCount;
  chunk.visualBlockCount = 0;
  chunk.visualMesh = null;
  chunk.visualMeshVersion = -1;
}

function emptyContentBounds() {
  return {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: -1,
    maxY: -1,
    maxZ: -1,
    width: 0,
    height: 0,
    depth: 0,
  };
}

function assertMutableResult(result) {
  assert.equal(Object.isFrozen(result), false);
  assert.equal(Object.isFrozen(result.building), false);
  assert.equal(Object.isFrozen(result.building.size), false);
  assert.equal(Object.isFrozen(result.placement), false);
  assert.equal(Object.isFrozen(result.placement.origin), false);
  assert.equal(Object.isFrozen(result.chunks[0]), false);
  assert.equal(Object.isFrozen(result.chunks[0].mesh), false);

  const name = result.building.name;
  const originX = result.placement.origin.x;
  const blockCount = result.chunks[0].mesh.blockCount;
  const firstVertexByte = result.chunks[0].mesh.vertices[0];
  result.building.name = `${name}-consumer-owned`;
  result.placement.origin.x = originX + 1;
  result.chunks[0].mesh.blockCount = blockCount + 1;
  result.chunks[0].mesh.vertices[0] = firstVertexByte ^ 1;
  assert.equal(result.building.name, `${name}-consumer-owned`);
  assert.equal(result.placement.origin.x, originX + 1);
  assert.equal(result.chunks[0].mesh.blockCount, blockCount + 1);
  assert.equal(result.chunks[0].mesh.vertices[0], (firstVertexByte ^ 1) & 0xff);
}

function fakeWorker(workers) {
  const worker = {
    messages: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      this.messages.push(message);
    },
    succeed(index) {
      const request = this.messages[index];
      const result = structuredClone(buildingResultFor(request));
      this.onmessage?.({ data: { requestId: request.requestId, ok: true, result } });
    },
    respond(response) {
      this.onmessage?.({ data: response });
    },
    terminate() {
      this.terminated = true;
    },
  };
  workers.push(worker);
  return worker;
}
