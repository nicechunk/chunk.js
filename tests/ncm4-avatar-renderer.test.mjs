import assert from "node:assert/strict";
import {
  createAvatarMeshFromNcm,
  createAvatarMeshFromNcm4Character,
  sampleNcm4Action,
  updateAvatarMeshVertices,
} from "../renderer/avatar-mesh.js";
import { encodeNcm4, NCM4_BONES } from "../ncm/character-codec.js";
import {
  createAvatarPreviewRenderer,
  createAvatarPreviewViewProjection,
  resolveAvatarPreviewAttachIronPickaxe,
  resolveAvatarPreviewEquipment,
} from "../renderer/avatar-preview.js";
import { mat4LookAt, mat4Multiply, mat4Perspective } from "../core/math.js";

assert.equal(resolveAvatarPreviewAttachIronPickaxe(undefined), true, "existing previews should keep their default pickaxe mesh");
assert.equal(resolveAvatarPreviewAttachIronPickaxe(false), false, "NCM4 previews must be able to opt out of legacy equipment");
assert.equal(resolveAvatarPreviewEquipment(undefined).rightHand, "pickaxe", "existing previews should keep the pickaxe visible by default");
assert.equal(resolveAvatarPreviewEquipment({ rightHand: "empty" }).rightHand, "empty", "NCM4 previews must be able to request empty hands");

