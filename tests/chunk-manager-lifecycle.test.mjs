import assert from "node:assert/strict";
import test from "node:test";

import { ChunkManager } from "../chunk/chunk-manager.js";

test("ChunkManager disposal is terminal, idempotent, and releases retained state", () => {
  const manager = new ChunkManager({ useWorkers: false, deferInitialBuilds: true });
  manager.ensureChunk(0, 0);
  manager.visibleChunkMemory.set("0,0", 1);
  manager.collisionColumnTopCache.set("0,0", 1);

  manager.dispose();
  manager.dispose();

  assert.equal(manager.disposed, true);
  assert.equal(manager.useWorkers, false);
  assert.equal(manager.workerCount, 0);
  assert.equal(manager.chunks.size, 0);
  assert.equal(manager.visibleChunkMemory.size, 0);
  assert.equal(manager.collisionColumnTopCache.size, 0);
  assert.throws(() => manager.ensureChunk(0, 0), /disposed ChunkManager/);
});

test("ChunkManager detaches and terminates module workers on disposal", () => {
  const OriginalWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class FakeWorker {
    constructor() {
      this.terminated = false;
      workers.push(this);
    }

    postMessage() {}

    terminate() {
      this.terminated = true;
    }
  };

  try {
    const manager = new ChunkManager({ useWorkers: true, workerCount: 1 });
    assert.equal(workers.length, 1);
    assert.equal(typeof workers[0].onmessage, "function");
    manager.dispose();
    assert.equal(workers[0].terminated, true);
    assert.equal(workers[0].onmessage, null);
    assert.equal(workers[0].onerror, null);
  } finally {
    if (OriginalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = OriginalWorker;
  }
});

test("Worker construction failure falls back without disposing the manager", () => {
  const OriginalWorker = globalThis.Worker;
  globalThis.Worker = class BlockedWorker {
    constructor() {
      throw new Error("blocked by CSP");
    }
  };

  try {
    const manager = new ChunkManager({
      useWorkers: true,
      workerCount: 1,
      viewDistance: 1,
      height: 8,
      minY: 0,
    });
    assert.equal(manager.disposed, false);
    assert.equal(manager.useWorkers, false);
    const chunk = manager.ensureChunk(0, 0);
    assert.equal(chunk.baseBlocksReady, true);
    manager.dispose();
  } finally {
    if (OriginalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = OriginalWorker;
  }
});

test("losing the last Worker releases queued chunks to synchronous fallback", () => {
  const OriginalWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class FakeWorker {
    constructor() {
      workers.push(this);
    }

    postMessage() {}

    terminate() {
      this.terminated = true;
    }
  };

  try {
    const manager = new ChunkManager({
      useWorkers: true,
      workerCount: 1,
      viewDistance: 1,
      height: 8,
      minY: 0,
    });
    const first = manager.ensureChunk(0, 0);
    const second = manager.ensureChunk(1, 0);
    manager.dispatchBuilds();
    assert.equal(first.buildState, "building");
    assert.equal(second.buildState, "queued");

    globalThis.Worker = class FailedReplacement {
      constructor() {
        throw new Error("replacement blocked");
      }
    };
    manager.handleWorkerError(workers[0], new Error("worker crashed"));

    assert.equal(manager.useWorkers, false);
    assert.equal(manager.buildQueue.length, 0);
    assert.equal(manager.inFlightBuilds.size, 0);
    assert.notEqual(first.buildState, "building");
    assert.notEqual(second.buildState, "queued");

    manager.rebuildDirtyChunks(1000);
    assert.equal(first.baseBlocksReady, true);
    assert.equal(second.baseBlocksReady, true);
    assert.ok(first.mesh);
    assert.ok(second.mesh);
    manager.dispose();
  } finally {
    if (OriginalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = OriginalWorker;
  }
});

test("Worker message errors and postMessage exceptions cannot strand in-flight work", () => {
  const OriginalWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class ThrowingWorker {
    constructor() {
      workers.push(this);
    }

    postMessage(message) {
      if (message.type === "buildChunk") throw new Error("DataCloneError");
    }

    terminate() {
      this.terminated = true;
    }
  };

  try {
    const manager = new ChunkManager({
      useWorkers: true,
      workerCount: 1,
      viewDistance: 1,
      height: 8,
      minY: 0,
    });
    assert.equal(typeof workers[0].onmessageerror, "function");
    const chunk = manager.ensureChunk(0, 0);
    assert.doesNotThrow(() => manager.dispatchBuilds());
    assert.equal(manager.useWorkers, false);
    assert.equal(manager.inFlightBuilds.size, 0);
    assert.notEqual(chunk.buildState, "building");
    manager.dispose();
  } finally {
    if (OriginalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = OriginalWorker;
  }
});

test("Worker seed payloads are detached from manager, config, and chunk ownership", () => {
  const harness = fakeChunkWorkerHarness();
  const expected = Uint8Array.from({ length: 32 }, (_, index) => index);
  try {
    const manager = harness.createManager({ worldSeed: expected });
    const chunk = manager.ensureChunk(0, 0);
    manager.dispatchBuilds();
    const message = harness.workers[0].messages.find((entry) => entry.type === "buildChunk");
    assert.ok(message);
    assert.deepEqual(message.worldSeed, expected);
    message.worldSeed.fill(255);
    assert.deepEqual(manager.worldSeed, expected);
    assert.deepEqual(manager.config.worldSeed, expected);
    assert.deepEqual(chunk.worldSeed, expected);
    manager.dispose();
  } finally {
    harness.restore();
  }
});

for (const [label, corrupt] of [
  ["unknown task ID", (message) => ({ ...message, taskId: message.taskId + 10_000 })],
  ["wrong coordinates", (message) => ({ ...message, chunkX: message.chunkX + 1 })],
  ["wrong response phase", (message) => ({ ...message, type: "visualBuilt" })],
]) {
  test(`ChunkManager quarantines a Worker that returns the ${label} without stranding its real task`, () => {
    const harness = fakeChunkWorkerHarness();
    try {
      const { manager, chunk, taskId, task, worker } = harness.startOne();
      worker.emit(corrupt(chunkBuiltResponse(taskId, task)));

      assert.equal(worker.terminated, true);
      assert.equal(manager.workers.includes(worker), false);
      assert.equal(manager.idleWorkers.includes(worker), false);
      assert.equal(manager.inFlightBuilds.has(taskId), false);
      assert.notEqual(chunk.buildState, "building");
      manager.dispose();
    } finally {
      harness.restore();
    }
  });
}

test("ChunkManager rejects a response from the wrong Worker without consuming the owned task", () => {
  const harness = fakeChunkWorkerHarness();
  try {
    const manager = harness.createManager({ workerCount: 2 });
    manager.setBuildConcurrencyLimit(2);
    const firstChunk = manager.ensureChunk(0, 0);
    const secondChunk = manager.ensureChunk(1, 0);
    manager.dispatchBuilds();

    const tasks = Array.from(manager.inFlightBuilds.entries());
    assert.equal(tasks.length, 2);
    const [targetId, targetTask] = tasks.find(([, task]) => task.id === firstChunk.id);
    const [senderId, senderTask] = tasks.find(([, task]) => task.id === secondChunk.id);
    senderTask.worker.emit(chunkBuiltResponse(targetId, targetTask));

    assert.equal(senderTask.worker.terminated, true);
    assert.equal(manager.inFlightBuilds.get(targetId), targetTask);
    assert.equal(firstChunk.buildState, "building");
    assert.equal(manager.inFlightBuilds.has(senderId), false);
    assert.notEqual(secondChunk.buildState, "building");
    assert.equal(manager.idleWorkers.includes(targetTask.worker), false);
    manager.dispose();
  } finally {
    harness.restore();
  }
});

test("Chunk Worker error responses quarantine the sender and release the exact owned task", () => {
  const harness = fakeChunkWorkerHarness();
  try {
    const { manager, chunk, taskId, task, worker } = harness.startOne();
    worker.emit({
      type: "chunkBuildError",
      taskId,
      chunkX: task.chunkX,
      chunkZ: task.chunkZ,
      error: "synthetic build failure",
    });

    assert.equal(worker.terminated, true);
    assert.equal(manager.idleWorkers.includes(worker), false);
    assert.equal(manager.inFlightBuilds.has(taskId), false);
    assert.equal(chunk.buildState, "error");
    assert.match(chunk.buildError, /synthetic build failure/);
    manager.dispose();
  } finally {
    harness.restore();
  }
});

test("late responses for canceled chunk tasks cannot release a Worker's newer task", () => {
  const harness = fakeChunkWorkerHarness();
  try {
    const { manager, taskId, task, worker } = harness.startOne();
    const canceledResponse = chunkBuiltResponse(taskId, task);
    manager.unloadFarChunks(100, 100);
    assert.equal(task.cancelled, true);

    worker.emit(canceledResponse);
    assert.equal(manager.inFlightBuilds.has(taskId), false);
    assert.equal(manager.idleWorkers.includes(worker), true);

    const currentChunk = manager.ensureChunk(100, 100);
    manager.dispatchBuilds();
    const [currentTaskId, currentTask] = Array.from(manager.inFlightBuilds.entries())
      .find(([, candidate]) => candidate.id === currentChunk.id);
    assert.equal(currentTask.worker, worker);
    assert.equal(manager.idleWorkers.includes(worker), false);

    worker.emit(canceledResponse);
    assert.equal(manager.inFlightBuilds.get(currentTaskId), currentTask);
    assert.equal(currentChunk.buildState, "building");
    assert.equal(manager.idleWorkers.includes(worker), false);
    manager.dispose();
  } finally {
    harness.restore();
  }
});

function chunkBuiltResponse(taskId, task, overrides = {}) {
  return {
    type: "chunkBuilt",
    taskId,
    chunkX: task.chunkX,
    chunkZ: task.chunkZ,
    mode: task.mode,
    taskVersion: task.version,
    materialVersion: task.materialVersion,
    visualPending: false,
    ...overrides,
  };
}

function fakeChunkWorkerHarness() {
  const OriginalWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class FakeWorker {
    constructor() {
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    emit(message) {
      this.onmessage?.({ data: message });
    }

    terminate() {
      this.terminated = true;
    }
  };

  return {
    createManager(options = {}) {
      return new ChunkManager({
        useWorkers: true,
        workerCount: 1,
        viewDistance: 1,
        height: 8,
        minY: 0,
        deferContinuousBuildDispatch: true,
        ...options,
      });
    },
    startOne() {
      const manager = this.createManager();
      const chunk = manager.ensureChunk(0, 0);
      manager.dispatchBuilds();
      const [taskId, task] = Array.from(manager.inFlightBuilds.entries())[0];
      return { manager, chunk, taskId, task, worker: task.worker, workers };
    },
    restore() {
      if (OriginalWorker === undefined) delete globalThis.Worker;
      else globalThis.Worker = OriginalWorker;
    },
    workers,
  };
}
