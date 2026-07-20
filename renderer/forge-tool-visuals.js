import { FORGE_MESH_VERTEX_STRIDE_BYTES, FORGE_RENDER_POSITION_SCALE } from "../forge/forge-mesher.js";

export const FORGE_TOOL_VISUAL_IDS = Object.freeze([
  "hammer",
  "saw",
  "handDrill",
  "grip",
  "axe",
  "paintBrush",
]);

const TOOL_ALIASES = Object.freeze({
  drill: "handDrill",
  handdrill: "handDrill",
  taper: "axe",
  paint: "paintBrush",
  paintbrush: "paintBrush",
});

const HAMMER_STRIKE_POINT = Object.freeze([0.46, 1.34, 0]);
const AXE_STRIKE_POINT = Object.freeze([0.58, 1.25, 0]);
const PAINT_TIP_POINT = Object.freeze([0.28, 0, 0]);
const IDENTITY_BASIS = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function normalizeForgeToolVisualId(value, fallback = "gloves") {
  const text = String(value ?? "");
  if (text === "gloves" || FORGE_TOOL_VISUAL_IDS.includes(text)) return text;
  return TOOL_ALIASES[text.toLowerCase()] ?? fallback;
}

export function createForgeToolVisualMesh(value) {
  const toolId = normalizeForgeToolVisualId(value, "");
  if (!toolId || toolId === "gloves") return null;
  const builder = createBuilder();
  if (toolId === "hammer") appendHammer(builder);
  else if (toolId === "saw") appendSaw(builder);
  else if (toolId === "handDrill") appendHandDrill(builder);
  else if (toolId === "grip") appendGripHand(builder);
  else if (toolId === "axe") appendAxe(builder);
  else if (toolId === "paintBrush") appendPaintBrush(builder);
  else return null;
  return finishBuilder(builder, toolId);
}

export function forgeToolActionDuration(value, options = {}) {
  const explicit = Number(options.durationSeconds ?? options.duration);
  if (Number.isFinite(explicit)) return clamp(explicit, 0.08, 5);
  const toolId = normalizeForgeToolVisualId(value, "");
  if (toolId === "hammer" || toolId === "axe") return 0.55;
  if (toolId === "saw" || toolId === "handDrill") return 0.54;
  if (toolId === "grip") return 0.28;
  if (toolId === "paintBrush") return 0.34;
  return 0;
}

export function normalizeForgeToolVisualHit(hit) {
  if (!hit) return null;
  const point = finiteVector3(hit.point);
  if (!point) return null;
  const face = hit.face ?? hit;
  const axis = integerInRange(face.axis ?? hit.axis, 0, 2);
  const side = normalizeSide(face.side ?? hit.side);
  let normal = finiteVector3(face.normal ?? hit.normal);
  if (!normal || lengthSquared(normal) < 1e-12) {
    if (axis == null || side == null) return null;
    normal = [0, 0, 0];
    normal[axis] = side ? 1 : -1;
  }
  normal = normalize(normal);
  const resolvedAxis = axis ?? dominantAxis(normal);
  const resolvedSide = side ?? (normal[resolvedAxis] >= 0 ? 1 : 0);
  const index = Number(hit.index);
  return {
    ...hit,
    index: Number.isInteger(index) && index >= 0 ? index : -1,
    point,
    localPoint: finiteVector3(hit.localPoint),
    axis: resolvedAxis,
    side: resolvedSide,
    normal,
    face: { ...face, axis: resolvedAxis, side: resolvedSide, normal: [...normal] },
  };
}

export function sameForgeToolVisualHit(left, right, epsilon = 1e-6) {
  if (!left || !right) return left === right;
  const a = normalizeForgeToolVisualHit(left);
  const b = normalizeForgeToolVisualHit(right);
  if (!a || !b) return a === b;
  return a.index === b.index
    && a.axis === b.axis
    && a.side === b.side
    && vectorsNear(a.point, b.point, epsilon);
}

