import assert from "node:assert/strict";
import test from "node:test";

import { WebGL2VoxelRenderer } from "../renderer/webgl2-renderer.js";

test("renderer preserves configured dynamic shadow capacity", () => {
  const { canvas } = fakeCanvas();
  const renderer = new WebGL2VoxelRenderer(canvas, { maxDynamicShadowCasters: 23 });
  assert.equal(renderer.options.maxDynamicShadowCasters, 23);
  renderer.dispose();
});

test("WebGL context restoration invalidates every context-owned buffer cache", () => {
  const { canvas, listeners } = fakeCanvas();
  const renderer = new WebGL2VoxelRenderer(canvas);
  renderer.chunkBuffers.set("terrain", {});
  renderer.visualChunkBuffers.set("water", {});
  renderer.regionBuffers.set("region", {});
  renderer.visualRegionBuffers.set("visual-region", {});
  renderer.avatarBuffers.set("avatar", { handle: { vao: {} } });
  renderer.regionGroupCache.set("group", {});
  renderer.frustumFilterCache = { key: "stale" };

  let initialized = 0;
  renderer.init = () => {
    initialized += 1;
    return renderer;
  };

  let prevented = false;
  listeners.get("webglcontextlost")({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(renderer.contextLost, true);

  listeners.get("webglcontextrestored")();
  assert.equal(renderer.contextLost, false);
  assert.equal(renderer.chunkBuffers.size, 0);
  assert.equal(renderer.visualChunkBuffers.size, 0);
  assert.equal(renderer.regionBuffers.size, 0);
  assert.equal(renderer.visualRegionBuffers.size, 0);
  assert.equal(renderer.avatarBuffers.size, 0);
  assert.equal(renderer.regionGroupCache.size, 0);
  assert.equal(renderer.frustumFilterCache, null);
  assert.equal(initialized, 1);

  renderer.dispose();
});

test("a partially initialized render pass is released and init remains retryable", () => {
  const { gl, state, control } = fakeWebGl();
  const { canvas, listeners, listenerCalls } = fakeCanvas({ gl, width: 7, height: 9 });
  let failProjectedShadowBuffer = true;
  const renderer = new WebGL2VoxelRenderer(canvas, {
    ...compactInitOptions(),
    onInitStage(stage) {
      if (failProjectedShadowBuffer && stage === "sun disc") {
        failProjectedShadowBuffer = false;
        control.failNextBuffer = true;
      }
    },
  });

  assert.throws(() => renderer.init(), /fake buffer allocation failure/);
  assertRendererInitRolledBack(renderer, canvas, listeners, { width: 7, height: 9 });
  assertContextResourcesReleased(state);
  assert.equal(listenerCalls.add.length, 2);
  assert.equal(listenerCalls.remove.length, 2);

  renderer.init();
  assert.equal(renderer.initialized, true);
  assert.equal(listeners.size, 2);
  assert.equal(listenerCalls.add.length, 4);

  renderer.dispose();
  assert.equal(listeners.size, 0);
  assertContextResourcesReleased(state);
});

test("a final init-stage failure restores canvas and listener ownership before retry", () => {
  const { gl, state } = fakeWebGl();
  const { canvas, listeners } = fakeCanvas({ gl, width: 11, height: 13, clientWidth: 29, clientHeight: 31 });
  let failResizeStage = true;
  const renderer = new WebGL2VoxelRenderer(canvas, {
    ...compactInitOptions(),
    onInitStage(stage) {
      if (failResizeStage && stage === "canvas resize") throw new Error("late init-stage failure");
    },
  });

  assert.throws(() => renderer.init(), /late init-stage failure/);
  assertRendererInitRolledBack(renderer, canvas, listeners, { width: 11, height: 13 });
  assertContextResourcesReleased(state);

  failResizeStage = false;
  renderer.init();
  assert.equal(renderer.initialized, true);
  assert.equal(canvas.width, 29);
  assert.equal(canvas.height, 31);
  assert.equal(listeners.size, 2);

  renderer.dispose();
  assert.equal(listeners.size, 0);
  assertContextResourcesReleased(state);
});

function compactInitOptions() {
  return {
    dpr: 1,
    textureTileSize: 1,
    cloudRadius: 1,
    cloudCellSize: 128,
    maxVoxelParticles: 16,
    maxDynamicShadowCasters: 1,
  };
}

function assertRendererInitRolledBack(renderer, canvas, listeners, dimensions) {
  assert.equal(renderer.initialized, false);
  assert.equal(renderer._contextListenersAttached, false);
  assert.equal(listeners.size, 0);
  assert.equal(canvas.width, dimensions.width);
  assert.equal(canvas.height, dimensions.height);
  for (const field of [
    "gl",
    "program",
    "avatarProgram",
    "uniforms",
    "avatarUniforms",
    "bufferManager",
    "textureArray",
    "cloudLayer",
    "skyGradient",
    "sunDisc",
    "projectedShadowLayer",
    "voxelOverlay",
    "voxelParticles",
  ]) {
    assert.equal(renderer[field], null, `${field} should be reset after failed init`);
  }
}

function assertContextResourcesReleased(state) {
  for (const kind of ["shaders", "programs", "buffers", "vertexArrays", "textures"]) {
    const created = state.created[kind];
    const deleted = state.deleted[kind];
    assert.equal(deleted.length, created.length, `${kind} should all be deleted`);
    assert.equal(new Set(deleted).size, created.length, `${kind} should be deleted exactly once`);
    for (const resource of created) assert.equal(deleted.includes(resource), true, `created ${kind} resource should be deleted`);
  }
}

function fakeCanvas({ gl = null, width = 1, height = 1, clientWidth = width, clientHeight = height } = {}) {
  const listeners = new Map();
  const listenerCalls = { add: [], remove: [] };
  return {
    listeners,
    listenerCalls,
    canvas: {
      width,
      height,
      clientWidth,
      clientHeight,
      getContext(name) {
        return name === "webgl2" ? gl : null;
      },
      getBoundingClientRect() {
        return { width: clientWidth, height: clientHeight };
      },
      addEventListener(name, listener) {
        listenerCalls.add.push({ name, listener });
        listeners.set(name, listener);
      },
      removeEventListener(name, listener) {
        listenerCalls.remove.push({ name, listener });
        if (listeners.get(name) === listener) listeners.delete(name);
      },
    },
  };
}

function fakeWebGl() {
  const state = {
    created: {
      shaders: [],
      programs: [],
      buffers: [],
      vertexArrays: [],
      textures: [],
    },
    deleted: {
      shaders: [],
      programs: [],
      buffers: [],
      vertexArrays: [],
      textures: [],
    },
  };
  const control = { failNextBuffer: false };
  let nextResourceId = 1;
  const create = (kind) => {
    const resource = { kind, id: nextResourceId++ };
    state.created[kind].push(resource);
    return resource;
  };
  const remove = (kind, resource) => state.deleted[kind].push(resource);
  const constants = new Map();
  const methods = {
    createShader: () => create("shaders"),
    deleteShader: (resource) => remove("shaders", resource),
    createProgram: () => create("programs"),
    deleteProgram: (resource) => remove("programs", resource),
    createBuffer() {
      if (control.failNextBuffer) {
        control.failNextBuffer = false;
        throw new Error("fake buffer allocation failure");
      }
      return create("buffers");
    },
    deleteBuffer: (resource) => remove("buffers", resource),
    createVertexArray: () => create("vertexArrays"),
    deleteVertexArray: (resource) => remove("vertexArrays", resource),
    createTexture: () => create("textures"),
    deleteTexture: (resource) => remove("textures", resource),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getUniformLocation: () => ({}),
    getExtension: () => null,
    getParameter: () => "fake WebGL2",
  };
  const noOpMethods = [
    "activeTexture",
    "attachShader",
    "bindBuffer",
    "bindTexture",
    "bindVertexArray",
    "bufferData",
    "compileShader",
    "cullFace",
    "depthFunc",
    "disable",
    "enable",
    "enableVertexAttribArray",
    "linkProgram",
    "pixelStorei",
    "shaderSource",
    "texParameteri",
    "texStorage3D",
    "texSubImage3D",
    "uniform1f",
    "uniform1i",
    "useProgram",
    "vertexAttribDivisor",
    "vertexAttribPointer",
    "viewport",
  ];
  for (const method of noOpMethods) methods[method] = () => {};
  const gl = new Proxy(methods, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === "string" && /^[A-Z0-9_]+$/.test(property)) {
        if (!constants.has(property)) constants.set(property, constants.size + 1);
        return constants.get(property);
      }
      return undefined;
    },
  });
  return { gl, state, control };
}
