import assert from "node:assert/strict";
import test from "node:test";

import { ChunkManager } from "../chunk/chunk-manager.js";

test("worker build failures never fall back to synchronous meshing in a frame", () => {
  const calls = { remesh: 0, sync: 0, dispatch: 0 };
  const chunk = failedChunk({ baseBlocksReady: true });
  const manager = managerHarness(chunk, calls, { retryAt: 0 });

  manager.rebuildDirtyChunks(5);

  assert.equal(calls.remesh, 1);
  assert.equal(calls.sync, 0);
  assert.equal(chunk.buildState, "queued");
});

test("worker build retry backoff leaves the previous mesh untouched", () => {
  const calls = { remesh: 0, sync: 0, dispatch: 0 };
  const chunk = failedChunk({ baseBlocksReady: true, mesh: { triangleCount: 12 } });
  const manager = managerHarness(chunk, calls, { retryAt: performance.now() + 10_000 });

  manager.rebuildDirtyChunks(5);

  assert.equal(calls.remesh, 0);
  assert.equal(calls.sync, 0);
  assert.deepEqual(chunk.mesh, { triangleCount: 12 });
  assert.equal(chunk.buildState, "error");
});

function managerHarness(chunk, calls, failure) {
  const manager = Object.create(ChunkManager.prototype);
  Object.assign(manager, {
    useWorkers: true,
    chunks: new Map([[chunk.id, chunk]]),
    centerChunkX: 0,
    centerChunkZ: 0,
    workerBuildFailures: new Map([[chunk.id, { count: 1, error: "test", ...failure }]]),
    completedBuilds: [],
    lastRebuildMs: 0,
    drainCompletedBuilds: () => [],
    enqueueBuild: () => false,
    enqueueRemesh(target) {
      calls.remesh += 1;
      target.buildState = "queued";
      return true;
    },
    ensureChunkBaseSync() {
      calls.sync += 1;
      throw new Error("synchronous fallback must not run while workers are available");
    },
    dispatchBuilds() {
      calls.dispatch += 1;
    },
  });
  return manager;
}

function failedChunk({ baseBlocksReady, mesh = null }) {
  return {
    id: "0,0",
    chunkX: 0,
    chunkZ: 0,
    dirty: true,
    buildState: "error",
    baseBlocksReady,
    mesh,
    markBuildStale() {
      this.buildState = this.baseBlocksReady ? "ready" : "empty";
      this.dirty = true;
    },
  };
}
