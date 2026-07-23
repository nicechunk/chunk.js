import assert from "node:assert/strict";
import test from "node:test";

import { ChunkManager } from "../chunk/chunk-manager.js";
import { createChunkEngine } from "../engine/create-chunk-engine.js";
import { WebGL2VoxelRenderer } from "../renderer/webgl2-renderer.js";

test("engine lifecycle is idempotent and terminal", async () => {
  await withEngineMocks(async ({ canvas, events }) => {
    const statuses = [];
    const engine = await createChunkEngine({
      canvas,
      viewDistance: 1,
      meshBudgetMs: 1,
      onStatus: ({ stage }) => statuses.push(stage),
    });

    engine.start();
    engine.start();
    assert.equal(events.requestedFrames, 1);
    assert.deepEqual(statuses, ["running"]);

    engine.setPaused(true);
    engine.setPaused(true);
    engine.setPaused(false);
    assert.deepEqual(statuses, ["running", "paused", "running"]);

    engine.stop();
    engine.stop();
    assert.equal(events.cancelledFrames, 1);
    assert.deepEqual(statuses, ["running", "paused", "running", "paused"]);

    engine.setPaused(true);
    assert.deepEqual(statuses, ["running", "paused", "running", "paused"]);
    engine.start();
    assert.equal(events.requestedFrames, 2);
    assert.equal(statuses.at(-1), "paused");

    const cameraBeforeDestroy = { ...engine.camera };
    engine.destroy();
    engine.destroy();
    assert.equal(events.cancelledFrames, 2);
    assert.equal(events.chunkDisposals, 1);
    assert.equal(events.rendererDisposals, 1);
    assert.deepEqual(events.disposalOrder, ["chunks", "renderer"]);
    assert.equal(statuses.at(-1), "destroyed");
    assert.throws(() => engine.start(), /destroyed Chunk\.js engine/);

    const statusCount = statuses.length;
    engine.stop();
    engine.setPaused(false);
    engine.resetCamera();
    assert.equal(statuses.length, statusCount);
    assert.deepEqual(engine.camera, cameraBeforeDestroy);
  });
});

test("renderer initialization failure releases the manager and partial renderer", async () => {
  await withEngineMocks(async ({ canvas, events }) => {
    await assert.rejects(
      createChunkEngine({ canvas }),
      /renderer initialization failed/,
    );
    assert.deepEqual(events.disposalOrder, ["chunks", "renderer"]);
    assert.equal(events.chunkDisposals, 1);
    assert.equal(events.rendererDisposals, 1);
  }, { rendererInitError: new Error("renderer initialization failed") });
});

test("renderer cleanup still runs when chunk cleanup reports an error", async () => {
  await withEngineMocks(async ({ canvas, events }) => {
    const engine = await createChunkEngine({ canvas });
    assert.throws(() => engine.destroy(), /chunk cleanup failed/);
    assert.deepEqual(events.disposalOrder, ["chunks", "renderer"]);
    assert.equal(events.rendererDisposals, 1);
  }, { chunkDisposeError: new Error("chunk cleanup failed") });
});

test("malformed engine options fail before allocating runtime resources", async () => {
  await withEngineMocks(async ({ canvas, events }) => {
    await assert.rejects(createChunkEngine(null), /options must be an object/);
    await assert.rejects(createChunkEngine({}), /requires a canvas/);
    for (const meshBudgetMs of [NaN, Infinity, -1, "6"]) {
      await assert.rejects(
        createChunkEngine({ canvas, meshBudgetMs }),
        /meshBudgetMs must be a finite non-negative number/,
      );
    }
    await assert.rejects(createChunkEngine({ canvas, onStats: 1 }), /onStats must be a function/);
    await assert.rejects(createChunkEngine({ canvas, onStatus: {} }), /onStatus must be a function/);
    assert.equal(events.managerUpdates, 0);
    assert.equal(events.rendererInitializations, 0);
  });
});