export function sampleForgeToolVisualPose(value, input = {}) {
  const toolId = normalizeForgeToolVisualId(value, "");
  const hit = normalizeForgeToolVisualHit(input.hit);
  if (!toolId || toolId === "gloves" || !hit) return null;
  const elapsed = Math.max(0, Number(input.elapsedSeconds ?? input.elapsed) || 0);
  const duration = Math.max(0.001, Number(input.durationSeconds ?? input.duration)
    || forgeToolActionDuration(toolId, input.settings));
  const progress = clamp(elapsed / duration, 0, 1);
  const camera = finiteVector3(input.cameraEye) ?? add(hit.point, scale(hit.normal, 6));
  const preview = Boolean(input.preview);
  const settings = input.settings ?? {};
  let pose;
  if (toolId === "hammer") pose = sampleSwingTool(hit, camera, preview, progress, HAMMER_STRIKE_POINT, "hammer");
  else if (toolId === "axe") pose = sampleSwingTool(hit, camera, preview, progress, AXE_STRIKE_POINT, "axe");
  else if (toolId === "saw") pose = sampleSaw(hit, settings, elapsed);
  else if (toolId === "handDrill") pose = sampleDrill(hit, elapsed);
  else if (toolId === "grip") pose = sampleGrip(hit, settings, preview, progress);
  else if (toolId === "paintBrush") pose = samplePaintBrush(hit, camera, preview, progress);
  if (!pose) return null;
  return {
    toolId,
    basis: pose.basis ?? [...IDENTITY_BASIS],
    translation: pose.translation ?? [...hit.point],
    opacity: clamp(Number(pose.opacity ?? 1), 0, 1),
    unlit: clamp(Number(pose.unlit ?? 0), 0, 1),
    tint: finiteVector3(pose.tint) ?? [1, 1, 1],
    tintMix: clamp(Number(pose.tintMix ?? 0), 0, 1),
    spinComponentIndex: Number.isInteger(pose.spinComponentIndex) ? pose.spinComponentIndex : -1,
    spinRadians: Number(pose.spinRadians) || 0,
    elapsed,
    duration,
    progress,
    preview,
  };
}

function appendHammer(builder) {
  appendBox(builder, [0, 1.34, 0], [0.92, 0.28, 0.36], 0x8d9390, 255, 0);
  appendBox(builder, [0, 0.64, 0], [0.16, 1.28, 0.16], 0x5a3724, 255, 1);
}

function appendSaw(builder) {
  appendBox(builder, [0, 0, 0], [1.08, 0.08, 0.20], 0xc8d0c9, 255, 0);
  appendBox(builder, [0, -0.07, 0.07], [1.02, 0.05, 0.06], 0x8f9893, 255, 1);
  appendBox(builder, [-0.64, 0.02, 0], [0.28, 0.18, 0.32], 0x6b3f25, 255, 2);
  for (let tooth = 0; tooth < 8; tooth += 1) {
    appendTriangularTooth(builder, [-0.43 + tooth * 0.12, -0.115, 0.09], 0.105, 0.075, 0.05, 0x727c77, 1);
  }
}

function appendHandDrill(builder) {
  appendTaperedCylinderX(builder, [0.30, 0, 0], 0.72, 0.08, 0.055, 14, 0xb8c0bd, 255, 1);
  appendBox(builder, [-0.10, 0, 0], [0.34, 0.22, 0.22], 0x6b3f25, 255, 0);
  appendBox(builder, [-0.24, -0.35, 0], [0.12, 0.54, 0.12], 0x5a3724, 255, 0);
  appendBox(builder, [-0.10, 0.15, 0], [0.08, 0.20, 0.08], 0x9a6943, 255, 0);
}

function appendGripHand(builder) {
  const hand = 0x40ff88;
  const joint = 0x1f9d54;
  const palmDepth = 0.045;
  const rail = 0.035;
  appendBox(builder, [0, 0.16, 0], [0.34, rail, palmDepth], hand, 112, 0);
  appendBox(builder, [0.015, -0.16, 0], [0.34 * 0.74, rail, palmDepth], hand, 112, 0);
  appendBox(builder, [-0.155, -0.005, 0], [rail, 0.42 * 0.68, palmDepth], hand, 112, 0);
  appendBox(builder, [0.155, 0.01, 0], [rail, 0.42 * 0.62, palmDepth], hand, 112, 0);
  appendBox(builder, [0.02, -0.245, 0], [0.18, 0.08, palmDepth], joint, 140, 1);
  for (let index = 0; index < 4; index += 1) {
    const x = -0.12 + index * 0.08;
    const length = index === 0 || index === 3 ? 0.16 : 0.19;
    appendBox(builder, [x, 0.255, -0.018], [0.045, length, 0.05], joint, 140, 1);
    appendBox(builder, [x, 0.255 + length * 0.58, -0.03], [0.04, length * 0.72, 0.045], hand, 112, 0);
    appendBox(builder, [x, 0.255 + length * 0.98, -0.054], [0.048, 0.028, 0.052], hand, 112, 0);
  }
  appendOrientedBox(builder, [-0.205, -0.035, -0.02], [0.055, 0.16, 0.05], [0, 0, -0.72], joint, 140, 1);
  appendOrientedBox(builder, [-0.25, 0.06, -0.04], [0.052, 0.14, 0.048], [0, 0, -0.36], hand, 112, 0);
}

