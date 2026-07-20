import { MAX_DESKTOP_DPR, MAX_MOBILE_DPR } from "../core/constants.js";
import { mat4LookAt, mat4Multiply, mat4Perspective, normalize3 } from "../core/math.js";
import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
  updateAvatarMeshVertices,
} from "./avatar-mesh.js";
import {
  buildForgeCuboidMesh,
  buildForgeDesignMesh,
  FORGE_MESH_MATERIAL_LAYER_OFFSET,
  FORGE_MESH_MATERIAL_LAYER_NONE,
  FORGE_MESH_VERTEX_STRIDE_BYTES,
  FORGE_RENDER_POSITION_SCALE,
} from "../forge/forge-mesher.js";
import {
  FORGE_TOOL_VISUAL_IDS,
  createForgeToolVisualMesh,
  forgeToolActionDuration,
  normalizeForgeToolVisualHit,
  normalizeForgeToolVisualId,
  sameForgeToolVisualHit,
  sampleForgeToolVisualPose,
} from "./forge-tool-visuals.js";
import {
  FORGE_MATERIAL_SURFACE_TILE_SIZE,
  activeForgeMaterialSurfaceSet,
  createForgeMaterialCatalog,
  createForgeMaterialTextureArray,
} from "./forge-material-surfaces.js";

export {
  FORGE_TOOL_VISUAL_IDS,
  createForgeToolVisualMesh,
  forgeToolActionDuration,
  normalizeForgeToolVisualHit,
  normalizeForgeToolVisualId,
  sampleForgeToolVisualPose,
} from "./forge-tool-visuals.js";

const IDENTITY_BASIS_3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
export const FORGE_MAX_COMPONENT_VISUAL_OFFSETS = 24;
const FORGE_DRAG_COMPONENT_NONE = -1;
const FORGE_DRAG_ALL_COMPONENTS = -2;

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in ivec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
layout(location = 3) in uint aComponentIndex;
layout(location = 4) in uint aMaterialLayer;

uniform mat4 uViewProjection;
uniform vec3 uOffset;
uniform mat3 uObjectBasis;
uniform int uComponentVisualOffsetsEnabled;
uniform vec3 uComponentVisualOffsets[${FORGE_MAX_COMPONENT_VISUAL_OFFSETS}];
uniform int uDragComponentIndex;
uniform vec3 uDragOffset;
uniform int uSpinComponentIndex;
uniform float uSpinRadians;
uniform float uExposure;
uniform float uOpacity;
uniform vec3 uColorTint;
uniform float uColorTintMix;
uniform float uMaterialTileScale;
uniform float uTimeSeconds;
uniform uint uClothComponentMask;
uniform vec3 uClothComponentMin[${FORGE_MAX_COMPONENT_VISUAL_OFFSETS}];
uniform vec3 uClothComponentMax[${FORGE_MAX_COMPONENT_VISUAL_OFFSETS}];
uniform float uClothMotionScale;

out vec3 vNormal;
out vec4 vColor;
out float vDepth;
out vec2 vMaterialUv;
flat out uint vComponentIndex;
flat out uint vMaterialLayer;

void applyClothWind(inout vec3 position) {
  if (aComponentIndex >= uint(${FORGE_MAX_COMPONENT_VISUAL_OFFSETS})
      || ((uClothComponentMask >> aComponentIndex) & 1u) == 0u) return;
  int componentIndex = int(aComponentIndex);
  vec3 boundsMin = uClothComponentMin[componentIndex];
  vec3 boundsMax = uClothComponentMax[componentIndex];
  vec3 span = max(boundsMax - boundsMin, vec3(0.0001));
  int thinAxis = span.x <= span.y && span.x <= span.z ? 0 : span.y <= span.z ? 1 : 2;
  float weight;
  if (thinAxis != 1 && span.y > 0.0001) {
    weight = clamp((boundsMax.y - position.y) / span.y, 0.0, 1.0);
  } else if (span.x >= span.z) {
    weight = clamp((position.x - boundsMin.x) / span.x, 0.0, 1.0);
  } else {
    weight = clamp((position.z - boundsMin.z) / span.z, 0.0, 1.0);
  }
  weight *= weight;
  float phase = uTimeSeconds * 2.15
    + dot(position, vec3(2.7, 0.65, 2.15)) * 2.4
    + float(componentIndex) * 0.73;
  float wave = sin(phase) + sin(phase * 0.47 + 1.8) * 0.42;
  float displacement = wave * weight * 0.055 * uClothMotionScale;
  if (thinAxis == 0) position.x += displacement;
  else if (thinAxis == 1) position.y += displacement;
  else position.z += displacement;
}

