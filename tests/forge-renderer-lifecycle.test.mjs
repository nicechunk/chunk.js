import assert from "node:assert/strict";
import test from "node:test";

import {
  ForgeWorkbenchRenderer,
  createForgeWorkbenchRenderer,
} from "../renderer/forge-workbench-renderer.js";

test("forge renderer factory releases lifecycle listeners when initialization fails", () => {
  const documentTarget = fakeEventTarget();
  const canvas = fakeCanvas(null);

  withGlobals({ document: documentTarget }, () => {
    assert.throws(
      () => createForgeWorkbenchRenderer(canvas, { controls: false, toolVisuals: false }),
      /WebGL2 is required/,
    );
  });

  assert.equal(canvas.listenerCount(), 0);
  assert.equal(documentTarget.listenerCount(), 0);
  assert.deepEqual(
    canvas.removed.map(({ name }) => name).sort(),
    ["webglcontextlost", "webglcontextrestored"],
  );
  assert.deepEqual(documentTarget.removed.map(({ name }) => name), ["visibilitychange"]);
});

test("forge mesh upload rollback releases partial allocations and leaves init retryable", () => {
  const { gl, state, control } = fakeForgeGl({ failBufferAt: 2 });
  const documentTarget = fakeEventTarget();
  const canvas = fakeCanvas(gl);

  withGlobals({
    document: documentTarget,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  }, () => {
    const renderer = new ForgeWorkbenchRenderer(canvas, { controls: false, toolVisuals: false });
    assert.throws(() => renderer.init(), /fake buffer allocation failure/);
    assertInitRolledBack(renderer);
    assertResourcesReleased(state);
    assert.equal(canvas.listenerCount("webglcontextlost"), 1);
    assert.equal(canvas.listenerCount("webglcontextrestored"), 1);
    assert.equal(documentTarget.listenerCount("visibilitychange"), 1);

    control.failBufferAt = 0;
    renderer.init();
    assert.equal(renderer.initialized, true);
    renderer.dispose();

    assert.equal(canvas.listenerCount(), 0);
    assert.equal(documentTarget.listenerCount(), 0);
    assertResourcesReleased(state);
  });
});

test("late forge init failure rolls back controls, resize observer, and GPU resources", () => {
  const { gl, state } = fakeForgeGl();
  const documentTarget = fakeEventTarget();
  const canvas = fakeCanvas(gl, { touchAction: "pan-x" });
  const observers = [];
  let failObserve = true;
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnectCalls = 0;
      observers.push(this);
    }

    observe() {
      if (failObserve) throw new Error("fake resize observation failure");
    }

    disconnect() {
      this.disconnectCalls += 1;
    }
  }

  withGlobals({
    document: documentTarget,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  }, () => {
    const renderer = new ForgeWorkbenchRenderer(canvas, { toolVisuals: false });
    assert.throws(() => renderer.init(), /fake resize observation failure/);

    assertInitRolledBack(renderer);
    assert.equal(renderer.controlsAttached, false);
    assert.equal(canvas.style.touchAction, "pan-x");
    for (const name of controlEventNames()) assert.equal(canvas.listenerCount(name), 0, `${name} should be removed`);
    assert.equal(observers[0].disconnectCalls, 1);
    assertResourcesReleased(state);

    failObserve = false;
    renderer.init();
    assert.equal(renderer.initialized, true);
    assert.equal(renderer.controlsAttached, true);
    assert.equal(canvas.style.touchAction, "none");
    for (const name of controlEventNames()) assert.equal(canvas.listenerCount(name), 1, `${name} should be attached`);

    renderer.dispose();
    assert.equal(canvas.style.touchAction, "pan-x");
    assert.equal(observers[1].disconnectCalls, 1);
    assert.equal(canvas.listenerCount(), 0);
    assert.equal(documentTarget.listenerCount(), 0);
    assertResourcesReleased(state);
  });
});

function assertInitRolledBack(renderer) {
  assert.equal(renderer.initialized, false);
  assert.equal(renderer.gl, null);
  assert.equal(renderer.program, null);
  assert.equal(renderer.uniforms, null);
  assert.equal(renderer.staticHandle, null);
  assert.equal(renderer.dynamicHandle, null);
  assert.equal(renderer.avatarHandle, null);
  assert.equal(renderer.toolHandles.size, 0);
  assert.deepEqual(renderer.guideHandles, { transform: null, reticle: null });
  assert.equal(renderer.materialTextureArray, null);
  assert.equal(renderer.materialTextureSignature, null);
  assert.equal(renderer.resizeObserver, null);
  assert.equal(renderer.framePending, false);
  assert.equal(renderer.raf, 0);
}