test("a status callback failure does not strand the engine in a false running state", async () => {
  await withEngineMocks(async ({ canvas, events }) => {
    let failStatus = true;
    const engine = await createChunkEngine({
      canvas,
      onStatus() {
        if (failStatus) throw new Error("status callback failed");
      },
    });
    assert.throws(() => engine.start(), /status callback failed/);
    assert.equal(events.requestedFrames, 0);

    failStatus = false;
    engine.start();
    assert.equal(events.requestedFrames, 1);
    engine.destroy();
  });
});

test("unsupported environments return a cleanup-safe no-op engine", async () => {
  await withEngineMocks(async ({ canvas, events }) => {
    const statuses = [];
    const engine = await createChunkEngine({
      canvas,
      onStatus: ({ stage }) => statuses.push(stage),
    });
    assert.equal(engine.supported, false);
    assert.equal(engine.backend, "none");
    assert.deepEqual(statuses, ["unsupported"]);
    assert.doesNotThrow(() => {
      engine.start();
      engine.stop();
      engine.setPaused(true);
      engine.resetCamera();
      engine.destroy();
      engine.destroy();
    });
    assert.equal(events.managerUpdates, 0);
    assert.equal(events.rendererInitializations, 0);
  }, { webGlSupported: false });
});

async function withEngineMocks(callback, {
  webGlSupported = true,
  rendererInitError = null,
  chunkDisposeError = null,
} = {}) {
  const events = {
    requestedFrames: 0,
    cancelledFrames: 0,
    managerUpdates: 0,
    rendererInitializations: 0,
    chunkDisposals: 0,
    rendererDisposals: 0,
    disposalOrder: [],
  };
  const restore = [];
  const canvas = createCanvas();
  const capabilityContext = {
    MAX_TEXTURE_SIZE: 1,
    MAX_ARRAY_TEXTURE_LAYERS: 2,
    MAX_TEXTURE_IMAGE_UNITS: 3,
    getExtension: () => null,
    getParameter: () => 0,
  };

  replaceGlobal("document", {
    createElement: () => ({
      getContext: () => (webGlSupported ? capabilityContext : null),
    }),
  }, restore);
  replaceGlobal("requestAnimationFrame", () => {
    events.requestedFrames += 1;
    return events.requestedFrames;
  }, restore);
  replaceGlobal("cancelAnimationFrame", () => {
    events.cancelledFrames += 1;
  }, restore);

  replaceMethod(ChunkManager.prototype, "updatePlayerPosition", function updatePlayerPosition() {
    events.managerUpdates += 1;
  }, restore);
  replaceMethod(ChunkManager.prototype, "surfaceYAt", () => 6, restore);
  replaceMethod(ChunkManager.prototype, "dispose", function dispose() {
    events.disposalOrder.push("chunks");
    events.chunkDisposals += 1;
    this.disposed = true;
    this.chunks.clear();
    if (chunkDisposeError) throw chunkDisposeError;
  }, restore);
  replaceMethod(WebGL2VoxelRenderer.prototype, "init", function init() {
    events.rendererInitializations += 1;
    this.initialized = true;
    if (rendererInitError) throw rendererInitError;
    return this;
  }, restore);
  replaceMethod(WebGL2VoxelRenderer.prototype, "dispose", function dispose() {
    events.disposalOrder.push("renderer");
    events.rendererDisposals += 1;
    this.initialized = false;
  }, restore);

  try {
    await callback({ canvas, events });
  } finally {
    for (const restoreValue of restore.reverse()) restoreValue();
  }
}

function createCanvas() {
  return {
    width: 320,
    height: 180,
    clientWidth: 320,
    clientHeight: 180,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ width: 320, height: 180 }),
  };
}

function replaceMethod(target, name, replacement, restore) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {
    ...descriptor,
    value: replacement,
  });
  restore.push(() => Object.defineProperty(target, name, descriptor));
}

function replaceGlobal(name, value, restore) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  restore.push(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}