function appendAxe(builder) {
  appendBox(builder, [0, 0.62, 0], [0.16, 1.24, 0.16], 0x5a3724, 255, 0);
  appendBox(builder, [0.12, 1.24, 0], [0.62, 0.34, 0.22], 0x9ea6a8, 255, 1);
  appendWedgeX(builder, [0.48, 1.24, 0], [0.34, 0.50, 0.13], 0xd6ddd8, 255, 1);
}

function appendPaintBrush(builder) {
  appendBox(builder, [-0.54, 0, 0], [0.82, 0.12, 0.12], 0x6b3f25, 255, 0);
  appendBox(builder, [-0.08, 0, 0], [0.18, 0.25, 0.17], 0xd8d0bd, 255, 1);
  appendBox(builder, [0.14, 0, 0], [0.28, 0.32, 0.13], 0xf0cf4f, 245, 2);
  appendBox(builder, [0.255, 0, 0], [0.06, 0.28, 0.11], 0x4bd6c8, 232, 2);
}

function sampleSwingTool(hit, cameraEye, preview, progress, strikePoint, toolId) {
  const normal = hit.normal;
  const approach = scale(normal, -1);
  const base = basisFromUnitVectors([1, 0, 0], approach);
  const viewDirection = normalize(subtract(cameraEye, hit.point));
  let tangent = subtract(viewDirection, scale(normal, dot(viewDirection, normal)));
  if (lengthSquared(tangent) < 1e-8) tangent = orthogonal(normal);
  tangent = normalize(tangent);
  const contactPoint = add(hit.point, scale(tangent, toolId === "hammer" ? 0.42 : 0.34));
  const translation = subtract(contactPoint, transformBasis(base, strikePoint));
  let angle;
  if (preview) angle = -0.58;
  else if (progress < 0.62) angle = mix(-0.58, 0, progress / 0.62);
  else angle = mix(0, -0.20, (progress - 0.62) / 0.38);
  return { basis: rotateBasisLocalZ(base, angle), translation };
}

function sampleSaw(hit, settings, elapsed) {
  const normal = hit.normal;
  const normalAxis = dominantAxis(normal);
  const axes = [0, 1, 2].filter((axis) => axis !== normalAxis);
  const radians = (Number(settings.angle) || 0) * Math.PI / 180;
  const line = add(scale(axisVector(axes[0]), Math.cos(radians)), scale(axisVector(axes[1]), Math.sin(radians)));
  const side = normalize(cross(line, normal));
  const travel = Math.sin(elapsed * 28) * 0.24;
  return {
    basis: basisColumns(normalize(line), normalize(normal), side),
    translation: add(add(hit.point, scale(normal, 0.18)), scale(line, travel)),
  };
}

function sampleDrill(hit, elapsed) {
  const approach = scale(hit.normal, -1);
  const basis = basisFromUnitVectors([1, 0, 0], approach);
  const pulse = 0.06 + Math.sin(elapsed * 22) * 0.025;
  return {
    basis,
    translation: add(add(hit.point, scale(hit.normal, 0.36)), scale(approach, pulse)),
    spinComponentIndex: 1,
    spinRadians: elapsed * 42,
  };
}

function sampleGrip(hit, settings, preview, progress) {
  const approach = normalize(hit.normal);
  let front = Math.abs(approach[1]) < 0.75 ? [0, 1, 0] : [0, 0, -(Math.sign(approach[1]) || 1)];
  front = subtract(front, scale(approach, dot(front, approach)));
  if (lengthSquared(front) < 1e-8) front = orthogonal(approach);
  front = normalize(front);
  const quarterTurns = Number(settings.rotation ?? settings.rotationStep ?? 0) || 0;
  const angle = Number(settings.angleRadians) || quarterTurns * Math.PI / 2;
  if (angle) front = rotateAroundAxis(front, approach, angle);
  const side = normalize(cross(front, approach));
  const press = preview ? 0 : Math.sin(progress * Math.PI) * 0.024;
  const translation = add(add(hit.point, scale(approach, 0.1076 - press)), scale(front, 0.015));
  const valid = settings.valid !== false;
  return {
    basis: basisColumns(side, front, approach),
    translation,
    opacity: valid ? 0.86 : 0.92,
    unlit: 1,
    tint: valid ? [0.25, 1, 0.53] : [1, 0.36, 0.30],
    tintMix: valid ? 0.2 : 0.92,
  };
}