function assertResourcesReleased(state) {
  for (const kind of Object.keys(state.created)) {
    assert.equal(
      state.deleted[kind].length,
      state.created[kind].length,
      `all created ${kind} should be deleted`,
    );
    assert.equal(
      new Set(state.deleted[kind]).size,
      state.deleted[kind].length,
      `${kind} should be deleted exactly once`,
    );
    for (const resource of state.created[kind]) {
      assert.equal(state.deleted[kind].includes(resource), true, `created ${kind} resource should be deleted`);
    }
  }
}

function controlEventNames() {
  return ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "wheel"];
}

function fakeCanvas(gl, { touchAction = "" } = {}) {
  const target = fakeEventTarget();
  return Object.assign(target, {
    style: { touchAction },
    width: 1,
    height: 1,
    clientWidth: 1,
    clientHeight: 1,
    getContext(name) {
      return name === "webgl2" ? gl : null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1, height: 1 };
    },
  });
}

function fakeEventTarget() {
  const listeners = new Map();
  return {
    hidden: false,
    added: [],
    removed: [],
    addEventListener(name, listener) {
      this.added.push({ name, listener });
      const entries = listeners.get(name) ?? new Set();
      entries.add(listener);
      listeners.set(name, entries);
    },
    removeEventListener(name, listener) {
      this.removed.push({ name, listener });
      const entries = listeners.get(name);
      entries?.delete(listener);
      if (!entries?.size) listeners.delete(name);
    },
    listenerCount(name = null) {
      if (name != null) return listeners.get(name)?.size ?? 0;
      let count = 0;
      for (const entries of listeners.values()) count += entries.size;
      return count;
    },
  };
}

function fakeForgeGl({ failBufferAt = 0 } = {}) {
  const state = {
    created: { shaders: [], programs: [], buffers: [], vertexArrays: [], textures: [] },
    deleted: { shaders: [], programs: [], buffers: [], vertexArrays: [], textures: [] },
  };
  const control = { failBufferAt, bufferCalls: 0 };
  let nextId = 1;
  const create = (kind) => {
    const resource = { kind, id: nextId++ };
    state.created[kind].push(resource);
    return resource;
  };
  const remove = (kind, resource) => state.deleted[kind].push(resource);
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    SHORT: 0x1402,
    BYTE: 0x1400,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_SHORT: 0x1403,
    UNSIGNED_INT: 0x1405,
    TEXTURE_2D_ARRAY: 0x8c1a,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    REPEAT: 0x2901,
    UNPACK_ALIGNMENT: 0x0cf5,
    DEPTH_TEST: 0x0b71,
    LEQUAL: 0x0203,
    CULL_FACE: 0x0b44,
    BACK: 0x0405,
    BLEND: 0x0be2,
    createShader: () => create("shaders"),
    deleteShader: (resource) => remove("shaders", resource),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    createProgram: () => create("programs"),
    deleteProgram: (resource) => remove("programs", resource),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    getUniformLocation: (_program, name) => ({ name }),
    createVertexArray: () => create("vertexArrays"),
    deleteVertexArray: (resource) => remove("vertexArrays", resource),
    createBuffer() {
      control.bufferCalls += 1;
      if (control.failBufferAt && control.bufferCalls === control.failBufferAt) {
        throw new Error("fake buffer allocation failure");
      }
      return create("buffers");
    },
    deleteBuffer: (resource) => remove("buffers", resource),
    bindVertexArray() {},
    bindBuffer() {},
    bufferData() {},
    enableVertexAttribArray() {},
    vertexAttribIPointer() {},
    vertexAttribPointer() {},
    createTexture: () => create("textures"),
    deleteTexture: (resource) => remove("textures", resource),
    bindTexture() {},
    texStorage3D() {},
    texSubImage3D() {},
    texParameteri() {},
    pixelStorei() {},
    enable() {},
    disable() {},
    depthFunc() {},
    cullFace() {},
  };
  return { gl, state, control };
}

function withGlobals(replacements, callback) {
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.prototype.hasOwnProperty.call(globalThis, name)
      ? { present: true, value: globalThis[name] }
      : { present: false, value: undefined });
    globalThis[name] = value;
  }
  try {
    return callback();
  } finally {
    for (const [name, entry] of previous) {
      if (entry.present) globalThis[name] = entry.value;
      else delete globalThis[name];
    }
  }
}
