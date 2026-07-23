import { mat4LookAt, mat4Multiply, mat4Perspective } from "../core/math.js";
import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
  createAvatarMeshFromNcm4Character,
  updateAvatarMeshVertices,
} from "./avatar-mesh.js";
import { NCM4_BONES } from "../ncm/character-codec.js";

const DEFAULT_MAX_PIXEL_RATIO = 1.35;
const DEFAULT_PREVIEW_EQUIPMENT = Object.freeze({ rightHand: "pickaxe" });

export function resolveAvatarPreviewAttachIronPickaxe(value) {
  return Boolean(value ?? true);
}

export function resolveAvatarPreviewEquipment(value) {
  return value ?? DEFAULT_PREVIEW_EQUIPMENT;
}

const VERTEX_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;

uniform mat4 uViewProjection;
uniform float uModelYaw;

out vec3 vNormal;
out vec4 vColor;
out float vDepth;

void main() {
  float c = cos(uModelYaw);
  float s = sin(uModelYaw);
  mat3 yaw = mat3(
    c, 0.0, -s,
    0.0, 1.0, 0.0,
    s, 0.0, c
  );
  vec3 p = yaw * aPosition;
  gl_Position = uViewProjection * vec4(p, 1.0);
  vNormal = normalize(yaw * aNormal);
  vColor = aColor;
  vDepth = max(0.0, gl_Position.w);
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec4 vColor;
in float vDepth;

out vec4 outColor;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 sunDir = normalize(vec3(-0.45, 0.72, 0.52));
  float sun = max(dot(normal, sunDir), 0.0);
  float hemi = normal.y * 0.5 + 0.5;
  vec3 sky = vec3(0.72, 0.86, 0.96) * (0.28 + hemi * 0.28);
  vec3 warm = vec3(1.0, 0.78, 0.48) * sun * 0.78;
  vec3 ground = vec3(0.42, 0.36, 0.30) * (1.0 - hemi) * 0.14;
  vec3 color = vColor.rgb * (sky + warm + ground + vec3(0.34));
  color = mix(color, vec3(0.89, 0.94, 0.97), smoothstep(9.0, 14.0, vDepth) * 0.16);
  outColor = vec4(color, vColor.a);
}
`;

export function createAvatarPreviewRenderer(containerOrCanvas, options = {}) {
  if (!containerOrCanvas || typeof document === "undefined") return null;
  const target = containerOrCanvas;
  const canvas = target instanceof HTMLCanvasElement
    ? target
    : target.querySelector?.("canvas[data-nicechunk-avatar-preview]") || document.createElement("canvas");
  if (!(target instanceof HTMLCanvasElement)) {
    canvas.className = options.className || "avatar-preview-canvas";
    canvas.dataset.nicechunkAvatarPreview = "true";
    if (canvas.parentNode !== target) target.prepend(canvas);
  }

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: Boolean(options.antialias ?? false),
    depth: true,
    stencil: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const program = createProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);
  if (!program) return null;

  const state = {
    disposed: false,
    maxPixelRatio: finiteNumber(options.maxPixelRatio, DEFAULT_MAX_PIXEL_RATIO),
    lastWidth: 0,
    lastHeight: 0,
    modelCode: "",
    character: null,
    characterName: "",
    characterScale: 1,
    mesh: null,
    handle: null,
    label: "",
    forgeRuntime: options.forgeRuntime ?? null,
    attachIronPickaxe: null,
    attachForgedPickaxe: null,
  };

  const uniforms = {
    viewProjection: gl.getUniformLocation(program, "uViewProjection"),
    modelYaw: gl.getUniformLocation(program, "uModelYaw"),
  };

  try {
    if (Object.prototype.hasOwnProperty.call(options, "character")) {
      setCharacter(options.character, options);
    } else {
      setModelCode(options.modelCode || DEFAULT_PEASANT_GUY_NCM, options);
    }
  } catch (error) {
    gl.deleteProgram(program);
    if (!(target instanceof HTMLCanvasElement) && canvas.parentNode === target) canvas.remove();
    throw error;
  }

  return {
    canvas,
    render(params = {}) {
      if (state.disposed || !state.mesh || !state.handle) return false;
      if (Object.prototype.hasOwnProperty.call(params, "character")) {
        setCharacter(params.character, params);
      } else if (params.modelCode && params.modelCode !== state.modelCode) {
        setModelCode(params.modelCode, params);
      }
      resizeCanvas(canvas, gl, state);
      const width = Math.max(1, canvas.width);
      const height = Math.max(1, canvas.height);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      const timeMs = finiteNumber(params.timeMs, typeof performance !== "undefined" ? performance.now() : 0);
      const animation = {
        moving: Boolean(params.moving ?? true),
        timeMs,
        elapsedMs: params.elapsedMs ?? params.actionElapsedMs,
        progress: params.progress ?? params.actionProgress,
        action: params.action ?? options.action,
        actionId: params.actionId ?? options.actionId,
        loop: params.loop ?? options.loop,
        equipment: resolveAvatarPreviewEquipment(params.equipment ?? options.equipment),
        miningProgress: params.miningProgress ?? 0,
      };
      const vertices = updateAvatarMeshVertices(state.mesh, animation) || state.mesh.vertices;
      gl.bindBuffer(gl.ARRAY_BUFFER, state.handle.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);

      const viewProjection = createAvatarPreviewViewProjection(
        state.mesh,
        width / height,
        resolvePreviewProjectionParams(options, params),
      );
      const yaw = finiteNumber(params.yaw, Math.sin(timeMs * 0.00028) * 0.18 + 0.18);
      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection);
      gl.uniform1f(uniforms.modelYaw, yaw);
      gl.bindVertexArray(state.handle.vao);
      gl.drawElements(gl.TRIANGLES, state.handle.indexCount, state.handle.indexType, 0);
      gl.bindVertexArray(null);
      return true;
    },
    setModelCode,
    setCharacter,
    setForgeRuntime(forgeRuntime = null, params = {}) {
      return setModelCode(params.modelCode || state.modelCode || DEFAULT_PEASANT_GUY_NCM, {
        ...params,
        forgeRuntime,
        attachIronPickaxe: Boolean(forgeRuntime),
        attachForgedPickaxe: Boolean(forgeRuntime),
        force: true,
      });
    },
    snapshot() {
      return {
        modelCode: state.modelCode,
        label: state.label,
        source: state.character ? "character" : "modelCode",
        format: state.mesh?.format ?? "NCM2",
        boneCount: state.mesh?.boneCount ?? 0,
        cuboidCount: state.mesh?.cuboidCount ?? 0,
        actionCount: state.mesh?.actionCount ?? 0,
        triangleCount: state.mesh?.triangleCount ?? 0,
        equipment: state.mesh?.equipment ?? [],
        actions: state.mesh?.actions ?? [],
        animation: state.mesh?.animation ?? null,
        forgeDesignHash: state.forgeRuntime?.designHash ?? 0,
        forgeRuntimeAttached: Boolean(state.forgeRuntime),
      };
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      disposeHandle(gl, state.handle);
      state.handle = null;
      gl.deleteProgram(program);
      if (!(target instanceof HTMLCanvasElement) && canvas.parentNode === target) canvas.remove();
    },
  };

  function setModelCode(modelCode = "", params = {}) {
    const code = String(modelCode || DEFAULT_PEASANT_GUY_NCM);
    const forgeRuntime = Object.prototype.hasOwnProperty.call(params, "forgeRuntime")
      ? params.forgeRuntime
      : state.forgeRuntime;
    const attachIronPickaxe = resolveAvatarPreviewAttachIronPickaxe(
      params.attachIronPickaxe ?? options.attachIronPickaxe,
    );
    const attachForgedPickaxe = Boolean(
      params.attachForgedPickaxe ?? options.attachForgedPickaxe ?? attachIronPickaxe,
    );
    if (!params.force
      && state.mesh
      && !state.character
      && state.modelCode === code
      && state.forgeRuntime === forgeRuntime
      && state.attachIronPickaxe === attachIronPickaxe
      && state.attachForgedPickaxe === attachForgedPickaxe) return true;
    let mesh = null;
    let label = "peasant_guy";
    try {
      mesh = createAvatarMeshFromNcm(code, {
        name: params.name || "profile_avatar",
        attachIronPickaxe,
        attachForgedPickaxe,
        forgeRuntime,
      });
      label = mesh.name || label;
      state.modelCode = code;
    } catch (error) {
      console.warn("NiceChunk avatar preview model failed, using built-in avatar:", error);
      mesh = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
        name: "profile_avatar",
        attachIronPickaxe,
        attachForgedPickaxe,
        forgeRuntime,
      });
      state.modelCode = DEFAULT_PEASANT_GUY_NCM;
      label = "peasant_guy";
    }
    disposeHandle(gl, state.handle);
    state.mesh = mesh;
    state.label = label;
    state.character = null;
    state.characterName = "";
    state.characterScale = 1;
    state.forgeRuntime = forgeRuntime;
    state.attachIronPickaxe = attachIronPickaxe;
    state.attachForgedPickaxe = attachForgedPickaxe;
    state.handle = createAvatarHandle(gl, mesh);
    return true;
  }

  function setCharacter(character, params = {}) {
    const scale = positiveNumber(params.scale ?? options.scale, 1);
    const name = String(params.name || options.name || character?.name || "profile_avatar");
    if (!params.force
      && state.mesh
      && state.character === character
      && state.characterName === name
      && state.characterScale === scale) return true;

    const source = resolveAvatarPreviewCharacter(character);
    // Authoring objects are intentionally not wrapped in the legacy model-code
    // fallback. Invalid source geometry must be fixed at its source instead of
    // being hidden behind the built-in peasant avatar.
    const mesh = createAvatarMeshFromNcm4Character(source, { scale, name });
    disposeHandle(gl, state.handle);
    state.modelCode = "";
    state.character = character;
    state.characterName = name;
    state.characterScale = scale;
    state.mesh = mesh;
    state.label = mesh.name || name;
    state.handle = createAvatarHandle(gl, mesh);
    return true;
  }
}

function resolveAvatarPreviewCharacter(character) {
  if (!character || typeof character !== "object" || Array.isArray(character)) {
    throw new TypeError("Avatar preview character must be an NCM4 authoring object.");
  }
  const cuboids = character.cuboids ?? character.boxes;
  if (!Array.isArray(cuboids) || !cuboids.length) {
    throw new Error("Invalid NCM4 character geometry.");
  }

  const pivotSource = character.pivots ?? character.bones ?? character.rig?.bones;
  const bones = NCM4_BONES.map((bone) => {
    const entry = Array.isArray(pivotSource)
      ? pivotSource.find((candidate, index) => (
          Array.isArray(candidate)
            ? index === bone.id
            : candidate?.id === bone.id || candidate?.name === bone.name
        ))
      : pivotSource?.[bone.name] ?? pivotSource?.[bone.id];
    const pivot = Array.isArray(entry) || ArrayBuffer.isView(entry) ? entry : entry?.pivot;
    if (!validVector3(pivot)) {
      throw new Error(`Invalid NCM4 ${bone.name} bone pivot.`);
    }
    return { ...bone, pivot: Array.from(pivot) };
  });
  return { ...character, bones };
}

function createAvatarHandle(gl, mesh) {
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices.byteLength, gl.DYNAMIC_DRAW);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.vertices);
  const stride = mesh.vertexStrideBytes || 40;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {
    vao,
    vbo,
    ibo,
    indexCount: mesh.indexCount,
    indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
  };
}

export function createAvatarPreviewViewProjection(mesh, aspect, params = {}) {
  const bounds = mesh.renderBounds || { minY: 0, maxY: mesh.bounds?.height ?? 2.4 };
  const height = Math.max(1, mesh.bounds?.height ?? (bounds.maxY - bounds.minY));
  const targetY = finiteNumber(params.targetY, height * finiteNumber(params.targetHeightRatio, 0.54));
  const eyeY = finiteNumber(params.eyeY, height * finiteNumber(params.eyeHeightRatio, 0.58));
  const target = [0, targetY, 0];
  const renderHeight = Math.max(height, Number(bounds.maxY) - Number(bounds.minY) || 0);
  const renderWidth = Math.max(
    Math.abs(Number(bounds.minX) || 0),
    Math.abs(Number(bounds.maxX) || 0),
    Math.abs(Number(bounds.minZ) || 0),
    Math.abs(Number(bounds.maxZ) || 0),
  ) * 2;
  const distance = finiteNumber(params.distance, Math.max(
    3.2,
    renderHeight * 1.72,
    renderWidth * 0.92 / Math.max(0.55, aspect),
  ));
  const eye = [0.05, eyeY, distance];
  const view = mat4LookAt(eye, target, [0, 1, 0]);
  const orthographic = params.projection === "orthographic" || params.orthographic === true;
  const projection = orthographic
    ? avatarOrthographicProjection(renderHeight, renderWidth, aspect, params)
    : mat4Perspective((finiteNumber(params.fov, 30) * Math.PI) / 180, Math.max(0.25, aspect), 0.05, 32);
  return mat4Multiply(projection, view);
}

function resolvePreviewProjectionParams(options, params) {
  const hasRenderProjection = Object.prototype.hasOwnProperty.call(params, "projection");
  const hasRenderOrthographic = Object.prototype.hasOwnProperty.call(params, "orthographic");
  const hasOptionProjection = Object.prototype.hasOwnProperty.call(options, "projection");
  const projection = hasRenderProjection
    ? params.projection
    : (hasRenderOrthographic ? undefined : options.projection);
  const orthographic = hasRenderProjection
    ? false
    : (hasRenderOrthographic ? params.orthographic : (hasOptionProjection ? false : options.orthographic));
  return {
    ...params,
    projection,
    orthographic,
    orthographicPadding: params.orthographicPadding ?? options.orthographicPadding,
    orthographicHeight: params.orthographicHeight ?? options.orthographicHeight,
    orthographicZoom: params.orthographicZoom ?? options.orthographicZoom,
    padding: params.padding ?? options.padding,
    height: params.height ?? options.height,
    zoom: params.zoom ?? options.zoom,
    targetY: params.targetY ?? options.targetY,
    eyeY: params.eyeY ?? options.eyeY,
    targetHeightRatio: params.targetHeightRatio ?? options.targetHeightRatio,
    eyeHeightRatio: params.eyeHeightRatio ?? options.eyeHeightRatio,
  };
}

function avatarOrthographicProjection(renderHeight, renderWidth, aspect, params) {
  const safeAspect = Math.max(0.25, finiteNumber(aspect, 1));
  const explicitHeight = finitePositiveNumber(params.orthographicHeight ?? params.height);
  const framingHeight = explicitHeight ?? Math.max(renderHeight, renderWidth / safeAspect);
  const padding = Math.max(0, Math.min(4, finiteNumber(params.orthographicPadding ?? params.padding, 0.12)));
  const zoom = Math.max(0.25, Math.min(4, finiteNumber(params.orthographicZoom ?? params.zoom, 1)));
  const viewHeight = (Math.max(0.01, framingHeight) / zoom) * (1 + padding * 2);
  const halfHeight = viewHeight * 0.5;
  const halfWidth = halfHeight * safeAspect;
  return mat4Orthographic(-halfWidth, halfWidth, -halfHeight, halfHeight, 0.05, 32);
}

function mat4Orthographic(left, right, bottom, top, near, far) {
  const width = Math.max(0.0001, right - left);
  const height = Math.max(0.0001, top - bottom);
  const depth = Math.max(0.0001, far - near);
  const out = new Float32Array(16);
  out[0] = 2 / width;
  out[5] = 2 / height;
  out[10] = -2 / depth;
  out[12] = -(right + left) / width;
  out[13] = -(top + bottom) / height;
  out[14] = -(far + near) / depth;
  out[15] = 1;
  return out;
}

function resizeCanvas(canvas, gl, state) {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(rect.width || canvas.clientWidth || 220));
  const cssHeight = Math.max(1, Math.floor(rect.height || canvas.clientHeight || 220));
  const dpr = Math.max(1, Math.min(state.maxPixelRatio, globalThis.devicePixelRatio || 1));
  const width = Math.max(1, Math.floor(cssWidth * dpr));
  const height = Math.max(1, Math.floor(cssHeight * dpr));
  if (canvas.width === width && canvas.height === height && state.lastWidth === width && state.lastHeight === height) return false;
  canvas.width = width;
  canvas.height = height;
  state.lastWidth = width;
  state.lastHeight = height;
  gl.viewport(0, 0, width, height);
  return true;
}

function disposeHandle(gl, handle) {
  if (!gl || !handle) return;
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  if (handle.vbo) gl.deleteBuffer(handle.vbo);
  if (handle.ibo) gl.deleteBuffer(handle.ibo);
  if (handle.vao) gl.deleteVertexArray(handle.vao);
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("NiceChunk avatar preview shader link failed:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("NiceChunk avatar preview shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveNumber(value, fallback) {
  return finitePositiveNumber(value) ?? fallback;
}

function validVector3(value) {
  return (Array.isArray(value) || ArrayBuffer.isView(value))
    && value.length === 3
    && [value[0], value[1], value[2]].every((coordinate) => Number.isFinite(Number(coordinate)));
}