function samplePaintBrush(hit, cameraEye, preview, progress) {
  const normal = hit.normal;
  const approach = scale(normal, -1);
  const base = basisFromUnitVectors([1, 0, 0], approach);
  const view = normalize(subtract(cameraEye, hit.point));
  let tangent = subtract(view, scale(normal, dot(view, normal)));
  if (lengthSquared(tangent) < 1e-8) tangent = orthogonal(normal);
  tangent = normalize(tangent);
  const stroke = preview ? 0 : Math.sin(progress * Math.PI * 2) * 0.10;
  const contact = add(add(hit.point, scale(normal, 0.015)), scale(tangent, stroke));
  return {
    basis: base,
    translation: subtract(contact, transformBasis(base, PAINT_TIP_POINT)),
    opacity: 0.96,
  };
}

function createBuilder() {
  return { vertices: [], indices: [] };
}

function appendBox(builder, center, size, color, alpha, componentIndex) {
  const half = size.map((value) => value * 0.5);
  const min = center.map((value, axis) => value - half[axis]);
  const max = center.map((value, axis) => value + half[axis]);
  appendAxisQuad(builder, 0, 1, min, max, color, alpha, componentIndex);
  appendAxisQuad(builder, 0, 0, min, max, color, alpha, componentIndex);
  appendAxisQuad(builder, 1, 1, min, max, color, alpha, componentIndex);
  appendAxisQuad(builder, 1, 0, min, max, color, alpha, componentIndex);
  appendAxisQuad(builder, 2, 1, min, max, color, alpha, componentIndex);
  appendAxisQuad(builder, 2, 0, min, max, color, alpha, componentIndex);
}

function appendOrientedBox(builder, center, size, rotation, color, alpha, componentIndex) {
  const local = createBuilder();
  appendBox(local, [0, 0, 0], size, color, alpha, componentIndex);
  const basis = eulerBasis(rotation);
  const vertexOffset = builder.vertices.length;
  for (const vertex of local.vertices) {
    builder.vertices.push({
      ...vertex,
      point: add(transformBasis(basis, vertex.point), center),
      normal: normalize(transformBasis(basis, vertex.normal)),
    });
  }
  for (const index of local.indices) builder.indices.push(vertexOffset + index);
}

function appendAxisQuad(builder, axis, side, min, max, color, alpha, componentIndex) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  let corners;
  if (axis === 0 && side) corners = [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]];
  else if (axis === 0) corners = [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]];
  else if (axis === 1 && side) corners = [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]];
  else if (axis === 1) corners = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
  else if (side) corners = [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]];
  else corners = [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]];
  const normal = [0, 0, 0];
  normal[axis] = side ? 1 : -1;
  appendQuad(builder, corners, [normal, normal, normal, normal], color, alpha, componentIndex);
}

function appendTaperedCylinderX(builder, center, length, leftRadius, rightRadius, segments, color, alpha, componentIndex) {
  const leftX = center[0] - length * 0.5;
  const rightX = center[0] + length * 0.5;
  for (let index = 0; index < segments; index += 1) {
    const a = index * Math.PI * 2 / segments;
    const b = (index + 1) * Math.PI * 2 / segments;
    const leftA = [leftX, center[1] + Math.cos(a) * leftRadius, center[2] + Math.sin(a) * leftRadius];
    const rightA = [rightX, center[1] + Math.cos(a) * rightRadius, center[2] + Math.sin(a) * rightRadius];
    const rightB = [rightX, center[1] + Math.cos(b) * rightRadius, center[2] + Math.sin(b) * rightRadius];
    const leftB = [leftX, center[1] + Math.cos(b) * leftRadius, center[2] + Math.sin(b) * leftRadius];
    const normalA = normalize([(leftRadius - rightRadius) / length, Math.cos(a), Math.sin(a)]);
    const normalB = normalize([(leftRadius - rightRadius) / length, Math.cos(b), Math.sin(b)]);
    appendQuad(builder, [leftA, leftB, rightB, rightA], [normalA, normalB, normalB, normalA], color, alpha, componentIndex);
    appendTriangle(builder, [[leftX, center[1], center[2]], leftB, leftA], [[-1, 0, 0], [-1, 0, 0], [-1, 0, 0]], color, alpha, componentIndex);
    appendTriangle(builder, [[rightX, center[1], center[2]], rightA, rightB], [[1, 0, 0], [1, 0, 0], [1, 0, 0]], color, alpha, componentIndex);
  }
}

