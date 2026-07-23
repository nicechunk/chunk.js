import assert from "node:assert/strict";
import test from "node:test";

test("documented package subpaths resolve to focused module graphs", async () => {
  const engine = await import("@nicechunk/chunk-js/engine/create");
  const play = await import("@nicechunk/chunk-js/play");
  const world = await import("@nicechunk/chunk-js/world");
  const renderer = await import("@nicechunk/chunk-js/renderer");
  const capabilities = await import("@nicechunk/chunk-js/capabilities");
  const math = await import("@nicechunk/chunk-js/math");
  const blueprint = await import("@nicechunk/chunk-js/ncm/blueprint");
  const character = await import("@nicechunk/chunk-js/ncm/character");

  assert.equal(typeof engine.createChunkEngine, "function");
  assert.equal(typeof play.ChunkManager, "function");
  assert.equal(typeof world.getBlockAt, "function");
  assert.equal(typeof renderer.WebGL2VoxelRenderer, "function");
  assert.equal(typeof capabilities.detectWebGl2Support, "function");
  assert.equal(typeof math.mat4Multiply, "function");
  assert.equal(typeof blueprint.decodeNcm3, "function");
  assert.equal(typeof character.decodeNcm4, "function");

  assert.deepEqual(Object.keys(engine), ["createChunkEngine"]);
  assert.equal("encodeNcm4" in world, false);
  assert.equal("decodeNcf1" in play, false);
  assert.equal("ChunkManager" in renderer, false);
  assert.deepEqual(Object.keys(capabilities), ["detectWebGl2Support"]);
});

test("legacy root, src, and engine package barrels stay equivalent", async () => {
  const root = await import("@nicechunk/chunk-js");
  const src = await import("@nicechunk/chunk-js/src");
  const engine = await import("@nicechunk/chunk-js/engine");

  assert.deepEqual(Object.keys(src), Object.keys(root));
  assert.deepEqual(Object.keys(engine), Object.keys(root));
  assert.equal(src.createChunkEngine, root.createChunkEngine);
  assert.equal(engine.createChunkEngine, root.createChunkEngine);
});

test("unexported filesystem paths remain internal to package consumers", async () => {
  await assert.rejects(
    import("@nicechunk/chunk-js/engine/create-chunk-engine.js"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});
