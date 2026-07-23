import assert from "node:assert/strict";
import test from "node:test";

import { createAvatarPreviewRenderer } from "../renderer/avatar-preview.js";
import { createSmeltingCoreRenderer } from "../renderer/smelting-core.js";

const rendererFactories = Object.freeze([
  ["avatar preview", createAvatarPreviewRenderer],
  ["smelting core", createSmeltingCoreRenderer],
]);

test("container preview factories leave no canvas behind when WebGL is unavailable", () => {
  for (const [label, factory] of rendererFactories) {
    const harness = domHarness(null);
    withDomGlobals(harness, () => {
      assert.equal(factory(harness.container), null, `${label} should report unsupported WebGL`);
    });
    assert.equal(harness.container.children.length, 0, `${label} should not retain its created canvas`);
  }
});

test("container preview factories leave no canvas or shader behind when program creation fails", () => {
  for (const [label, factory] of rendererFactories) {
    const { gl, state } = fakePreviewGl({ failShaderCompile: true });
    const harness = domHarness(gl);
    withMutedWarnings(() => withDomGlobals(harness, () => {
      assert.equal(factory(harness.container), null, `${label} should report shader setup failure`);
    }));
    assert.equal(harness.container.children.length, 0, `${label} should not retain its created canvas`);
    assertResourcesReleased(state);
  }
});

test("avatar preview initialization releases partial mesh allocations and its program", () => {
  const { gl, state } = fakePreviewGl({ failBufferAt: 2 });
  const harness = domHarness(gl);

  withDomGlobals(harness, () => {
    assert.throws(
      () => createAvatarPreviewRenderer(harness.container),
      /fake buffer allocation failure/,
    );
  });

  assert.equal(harness.container.children.length, 0);
  assertResourcesReleased(state);
});

test("smelting core initialization releases its completed GPU allocations after a late failure", () => {
  const { gl, state } = fakePreviewGl({ failUniformAt: 3 });
  const harness = domHarness(gl);

  withDomGlobals(harness, () => {
    assert.throws(
      () => createSmeltingCoreRenderer(harness.container),
      /fake uniform lookup failure/,
    );
  });

  assert.equal(harness.container.children.length, 0);
  assertResourcesReleased(state);
});

test("successful container preview factories insert and later release their owned canvas", () => {
  for (const [label, factory] of rendererFactories) {
    const { gl, state } = fakePreviewGl();
    const harness = domHarness(gl);
    let renderer = null;
    withDomGlobals(harness, () => {
      renderer = factory(harness.container);
      assert.ok(renderer, `${label} should initialize`);
      assert.equal(harness.container.children.length, 1);
      assert.equal(harness.container.children[0], renderer.canvas);
      renderer.dispose();
      renderer.dispose();
    });
    assert.equal(harness.container.children.length, 0, `${label} should release its owned canvas`);
    assertResourcesReleased(state);
  }
});

function domHarness(gl) {
  const createdCanvases = [];
  class FakeCanvas {
    constructor() {
      this.dataset = {};
      this.style = {};
      this.className = "";
      this.parentNode = null;
      this.width = 1;
      this.height = 1;
      this.clientWidth = 1;
      this.clientHeight = 1;
    }

    getContext(name) {
      return name === "webgl2" ? gl : null;
    }

    getBoundingClientRect() {
      return { width: 1, height: 1 };
    }

    remove() {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
      this.parentNode = null;
    }
  }
  const container = {
    children: [],
    querySelector() {
      return null;
    },
    prepend(canvas) {
      canvas.remove();
      canvas.parentNode = this;
      this.children.unshift(canvas);
    },
  };
  return {
    Canvas: FakeCanvas,
    container,
    document: {
      createElement(name) {
        assert.equal(name, "canvas");
        const canvas = new FakeCanvas();
        createdCanvases.push(canvas);
        return canvas;
      },
    },
    createdCanvases,
  };
}

function fakePreviewGl({ failShaderCompile = false, failBufferAt = 0, failUniformAt = 0 } = {}) {
  const state = {
    created: { shaders: [], programs: [], buffers: [], vertexArrays: [] },
    deleted: { shaders: [], programs: [], buffers: [], vertexArrays: [] },
  };
  let nextId = 1;
  let bufferCalls = 0;
  let uniformCalls = 0;
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
    DYNAMIC_DRAW: 0x88e8,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    UNSIGNED_INT: 0x1405,
    UNSIGNED_SHORT: 0x1403,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    createShader: () => create("shaders"),
    deleteShader: (resource) => remove("shaders", resource),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => !failShaderCompile,
    getShaderInfoLog: () => "fake shader compile failure",
    createProgram: () => create("programs"),
    deleteProgram: (resource) => remove("programs", resource),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    createBuffer() {
      bufferCalls += 1;
      if (failBufferAt && bufferCalls === failBufferAt) throw new Error("fake buffer allocation failure");
      return create("buffers");
    },
    deleteBuffer: (resource) => remove("buffers", resource),
    createVertexArray: () => create("vertexArrays"),
    deleteVertexArray: (resource) => remove("vertexArrays", resource),
    getAttribLocation: () => 0,
    getUniformLocation(_program, name) {
      uniformCalls += 1;
      if (failUniformAt && uniformCalls === failUniformAt) throw new Error("fake uniform lookup failure");
      return { name };
    },
    bindVertexArray() {},
    bindBuffer() {},
    bufferData() {},
    bufferSubData() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    enable() {},
    disable() {},
    blendFunc() {},
  };
  return { gl, state };
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

function withDomGlobals(harness, callback) {
  return withGlobals({ document: harness.document, HTMLCanvasElement: harness.Canvas }, callback);
}

function withMutedWarnings(callback) {
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    return callback();
  } finally {
    console.warn = previousWarn;
  }
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