function appendTriangularTooth(builder, center, width, height, depth, color, componentIndex) {
  const x0 = center[0] - width * 0.5;
  const x1 = center[0] + width * 0.5;
  const y0 = center[1] + height * 0.5;
  const y1 = center[1] - height * 0.5;
  const z0 = center[2] - depth * 0.5;
  const z1 = center[2] + depth * 0.5;
  const points = [[x0, y0, z0], [x1, y0, z0], [center[0], y1, z0], [x0, y0, z1], [x1, y0, z1], [center[0], y1, z1]];
  appendTriangle(builder, [points[0], points[2], points[1]], [[0, 0, -1], [0, 0, -1], [0, 0, -1]], color, 255, componentIndex);
  appendTriangle(builder, [points[3], points[4], points[5]], [[0, 0, 1], [0, 0, 1], [0, 0, 1]], color, 255, componentIndex);
  appendQuad(builder, [points[0], points[3], points[5], points[2]], [[-0.7, -0.7, 0], [-0.7, -0.7, 0], [-0.7, -0.7, 0], [-0.7, -0.7, 0]], color, 255, componentIndex);
  appendQuad(builder, [points[1], points[2], points[5], points[4]], [[0.7, -0.7, 0], [0.7, -0.7, 0], [0.7, -0.7, 0], [0.7, -0.7, 0]], color, 255, componentIndex);
}

function appendWedgeX(builder, center, size, color, alpha, componentIndex) {
  const hx = size[0] * 0.5;
  const hy = size[1] * 0.5;
  const hz = size[2] * 0.5;
  const x0 = center[0] - hx;
  const x1 = center[0] + hx;
  const points = [
    [x0, center[1] - hy, center[2] - hz], [x0, center[1] + hy, center[2] - hz], [x1, center[1], center[2] - hz],
    [x0, center[1] - hy, center[2] + hz], [x0, center[1] + hy, center[2] + hz], [x1, center[1], center[2] + hz],
  ];
  appendTriangle(builder, [points[0], points[2], points[1]], [[0, 0, -1], [0, 0, -1], [0, 0, -1]], color, alpha, componentIndex);
  appendTriangle(builder, [points[3], points[4], points[5]], [[0, 0, 1], [0, 0, 1], [0, 0, 1]], color, alpha, componentIndex);
  appendQuad(builder, [points[0], points[3], points[5], points[2]], [[0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0]], color, alpha, componentIndex);
  appendQuad(builder, [points[1], points[2], points[5], points[4]], [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]], color, alpha, componentIndex);
  appendQuad(builder, [points[0], points[1], points[4], points[3]], [[-1, 0, 0], [-1, 0, 0], [-1, 0, 0], [-1, 0, 0]], color, alpha, componentIndex);
}