void main() {
  vec3 position = vec3(aPosition) / ${FORGE_RENDER_POSITION_SCALE.toFixed(1)};
  vec3 normal = normalize(aNormal);
  vec3 absoluteNormal = abs(normal);
  if (absoluteNormal.x >= absoluteNormal.y && absoluteNormal.x >= absoluteNormal.z) {
    vMaterialUv = vec2(position.z, position.y) * uMaterialTileScale;
  } else if (absoluteNormal.y >= absoluteNormal.z) {
    vMaterialUv = vec2(position.x, position.z) * uMaterialTileScale;
  } else {
    vMaterialUv = vec2(position.x, position.y) * uMaterialTileScale;
  }
  applyClothWind(position);
  if (int(aComponentIndex) == uSpinComponentIndex) {
    float cosine = cos(uSpinRadians);
    float sine = sin(uSpinRadians);
    position.yz = mat2(cosine, sine, -sine, cosine) * position.yz;
    normal.yz = mat2(cosine, sine, -sine, cosine) * normal.yz;
  }
  if (uComponentVisualOffsetsEnabled != 0 && aComponentIndex < uint(${FORGE_MAX_COMPONENT_VISUAL_OFFSETS})) {
    position += uComponentVisualOffsets[int(aComponentIndex)];
  }
  if (uDragComponentIndex == ${FORGE_DRAG_ALL_COMPONENTS} || int(aComponentIndex) == uDragComponentIndex) {
    position += uDragOffset;
  }
  position = uObjectBasis * position + uOffset;
  gl_Position = uViewProjection * vec4(position, 1.0);
  vNormal = normalize(uObjectBasis * normal);
  vec3 color = mix(aColor.rgb, uColorTint, uColorTintMix);
  vColor = vec4(color * uExposure, aColor.a * uOpacity);
  vDepth = max(0.0, gl_Position.w);
  vComponentIndex = aComponentIndex;
  vMaterialLayer = aMaterialLayer;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec3 vNormal;
in vec4 vColor;
in float vDepth;
in vec2 vMaterialUv;
flat in uint vComponentIndex;
flat in uint vMaterialLayer;

uniform vec3 uFogColor;
uniform vec2 uFogNearFar;
uniform vec3 uLightDirection;
uniform vec3 uAmbientColor;
uniform vec3 uKeyLightColor;
uniform float uExposure;
uniform float uUnlit;
uniform sampler2DArray uMaterialTextureArray;
uniform int uMaterialTextureEnabled;
uniform int uMaterialLayerCount;
uniform int uSelectedComponentIndex;
uniform int uSelectedFaceAxis;
uniform int uSelectedFaceSide;
uniform int uHoveredComponentIndex;
uniform int uHoveredFaceAxis;
uniform int uHoveredFaceSide;

out vec4 outColor;

float faceMask(int componentIndex, int faceAxis, int faceSide, vec3 normal) {
  if (componentIndex < 0 || faceAxis < 0 || faceSide < 0 || int(vComponentIndex) != componentIndex) return 0.0;
  vec3 absoluteNormal = abs(normal);
  int normalAxis = 0;
  float dominant = absoluteNormal.x;
  if (absoluteNormal.y > dominant) {
    normalAxis = 1;
    dominant = absoluteNormal.y;
  }
  if (absoluteNormal.z > dominant) normalAxis = 2;
  float signedNormal = normalAxis == 0 ? normal.x : normalAxis == 1 ? normal.y : normal.z;
  int normalSide = signedNormal >= 0.0 ? 1 : 0;
  return normalAxis == faceAxis && normalSide == faceSide ? 1.0 : 0.0;
}

void main() {
  vec3 normal = normalize(vNormal);
  float key = max(dot(normal, normalize(uLightDirection)), 0.0);
  float hemi = normal.y * 0.5 + 0.5;
  vec3 light = mix(uAmbientColor * (0.82 + hemi * 0.18) + uKeyLightColor * key, vec3(1.0), uUnlit);
  bool useMaterialTexture = uMaterialTextureEnabled != 0
    && vMaterialLayer != uint(${FORGE_MESH_MATERIAL_LAYER_NONE})
    && int(vMaterialLayer) < uMaterialLayerCount;
  vec3 surfaceColor = vColor.rgb;
  if (useMaterialTexture) {
    surfaceColor = texture(
      uMaterialTextureArray,
      vec3(fract(vMaterialUv), float(vMaterialLayer))
    ).rgb * uExposure;
  }
  vec3 color = surfaceColor * light;
  float hovered = faceMask(uHoveredComponentIndex, uHoveredFaceAxis, uHoveredFaceSide, normal);
  float selected = faceMask(uSelectedComponentIndex, uSelectedFaceAxis, uSelectedFaceSide, normal);
  hovered *= 1.0 - selected;
  color = mix(color, color * 0.72 + vec3(0.20, 0.72, 0.92) * 0.48, hovered * 0.24);
  color = mix(color, color * 0.62 + vec3(1.00, 0.63, 0.12) * 0.62, selected * 0.38);
  float fog = smoothstep(uFogNearFar.x, uFogNearFar.y, vDepth);
  outColor = vec4(mix(color, uFogColor, fog), vColor.a);
}
`;

export const DEFAULT_FORGE_BENCH_CUBOIDS = Object.freeze([
  cuboid("base", [0, 0.12, 0], [3.45, 0.28, 3.45], 0x222),
  cuboid("back", [0, 0.72, -1.34], [3.08, 1.12, 0.40], 0x333),
  cuboid("left", [-1.34, 0.72, 0], [0.40, 1.12, 3.08], 0x333),
  cuboid("right", [1.34, 0.72, 0], [0.40, 1.12, 3.08], 0x333),
  cuboid("front-left", [-1.02, 0.72, 1.34], [1.04, 1.12, 0.40], 0x333),
  cuboid("front-right", [1.02, 0.72, 1.34], [1.04, 1.12, 0.40], 0x333),
  cuboid("front-sill", [0, 0.28, 1.34], [1.10, 0.24, 0.40], 0x222),
  cuboid("deck", [0, 1.38, 0], [6.40, 0.22, 6.40], 0x666),
]);

const FORGE_TRANSFORM_GIZMO_MESH = createForgeTransformGizmoMesh();
const FORGE_CONSTRUCTION_RETICLE_MESH = createForgeConstructionReticleMesh();
const FORGE_TRANSFORM_SNAP = FORGE_RENDER_POSITION_SCALE / 2;
const FORGE_GIZMO_TARGET_PIXELS = 82;
const FORGE_RETICLE_TARGET_PIXELS = 34;
const DEFAULT_FORGE_AVATAR_POSITION = Object.freeze([-2.62, 1.5, 0.92]);
const DEFAULT_FORGE_AVATAR_YAW = -0.18;

export class ForgeWorkbenchRenderer {
  constructor(canvas, options = {}) {
    if (!canvas) throw new TypeError("ForgeWorkbenchRenderer requires a canvas.");
    this.canvas = canvas;
    const staticMesh = buildForgeCuboidMesh(options.benchCuboids ?? DEFAULT_FORGE_BENCH_CUBOIDS);
    const explicitWorkpieceFloorY = options.workpieceFloorY != null && Number.isFinite(Number(options.workpieceFloorY))
      ? Number(options.workpieceFloorY)
      : null;
    const workpieceFloorY = explicitWorkpieceFloorY ?? forgeWorkSurfaceY(staticMesh);
    this.options = {
      dpr: Number.isFinite(options.dpr) ? Number(options.dpr) : null,
      maxMobileDpr: finite(options.maxMobileDpr, MAX_MOBILE_DPR),
      maxDesktopDpr: finite(options.maxDesktopDpr, MAX_DESKTOP_DPR),
      clearColor: normalizeColor(options.clearColor, [0.74, 0.75, 0.76, 1]),
      fogColor: normalizeColor(options.fogColor, [0.74, 0.75, 0.76, 1]).slice(0, 3),
      fogNear: finite(options.fogNear, 14),
      fogFar: finite(options.fogFar, 32),
      exposure: finite(options.exposure, 1.08),
      lightDirection: direction3(options.lightDirection, [-0.48, 0.76, 0.43]),
      ambientColor: normalizeColor(options.ambientColor, [0.58, 0.61, 0.66, 1]).slice(0, 3),
      keyLightColor: normalizeColor(options.keyLightColor, [0.72, 0.65, 0.54, 1]).slice(0, 3),
      controls: options.controls !== false,
      toolVisuals: options.toolVisuals !== false,
      powerPreference: options.powerPreference === "high-performance" ? "high-performance" : "low-power",
      materialTextureSeed: options.materialTextureSeed == null
        ? null
        : String(options.materialTextureSeed),
      materialTextureTileSize: clampInteger(
        options.materialTextureTileSize,
        8,
        128,
        FORGE_MATERIAL_SURFACE_TILE_SIZE,
      ),
      materialTileScale: Math.max(0.01, finite(options.materialTileScale, 1)),
      workpieceOffset: vector3(options.workpieceOffset ?? [0, workpieceFloorY ?? 0, 0]),
    };
    this.camera = {
      target: vector3(options.target ?? [-0.35, 1.15, -0.25]),
      yaw: finite(options.yaw, -0.72),
      pitch: clamp(finite(options.pitch, 0.38), -0.15, 1.08),
      distance: clamp(finite(options.distance, 9.2), 4.5, 18),
      fov: clamp(finite(options.fov, 46), 20, 90),
      near: Math.max(0.01, finite(options.near, 0.08)),
      far: Math.max(20, finite(options.far, 80)),
    };
    this.gl = null;
    this.program = null;
    this.uniforms = null;
    this.forgeMaterialCatalog = createForgeMaterialCatalog(options.forgeMaterialCatalog);
    this.componentMaterialIds = [];
    this.materialSurfaceSet = activeForgeMaterialSurfaceSet([], {
      catalog: this.forgeMaterialCatalog,
    });
    this.materialTextureArray = null;
    this.materialTextureSignature = null;
    this.staticMesh = staticMesh;
    this.dynamicMesh = buildForgeCuboidMesh(options.workpieceCuboids ?? []);
    this.workpieceGrouped = Boolean(options.workpieceGrouped);
    this.dynamicComponentPickBounds = this.dynamicMesh.pickBounds;
    if (this.workpieceGrouped) {
      const groupedBound = mergeForgePickBounds(this.dynamicComponentPickBounds);
      this.dynamicMesh.pickBounds = groupedBound ? [groupedBound] : [];
    }
    this.explicitWorkpieceFloorY = explicitWorkpieceFloorY;
    this.workpieceFloorY = workpieceFloorY;
    this.explicitWorkpieceOffset = options.workpieceOffset != null;
    this.toolMeshes = new Map(this.options.toolVisuals
      ? FORGE_TOOL_VISUAL_IDS.map((toolId) => [toolId, createForgeToolVisualMesh(toolId)])
      : []);
    this.guideMeshes = {
      transform: FORGE_TRANSFORM_GIZMO_MESH,
      reticle: FORGE_CONSTRUCTION_RETICLE_MESH,
    };
    this.dynamicOffset = options.workpieceCuboids ? [0, 0, 0] : [...this.options.workpieceOffset];
    this.staticHandle = null;
    this.dynamicHandle = null;
    this.avatarHandle = null;
    this.avatar = {
      modelCode: String(options.avatarModelCode || DEFAULT_PEASANT_GUY_NCM),
      position: vector3(options.avatarPosition ?? DEFAULT_FORGE_AVATAR_POSITION),
      yaw: finite(options.avatarYaw, DEFAULT_FORGE_AVATAR_YAW),
      runtime: null,
      state: "empty",
      mesh: null,
      packedMesh: null,
      equipment: { rightHand: "empty" },
      clothAnimated: false,
      lastAnimationTime: 0,
    };
    this.toolHandles = new Map();
    this.guideHandles = { transform: null, reticle: null };
    this.initialized = false;
    this.contextLost = false;
    this.disposed = false;
    this.framePending = false;
    this.raf = 0;
    this.drawCount = 0;
    this.lastStats = emptyStats();
    this.selected = null;
    this.hovered = null;
    this.transformTargetIndex = -1;
    this.ungroupedTransformTargetIndex = -1;
    this.hoveredGizmoAxis = null;
    this.constructionPreview = null;
    this.controlsAttached = false;
    this.pointers = new Map();
    this.drag = null;
    this.dragPreview = null;
    this.componentVisualOffsets = new Float32Array(FORGE_MAX_COMPONENT_VISUAL_OFFSETS * 3);
    this.componentVisualOffsetLength = 0;
    this.componentVisualOffsetsEnabled = false;
    this.clothComponentMask = 0;
    this.clothComponentCount = 0;
    this.clothComponentMin = new Float32Array(FORGE_MAX_COMPONENT_VISUAL_OFFSETS * 3);
    this.clothComponentMax = new Float32Array(FORGE_MAX_COMPONENT_VISUAL_OFFSETS * 3);
    this.clothFrameTimer = 0;
    this.reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    this.workpieceDragEnabled = options.workpieceDragEnabled !== false;
    this.workpieceDragConstraint = typeof options.workpieceDragConstraint === "function"
      ? options.workpieceDragConstraint
      : null;
    this.pinchDistance = 0;
    this.hoverPoint = null;
    this.hoverRaf = 0;
    this.hoverUpdateActive = false;
    this.activeTool = "gloves";
    this.activeToolSettings = {};
    this.toolPreview = null;
    this.toolAction = null;
    this.nextToolActionId = 1;
    this.resizeObserver = null;
    this.onPick = typeof options.onPick === "function" ? options.onPick : null;
    this.onHover = typeof options.onHover === "function" ? options.onHover : null;
    this.onWorkpieceDrag = typeof options.onWorkpieceDrag === "function" ? options.onWorkpieceDrag : null;
    this.onToolActionEnd = typeof options.onToolActionEnd === "function" ? options.onToolActionEnd : null;
    this._onContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      try {
        this.resetPointerInteraction(event, { notifyCancel: true });
      } finally {
        if (this.raf) cancelFrame(this.raf);
        this.raf = 0;
        if (this.clothFrameTimer) globalThis.clearTimeout?.(this.clothFrameTimer);
        this.clothFrameTimer = 0;
        this.toolAction = null;
        this.toolPreview = null;
        this.constructionPreview = null;
        this.materialTextureArray = null;
        this.materialTextureSignature = null;
        this.initialized = false;
        this.framePending = false;
      }
    };
    this._onContextRestored = () => {
      this.contextLost = false;
      this.program = null;
      this.staticHandle = null;
      this.dynamicHandle = null;
      this.avatarHandle = null;
      this.toolHandles = new Map();
      this.guideHandles = { transform: null, reticle: null };
      this.materialTextureArray = null;
      this.materialTextureSignature = null;
      this.init();
      this.invalidate();
    };
    this._onPointerDown = (event) => this.pointerDown(event);
    this._onPointerMove = (event) => this.pointerMove(event);
    this._onPointerUp = (event) => this.pointerUp(event);
    this._onPointerCancel = (event) => this.pointerCancel(event);
    this._onPointerLeave = (event) => this.pointerLeave(event);
    this._onWheel = (event) => this.wheel(event);
    this._onResize = () => this.invalidate();
    this._onVisibilityChange = () => {
      if (!globalThis.document?.hidden && (this.clothComponentMask || this.avatar.clothAnimated)) this.invalidate();
    };
    this.canvas.addEventListener("webglcontextlost", this._onContextLost, false);
    this.canvas.addEventListener("webglcontextrestored", this._onContextRestored, false);
    globalThis.document?.addEventListener?.("visibilitychange", this._onVisibilityChange);
  }

  init() {
    if (this.disposed) throw new Error("ForgeWorkbenchRenderer has been disposed.");
    if (this.contextLost) return this;
    if (this.initialized && this.gl && !this.contextLost) return this;
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: this.options.powerPreference,
    });
    if (!gl) throw new Error("WebGL2 is required for the forge workbench renderer.");
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.uniforms = {
      viewProjection: gl.getUniformLocation(this.program, "uViewProjection"),
      offset: gl.getUniformLocation(this.program, "uOffset"),
      objectBasis: gl.getUniformLocation(this.program, "uObjectBasis"),
      componentVisualOffsetsEnabled: gl.getUniformLocation(this.program, "uComponentVisualOffsetsEnabled"),
      componentVisualOffsets: gl.getUniformLocation(this.program, "uComponentVisualOffsets[0]"),
      dragComponentIndex: gl.getUniformLocation(this.program, "uDragComponentIndex"),
      dragOffset: gl.getUniformLocation(this.program, "uDragOffset"),
      spinComponentIndex: gl.getUniformLocation(this.program, "uSpinComponentIndex"),
      spinRadians: gl.getUniformLocation(this.program, "uSpinRadians"),
      exposure: gl.getUniformLocation(this.program, "uExposure"),
      opacity: gl.getUniformLocation(this.program, "uOpacity"),
      colorTint: gl.getUniformLocation(this.program, "uColorTint"),
      colorTintMix: gl.getUniformLocation(this.program, "uColorTintMix"),
      materialTileScale: gl.getUniformLocation(this.program, "uMaterialTileScale"),
      timeSeconds: gl.getUniformLocation(this.program, "uTimeSeconds"),
      clothComponentMask: gl.getUniformLocation(this.program, "uClothComponentMask"),
      clothComponentMin: gl.getUniformLocation(this.program, "uClothComponentMin[0]"),
      clothComponentMax: gl.getUniformLocation(this.program, "uClothComponentMax[0]"),
      clothMotionScale: gl.getUniformLocation(this.program, "uClothMotionScale"),
      materialTextureArray: gl.getUniformLocation(this.program, "uMaterialTextureArray"),
      materialTextureEnabled: gl.getUniformLocation(this.program, "uMaterialTextureEnabled"),
      materialLayerCount: gl.getUniformLocation(this.program, "uMaterialLayerCount"),
      fogColor: gl.getUniformLocation(this.program, "uFogColor"),
      fogNearFar: gl.getUniformLocation(this.program, "uFogNearFar"),
      lightDirection: gl.getUniformLocation(this.program, "uLightDirection"),
      ambientColor: gl.getUniformLocation(this.program, "uAmbientColor"),
      keyLightColor: gl.getUniformLocation(this.program, "uKeyLightColor"),
      unlit: gl.getUniformLocation(this.program, "uUnlit"),
      selectedComponentIndex: gl.getUniformLocation(this.program, "uSelectedComponentIndex"),
      selectedFaceAxis: gl.getUniformLocation(this.program, "uSelectedFaceAxis"),
      selectedFaceSide: gl.getUniformLocation(this.program, "uSelectedFaceSide"),
      hoveredComponentIndex: gl.getUniformLocation(this.program, "uHoveredComponentIndex"),
      hoveredFaceAxis: gl.getUniformLocation(this.program, "uHoveredFaceAxis"),
      hoveredFaceSide: gl.getUniformLocation(this.program, "uHoveredFaceSide"),
    };
    this.staticHandle = uploadMesh(gl, this.staticMesh, gl.STATIC_DRAW);
    this.dynamicHandle = uploadMesh(gl, this.dynamicMesh, gl.DYNAMIC_DRAW);
    this.avatarHandle = uploadMesh(
      gl,
      this.avatar.packedMesh,
      this.avatar.clothAnimated ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW,
    );
    this.toolHandles = new Map(Array.from(this.toolMeshes, ([toolId, mesh]) => [toolId, uploadMesh(gl, mesh, gl.STATIC_DRAW)]));
    this.guideHandles = {
      transform: uploadMesh(gl, this.guideMeshes.transform, gl.STATIC_DRAW),
      reticle: uploadMesh(gl, this.guideMeshes.reticle, gl.STATIC_DRAW),
    };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.rebuildMaterialTextureArray(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);
    this.initialized = true;
    if (this.options.controls) this.attachControls();
    this.observeResize();
    this.invalidate();
    return this;
  }

  setSceneAvatar(forgeRuntime = null, params = {}) {
    const runtime = forgeRuntime?.grip ? forgeRuntime : null;
    const modelCode = String(params.modelCode || this.avatar.modelCode || DEFAULT_PEASANT_GUY_NCM);
    const position = params.position == null ? this.avatar.position : vector3(params.position);
    const yaw = Number.isFinite(Number(params.yaw)) ? Number(params.yaw) : this.avatar.yaw;
    const state = String(params.state || (runtime ? "equipped" : "empty"));
    const signature = runtime
      ? `${modelCode}:${runtime.mode || "components"}:${Number(runtime.designHash) >>> 0}`
      : `${modelCode}:empty`;
    const poseChanged = yaw !== this.avatar.yaw || !floatArraysEqual(position, this.avatar.position);
    this.avatar.position = position;
    this.avatar.yaw = yaw;
    this.avatar.state = state;
    if (this.avatar.signature === signature && this.avatar.packedMesh) {
      this.avatar.runtime = runtime;
      if (poseChanged) this.invalidate();
      return this;
    }

    const equipped = Boolean(runtime);
    const equipment = equipped
      ? { rightHand: "forged_pickaxe", forged: true, designHash: Number(runtime.designHash) >>> 0 }
      : { rightHand: "empty" };
    const mesh = createAvatarMeshFromNcm(modelCode, {
      name: "forge_scene_avatar",
      attachIronPickaxe: equipped,
      attachForgedPickaxe: equipped,
      forgeRuntime: runtime,
    });
    const vertices = updateAvatarMeshVertices(mesh, {
      moving: false,
      timeMs: nowMilliseconds(),
      equipment,
    }) || mesh.vertices;
    const packedMesh = packAvatarMesh(mesh, vertices);
    this.avatar.modelCode = modelCode;
    this.avatar.runtime = runtime;
    this.avatar.mesh = mesh;
    this.avatar.packedMesh = packedMesh;
    this.avatar.equipment = equipment;
    this.avatar.clothAnimated = Boolean(runtime?.clothComponentCount);
    this.avatar.lastAnimationTime = 0;
    this.avatar.signature = signature;
    if (this.gl && this.initialized && !this.contextLost) {
      disposeHandle(this.gl, this.avatarHandle);
      this.avatarHandle = uploadMesh(
        this.gl,
        packedMesh,
        this.avatar.clothAnimated ? this.gl.DYNAMIC_DRAW : this.gl.STATIC_DRAW,
      );
    }
    this.invalidate();
    return this;
  }

  avatarPreviewSnapshot() {
    return {
      modelCode: this.avatar.modelCode,
      label: this.avatar.mesh?.name ?? "forge_scene_avatar",
      triangleCount: this.avatar.mesh?.triangleCount ?? 0,
      equipment: this.avatar.mesh?.equipment ?? [],
      forgeDesignHash: Number(this.avatar.runtime?.designHash) >>> 0,
      forgeRuntimeAttached: Boolean(this.avatar.runtime),
      state: this.avatar.state,
      position: [...this.avatar.position],
      yaw: this.avatar.yaw,
      sharedScene: true,
    };
  }

  updateSceneAvatarAnimation(timestamp) {
    if (!this.avatar.clothAnimated || !this.avatar.mesh || !this.avatarHandle || !this.gl) return false;
    if (Number(timestamp) - this.avatar.lastAnimationTime < (this.reducedMotion ? 100 : 33)) return false;
    this.avatar.lastAnimationTime = Number(timestamp);
    const vertices = updateAvatarMeshVertices(this.avatar.mesh, {
      moving: false,
      timeMs: timestamp,
      equipment: this.avatar.equipment,
      clothMotionScale: this.reducedMotion ? 0.28 : 1,
    }) || this.avatar.mesh.vertices;
    writePackedAvatarVertices(this.avatar.packedMesh.vertices, vertices);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.avatarHandle.vbo);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.avatar.packedMesh.vertices);
    return true;
  }

  setBenchCuboids(cuboids) {
    const previousBaseOffset = [...this.options.workpieceOffset];
    this.staticMesh = buildForgeCuboidMesh(cuboids ?? []);
    this.workpieceFloorY = this.explicitWorkpieceFloorY ?? forgeWorkSurfaceY(this.staticMesh);
    if (!this.explicitWorkpieceOffset && Number.isFinite(this.workpieceFloorY)) {
      this.options.workpieceOffset = [previousBaseOffset[0], this.workpieceFloorY, previousBaseOffset[2]];
      if (vectorsNearlyEqual(this.dynamicOffset, previousBaseOffset)) {
        this.dynamicOffset = [...this.options.workpieceOffset];
      }
    }
    if (this.gl) {
      disposeHandle(this.gl, this.staticHandle);
      this.staticHandle = uploadMesh(this.gl, this.staticMesh, this.gl.STATIC_DRAW);
    }
    this.invalidate();
    return this;
  }

  setWorkpieceCuboids(cuboids, { offset = [0, 0, 0] } = {}) {
    this.componentMaterialIds = [];
    this.setMaterialSurfaceSet(activeForgeMaterialSurfaceSet([], {
      catalog: this.forgeMaterialCatalog,
    }));
    this.dynamicOffset = vector3(offset);
    this.setClothComponents(null, null);
    this.replaceDynamicMesh(buildForgeCuboidMesh(cuboids ?? []));
    return this;
  }

  setWorkpieceOffset(offset, { constrainToFloor = true } = {}) {
    const requested = vector3(offset);
    const next = constrainToFloor
      ? floorConstrainedWorkpieceOffset(this.dynamicMesh, requested, this.workpieceFloorY)
      : requested;
    if (vectorsNearlyEqual(next, this.dynamicOffset)) return this;
    this.dynamicOffset = next;
    this.invalidate();
    return this;
  }

  setDesign(design, {
    offset = this.options.workpieceOffset,
    constrainToFloor = true,
    componentMaterialIds = [],
  } = {}) {
    this.componentMaterialIds = Array.from(componentMaterialIds ?? [], (materialId) => String(materialId ?? ""));
    const materialSurfaceSet = activeForgeMaterialSurfaceSet(
      design?.appearance ? [] : this.componentMaterialIds,
      { catalog: this.forgeMaterialCatalog },
    );
    const mesh = buildForgeDesignMesh(design, {
      componentMaterialLayers: materialSurfaceSet.componentLayers,
    });
    this.setClothComponents(design, mesh);
    this.setMaterialSurfaceSet(materialSurfaceSet);
    this.dynamicOffset = constrainToFloor
      ? floorConstrainedWorkpieceOffset(mesh, vector3(offset), this.workpieceFloorY)
      : vector3(offset);
    this.replaceDynamicMesh(mesh);
    return this;
  }

  setClothComponents(design, mesh) {
    this.clothComponentMask = 0;
    this.clothComponentCount = 0;
    this.clothComponentMin.fill(0);
    this.clothComponentMax.fill(0);
    if (!design?.appearance && Array.isArray(design?.components)) {
      for (let index = 0; index < Math.min(design.components.length, FORGE_MAX_COMPONENT_VISUAL_OFFSETS); index += 1) {
        if (design.components[index]?.resourceId !== "cloth") continue;
        const bound = mesh?.pickBounds?.find((candidate) => candidate.index === index);
        if (!bound) continue;
        this.clothComponentMask = (this.clothComponentMask | (1 << index)) >>> 0;
        this.clothComponentCount += 1;
        this.clothComponentMin.set(bound.min, index * 3);
        this.clothComponentMax.set(bound.max, index * 3);
      }
    }
    if (!this.clothComponentMask && this.clothFrameTimer) {
      globalThis.clearTimeout?.(this.clothFrameTimer);
      this.clothFrameTimer = 0;
    }
    return this;
  }

  setMaterialSurfaceSet(materialSurfaceSet) {
    this.materialSurfaceSet = materialSurfaceSet ?? activeForgeMaterialSurfaceSet([], {
      catalog: this.forgeMaterialCatalog,
    });
    if (this.gl && !this.contextLost) this.rebuildMaterialTextureArray();
    return this;
  }

  rebuildMaterialTextureArray(force = false) {
    if (!this.gl || this.contextLost) return false;
    const signature = this.materialSurfaceSet?.signature ?? "";
    if (!force && this.materialTextureSignature === signature && this.materialTextureArray) return false;
    this.materialTextureArray?.dispose?.();
    this.materialTextureArray = createForgeMaterialTextureArray(this.gl, {
      materialIds: this.materialSurfaceSet?.materialIds ?? [],
      catalog: this.forgeMaterialCatalog,
      seed: this.options.materialTextureSeed,
      tileSize: this.options.materialTextureTileSize,
    });
    this.materialTextureSignature = signature;
    return true;
  }

  replaceDynamicMesh(mesh) {
    this.dynamicMesh = mesh;
    this.dynamicComponentPickBounds = Array.isArray(mesh.pickBounds) ? mesh.pickBounds : [];
    this.updateWorkpiecePickBounds();
    if (this.gl) {
      disposeHandle(this.gl, this.dynamicHandle);
      this.dynamicHandle = uploadMesh(this.gl, mesh, this.gl.DYNAMIC_DRAW);
    }
    this.selected = null;
    this.hovered = null;
    this.dragPreview = null;
    this.toolPreview = null;
    this.constructionPreview = null;
    this.hoveredGizmoAxis = null;
    if (!mesh.pickBounds?.some((bound) => bound.index === this.transformTargetIndex)) this.transformTargetIndex = -1;
    this.invalidate();
  }

  updateWorkpiecePickBounds() {
    if (!this.dynamicMesh) return;
    if (!this.workpieceGrouped) {
      this.dynamicMesh.pickBounds = this.dynamicComponentPickBounds;
      return;
    }
    const groupedBound = mergeForgePickBounds(this.dynamicComponentPickBounds);
    this.dynamicMesh.pickBounds = groupedBound ? [groupedBound] : [];
  }

  setWorkpieceGrouped(grouped) {
    const next = Boolean(grouped);
    if (next === this.workpieceGrouped) return this;
    if (this.drag?.hit && !this.drag.cancelled) this.cancelWorkpieceDrag(null);
    if (next) this.ungroupedTransformTargetIndex = this.transformTargetIndex;
    this.workpieceGrouped = next;
    this.updateWorkpiecePickBounds();
    if (next) {
      this.transformTargetIndex = this.dynamicMesh.pickBounds.length && this.transformTargetIndex >= 0 ? 0 : -1;
    } else {
      const restoreIndex = this.ungroupedTransformTargetIndex;
      this.transformTargetIndex = this.dynamicComponentPickBounds.some((bound) => bound.index === restoreIndex)
        ? restoreIndex
        : -1;
    }
    this.selected = null;
    this.hovered = null;
    this.dragPreview = null;
    this.toolPreview = null;
    this.constructionPreview = null;
    this.hoveredGizmoAxis = null;
    this.invalidate();
    return this;
  }

  setComponentVisualOffsets(offsets = null) {
    const normalized = normalizeComponentVisualOffsets(offsets);
    const changed = normalized.enabled !== this.componentVisualOffsetsEnabled
      || normalized.length !== this.componentVisualOffsetLength
      || !floatArraysEqual(normalized.values, this.componentVisualOffsets);
    if (!changed) return this;
    this.componentVisualOffsets.set(normalized.values);
    this.componentVisualOffsetLength = normalized.length;
    this.componentVisualOffsetsEnabled = normalized.enabled;
    this.invalidate();
    return this;
  }

  componentVisualOffset(index) {
    return componentVisualOffsetAt(
      this.componentVisualOffsetsEnabled ? this.componentVisualOffsets : null,
      index,
    );
  }

  groupedWorkpieceBound() {
    return mergeForgePickBounds(this.dynamicComponentPickBounds, {
      componentOffsets: this.componentVisualOffsetsEnabled ? this.componentVisualOffsets : null,
    });
  }

  setWorkpieceDragConstraint(constraint = null) {
    if (constraint != null && typeof constraint !== "function") {
      throw new TypeError("Forge workpiece drag constraint must be a function or null.");
    }
    this.workpieceDragConstraint = constraint;
    return this;
  }

  setCamera(options = {}) {
    this.cancelScheduledHover();
    this.setHoveredFace(null);
    if (options.target != null) this.camera.target = vector3(options.target);
    if (Number.isFinite(options.yaw)) this.camera.yaw = Number(options.yaw);
    if (Number.isFinite(options.pitch)) this.camera.pitch = clamp(Number(options.pitch), -0.15, 1.08);
    if (Number.isFinite(options.distance)) this.camera.distance = clamp(Number(options.distance), 4.5, 18);
    if (Number.isFinite(options.fov)) this.camera.fov = clamp(Number(options.fov), 20, 90);
    this.invalidate();
    return this;
  }

  orbit(deltaYaw, deltaPitch) {
    this.cancelScheduledHover();
    this.setHoveredFace(null);
    this.camera.yaw += Number(deltaYaw) || 0;
    this.camera.pitch = clamp(this.camera.pitch + (Number(deltaPitch) || 0), -0.15, 1.08);
    this.invalidate();
    return this;
  }

  zoom(delta) {
    this.cancelScheduledHover();
    this.setHoveredFace(null);
    const amount = Number(delta) || 0;
    this.camera.distance = clamp(this.camera.distance * Math.exp(amount), 4.5, 18);
    this.invalidate();
    return this;
  }

  resetCamera() {
    this.cancelScheduledHover();
    this.setHoveredFace(null);
    this.camera.target = [-0.35, 1.15, -0.25];
    this.camera.yaw = -0.72;
    this.camera.pitch = 0.38;
    this.camera.distance = 9.2;
    this.invalidate();
    return this;
  }

  pick(clientX, clientY) {
    const best = this.pickWorkpiece(clientX, clientY);
    this.setSelectedFace(best);
    return best;
  }

  pickWorkpiece(clientX, clientY) {
    const ray = this.screenRay(clientX, clientY);
    const dynamicHit = pickForgeMeshRay(this.dynamicMesh, ray, {
      offset: this.dynamicOffset,
      componentOffsets: this.componentVisualOffsetsEnabled ? this.componentVisualOffsets : null,
      pickBounds: this.workpieceGrouped ? this.dynamicComponentPickBounds : this.dynamicMesh.pickBounds,
    });
    if (!dynamicHit) return null;
    const staticHit = pickForgeMeshRay(this.staticMesh, ray);
    if (staticHit && staticHit.distance <= dynamicHit.distance + 1e-6) return null;
    return this.workpieceGrouped
      ? groupedForgeHit(dynamicHit, this.groupedWorkpieceBound())
      : dynamicHit;
  }

  setSelectedFace(hit = null) {
    const next = normalizeForgeHighlightHit(hit);
    const changed = !sameForgeHighlightedFace(this.selected, next);
    this.selected = next;
    if (changed) this.invalidate();
    return this;
  }

  setTransformTarget(index = -1) {
    const value = Number(index);
    const next = this.workpieceGrouped
      ? Number.isInteger(value) && value >= 0 && this.dynamicMesh.pickBounds?.length ? 0 : -1
      : Number.isInteger(value) && value >= 0
        && this.dynamicMesh.pickBounds?.some((bound) => bound.index === value)
        ? value
        : -1;
    if (next === this.transformTargetIndex) return this;
    this.transformTargetIndex = next;
    this.hoveredGizmoAxis = null;
    if (this.drag?.mode === "axis") this.cancelWorkpieceDrag(null);
    this.invalidate();
    return this;
  }

  setConstructionPreview(descriptor = null) {
    const next = normalizeConstructionPreview(descriptor);
    const changed = !sameConstructionPreview(this.constructionPreview, next);
    this.constructionPreview = next;
    if (changed && !this.hoverUpdateActive) this.invalidate();
    return this;
  }

  axisGizmoState() {
    if (this.activeTool !== "gloves" || !this.workpieceDragEnabled || this.transformTargetIndex < 0) return null;
    const bound = this.workpieceGrouped
      ? this.groupedWorkpieceBound()
      : this.dynamicMesh.pickBounds?.find((candidate) => candidate.index === this.transformTargetIndex);
    if (!bound) return null;
    const previewOffset = this.dragPreview?.index === bound.index ? this.dragPreview.deltaWorld : [0, 0, 0];
    const visualOffset = this.workpieceGrouped ? [0, 0, 0] : this.componentVisualOffset(bound.index);
    const center = bound.min.map((value, axis) => (
      (value + bound.max[axis]) * 0.5 + this.dynamicOffset[axis] + visualOffset[axis] + previewOffset[axis]
    ));
    return {
      index: bound.index,
      center,
      scale: this.worldScaleForPixels(center, FORGE_GIZMO_TARGET_PIXELS, 0.44, 2.4),
    };
  }

  pickTransformGizmo(clientX, clientY) {
    const state = this.axisGizmoState();
    if (!state) return null;
    const result = pickForgeAxisGizmoRay(this.screenRay(clientX, clientY), state);
    if (!result) return null;
    const selected = this.selected?.index === state.index ? cloneForgeHit(this.selected) : null;
    const visualOffset = this.workpieceGrouped ? [0, 0, 0] : this.componentVisualOffset(state.index);
    const previewOffset = this.dragPreview?.index === state.index ? this.dragPreview.deltaWorld : [0, 0, 0];
    return {
      ...result,
      index: state.index,
      center: [...state.center],
      scale: state.scale,
      hit: {
        ...(selected ?? {}),
        index: state.index,
        point: [...state.center],
        localPoint: state.center.map((value, axis) => (
          value
          - this.dynamicOffset[axis]
          - visualOffset[axis]
          - previewOffset[axis]
        )),
      },
    };
  }

  worldScaleForPixels(point, pixels, minimum = 0, maximum = Infinity) {
    const rect = this.canvas.getBoundingClientRect?.() ?? { height: this.canvas.clientHeight || 1 };
    const height = Math.max(1, Number(rect.height) || 1);
    const distance = Math.max(0.01, Math.sqrt(lengthSquared(subtract(point, cameraEye(this.camera)))));
    const visibleHeight = 2 * distance * Math.tan(this.camera.fov * Math.PI / 360);
    return clamp(visibleHeight * Math.max(1, Number(pixels) || 1) / height, minimum, maximum);
  }

  workpieceWorldPoint(localPoint, componentIndex = null) {
    const visualOffset = this.componentVisualOffset(componentIndex);
    const index = Number(componentIndex);
    const previewOffset = Number.isInteger(index) && this.dragPreview?.index === index
      ? this.dragPreview.deltaWorld
      : [0, 0, 0];
    return vector3(localPoint).map((value, axis) => (
      value + this.dynamicOffset[axis] + visualOffset[axis] + previewOffset[axis]
    ));
  }

  workpieceBaseOffset() {
    return [...this.options.workpieceOffset];
  }

  workpieceFloorLocalY(offset = this.dynamicOffset) {
    const workpieceOffset = vector3(offset);
    return Number.isFinite(this.workpieceFloorY) ? this.workpieceFloorY - workpieceOffset[1] : null;
  }

  constrainWorkpieceDragDelta(index, deltaWorld) {
    const delta = vector3(deltaWorld);
    const componentIndex = Number(index);
    const bound = this.workpieceGrouped
      ? this.groupedWorkpieceBound()
      : this.dynamicMesh.pickBounds?.find((candidate) => candidate.index === componentIndex);
    let minimumDeltaY = -Infinity;
    if (Number.isFinite(this.workpieceFloorY) && bound) {
      minimumDeltaY = Math.ceil(
        (this.workpieceFloorY - (bound.min[1] + this.dynamicOffset[1])) * FORGE_TRANSFORM_SNAP - 1e-7,
      ) / FORGE_TRANSFORM_SNAP;
      delta[1] = Math.max(delta[1], minimumDeltaY);
    }
    if (!this.workpieceDragConstraint) return delta;
    const constrained = finiteVector3OrNull(this.workpieceDragConstraint(componentIndex, [...delta], this));
    if (!constrained) return delta;
    constrained[1] = Math.max(constrained[1], minimumDeltaY);
    return constrained;
  }

  setHoveredFace(hit = null, { immediate = false, gizmoAxis = null } = {}) {
    const next = normalizeForgeHighlightHit(hit);
    const nextToolPreview = this.activeTool === "gloves" ? null : normalizeForgeToolVisualHit(hit);
    const changed = !sameForgeHighlightedFace(this.hovered, next);
    const aimChanged = this.activeTool !== "gloves" && !sameForgeToolVisualHit(this.hovered, next);
    const previousToolPreview = this.toolPreview;
    const previousConstructionPreview = this.constructionPreview;
    const normalizedGizmoAxis = normalizeOptionalAxis(gizmoAxis);
    const gizmoChanged = normalizedGizmoAxis !== this.hoveredGizmoAxis;
    const clearConstruction = (!next || this.activeTool === "gloves") && Boolean(this.constructionPreview);
    this.hovered = next;
    this.toolPreview = nextToolPreview;
    this.hoveredGizmoAxis = normalizedGizmoAxis;
    if (clearConstruction) this.constructionPreview = null;
    if (changed || aimChanged || gizmoChanged || clearConstruction) {
      this.canvas.style.cursor = normalizedGizmoAxis == null ? "default" : "grab";
      this.hoverUpdateActive = true;
      try {
        this.onHover?.({
          hit: cloneForgeHit(next),
          gizmoAxis: normalizedGizmoAxis,
        });
      } finally {
        this.hoverUpdateActive = false;
      }
      const toolPreviewChanged = !sameForgeToolVisualHit(previousToolPreview, this.toolPreview);
      const constructionChanged = !sameConstructionPreview(previousConstructionPreview, this.constructionPreview);
      if (!changed && !toolPreviewChanged && !gizmoChanged && !constructionChanged) return this;
      if (immediate && !this.framePending && !this.disposed && !this.contextLost) this.render();
      else this.invalidate();
    }
    return this;
  }

  setWorkpieceDragEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.workpieceDragEnabled) return this;
    this.workpieceDragEnabled = next;
    if (!next && this.drag?.hit && this.drag.workpieceDragEnabled && !this.drag.cancelled) {
      this.cancelWorkpieceDrag(null);
    }
    if (!next && this.hoveredGizmoAxis != null) this.setHoveredFace(this.hovered, { gizmoAxis: null });
    this.invalidate();
    return this;
  }

  setActiveTool(toolId, settings = {}) {
    const nextTool = normalizeForgeToolVisualId(toolId, "gloves");
    const changed = nextTool !== this.activeTool;
    this.activeTool = nextTool;
    this.activeToolSettings = cloneToolSettings(settings);
    if (changed) {
      this.toolPreview = null;
      this.toolAction = null;
      this.constructionPreview = null;
      this.hoveredGizmoAxis = null;
      this.canvas.style.cursor = "default";
    }
    if (changed || this.toolPreview || this.toolAction) this.invalidate();
    return this;
  }

  setToolPreview(hit = null, settings = null) {
    const next = this.activeTool === "gloves" ? null : normalizeForgeToolVisualHit(hit);
    const changed = !sameForgeToolVisualHit(this.toolPreview, next);
    if (settings != null) this.activeToolSettings = cloneToolSettings(settings);
    this.toolPreview = next;
    if ((changed || settings != null) && !this.hoverUpdateActive) this.invalidate();
    return this;
  }

  playToolAction(input = {}, hit = null, settings = null) {
    const descriptor = typeof input === "string"
      ? { toolId: input, hit, settings }
      : input ?? {};
    const toolId = normalizeForgeToolVisualId(descriptor.toolId ?? descriptor.tool ?? this.activeTool, "gloves");
    const target = normalizeForgeToolVisualHit(descriptor.hit ?? this.toolPreview);
    if (toolId === "gloves" || !target || !this.toolMeshes.has(toolId)) return null;
    const actionSettings = {
      ...cloneToolSettings(this.activeToolSettings),
      ...cloneToolSettings(descriptor.settings ?? descriptor.options),
    };
    const duration = forgeToolActionDuration(toolId, {
      ...actionSettings,
      durationSeconds: descriptor.durationSeconds ?? descriptor.duration,
    });
    const id = this.nextToolActionId++;
    this.activeTool = toolId;
    this.activeToolSettings = actionSettings;
    this.toolPreview = null;
    this.toolAction = {
      id,
      toolId,
      hit: target,
      settings: actionSettings,
      cameraEye: cameraEye(this.camera),
      startTime: nowMilliseconds(),
      duration,
    };
    this.invalidate();
    return id;
  }

  cancelToolAction(actionId = null) {
    if (!this.toolAction || actionId != null && this.toolAction.id !== actionId) return false;
    const action = this.toolAction;
    this.toolAction = null;
    this.invalidate();
    this.notifyToolActionEnd(action, true);
    return true;
  }

  toolVisualState(timestamp = nowMilliseconds()) {
    const action = this.toolAction;
    if (action) {
      const elapsed = Math.max(0, (Number(timestamp) - action.startTime) / 1000);
      if (elapsed >= action.duration) {
        this.toolAction = null;
        this.notifyToolActionEnd(action, false);
        return null;
      }
      return sampleForgeToolVisualPose(action.toolId, {
        hit: action.hit,
        settings: action.settings,
        cameraEye: action.cameraEye,
        elapsedSeconds: elapsed,
        durationSeconds: action.duration,
      });
    }
    if (!this.toolPreview || this.activeTool === "gloves") return null;
    return sampleForgeToolVisualPose(this.activeTool, {
      hit: this.toolPreview,
      settings: this.activeToolSettings,
      cameraEye: cameraEye(this.camera),
      elapsedSeconds: 0,
      durationSeconds: forgeToolActionDuration(this.activeTool, this.activeToolSettings),
      preview: true,
    });
  }

  constructionVisualState() {
    const preview = this.constructionPreview;
    if (!preview || this.activeTool === "gloves") return null;
    const normal = [...preview.normal];
    const tangentAxes = [0, 1, 2].filter((axis) => axis !== preview.axis);
    const tangentA = [0, 0, 0];
    const tangentB = [0, 0, 0];
    tangentA[tangentAxes[0]] = 1;
    tangentB[tangentAxes[1]] = preview.side ? 1 : -1;
    const scale = this.worldScaleForPixels(preview.point, FORGE_RETICLE_TARGET_PIXELS, 0.12, 0.72);
    return {
      basis: basisColumns(
        tangentA.map((value) => value * scale),
        tangentB.map((value) => value * scale),
        normal.map((value) => value * scale),
      ),
      translation: preview.point.map((value, axis) => value + normal[axis] * Math.max(0.008, scale * 0.025)),
      opacity: 0.96,
      unlit: 1,
      ...(preview.toolId === "grip" && preview.valid != null ? {
        tint: preview.valid ? [0.25, 1, 0.53] : [1, 0.36, 0.30],
        tintMix: 0.9,
      } : {}),
    };
  }

  notifyToolActionEnd(action, cancelled) {
    if (!action || !this.onToolActionEnd) return;
    this.onToolActionEnd({
      id: action.id,
      toolId: action.toolId,
      hit: cloneForgeHit(action.hit),
      cancelled: Boolean(cancelled),
    });
  }

  intersectHorizontalPlane(clientX, clientY, planeY) {
    const ray = this.screenRay(clientX, clientY);
    const denominator = ray.direction[1];
    if (Math.abs(denominator) < 1e-7) return null;
    const distance = (Number(planeY) - ray.origin[1]) / denominator;
    if (!Number.isFinite(distance) || distance < 0) return null;
    return ray.origin.map((value, axis) => value + ray.direction[axis] * distance);
  }

  screenRay(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: this.canvas.clientWidth || 1, height: this.canvas.clientHeight || 1 };
    const width = Math.max(1, rect.width || 1);
    const height = Math.max(1, rect.height || 1);
    const ndcX = ((Number(clientX) - rect.left) / width) * 2 - 1;
    const ndcY = 1 - ((Number(clientY) - rect.top) / height) * 2;
    const origin = cameraEye(this.camera);
    const forward = normalize3(subtract(this.camera.target, origin));
    let right = normalize3(cross(forward, [0, 1, 0]));
    if (lengthSquared(right) < 0.000001) right = [1, 0, 0];
    const up = normalize3(cross(right, forward));
    const halfHeight = Math.tan(this.camera.fov * Math.PI / 360);
    const halfWidth = halfHeight * width / height;
    return {
      origin,
      direction: normalize3([
        forward[0] + right[0] * ndcX * halfWidth + up[0] * ndcY * halfHeight,
        forward[1] + right[1] * ndcX * halfWidth + up[1] * ndcY * halfHeight,
        forward[2] + right[2] * ndcX * halfWidth + up[2] * ndcY * halfHeight,
      ]),
    };
  }

  clampedDpr(value = null) {
    if (Number.isFinite(this.options.dpr)) return Math.max(0.5, this.options.dpr);
    const raw = Number.isFinite(value) ? Number(value) : (globalThis.devicePixelRatio || 1);
    const coarse = globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    return Math.min(Math.max(0.75, raw), coarse ? this.options.maxMobileDpr : this.options.maxDesktopDpr);
  }

  resize() {
    if (!this.gl) return false;
    const rect = this.canvas.getBoundingClientRect?.() ?? { width: this.canvas.clientWidth || 1, height: this.canvas.clientHeight || 1 };
    const dpr = this.clampedDpr();
    const width = Math.max(1, Math.floor((rect.width || 1) * dpr));
    const height = Math.max(1, Math.floor((rect.height || 1) * dpr));
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
    return true;
  }

  invalidate() {
    if (this.disposed || this.contextLost || this.framePending) return false;
    this.framePending = true;
    this.raf = requestFrame((timestamp) => {
      this.raf = 0;
      this.framePending = false;
      if (!this.disposed && !this.contextLost) {
        this.render(timestamp);
        if (this.toolAction) this.invalidate();
        else this.scheduleClothFrame();
      }
    });
    return true;
  }

  scheduleClothFrame() {
    if (this.clothFrameTimer
      || (!this.clothComponentMask && !this.avatar.clothAnimated)
      || this.disposed
      || this.contextLost
      || globalThis.document?.hidden) return false;
    const interval = this.reducedMotion ? 100 : 33;
    this.clothFrameTimer = globalThis.setTimeout?.(() => {
      this.clothFrameTimer = 0;
      this.invalidate();
    }, interval) ?? 0;
    return Boolean(this.clothFrameTimer);
  }

  render(timestamp = nowMilliseconds()) {
    if (this.disposed || this.contextLost) return this.lastStats;
    if (!this.initialized) this.init();
    if (!this.gl || this.contextLost) return this.lastStats;
    const gl = this.gl;
    this.resize();
    const aspect = Math.max(1, this.canvas.width) / Math.max(1, this.canvas.height);
    const eye = cameraEye(this.camera);
    const projection = mat4Perspective(this.camera.fov * Math.PI / 180, aspect, this.camera.near, this.camera.far);
    const view = mat4LookAt(eye, this.camera.target, [0, 1, 0]);
    const viewProjection = mat4Multiply(projection, view);
    const clear = this.options.clearColor;
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjection);
    gl.uniform1f(this.uniforms.exposure, this.options.exposure);
    gl.uniform1f(this.uniforms.materialTileScale, this.options.materialTileScale);
    gl.uniform1f(this.uniforms.timeSeconds, Number(timestamp) / 1_000);
    gl.uniform1f(this.uniforms.clothMotionScale, this.reducedMotion ? 0.28 : 1);
    gl.uniform1i(this.uniforms.materialTextureArray, 0);
    gl.uniform1i(this.uniforms.materialTextureEnabled, this.materialTextureArray?.layerCount ? 1 : 0);
    gl.uniform1i(this.uniforms.materialLayerCount, this.materialTextureArray?.layerCount ?? 0);
    this.materialTextureArray?.bind?.(0);
    gl.uniform3fv(this.uniforms.fogColor, this.options.fogColor);
    gl.uniform2f(this.uniforms.fogNearFar, this.options.fogNear, this.options.fogFar);
    gl.uniform3fv(this.uniforms.lightDirection, this.options.lightDirection);
    gl.uniform3fv(this.uniforms.ambientColor, this.options.ambientColor);
    gl.uniform3fv(this.uniforms.keyLightColor, this.options.keyLightColor);
    setObjectVisualUniforms(gl, this.uniforms, null);
    let drawCalls = 0;
    let triangles = 0;
    setForgeHighlightUniforms(gl, this.uniforms, null, null);
    gl.uniform1i(this.uniforms.componentVisualOffsetsEnabled, 0);
    gl.uniform1i(this.uniforms.dragComponentIndex, FORGE_DRAG_COMPONENT_NONE);
    gl.uniform3f(this.uniforms.dragOffset, 0, 0, 0);
    setUniformUint(gl, this.uniforms.clothComponentMask, 0);
    if (drawHandle(gl, this.uniforms.offset, this.staticHandle, [0, 0, 0])) {
      drawCalls += 1;
      triangles += this.staticHandle.triangleCount;
    }
    this.updateSceneAvatarAnimation(timestamp);
    if (this.avatarHandle?.indexCount) {
      setObjectVisualUniforms(gl, this.uniforms, { basis: avatarYawBasis(this.avatar.yaw) });
      gl.disable(gl.CULL_FACE);
      if (drawHandle(gl, this.uniforms.offset, this.avatarHandle, this.avatar.position)) {
        drawCalls += 1;
        triangles += this.avatarHandle.triangleCount;
      }
      gl.enable(gl.CULL_FACE);
      setObjectVisualUniforms(gl, this.uniforms, null);
    }
    const dragPreview = this.dragPreview;
    setForgeHighlightUniforms(gl, this.uniforms, this.selected, this.hovered);
    gl.uniform1i(this.uniforms.componentVisualOffsetsEnabled, this.componentVisualOffsetsEnabled ? 1 : 0);
    if (this.componentVisualOffsetsEnabled) {
      gl.uniform3fv(this.uniforms.componentVisualOffsets, this.componentVisualOffsets);
    }
    gl.uniform1i(
      this.uniforms.dragComponentIndex,
      dragPreview ? (this.workpieceGrouped ? FORGE_DRAG_ALL_COMPONENTS : dragPreview.index) : FORGE_DRAG_COMPONENT_NONE,
    );
    gl.uniform3fv(this.uniforms.dragOffset, dragPreview?.deltaWorld ?? [0, 0, 0]);
    if (this.clothComponentMask) {
      gl.uniform3fv(this.uniforms.clothComponentMin, this.clothComponentMin);
      gl.uniform3fv(this.uniforms.clothComponentMax, this.clothComponentMax);
    }
    setUniformUint(gl, this.uniforms.clothComponentMask, this.clothComponentMask);
    if (drawHandle(gl, this.uniforms.offset, this.dynamicHandle, this.dynamicOffset)) {
      drawCalls += 1;
      triangles += this.dynamicHandle.triangleCount;
    }
    const overlayPasses = [];
    const gizmo = this.axisGizmoState();
    if (gizmo && this.guideHandles.transform?.indexCount) {
      overlayPasses.push({
        handle: this.guideHandles.transform,
        visual: {
          basis: scaledIdentityBasis(gizmo.scale),
          translation: gizmo.center,
          opacity: 0.98,
          unlit: 1,
        },
      });
    }
    const toolVisual = this.toolVisualState(timestamp);
    const toolHandle = toolVisual ? this.toolHandles.get(toolVisual.toolId) : null;
    if (toolHandle?.indexCount) overlayPasses.push({ handle: toolHandle, visual: toolVisual });
    const constructionVisual = this.constructionVisualState();
    if (constructionVisual && this.guideHandles.reticle?.indexCount) {
      // Keep the snapped target readable even when a large tool model crosses it.
      overlayPasses.push({ handle: this.guideHandles.reticle, visual: constructionVisual });
    }
    if (overlayPasses.length) {
      setForgeHighlightUniforms(gl, this.uniforms, null, null);
      gl.uniform1i(this.uniforms.componentVisualOffsetsEnabled, 0);
      gl.uniform1i(this.uniforms.dragComponentIndex, FORGE_DRAG_COMPONENT_NONE);
      gl.uniform3f(this.uniforms.dragOffset, 0, 0, 0);
      setUniformUint(gl, this.uniforms.clothComponentMask, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const pass of overlayPasses) {
        setObjectVisualUniforms(gl, this.uniforms, pass.visual);
        if (drawHandle(gl, this.uniforms.offset, pass.handle, pass.visual.translation)) {
          drawCalls += 1;
          triangles += pass.handle.triangleCount;
        }
      }
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      setObjectVisualUniforms(gl, this.uniforms, null);
    }
    gl.bindVertexArray(null);
    this.drawCount += 1;
    this.lastStats = {
      backend: "webgl2",
      onDemand: true,
      frames: this.drawCount,
      drawCalls,
      triangles,
      bufferMemory: (this.staticHandle?.byteLength || 0)
        + (this.dynamicHandle?.byteLength || 0)
        + (this.avatarHandle?.byteLength || 0)
        + sumHandleBytes(this.toolHandles)
        + sumHandleBytes(Object.values(this.guideHandles)),
      textureMemory: (this.materialTextureArray?.layerCount || 0)
        * this.options.materialTextureTileSize
        * this.options.materialTextureTileSize
        * 4,
      materialLayers: this.materialTextureArray?.layerCount || 0,
      width: this.canvas.width,
      height: this.canvas.height,
      dpr: this.clampedDpr(),
    };
    return this.lastStats;
  }

  attachControls() {
    if (this.controlsAttached) return this;
    this.controlsAttached = true;
    this.canvas.style.touchAction = "none";
    this.canvas.addEventListener("pointerdown", this._onPointerDown);
    this.canvas.addEventListener("pointermove", this._onPointerMove);
    this.canvas.addEventListener("pointerup", this._onPointerUp);
    this.canvas.addEventListener("pointercancel", this._onPointerCancel);
    this.canvas.addEventListener("pointerleave", this._onPointerLeave);
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
    return this;
  }

  detachControls() {
    if (!this.controlsAttached) return this;
    this.controlsAttached = false;
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    this.canvas.removeEventListener("pointermove", this._onPointerMove);
    this.canvas.removeEventListener("pointerup", this._onPointerUp);
    this.canvas.removeEventListener("pointercancel", this._onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this._onPointerLeave);
    this.canvas.removeEventListener("wheel", this._onWheel);
    this.resetPointerInteraction(null, { notifyCancel: true });
    return this;
  }

  scheduleHover(clientX, clientY, pointerType = "mouse") {
    if (pointerType === "touch" || this.disposed || this.contextLost) {
      if (pointerType === "touch") this.setHoveredFace(null);
      return;
    }
    const x = Number(clientX);
    const y = Number(clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.hoverPoint = { x, y };
    if (this.hoverRaf) return;
    this.hoverRaf = requestFrame(() => {
      this.hoverRaf = 0;
      const point = this.hoverPoint;
      this.hoverPoint = null;
      if (!point || this.disposed || this.contextLost || this.pointers.size) return;
      const gizmo = this.pickTransformGizmo(point.x, point.y);
      const hit = gizmo ? null : this.pickWorkpiece(point.x, point.y);
      this.setHoveredFace(hit, { immediate: true, gizmoAxis: gizmo?.axis ?? null });
    });
  }

  cancelScheduledHover() {
    this.hoverPoint = null;
    if (!this.hoverRaf) return;
    cancelFrame(this.hoverRaf);
    this.hoverRaf = 0;
  }

  pointerLeave() {
    this.cancelScheduledHover();
    this.setHoveredFace(null);
  }

  resetPointerInteraction(event = null, { notifyCancel = true } = {}) {
    const drag = this.drag;
    try {
      if (notifyCancel && drag?.hit && drag.workpieceDragEnabled && !drag.cancelled) {
        this.notifyWorkpieceDrag("cancel", drag, event);
      }
    } finally {
      for (const pointerId of this.pointers.keys()) {
        try {
          const hasCapture = typeof this.canvas.hasPointerCapture === "function"
            ? this.canvas.hasPointerCapture(pointerId)
            : true;
          if (hasCapture) this.canvas.releasePointerCapture?.(pointerId);
        } catch {
          // Pointer capture may already have been released by the browser.
        }
      }
      const hadPreview = Boolean(this.dragPreview);
      this.pointers.clear();
      this.drag = null;
      this.dragPreview = null;
      this.pinchDistance = 0;
      this.cancelScheduledHover();
      this.setHoveredFace(null);
      if (hadPreview) this.invalidate();
    }
  }

  pointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    this.cancelScheduledHover();
    this.setHoveredFace(null);
    this.canvas.setPointerCapture?.(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    const firstPointer = this.pointers.size === 0;
    this.pointers.set(event.pointerId, point);
    if (firstPointer) {
      let gizmo = this.pickTransformGizmo(point.x, point.y);
      let hit = gizmo?.hit ?? this.pick(point.x, point.y);
      let axisPlaneNormal = null;
      let startAxisValue = null;
      let startPoint = null;
      if (gizmo) {
        const axisVector = unitAxis(gizmo.axis);
        axisPlaneNormal = forgeAxisDragPlaneNormal(axisVector, subtract(cameraEye(this.camera), gizmo.center));
        startPoint = axisPlaneNormal
          ? intersectRayPlane(this.screenRay(point.x, point.y), gizmo.center, axisPlaneNormal)
          : null;
        if (startPoint) startAxisValue = dot(subtract(startPoint, gizmo.center), axisVector);
        if (!Number.isFinite(startAxisValue)) {
          gizmo = null;
          hit = this.pick(point.x, point.y);
          axisPlaneNormal = null;
          startAxisValue = null;
          startPoint = null;
        }
      }
      if (!gizmo && hit) {
        startPoint = this.intersectHorizontalPlane(point.x, point.y, hit.point[1]) ?? [...hit.point];
      }
      this.setHoveredFace(gizmo ? null : hit, { gizmoAxis: gizmo?.axis ?? null });
      this.drag = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        x: point.x,
        y: point.y,
        moved: false,
        cancelled: false,
        hit,
        mode: gizmo ? "axis" : "free",
        axis: gizmo?.axis ?? null,
        axisOrigin: gizmo ? [...gizmo.center] : null,
        axisPlaneNormal,
        startAxisValue,
        planeY: hit?.point?.[1] ?? null,
        startPoint,
        point: startPoint,
        deltaWorld: [0, 0, 0],
        workpieceDragEnabled: this.workpieceDragEnabled,
      };
      if (hit && this.drag.workpieceDragEnabled) this.notifyWorkpieceDrag("start", this.drag, event);
    }
    if (this.pointers.size === 2) {
      this.cancelWorkpieceDrag(event);
      this.pinchDistance = pointerPairDistance(this.pointers);
    }
  }

  pointerMove(event) {
    if (!this.pointers.has(event.pointerId)) {
      this.scheduleHover(event.clientX, event.clientY, event.pointerType);
      return;
    }
    const previous = this.pointers.get(event.pointerId);
    const next = { x: event.clientX, y: event.clientY };
    this.pointers.set(event.pointerId, next);
    if (this.pointers.size >= 2) {
      this.setHoveredFace(null);
      const distance = pointerPairDistance(this.pointers);
      if (this.pinchDistance > 0 && distance > 0) this.zoom(Math.log(this.pinchDistance / distance));
      this.pinchDistance = distance;
      if (this.drag) this.drag.moved = true;
      return;
    }
    if (this.drag?.pointerId !== event.pointerId) return;
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    if (this.drag) {
      this.drag.x = next.x;
      this.drag.y = next.y;
      const coarse = event.pointerType === "touch" || (globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false);
      this.drag.moved ||= Math.hypot(next.x - this.drag.startX, next.y - this.drag.startY) > (coarse ? 8 : 4);
    }
    if (this.drag && !this.drag.workpieceDragEnabled && this.activeTool !== "gloves") {
      const aimHit = this.pickWorkpiece(next.x, next.y);
      this.setHoveredFace(aimHit, { immediate: true });
      return;
    }
    if (this.drag?.hit) {
      if (!this.drag.workpieceDragEnabled || this.drag.cancelled) return;
      if (!this.drag.moved) return;
      if (this.drag.mode === "axis") {
        const ray = this.screenRay(next.x, next.y);
        const axisPoint = intersectRayPlane(ray, this.drag.axisOrigin, this.drag.axisPlaneNormal);
        if (!axisPoint) return;
        const axisVector = unitAxis(this.drag.axis);
        const axisValue = dot(subtract(axisPoint, this.drag.axisOrigin), axisVector);
        const amount = Math.round((axisValue - this.drag.startAxisValue) * FORGE_TRANSFORM_SNAP) / FORGE_TRANSFORM_SNAP;
        const deltaWorld = this.constrainWorkpieceDragDelta(
          this.drag.hit.index,
          axisVector.map((value) => value * amount),
        );
        if (vectorsNearlyEqual(deltaWorld, this.drag.deltaWorld)) return;
        this.drag.point = axisPoint;
        this.drag.deltaWorld = deltaWorld;
        this.dragPreview = { index: this.drag.hit.index, deltaWorld: [...deltaWorld] };
        this.canvas.style.cursor = "grabbing";
        this.notifyWorkpieceDrag("move", this.drag, event);
        this.invalidate();
        return;
      }
      const planePoint = this.intersectHorizontalPlane(next.x, next.y, this.drag.planeY);
      if (!planePoint || !this.drag.startPoint) return;
      const deltaWorld = this.constrainWorkpieceDragDelta(this.drag.hit.index, [
        planePoint[0] - this.drag.startPoint[0],
        0,
        planePoint[2] - this.drag.startPoint[2],
      ]);
      if (vectorsNearlyEqual(deltaWorld, this.drag.deltaWorld)) return;
      this.drag.point = planePoint;
      this.drag.deltaWorld = deltaWorld;
      this.dragPreview = { index: this.drag.hit.index, deltaWorld: [...deltaWorld] };
      this.notifyWorkpieceDrag("move", this.drag, event);
      this.invalidate();
      return;
    }
    this.orbit(-dx * 0.008, dy * 0.005);
  }

  pointerUp(event) {
    const drag = this.drag?.pointerId === event.pointerId ? this.drag : null;
    this.pointers.delete(event.pointerId);
    this.canvas.releasePointerCapture?.(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    if (drag) {
      try {
        if (drag.workpieceDragEnabled) {
          if (drag.hit && !drag.cancelled && drag.moved) this.notifyWorkpieceDrag("end", drag, event);
          else if (!drag.cancelled && !drag.moved) this.onPick?.(drag.hit, event);
        } else if (!drag.cancelled) {
          const releaseHit = this.pickWorkpiece(event.clientX, event.clientY);
          this.setSelectedFace(releaseHit);
          this.setHoveredFace(releaseHit, { immediate: true });
          this.onPick?.(releaseHit, event);
        }
      } finally {
        this.dragPreview = null;
        this.drag = null;
        this.canvas.style.cursor = this.hoveredGizmoAxis == null ? "default" : "grab";
        this.invalidate();
      }
    }
    if (event.pointerType !== "touch" && this.pointers.size === 0) {
      this.scheduleHover(event.clientX, event.clientY, event.pointerType);
    }
  }

  pointerCancel(event) {
    const drag = this.drag?.pointerId === event.pointerId ? this.drag : null;
    this.pointers.delete(event.pointerId);
    this.canvas.releasePointerCapture?.(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    if (!drag) return;
    try {
      if (drag.hit && drag.workpieceDragEnabled && !drag.cancelled) this.notifyWorkpieceDrag("cancel", drag, event);
    } finally {
      this.dragPreview = null;
      this.drag = null;
      this.canvas.style.cursor = "default";
      this.setHoveredFace(null);
      this.invalidate();
    }
  }

  cancelWorkpieceDrag(event) {
    if (!this.drag || this.drag.cancelled) return;
    this.drag.cancelled = true;
    this.drag.moved = true;
    this.dragPreview = null;
    if (this.drag.hit && this.drag.workpieceDragEnabled) this.notifyWorkpieceDrag("cancel", this.drag, event);
    this.invalidate();
  }

  notifyWorkpieceDrag(phase, drag, event) {
    this.onWorkpieceDrag?.({
      phase,
      hit: drag.hit,
      startPoint: drag.startPoint ? [...drag.startPoint] : null,
      point: drag.point ? [...drag.point] : null,
      deltaWorld: [...drag.deltaWorld],
      mode: drag.mode,
      axis: drag.axis,
    }, event);
  }

  wheel(event) {
    event.preventDefault();
    this.zoom(clamp(event.deltaY * 0.0015, -0.35, 0.35));
  }

  observeResize() {
    if (this.resizeObserver || typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(this._onResize);
    this.resizeObserver.observe(this.canvas);
  }

  snapshot() {
    return {
      ...this.lastStats,
      camera: { ...this.camera, target: [...this.camera.target] },
      workpieceOffset: [...this.dynamicOffset],
      workpieceBaseOffset: this.workpieceBaseOffset(),
      workpieceFloorY: this.workpieceFloorY,
      workpieceFloorLocalY: this.workpieceFloorLocalY(),
      selected: cloneForgeHit(this.selected),
      hovered: cloneForgeHit(this.hovered),
      transformTargetIndex: this.transformTargetIndex,
      hoveredGizmoAxis: this.hoveredGizmoAxis,
      axisGizmo: cloneAxisGizmoState(this.axisGizmoState()),
      constructionPreview: cloneConstructionPreview(this.constructionPreview),
      workpieceDragEnabled: this.workpieceDragEnabled,
      workpieceGrouped: this.workpieceGrouped,
      componentVisualOffsets: this.componentVisualOffsetsEnabled
        ? cloneComponentVisualOffsets(this.componentVisualOffsets, this.componentVisualOffsetLength)
        : null,
      componentMaterialIds: [...this.componentMaterialIds],
      materialIds: [...(this.materialSurfaceSet?.materialIds ?? [])],
      materialRuleSet: this.forgeMaterialCatalog?.ruleSet ?? "",
      materialCatalogSize: this.forgeMaterialCatalog?.materialIds?.length ?? 0,
      clothComponentCount: this.clothComponentCount,
      clothAnimationFps: this.clothComponentMask ? (this.reducedMotion ? 10 : 30) : 0,
      avatar: this.avatarPreviewSnapshot(),
      dragPreview: this.dragPreview ? {
        index: this.dragPreview.index,
        deltaWorld: [...this.dragPreview.deltaWorld],
        axis: this.drag?.axis ?? null,
      } : null,
      activeTool: this.activeTool,
      toolPreview: cloneForgeHit(this.toolPreview),
      toolAction: this.toolAction ? {
        id: this.toolAction.id,
        toolId: this.toolAction.toolId,
        hit: cloneForgeHit(this.toolAction.hit),
        duration: this.toolAction.duration,
        startTime: this.toolAction.startTime,
      } : null,
      staticTriangles: this.staticMesh.triangleCount,
      dynamicTriangles: this.dynamicMesh.triangleCount,
      avatarTriangles: this.avatarHandle?.triangleCount ?? 0,
      toolTriangles: Array.from(this.toolMeshes.values()).reduce((sum, mesh) => sum + (mesh?.triangleCount || 0), 0),
      guideTriangles: Object.values(this.guideMeshes).reduce((sum, mesh) => sum + (mesh?.triangleCount || 0), 0),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.detachControls();
    this.cancelScheduledHover();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.raf) cancelFrame(this.raf);
    this.raf = 0;
    if (this.clothFrameTimer) globalThis.clearTimeout?.(this.clothFrameTimer);
    this.clothFrameTimer = 0;
    this.framePending = false;
    if (this.gl) {
      this.materialTextureArray?.dispose?.();
      disposeHandle(this.gl, this.staticHandle);
      disposeHandle(this.gl, this.dynamicHandle);
      disposeHandle(this.gl, this.avatarHandle);
      for (const handle of this.toolHandles.values()) disposeHandle(this.gl, handle);
      for (const handle of Object.values(this.guideHandles)) disposeHandle(this.gl, handle);
      if (this.program) this.gl.deleteProgram(this.program);
    }
    this.canvas.removeEventListener("webglcontextlost", this._onContextLost, false);
    this.canvas.removeEventListener("webglcontextrestored", this._onContextRestored, false);
    globalThis.document?.removeEventListener?.("visibilitychange", this._onVisibilityChange);
    this.staticHandle = null;
    this.dynamicHandle = null;
    this.avatarHandle = null;
    this.toolHandles = new Map();
    this.guideHandles = { transform: null, reticle: null };
    this.materialTextureArray = null;
    this.materialTextureSignature = null;
    this.materialSurfaceSet = activeForgeMaterialSurfaceSet([], {
      catalog: this.forgeMaterialCatalog,
    });
    this.componentMaterialIds = [];
    this.program = null;
    this.gl = null;
    this.selected = null;
    this.hovered = null;
    this.toolPreview = null;
    this.toolAction = null;
    this.constructionPreview = null;
    this.componentVisualOffsets.fill(0);
    this.componentVisualOffsetLength = 0;
    this.componentVisualOffsetsEnabled = false;
    this.dynamicComponentPickBounds = [];
    this.workpieceDragConstraint = null;
    this.initialized = false;
  }
}

export function createForgeTransformGizmoMesh() {
  const cuboids = [
    { id: "axis-origin", center: [0, 0, 0], size: [0.16, 0.16, 0.16], color444: 0xfff, userData: { kind: "axis-origin" } },
  ];
  const colors = [0xf44, 0x4d6, 0x49f];
  for (let axis = 0; axis < 3; axis += 1) {
    const shaftCenter = [0, 0, 0];
    const shaftSize = [0.07, 0.07, 0.07];
    const headCenter = [0, 0, 0];
    const headSize = [0.22, 0.22, 0.22];
    shaftCenter[axis] = 0.57;
    shaftSize[axis] = 0.98;
    headCenter[axis] = 1.15;
    cuboids.push(
      { id: `axis-${axis}-shaft`, center: shaftCenter, size: shaftSize, color444: colors[axis], userData: { kind: "axis", axis } },
      { id: `axis-${axis}-head`, center: headCenter, size: headSize, color444: colors[axis], userData: { kind: "axis", axis } },
    );
  }
  return buildForgeCuboidMesh(cuboids);
}

export function createForgeConstructionReticleMesh() {
  return buildForgeCuboidMesh([
    { id: "reticle-left", center: [-0.58, 0, 0], size: [0.62, 0.075, 0.04], color444: 0xff3 },
    { id: "reticle-right", center: [0.58, 0, 0], size: [0.62, 0.075, 0.04], color444: 0xff3 },
    { id: "reticle-down", center: [0, -0.58, 0], size: [0.075, 0.62, 0.04], color444: 0xff3 },
    { id: "reticle-up", center: [0, 0.58, 0], size: [0.075, 0.62, 0.04], color444: 0xff3 },
    { id: "reticle-center", center: [0, 0, 0], size: [0.14, 0.14, 0.055], color444: 0xfff },
  ]);
}

export function pickForgeAxisGizmoRay(ray, state, { radiusScale = 0.16 } = {}) {
  const center = vector3(state?.center);
  const scale = Number(state?.scale);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const origin = vector3(ray?.origin);
  const direction = direction3(ray?.direction, [0, 0, -1]);
  let best = null;
  for (let axis = 0; axis < 3; axis += 1) {
    const axisVector = unitAxis(axis);
    const start = center.map((value, coordinate) => value + axisVector[coordinate] * scale * 0.04);
    const end = center.map((value, coordinate) => value + axisVector[coordinate] * scale * 1.3);
    const closest = closestRaySegment(origin, direction, start, end);
    if (!closest || closest.distance > scale * radiusScale) continue;
    if (best && closest.distance >= best.distance) continue;
    best = {
      axis,
      distance: closest.distance,
      rayDistance: closest.rayDistance,
      axisParameter: closest.segmentParameter * scale * 1.26 + scale * 0.04,
    };
  }
  return best;
}

export function forgeAxisDragPlaneNormal(axisVector, eyeOffset) {
  const axis = direction3(axisVector, [1, 0, 0]);
  const view = direction3(eyeOffset, [0, 0, 1]);
  const projected = view.map((value, coordinate) => value - axis[coordinate] * dot(view, axis));
  return lengthSquared(projected) < 1e-6 ? null : normalize3(projected);
}

export function intersectRayPlane(ray, point, normal) {
  if (!normal) return null;
  const origin = vector3(ray?.origin);
  const direction = direction3(ray?.direction, [0, 0, -1]);
  const planePoint = vector3(point);
  const planeNormal = direction3(normal, [0, 1, 0]);
  const denominator = dot(direction, planeNormal);
  if (Math.abs(denominator) < 1e-7) return null;
  const distance = dot(subtract(planePoint, origin), planeNormal) / denominator;
  if (!Number.isFinite(distance) || distance < 0) return null;
  return origin.map((value, axis) => value + direction[axis] * distance);
}

export function createForgeWorkbenchRenderer(canvas, options = {}) {
  return new ForgeWorkbenchRenderer(canvas, options).init();
}

export function pickForgeMeshRay(mesh, ray, {
  offset = [0, 0, 0],
  componentOffsets = null,
  pickBounds = mesh?.pickBounds,
} = {}) {
  if (!mesh?.vertices || !mesh?.indices || !Array.isArray(pickBounds)) return null;
  const origin = vector3(ray?.origin);
  const direction = direction3(ray?.direction, [0, 0, -1]);
  const meshOffset = vector3(offset);
  const view = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  let best = null;
  for (const bound of pickBounds) {
    const componentOffset = componentVisualOffsetAt(componentOffsets, bound.index);
    const boundOffset = meshOffset.map((value, axis) => value + componentOffset[axis]);
    const min = bound.min.map((value, axis) => value + boundOffset[axis]);
    const max = bound.max.map((value, axis) => value + boundOffset[axis]);
    if (rayAabbDistance(origin, direction, min, max) == null) continue;
    const firstIndex = Math.max(0, Number(bound.firstIndex) || 0);
    const indexCount = Math.max(0, Number(bound.indexCount) || 0);
    const endIndex = Math.min(mesh.indices.length, firstIndex + indexCount);
    for (let cursor = firstIndex; cursor + 2 < endIndex; cursor += 3) {
      const firstVertex = mesh.indices[cursor];
      const distance = packedTriangleDistance(
        view,
        firstVertex,
        mesh.indices[cursor + 1],
        mesh.indices[cursor + 2],
        origin,
        direction,
        boundOffset,
      );
      if (distance == null || best && distance >= best.distance) continue;
      const normal = packedVertexNormal(view, firstVertex);
      const axis = dominantAxis(normal);
      const side = normal[axis] >= 0 ? 1 : 0;
      const point = origin.map((value, coordinate) => value + direction[coordinate] * distance);
      const localPoint = point.map((value, coordinate) => value - boundOffset[coordinate]);
      const face = { axis, side, normal };
      best = {
        ...bound,
        distance,
        point,
        localPoint,
        axis,
        side,
        normal: [...normal],
        face,
      };
    }
  }
  return best;
}

function mergeForgePickBounds(bounds, { componentOffsets = null } = {}) {
  if (!Array.isArray(bounds) || !bounds.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let firstIndex = Infinity;
  let endIndex = -Infinity;
  let componentCount = 0;
  for (const bound of bounds) {
    if (!bound?.min || !bound?.max) continue;
    const offset = componentVisualOffsetAt(componentOffsets, bound.index);
    const boundMin = finiteVector3OrNull(bound.min);
    const boundMax = finiteVector3OrNull(bound.max);
    if (!boundMin || !boundMax) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], boundMin[axis] + offset[axis]);
      max[axis] = Math.max(max[axis], boundMax[axis] + offset[axis]);
    }
    const start = Math.max(0, Math.trunc(Number(bound.firstIndex) || 0));
    const count = Math.max(0, Math.trunc(Number(bound.indexCount) || 0));
    firstIndex = Math.min(firstIndex, start);
    endIndex = Math.max(endIndex, start + count);
    componentCount += 1;
  }
  if (!componentCount || min.some((value) => !Number.isFinite(value)) || max.some((value) => !Number.isFinite(value))) return null;
  return {
    id: "workpiece-group",
    index: 0,
    min,
    max,
    firstIndex: Number.isFinite(firstIndex) ? firstIndex : 0,
    indexCount: Number.isFinite(endIndex) && Number.isFinite(firstIndex) ? Math.max(0, endIndex - firstIndex) : 0,
    userData: { kind: "workpiece-group", grouped: true, componentCount },
  };
}

function groupedForgeHit(hit, groupedBound) {
  if (!hit || !groupedBound) return hit;
  return {
    ...hit,
    ...groupedBound,
    sourceComponentId: hit.id,
    sourceComponentIndex: hit.index,
    sourceComponentUserData: hit.userData,
    point: [...hit.point],
    localPoint: hit.localPoint ? [...hit.localPoint] : null,
    normal: [...hit.normal],
    face: { ...hit.face, normal: [...hit.face.normal] },
  };
}

function uploadMesh(gl, mesh, usage) {
  if (!mesh?.indexCount) return null;
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, usage);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribIPointer(0, 3, gl.SHORT, FORGE_MESH_VERTEX_STRIDE_BYTES, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.BYTE, true, FORGE_MESH_VERTEX_STRIDE_BYTES, 6);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, FORGE_MESH_VERTEX_STRIDE_BYTES, 10);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_SHORT, FORGE_MESH_VERTEX_STRIDE_BYTES, 14);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_BYTE, FORGE_MESH_VERTEX_STRIDE_BYTES, FORGE_MESH_MATERIAL_LAYER_OFFSET);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, usage);
  gl.bindVertexArray(null);
  return {
    vao,
    vbo,
    ibo,
    indexCount: mesh.indexCount,
    indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
    triangleCount: mesh.triangleCount,
    byteLength: mesh.byteLength,
  };
}

function packAvatarMesh(mesh, sourceVertices) {
  const vertexCount = Math.max(0, Math.min(
    Number(mesh?.vertexCount) || 0,
    Math.floor((sourceVertices?.length || 0) / 10),
  ));
  const vertices = new Uint8Array(vertexCount * FORGE_MESH_VERTEX_STRIDE_BYTES);
  writePackedAvatarVertices(vertices, sourceVertices);
  const indices = mesh?.indices ?? new Uint16Array(0);
  return {
    vertices,
    indices,
    vertexCount,
    indexCount: indices.length,
    triangleCount: indices.length / 3,
    vertexStrideBytes: FORGE_MESH_VERTEX_STRIDE_BYTES,
    byteLength: vertices.byteLength + indices.byteLength,
  };
}

function writePackedAvatarVertices(target, source) {
  if (!target?.byteLength || !source?.length) return target;
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  const vertexCount = Math.min(
    Math.floor(target.byteLength / FORGE_MESH_VERTEX_STRIDE_BYTES),
    Math.floor(source.length / 10),
  );
  for (let index = 0; index < vertexCount; index += 1) {
    const sourceOffset = index * 10;
    const targetOffset = index * FORGE_MESH_VERTEX_STRIDE_BYTES;
    for (let axis = 0; axis < 3; axis += 1) {
      view.setInt16(
        targetOffset + axis * 2,
        clamp(Math.round(Number(source[sourceOffset + axis]) * FORGE_RENDER_POSITION_SCALE), -32768, 32767),
        true,
      );
      view.setInt8(
        targetOffset + 6 + axis,
        clamp(Math.round(Number(source[sourceOffset + 3 + axis]) * 127), -127, 127),
      );
    }
    view.setUint8(targetOffset + FORGE_MESH_MATERIAL_LAYER_OFFSET, FORGE_MESH_MATERIAL_LAYER_NONE);
    for (let channel = 0; channel < 4; channel += 1) {
      view.setUint8(
        targetOffset + 10 + channel,
        clamp(Math.round(Number(source[sourceOffset + 6 + channel]) * 255), 0, 255),
      );
    }
    view.setUint16(targetOffset + 14, 0, true);
  }
  return target;
}

function setForgeHighlightUniforms(gl, uniforms, selected, hovered) {
  const selectedFace = highlightedFaceState(selected);
  const hoveredFace = highlightedFaceState(hovered);
  gl.uniform1i(uniforms.selectedComponentIndex, selectedFace?.renderIndex ?? -1);
  gl.uniform1i(uniforms.selectedFaceAxis, selectedFace?.axis ?? -1);
  gl.uniform1i(uniforms.selectedFaceSide, selectedFace?.side ?? -1);
  gl.uniform1i(uniforms.hoveredComponentIndex, hoveredFace?.renderIndex ?? -1);
  gl.uniform1i(uniforms.hoveredFaceAxis, hoveredFace?.axis ?? -1);
  gl.uniform1i(uniforms.hoveredFaceSide, hoveredFace?.side ?? -1);
}

function setUniformUint(gl, location, value) {
  if (typeof gl.uniform1ui === "function") {
    gl.uniform1ui(location, value >>> 0);
    return;
  }
  gl.uniform1i(location, value >>> 0);
}

function setObjectVisualUniforms(gl, uniforms, visual) {
  gl.uniformMatrix3fv(uniforms.objectBasis, false, visual?.basis ?? IDENTITY_BASIS_3);
  gl.uniform1i(uniforms.spinComponentIndex, visual?.spinComponentIndex ?? -1);
  gl.uniform1f(uniforms.spinRadians, visual?.spinRadians ?? 0);
  gl.uniform1f(uniforms.opacity, visual?.opacity ?? 1);
  gl.uniform3fv(uniforms.colorTint, visual?.tint ?? [1, 1, 1]);
  gl.uniform1f(uniforms.colorTintMix, visual?.tintMix ?? 0);
  gl.uniform1f(uniforms.unlit, visual?.unlit ?? 0);
}

function sumHandleBytes(handles) {
  let bytes = 0;
  for (const handle of handles?.values?.() ?? []) bytes += handle?.byteLength || 0;
  return bytes;
}

function drawHandle(gl, offsetUniform, handle, offset) {
  if (!handle?.indexCount) return false;
  gl.uniform3f(offsetUniform, offset[0], offset[1], offset[2]);
  gl.bindVertexArray(handle.vao);
  gl.drawElements(gl.TRIANGLES, handle.indexCount, handle.indexType, 0);
  return true;
}

function disposeHandle(gl, handle) {
  if (!gl || !handle) return;
  gl.deleteBuffer(handle.vbo);
  gl.deleteBuffer(handle.ibo);
  gl.deleteVertexArray(handle.vao);
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Forge shader program failed to link.";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Forge shader failed to compile.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function cameraEye(camera) {
  const cp = Math.cos(camera.pitch);
  return [
    camera.target[0] + Math.sin(camera.yaw) * cp * camera.distance,
    camera.target[1] + Math.sin(camera.pitch) * camera.distance,
    camera.target[2] + Math.cos(camera.yaw) * cp * camera.distance,
  ];
}

function packedTriangleDistance(view, ia, ib, ic, origin, direction, offset) {
  const aCursor = ia * FORGE_MESH_VERTEX_STRIDE_BYTES;
  const bCursor = ib * FORGE_MESH_VERTEX_STRIDE_BYTES;
  const cCursor = ic * FORGE_MESH_VERTEX_STRIDE_BYTES;
  const ax = view.getInt16(aCursor, true) / FORGE_RENDER_POSITION_SCALE + offset[0];
  const ay = view.getInt16(aCursor + 2, true) / FORGE_RENDER_POSITION_SCALE + offset[1];
  const az = view.getInt16(aCursor + 4, true) / FORGE_RENDER_POSITION_SCALE + offset[2];
  const bx = view.getInt16(bCursor, true) / FORGE_RENDER_POSITION_SCALE + offset[0];
  const by = view.getInt16(bCursor + 2, true) / FORGE_RENDER_POSITION_SCALE + offset[1];
  const bz = view.getInt16(bCursor + 4, true) / FORGE_RENDER_POSITION_SCALE + offset[2];
  const cx = view.getInt16(cCursor, true) / FORGE_RENDER_POSITION_SCALE + offset[0];
  const cy = view.getInt16(cCursor + 2, true) / FORGE_RENDER_POSITION_SCALE + offset[1];
  const cz = view.getInt16(cCursor + 4, true) / FORGE_RENDER_POSITION_SCALE + offset[2];
  const edge1x = bx - ax;
  const edge1y = by - ay;
  const edge1z = bz - az;
  const edge2x = cx - ax;
  const edge2y = cy - ay;
  const edge2z = cz - az;
  const px = direction[1] * edge2z - direction[2] * edge2y;
  const py = direction[2] * edge2x - direction[0] * edge2z;
  const pz = direction[0] * edge2y - direction[1] * edge2x;
  const determinant = edge1x * px + edge1y * py + edge1z * pz;
  if (Math.abs(determinant) < 1e-9) return null;
  const inverse = 1 / determinant;
  const tx = origin[0] - ax;
  const ty = origin[1] - ay;
  const tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < -1e-7 || u > 1.0000001) return null;
  const qx = ty * edge1z - tz * edge1y;
  const qy = tz * edge1x - tx * edge1z;
  const qz = tx * edge1y - ty * edge1x;
  const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inverse;
  if (v < -1e-7 || u + v > 1.0000001) return null;
  const distance = (edge2x * qx + edge2y * qy + edge2z * qz) * inverse;
  return distance > 1e-7 ? distance : null;
}

function packedVertexNormal(view, vertexIndex) {
  const cursor = vertexIndex * FORGE_MESH_VERTEX_STRIDE_BYTES + 6;
  return [Math.sign(view.getInt8(cursor)), Math.sign(view.getInt8(cursor + 1)), Math.sign(view.getInt8(cursor + 2))];
}

function dominantAxis(value) {
  let axis = 0;
  if (Math.abs(value[1]) > Math.abs(value[axis])) axis = 1;
  if (Math.abs(value[2]) > Math.abs(value[axis])) axis = 2;
  return axis;
}

function rayAabbDistance(origin, direction, min, max) {
  let near = -Infinity;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(direction[axis]) < 1e-9) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    let a = (min[axis] - origin[axis]) / direction[axis];
    let b = (max[axis] - origin[axis]) / direction[axis];
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  if (far < 0) return null;
  return near >= 0 ? near : far;
}

function cuboid(id, center, size, color444) {
  return Object.freeze({ id, center: Object.freeze(center), size: Object.freeze(size), color444 });
}

function forgeWorkSurfaceY(mesh) {
  let workSurfaceY = -Infinity;
  for (const bound of mesh?.pickBounds ?? []) {
    if (bound.id !== "deck" && bound.userData?.workSurface !== true) continue;
    const value = Number(bound.max?.[1]);
    if (Number.isFinite(value)) workSurfaceY = Math.max(workSurfaceY, value);
  }
  return Number.isFinite(workSurfaceY) ? workSurfaceY : null;
}

function floorConstrainedWorkpieceOffset(mesh, offset, floorY) {
  const constrained = [...offset];
  if (!Number.isFinite(floorY)) return constrained;
  let minimumY = Infinity;
  for (const bound of mesh?.pickBounds ?? []) {
    const value = Number(bound.min?.[1]);
    if (Number.isFinite(value)) minimumY = Math.min(minimumY, value);
  }
  if (Number.isFinite(minimumY)) constrained[1] = Math.max(constrained[1], floorY - minimumY);
  return constrained;
}

function pointerPairDistance(pointers) {
  const [a, b] = Array.from(pointers.values());
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

function normalizeConstructionPreview(input) {
  if (!input) return null;
  const source = normalizeForgeToolVisualHit(input.hit ?? input);
  if (!source) return null;
  const cell = Array.isArray(input.cell) || ArrayBuffer.isView(input.cell)
    ? Array.from(input.cell).slice(0, 3).map((value) => Math.round(Number(value) || 0))
    : null;
  return {
    toolId: normalizeForgeToolVisualId(input.toolId ?? input.tool ?? "", ""),
    index: source.index,
    point: [...source.point],
    localPoint: source.localPoint ? [...source.localPoint] : null,
    axis: source.axis,
    side: source.side,
    normal: [...source.normal],
    face: { ...source.face, normal: [...source.normal] },
    cell: cell?.length === 3 ? cell : null,
    plane: Number.isFinite(Number(input.plane)) ? Math.round(Number(input.plane)) : null,
    valid: input.valid == null ? null : Boolean(input.valid),
  };
}

function sameConstructionPreview(left, right) {
  if (!left || !right) return left === right;
  return left.toolId === right.toolId
    && left.index === right.index
    && left.axis === right.axis
    && left.side === right.side
    && left.plane === right.plane
    && left.valid === right.valid
    && vectorsNearlyEqual(left.point, right.point)
    && sameIntegerVector(left.cell, right.cell);
}

function sameIntegerVector(left, right) {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneConstructionPreview(preview) {
  return preview ? {
    ...preview,
    point: [...preview.point],
    localPoint: preview.localPoint ? [...preview.localPoint] : null,
    normal: [...preview.normal],
    face: { ...preview.face, normal: [...preview.face.normal] },
    cell: preview.cell ? [...preview.cell] : null,
  } : null;
}

function cloneAxisGizmoState(state) {
  return state ? { ...state, center: [...state.center] } : null;
}

function closestRaySegment(origin, direction, start, end) {
  const segment = subtract(end, start);
  const length2 = lengthSquared(segment);
  if (length2 < 1e-12) return null;
  const offset = subtract(origin, start);
  const a = lengthSquared(direction);
  const b = dot(direction, segment);
  const c = length2;
  const d = dot(direction, offset);
  const e = dot(segment, offset);
  const denominator = a * c - b * b;
  const candidates = [];
  if (denominator > 1e-12) {
    const rayDistance = (b * e - c * d) / denominator;
    const segmentParameter = (a * e - b * d) / denominator;
    if (rayDistance >= 0 && segmentParameter >= 0 && segmentParameter <= 1) {
      candidates.push({ rayDistance, segmentParameter });
    }
  }
  for (const segmentParameter of [0, 1]) {
    const point = start.map((value, axis) => value + segment[axis] * segmentParameter);
    candidates.push({
      rayDistance: Math.max(0, dot(subtract(point, origin), direction) / a),
      segmentParameter,
    });
  }
  candidates.push({
    rayDistance: 0,
    segmentParameter: clamp(dot(subtract(origin, start), segment) / c, 0, 1),
  });
  let best = null;
  for (const candidate of candidates) {
    const rayPoint = origin.map((value, axis) => value + direction[axis] * candidate.rayDistance);
    const segmentPoint = start.map((value, axis) => value + segment[axis] * candidate.segmentParameter);
    const distance = Math.sqrt(lengthSquared(subtract(rayPoint, segmentPoint)));
    if (!best || distance < best.distance) best = { ...candidate, distance };
  }
  return best;
}

function normalizeOptionalAxis(value) {
  const axis = Number(value);
  return Number.isInteger(axis) && axis >= 0 && axis <= 2 ? axis : null;
}

function unitAxis(value) {
  const axis = normalizeOptionalAxis(value);
  if (axis == null) throw new RangeError("Forge axes must be 0, 1, or 2.");
  const result = [0, 0, 0];
  result[axis] = 1;
  return result;
}

function scaledIdentityBasis(scale) {
  return new Float32Array([scale, 0, 0, 0, scale, 0, 0, 0, scale]);
}

function avatarYawBasis(yaw) {
  const cosine = Math.cos(Number(yaw) || 0);
  const sine = Math.sin(Number(yaw) || 0);
  return basisColumns([cosine, 0, -sine], [0, 1, 0], [sine, 0, cosine]);
}

function basisColumns(x, y, z) {
  return new Float32Array([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function lengthSquared(value) {
  return value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
}

function vectorsNearlyEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a[0] - b[0]) <= epsilon
    && Math.abs(a[1] - b[1]) <= epsilon
    && Math.abs(a[2] - b[2]) <= epsilon;
}

function highlightedFaceState(hit) {
  const index = Number(hit?.index);
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) return null;
  const sourceComponentIndex = Number(hit?.sourceComponentIndex);
  const renderIndex = Number.isInteger(sourceComponentIndex) && sourceComponentIndex >= 0 && sourceComponentIndex <= 0xffff
    ? sourceComponentIndex
    : index;
  const face = hit.face ?? hit;
  const axis = Number(face?.axis);
  const side = Number(face?.side);
  if (!Number.isInteger(axis) || axis < 0 || axis > 2 || !Number.isInteger(side) || side < 0 || side > 1) return null;
  return { index, renderIndex, axis, side };
}

function normalizeForgeHighlightHit(hit) {
  const state = highlightedFaceState(hit);
  if (!state) return null;
  const sourceNormal = hit.face?.normal ?? hit.normal;
  const normal = Array.isArray(sourceNormal) || ArrayBuffer.isView(sourceNormal)
    ? Array.from(sourceNormal).slice(0, 3).map((value) => Number(value) || 0)
    : [0, 0, 0];
  while (normal.length < 3) normal.push(0);
  if (lengthSquared(normal) < 1e-12) normal[state.axis] = state.side ? 1 : -1;
  return cloneForgeHit({
    ...hit,
    index: state.index,
    axis: state.axis,
    side: state.side,
    normal,
    face: { ...hit.face, axis: state.axis, side: state.side, normal },
  });
}

function sameForgeHighlightedFace(left, right) {
  const a = highlightedFaceState(left);
  const b = highlightedFaceState(right);
  return a === null || b === null
    ? a === b
    : a.index === b.index && a.renderIndex === b.renderIndex && a.axis === b.axis && a.side === b.side;
}

function cloneForgeHit(hit) {
  if (!hit) return null;
  return {
    ...hit,
    min: hit.min ? [...hit.min] : hit.min,
    max: hit.max ? [...hit.max] : hit.max,
    point: hit.point ? [...hit.point] : hit.point,
    localPoint: hit.localPoint ? [...hit.localPoint] : hit.localPoint,
    normal: hit.normal ? [...hit.normal] : hit.normal,
    face: hit.face ? { ...hit.face, normal: hit.face.normal ? [...hit.face.normal] : hit.face.normal } : hit.face,
  };
}

function cloneToolSettings(settings) {
  if (!settings || typeof settings !== "object") return {};
  return { ...settings };
}

function normalizeComponentVisualOffsets(input) {
  const values = new Float32Array(FORGE_MAX_COMPONENT_VISUAL_OFFSETS * 3);
  if (input == null) return { values, length: 0, enabled: false };
  let length = 0;
  const assign = (rawIndex, rawOffset) => {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= FORGE_MAX_COMPONENT_VISUAL_OFFSETS) {
      throw new RangeError(`Forge component visual offset index must be between 0 and ${FORGE_MAX_COMPONENT_VISUAL_OFFSETS - 1}.`);
    }
    length = Math.max(length, index + 1);
    if (rawOffset == null) return;
    const offset = finiteVector3OrNull(rawOffset);
    if (!offset) throw new TypeError("Forge component visual offsets must be finite three-component vectors.");
    values.set(offset, index * 3);
  };
  if (ArrayBuffer.isView(input)) {
    if (!Number.isInteger(input.length) || input.length % 3 !== 0) {
      throw new TypeError("Flat forge component visual offsets must contain complete three-component vectors.");
    }
    if (input.length / 3 > FORGE_MAX_COMPONENT_VISUAL_OFFSETS) {
      throw new RangeError(`Forge component visual offsets support at most ${FORGE_MAX_COMPONENT_VISUAL_OFFSETS} components.`);
    }
    for (let index = 0; index < input.length / 3; index += 1) {
      assign(index, [input[index * 3], input[index * 3 + 1], input[index * 3 + 2]]);
    }
  } else if (Array.isArray(input)) {
    const flat = input.length > 0 && input.every((entry) => Number.isFinite(entry));
    if (flat) {
      if (input.length % 3 !== 0) {
        throw new TypeError("Flat forge component visual offsets must contain complete three-component vectors.");
      }
      if (input.length / 3 > FORGE_MAX_COMPONENT_VISUAL_OFFSETS) {
        throw new RangeError(`Forge component visual offsets support at most ${FORGE_MAX_COMPONENT_VISUAL_OFFSETS} components.`);
      }
      for (let index = 0; index < input.length / 3; index += 1) {
        assign(index, input.slice(index * 3, index * 3 + 3));
      }
    } else {
      if (input.length > FORGE_MAX_COMPONENT_VISUAL_OFFSETS) {
        throw new RangeError(`Forge component visual offsets support at most ${FORGE_MAX_COMPONENT_VISUAL_OFFSETS} components.`);
      }
      input.forEach((entry, index) => {
        if (entry && typeof entry === "object" && "index" in entry && "offset" in entry) assign(entry.index, entry.offset);
        else assign(index, entry);
      });
      length = Math.max(length, input.length);
    }
  } else if (input instanceof Map) {
    for (const [index, offset] of input) assign(index, offset);
  } else if (typeof input === "object") {
    for (const [index, offset] of Object.entries(input)) assign(index, offset);
  } else {
    throw new TypeError("Forge component visual offsets must be an indexed collection or null.");
  }
  return { values, length, enabled: true };
}

function componentVisualOffsetAt(offsets, rawIndex) {
  const index = Number(rawIndex);
  if (!offsets || !Number.isInteger(index) || index < 0 || index >= FORGE_MAX_COMPONENT_VISUAL_OFFSETS) return [0, 0, 0];
  if (ArrayBuffer.isView(offsets)) {
    const cursor = index * 3;
    return cursor + 2 < offsets.length
      ? [Number(offsets[cursor]) || 0, Number(offsets[cursor + 1]) || 0, Number(offsets[cursor + 2]) || 0]
      : [0, 0, 0];
  }
  const source = offsets instanceof Map ? offsets.get(index) ?? offsets.get(String(index)) : offsets[index];
  if (source && typeof source === "object" && "offset" in source) return finiteVector3OrNull(source.offset) ?? [0, 0, 0];
  return finiteVector3OrNull(source) ?? [0, 0, 0];
}

function cloneComponentVisualOffsets(offsets, length) {
  return Array.from({ length }, (_, index) => componentVisualOffsetAt(offsets, index));
}

function finiteVector3OrNull(value) {
  const entries = Array.isArray(value) || ArrayBuffer.isView(value)
    ? Array.from(value).slice(0, 3)
    : [value?.x, value?.y, value?.z];
  if (entries.length !== 3 || entries.some((entry) => !Number.isFinite(Number(entry)))) return null;
  return entries.map(Number);
}

function floatArraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function nowMilliseconds() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function requestFrame(callback) {
  const request = globalThis.requestAnimationFrame
    ?? ((handler) => globalThis.setTimeout(() => handler(globalThis.performance?.now?.() ?? Date.now()), 0));
  return request(callback);
}

function cancelFrame(id) {
  const cancel = globalThis.cancelAnimationFrame ?? globalThis.clearTimeout;
  cancel?.(id);
}

function vector3(value) {
  const values = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value).slice(0, 3) : [value?.x, value?.y, value?.z];
  if (values.length !== 3 || values.some((entry) => !Number.isFinite(Number(entry)))) throw new TypeError("Expected a three-component finite vector.");
  return values.map(Number);
}

function direction3(value, fallback) {
  const direction = value == null ? [...fallback] : vector3(value);
  return lengthSquared(direction) > 1e-12 ? normalize3(direction) : normalize3(fallback);
}

function normalizeColor(value, fallback) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return [...fallback];
  const color = Array.from(value).slice(0, 4);
  while (color.length < 4) color.push(1);
  return color.map((entry) => clamp(Number(entry) || 0, 0, 1));
}

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(numeric) ? Math.trunc(numeric) : fallback));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function emptyStats() {
  return {
    backend: "webgl2",
    onDemand: true,
    frames: 0,
    drawCalls: 0,
    triangles: 0,
    bufferMemory: 0,
    textureMemory: 0,
    materialLayers: 0,
    width: 0,
    height: 0,
    dpr: 1,
  };
}