const character = {
  format: "NCM4",
  version: 1,
  unit: 1,
  palette: ["#8a5b3d", "#f4efe8", "#d7ad45"],
  bones: NCM4_BONES.map((bone) => ({
    ...bone,
    pivot: bone.id === 11 ? [1, 2, 0] : [0, 0, 0],
  })),
  cuboids: [
    { origin: [0, 0, 0], size: [2, 3, 1], paletteIndex: 0, bone: 0, group: 0 },
    { origin: [1, 2, 0], size: [2, 1, 1], paletteIndex: 1, bone: 11, group: 0 },
    { origin: [3, 2, 0], size: [1, 1, 1], paletteIndex: 2, bone: 11, group: 1 },
    { origin: [4, 2, 0], size: [1, 1, 1], paletteIndex: 2, bone: 11, group: 2 },
    { origin: [5, 2, 0], size: [1, 1, 1], paletteIndex: 2, bone: 11, group: 3 },
  ],
  actions: [
    {
      id: 1,
      name: "greet_customer",
      duration: 30,
      ticksPerSecond: 30,
      loop: true,
      visibleGroupMask: 1,
      keyframes: [
        { tick: 0, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
        { tick: 15, rotations: [{ bone: 11, rotation: [0, 0, -Math.PI / 4] }] },
        { tick: 30, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
      ],
    },
    {
      id: 2,
      name: "show_goods",
      duration: 30,
      ticksPerSecond: 30,
      loop: true,
      visibleGroupMask: 3,
      keyframes: [
        { tick: 0, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
        { tick: 15, rotations: [{ bone: 11, rotation: [0, 0, Math.PI / 2] }] },
        { tick: 30, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
      ],
    },
    {
      id: 3,
      name: "record_price",
      duration: 30,
      ticksPerSecond: 30,
      loop: true,
      visibleGroupMask: 5,
      keyframes: [
        { tick: 0, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
        { tick: 15, rotations: [{ bone: 11, rotation: [Math.PI / 4, 0, 0] }] },
        { tick: 30, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
      ],
    },
    {
      id: 4,
      name: "complete_trade",
      duration: 30,
      ticksPerSecond: 30,
      loop: true,
      visibleGroupMask: 9,
      keyframes: [
        { tick: 0, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
        { tick: 15, rotations: [{ bone: 11, rotation: [0, Math.PI / 4, 0] }] },
        { tick: 30, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
      ],
    },
  ],
};

const sample = sampleNcm4Action(character.actions, { action: "show_goods", progress: 0.25 });
assert.equal(sample.action.id, 2);
assert.equal(sample.visibleGroupMask, 3);
assert.ok(Math.abs(sample.rotations.get("11").z - Math.PI / 4) < 1e-8, "sparse NCM4 rotations should interpolate in radians");

const loopClosingSample = sampleNcm4Action([{
  id: 3,
  name: "record_price",
  durationTicks: 30,
  ticksPerSecond: 30,
  loop: true,
  visibleGroupMask: 5,
  keyframes: [
    { tick: 0, rotations: [{ bone: 11, rotation: [0, 0, 0] }] },
    { tick: 15, rotations: [{ bone: 11, rotation: [0, 0, Math.PI / 2] }] },
  ],
}], { action: "record_price", progress: 0.75 });
assert.ok(
  Math.abs(loopClosingSample.rotations.get("11").z - Math.PI / 4) < 1e-8,
  "a two-keyframe loop must interpolate from its last authored pose back to tick zero",
);

const mesh = createAvatarMeshFromNcm4Character(character, { name: "renderer_fixture" });
assert.equal(mesh.format, "NCM4");
assert.equal(mesh.boneCount, 20);
assert.equal(mesh.actionCount, 4);
assert.equal(mesh.vertexCount, character.cuboids.length * 24);
assert.equal(mesh.indexCount, character.cuboids.length * 36);

const previewAspect = 1.25;
const previewBounds = mesh.renderBounds;
const previewHeight = Math.max(1, mesh.bounds.height);
const previewRenderHeight = Math.max(previewHeight, previewBounds.maxY - previewBounds.minY);
const previewRenderWidth = Math.max(
  Math.abs(previewBounds.minX),
  Math.abs(previewBounds.maxX),
  Math.abs(previewBounds.minZ),
  Math.abs(previewBounds.maxZ),
) * 2;
const previewDistance = Math.max(
  3.2,
  previewRenderHeight * 1.72,
  previewRenderWidth * 0.92 / Math.max(0.55, previewAspect),
);
const legacyProjection = mat4Multiply(
  mat4Perspective((30 * Math.PI) / 180, previewAspect, 0.05, 32),
  mat4LookAt(
    [0.05, previewHeight * 0.58, previewDistance],
    [0, previewHeight * 0.54, 0],
    [0, 1, 0],
  ),
);
assert.deepEqual(
  createAvatarPreviewViewProjection(mesh, previewAspect),
  legacyProjection,
  "the default preview must preserve the existing perspective matrix",
);
assert.deepEqual(
  createAvatarPreviewViewProjection(mesh, previewAspect, { orthographic: false }),
  legacyProjection,
  "orthographic projection must remain strictly opt-in",
);
const orthographicProjection = createAvatarPreviewViewProjection(mesh, previewAspect, {
  projection: "orthographic",
  orthographicPadding: 0.18,
  orthographicHeight: 4,
});
assert.equal(orthographicProjection.length, 16);
assert.ok(Array.from(orthographicProjection).every(Number.isFinite), "orthographic preview matrices must remain finite");
assert.notDeepEqual(orthographicProjection, legacyProjection);
assert.deepEqual(
  createAvatarPreviewViewProjection(mesh, previewAspect, { orthographic: true, padding: 0.18, height: 4 }),
  orthographicProjection,
  "the boolean mode and concise framing aliases should match the explicit orthographic API",
);
const zoomedOrthographicProjection = createAvatarPreviewViewProjection(mesh, previewAspect, {
  projection: "orthographic",
  orthographicPadding: 0.18,
  orthographicHeight: 4,
  orthographicZoom: 1.5,
});
assert.notDeepEqual(
  zoomedOrthographicProjection,
  orthographicProjection,
  "orthographic zoom must change the preview projection instead of relying on camera distance",
);
assert.ok(
  Math.abs(zoomedOrthographicProjection[0]) > Math.abs(orthographicProjection[0]),
  "a larger orthographic zoom should magnify the character",
);
assert.deepEqual(
  createAvatarPreviewViewProjection(mesh, previewAspect, {
    orthographic: true,
    padding: 0.18,
    height: 4,
    zoom: 1.5,
  }),
  zoomedOrthographicProjection,
  "the concise zoom alias should match the explicit orthographic zoom API",
);

const propVertexOffset = 2 * 24 * 10;
for (let offset = propVertexOffset; offset < mesh.vertices.length; offset += 10) {
  assert.equal(mesh.vertices[offset + 9], 0, "the static NCM4 rest mesh should not flash inactive props before its first update");
}
const hidden = new Float32Array(updateAvatarMeshVertices(mesh, {}));
for (let offset = propVertexOffset; offset < hidden.length; offset += 10) {
  assert.equal(hidden[offset + 9], 0, "unselected action props should be collapsed without changing the buffer layout");
}

const rest = new Float32Array(updateAvatarMeshVertices(mesh, { action: 2, progress: 0 }));
const posed = new Float32Array(updateAvatarMeshVertices(mesh, { action: 2, progress: 0.5 }));
assert.equal(posed.length, mesh.vertices.length, "NCM4 animation must keep one stable vertex buffer");
assert.ok(Array.from(posed).every(Number.isFinite));
assert.notDeepEqual(
  Array.from(posed.slice(24 * 10, 25 * 10)),
  Array.from(rest.slice(24 * 10, 25 * 10)),
  "an explicitly bound child bone should move its cuboids",
);
for (let offset = propVertexOffset; offset < posed.length; offset += 10) {
  const partIndex = Math.floor(offset / (24 * 10));
  const expectedAlpha = character.cuboids[partIndex].group === 1 ? 1 : 0;
  assert.equal(
    posed[offset + 9],
    expectedAlpha,
    "the selected action should reveal only its prop group inside the same draw buffer",
  );
}

const encodedMesh = createAvatarMeshFromNcm(encodeNcm4(character), { name: "encoded_renderer_fixture" });
assert.equal(encodedMesh.format, "NCM4", "the public avatar loader should dispatch canonical NCM4 text to the shared renderer");
assert.equal(encodedMesh.vertexCount, mesh.vertexCount);
assert.equal(encodedMesh.indexCount, mesh.indexCount);

const ncm2Mesh = createAvatarMeshFromNcm();
assert.ok(ncm2Mesh.vertexCount > 0, "NCM2 avatars should remain compatible");
assert.notEqual(ncm2Mesh.format, "NCM4");

const authoringCharacter = structuredClone(character);
authoringCharacter.name = "direct_authoring_fixture";
authoringCharacter.pivots = Object.fromEntries(
  character.bones.map((bone) => [bone.name, [...bone.pivot]]),
);
delete authoringCharacter.bones;

const previewHarness = createPreviewHarness();
const originalDocument = globalThis.document;
const originalCanvasClass = globalThis.HTMLCanvasElement;
globalThis.document = {};
globalThis.HTMLCanvasElement = previewHarness.Canvas;
let preview = null;
try {
  preview = createAvatarPreviewRenderer(new previewHarness.Canvas(), {
    character: authoringCharacter,
    attachIronPickaxe: false,
    equipment: { rightHand: "empty" },
    antialias: true,
  });
  assert.ok(preview, "a direct authoring object should initialize the shared WebGL preview");
  assert.equal(
    previewHarness.contexts.at(-1)?.attributes?.antialias,
    true,
    "authoring previews may opt into WebGL antialiasing without changing the shared default",
  );
  assert.equal(typeof preview.setCharacter, "function");
  assert.deepEqual(
    {
      source: preview.snapshot().source,
      format: preview.snapshot().format,
      bones: preview.snapshot().boneCount,
      actions: preview.snapshot().actionCount,
    },
    { source: "character", format: "NCM4", bones: 20, actions: 4 },
    "authored pivot maps must hydrate the canonical 20-bone NCM4 skeleton without an encode/decode pass",
  );

  const visibleGroupByAction = new Map([
    ["greet_customer", 0],
    ["show_goods", 1],
    ["record_price", 2],
    ["complete_trade", 3],
  ]);
  for (const action of authoringCharacter.actions) {
    assert.equal(preview.render({
      character: authoringCharacter,
      action: action.name,
      progress: 0.5,
      timeMs: 0,
      yaw: 0,
      moving: false,
    }), true);
    const uploaded = previewHarness.uploads.at(-1);
    const visibleGroup = visibleGroupByAction.get(action.name);
    for (let partIndex = 0; partIndex < authoringCharacter.cuboids.length; partIndex += 1) {
      const group = authoringCharacter.cuboids[partIndex].group;
      const expectedAlpha = group === 0 || group === visibleGroup ? 1 : 0;
      assert.equal(
        uploaded[partIndex * 24 * 10 + 9],
        expectedAlpha,
        `${action.name} must keep group ${group} visibility in the direct-object preview`,
      );
    }
    assert.equal(preview.snapshot().animation.visibleGroupMask, action.visibleGroupMask);
  }

  const switchedCharacter = structuredClone(authoringCharacter);
  switchedCharacter.name = "render_switched_fixture";
  assert.equal(preview.render({
    character: switchedCharacter,
    action: "greet_customer",
    progress: 0,
    timeMs: 0,
    yaw: 0,
  }), true);
  assert.equal(preview.snapshot().label, "render_switched_fixture", "render(params.character) must switch direct sources");
  assert.equal(preview.setCharacter(authoringCharacter, { name: "set_character_fixture" }), true);
  assert.equal(preview.snapshot().label, "set_character_fixture", "setCharacter must install a direct source explicitly");

  assert.throws(
    () => preview.render({ character: { format: "NCM4", cuboids: [] } }),
    /Invalid NCM4 character geometry/,
    "invalid authoring objects must fail fast instead of falling back to the built-in model",
  );
  assert.equal(preview.snapshot().label, "set_character_fixture", "a rejected authoring object must leave the active mesh intact");
} finally {
  preview?.dispose();
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalCanvasClass === undefined) delete globalThis.HTMLCanvasElement;
  else globalThis.HTMLCanvasElement = originalCanvasClass;
}

console.log("ncm4 avatar renderer tests passed");

function createPreviewHarness() {
  const uploads = [];
  const contexts = [];
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
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    DEPTH_TEST: 0x0b71,
    LEQUAL: 0x0203,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram: () => {},
    getUniformLocation: () => ({}),
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    bindVertexArray: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData(target, _offset, data) {
      if (target === this.ARRAY_BUFFER) uploads.push(new Float32Array(data));
    },
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    enable: () => {},
    depthFunc: () => {},
    disable: () => {},
    blendFunc: () => {},
    useProgram: () => {},
    uniformMatrix4fv: () => {},
    uniform1f: () => {},
    drawElements: () => {},
    deleteBuffer: () => {},
    deleteVertexArray: () => {},
  };

  class Canvas {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.clientWidth = 320;
      this.clientHeight = 400;
    }

    getContext(kind, attributes) {
      contexts.push({ kind, attributes });
      return kind === "webgl2" ? gl : null;
    }

    getBoundingClientRect() {
      return { width: this.clientWidth, height: this.clientHeight };
    }
  }

  return { Canvas, uploads, contexts };
}