function appendQuad(builder, points, normals, color, alpha, componentIndex) {
  const base = builder.vertices.length;
  for (let index = 0; index < 4; index += 1) appendVertex(builder, points[index], normals[index], color, alpha, componentIndex);
  builder.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function appendTriangle(builder, points, normals, color, alpha, componentIndex) {
  const base = builder.vertices.length;
  for (let index = 0; index < 3; index += 1) appendVertex(builder, points[index], normals[index], color, alpha, componentIndex);
  builder.indices.push(base, base + 1, base + 2);
}

function appendVertex(builder, point, normal, color, alpha, componentIndex) {
  builder.vertices.push({ point, normal: normalize(normal), color, alpha, componentIndex });
}

function finishBuilder(builder, toolId) {
  const data = new Uint8Array(builder.vertices.length * FORGE_MESH_VERTEX_STRIDE_BYTES);
  const view = new DataView(data.buffer);
  for (let index = 0; index < builder.vertices.length; index += 1) {
    const vertex = builder.vertices[index];
    const cursor = index * FORGE_MESH_VERTEX_STRIDE_BYTES;
    const packed = vertex.point.map((value) => Math.round(value * FORGE_RENDER_POSITION_SCALE));
    if (packed.some((value) => value < -32768 || value > 32767)) throw new RangeError(`Forge tool ${toolId} exceeds packed render coordinates.`);
    view.setInt16(cursor, packed[0], true);
    view.setInt16(cursor + 2, packed[1], true);
    view.setInt16(cursor + 4, packed[2], true);
    view.setInt8(cursor + 6, Math.round(clamp(vertex.normal[0], -1, 1) * 127));
    view.setInt8(cursor + 7, Math.round(clamp(vertex.normal[1], -1, 1) * 127));
    view.setInt8(cursor + 8, Math.round(clamp(vertex.normal[2], -1, 1) * 127));
    view.setUint8(cursor + 9, 255);
    view.setUint8(cursor + 10, vertex.color >> 16 & 255);
    view.setUint8(cursor + 11, vertex.color >> 8 & 255);
    view.setUint8(cursor + 12, vertex.color & 255);
    view.setUint8(cursor + 13, clamp(Math.round(vertex.alpha), 0, 255));
    view.setUint16(cursor + 14, clamp(Math.round(vertex.componentIndex), 0, 0xffff), true);
  }
  const indices = builder.vertices.length > 65535 ? new Uint32Array(builder.indices) : new Uint16Array(builder.indices);
  return {
    toolId,
    vertices: data,
    indices,
    vertexStrideBytes: FORGE_MESH_VERTEX_STRIDE_BYTES,
    vertexCount: builder.vertices.length,
    indexCount: indices.length,
    triangleCount: indices.length / 3,
    byteLength: data.byteLength + indices.byteLength,
    pickBounds: [],
  };
}

function basisFromUnitVectors(from, to) {
  const source = normalize(from);
  const target = normalize(to);
  let w = dot(source, target) + 1;
  let xyz;
  if (w < 1e-7) {
    w = 0;
    xyz = Math.abs(source[0]) > Math.abs(source[2]) ? [-source[1], source[0], 0] : [0, -source[2], source[1]];
  } else {
    xyz = cross(source, target);
  }
  const length = Math.hypot(xyz[0], xyz[1], xyz[2], w) || 1;
  return quaternionBasis([xyz[0] / length, xyz[1] / length, xyz[2] / length, w / length]);
}

function quaternionBasis([x, y, z, w]) {
  const xx = x * x; const yy = y * y; const zz = z * z;
  const xy = x * y; const xz = x * z; const yz = y * z;
  const wx = w * x; const wy = w * y; const wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy),
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx),
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy),
  ];
}

function eulerBasis(rotation) {
  const [x, y, z] = rotation;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  return [
    cy * cz, cy * sz, -sy,
    sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy,
    cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy,
  ];
}

function rotateBasisLocalZ(basis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = basis.slice(0, 3);
  const y = basis.slice(3, 6);
  const z = basis.slice(6, 9);
  return basisColumns(add(scale(x, cosine), scale(y, sine)), add(scale(x, -sine), scale(y, cosine)), z);
}

function basisColumns(x, y, z) {
  return [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
}

function transformBasis(basis, vector) {
  return [
    basis[0] * vector[0] + basis[3] * vector[1] + basis[6] * vector[2],
    basis[1] * vector[0] + basis[4] * vector[1] + basis[7] * vector[2],
    basis[2] * vector[0] + basis[5] * vector[1] + basis[8] * vector[2],
  ];
}

function rotateAroundAxis(vector, axis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return add(add(scale(vector, cosine), scale(cross(axis, vector), sine)), scale(axis, dot(axis, vector) * (1 - cosine)));
}

function axisVector(axis) {
  const out = [0, 0, 0];
  out[axis] = 1;
  return out;
}

function orthogonal(vector) {
  const reference = Math.abs(vector[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(reference, vector));
}

function finiteVector3(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const result = Array.from(value).slice(0, 3).map(Number);
  return result.length === 3 && result.every(Number.isFinite) ? result : null;
}

function integerInRange(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function normalizeSide(value) {
  if (value === "high" || value === "positive") return 1;
  if (value === "low" || value === "negative") return 0;
  return integerInRange(value, 0, 1);
}

function dominantAxis(value) {
  let axis = 0;
  if (Math.abs(value[1]) > Math.abs(value[axis])) axis = 1;
  if (Math.abs(value[2]) > Math.abs(value[axis])) axis = 2;
  return axis;
}

function normalize(value) {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(value, amount) {
  return [value[0] * amount, value[1] * amount, value[2] * amount];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function lengthSquared(value) {
  return dot(value, value);
}

function vectorsNear(a, b, epsilon) {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon && Math.abs(a[2] - b[2]) <= epsilon;
}

function mix(a, b, amount) {
  return a + (b - a) * amount;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
