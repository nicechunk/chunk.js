import {
  createEquipmentModelParts,
  EQUIPMENT_MODEL_ID,
  forgedPickaxePalette,
} from "./equipment-model.js";
import { decodeNcm4 } from "../ncm/character-codec.js";
import {
  ncm4PartGroupVisible,
  ncm4RotationForBone,
  sampleNcm4Action,
} from "./avatar-action.js";

export {
  ncm4PartGroupVisible,
  resolveNcm4Action,
  sampleNcm4Action,
} from "./avatar-action.js";

export const PEASANT_GUY_NCM_URLS = [
  "/media/vox/chr_peasant_guy_blackhair.ncm",
  "/public/media/vox/chr_peasant_guy_blackhair.ncm",
];

export const DEFAULT_PEASANT_GUY_NCM =
  "NCM2:ICAgCTgIERERM6a4OjImfVMsx4VQ17mO4aZ5___7cM4GABCdDQDkuQoASHQVAKAWKSBAM1JAgJykgABJSQEBaq6CITRfBSPoySoIkGsXBKDYbghA010QgF7DIQDFlgEAYi4DAORcBmBIugzAUHMagKDntABD7mkAgFjbAIA5BwIQiw4EIOZeCCAsvhBAmHsMmDD5GDBhDzJhwNqLIITNF0EIfK-JAXheLCHwvQgAYHwRAED6Ygmh7omQQuMTIYXCl4AIfY8JAAxfBAe4PBlA8HsSAOD4JADA-skAgiGcoAA7RwkAdo8GIhwfDUQYRgoIMHQVDGDnbgjA0d0QwJ2rAIBLVwEA";

export const BUILTIN_AVATAR_MODEL_CODES = new Map([
  ["", DEFAULT_PEASANT_GUY_NCM],
  ["NCM:peasant_guy:v1", DEFAULT_PEASANT_GUY_NCM],
  ["NCM:peasant_guy_blackhair:v1", DEFAULT_PEASANT_GUY_NCM],
  ["peasant_guy", DEFAULT_PEASANT_GUY_NCM],
]);

const AVATAR_VERTEX_STRIDE_FLOATS = 10;
const BASIC_PICKAXE_EQUIPMENT_ID = EQUIPMENT_MODEL_ID.basicPickaxe;
const FORGED_PICKAXE_EQUIPMENT_ID = EQUIPMENT_MODEL_ID.forgedPickaxe;
const BLUEPRINT_EQUIPMENT_ID = EQUIPMENT_MODEL_ID.blueprint;
export const FORGE_AVATAR_GRIP_EMBED_DEPTH = 0.025;
const DEFAULT_RIGHT_HAND_POSE = Object.freeze({ carryZ: 0, miningZ: -0.2 });
const FORGED_POSE_CLEARANCE = 0.008;
const FORGED_POSE_STEP = 0.025;
const FORGED_POSE_MAX_Z = 0.75;
const FORGED_CARRY_ARM_X_SAMPLES = Object.freeze([-0.32, -0.24, -0.16, -0.08, 0, 0.08, 0.16, 0.24, 0.32]);
const FORGED_MINING_ARM_X_SAMPLES = Object.freeze(Array.from(
  { length: 32 },
  (_, index) => -1.4 + index * 0.15,
));

export function forgeAvatarTargetGrip(handAnchor, avatarScale = 1) {
  const anchor = Array.isArray(handAnchor) || ArrayBuffer.isView(handAnchor)
    ? Array.from(handAnchor).slice(0, 3).map(Number)
    : [];
  if (anchor.length !== 3 || anchor.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Forge avatar hand anchor must contain three finite coordinates.");
  }
  const scale = Math.max(0.1, Number(avatarScale) || 1);
  return [anchor[0], anchor[1] + FORGE_AVATAR_GRIP_EMBED_DEPTH * scale, anchor[2]];
}

export async function loadPeasantGuyAvatarMesh(options = {}) {
  const urls = options.urls ?? PEASANT_GUY_NCM_URLS;
  let code = options.ncmCode ?? "";
  if (!code && options.fetchModel && typeof fetch === "function") {
    for (const url of urls) {
      try {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) continue;
        code = (await response.text()).trim();
        if (code) break;
      } catch {
        // Local direct-file demos may not expose /media. Fall back to embedded NCM below.
      }
    }
  }
  return createAvatarMeshFromNcm(code || DEFAULT_PEASANT_GUY_NCM, options);
}

export function createAvatarMeshFromNcm(ncmCode, {
  scale = 1,
  name = "peasant_guy",
  attachIronPickaxe = false,
  attachForgedPickaxe = attachIronPickaxe,
  forgeRuntime = null,
} = {}) {
  const resolvedCode = resolveAvatarNcmCode(ncmCode);
  if (/^NCM4:/i.test(resolvedCode)) {
    return createAvatarMeshFromNcm4Character(decodeNcm4(resolvedCode), { scale, name });
  }
  const character = decodeNcm(resolvedCode);
  const unit = character.unit || 100;
  const modelBounds = boundsOfNcmBoxes(character.boxes);
  const sourceParts = character.boxes.map((part) => toRuntimePart(part, unit, modelBounds));
  const bounds = boundsOfParts(sourceParts);
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const bodyParts = sourceParts.map((part) => ({
    ...part,
    cx: (part.cx - centerX) * scale,
    cy: (part.cy - bounds.minY) * scale,
    cz: (part.cz - centerZ) * scale,
    sx: part.sx * scale,
    sy: part.sy * scale,
    sz: part.sz * scale,
  }));
  const runtimeBounds = boundsOfParts(bodyParts);
  const rig = avatarRig(bodyParts, runtimeBounds);
  addAvatarToolRig(rig);
  const restoredForge = attachIronPickaxe && attachForgedPickaxe
    ? createRestoredForgeEquipment(bodyParts, runtimeBounds, rig, scale, forgeRuntime)
    : null;
  const equipmentParts = attachIronPickaxe
    ? [
        ...createBasicIronPickaxeParts(bodyParts, runtimeBounds, rig, scale),
        ...(attachForgedPickaxe
          ? restoredForge?.parts ?? createForgedPickaxeParts(bodyParts, runtimeBounds, rig, scale)
          : []),
        ...createBlueprintParts(bodyParts, runtimeBounds, rig, scale),
        ...createHeldBlockParts(bodyParts, runtimeBounds, rig, scale),
      ]
    : [];
  const runtimeParts = equipmentParts.length ? bodyParts.concat(equipmentParts) : bodyParts;
  const collisionParts = equipmentParts
    .filter((part) => part?.toolCollisionPart !== false && !part?.geometry)
    .concat(restoredForge?.collisionParts ?? []);
  const renderBounds = boundsOfParts(runtimeParts);
  const vertices = [];
  const indices = [];
  for (const part of runtimeParts) appendPart(vertices, indices, part);
  const vertexArray = new Float32Array(vertices);
  const mesh = {
    name,
    modelScale: scale,
    vertices: vertexArray,
    runtimeVertices: new Float32Array(vertexArray.length),
    indices: indices.length > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    vertexCount: vertices.length / AVATAR_VERTEX_STRIDE_FLOATS,
    indexCount: indices.length,
    triangleCount: indices.length / 3,
    bounds: {
      height: runtimeBounds.maxY - runtimeBounds.minY,
      width: Math.max(runtimeBounds.maxX - runtimeBounds.minX, runtimeBounds.maxZ - runtimeBounds.minZ),
    },
    renderBounds,
    equipment: summarizeEquipmentParts(equipmentParts),
    equipmentPoses: restoredForge
      ? { [FORGED_PICKAXE_EQUIPMENT_ID]: restoredForge.pose }
      : {},
    parts: runtimeParts,
    ...(restoredForge ? { collisionParts } : {}),
    pivots: rig.pivots,
    boneOffsets: rig.boneOffsets,
    handAnchors: rig.handAnchors,
    vertexStrideBytes: AVATAR_VERTEX_STRIDE_FLOATS * 4,
  };
  return mesh;
}

// Validates a restored forge model in the same bind pose and grip transform
// used by Play. Arm contact is intentional; intersections with the head,
// torso, or legs make the grip invalid.
export function forgeRuntimeAvatarCollisionReport(runtime, {
  avatarMesh = null,
  avatarModelCode = DEFAULT_PEASANT_GUY_NCM,
  clearance = 0.006,
} = {}) {
  if (!runtime?.mesh || !runtime?.grip?.offsetQ) return emptyForgeAvatarCollisionReport();
  const mesh = avatarMesh ?? createAvatarMeshFromNcm(avatarModelCode, {
    attachIronPickaxe: false,
    attachForgedPickaxe: false,
  });
  const bodyParts = (mesh.parts ?? []).filter((part) => !part.equipment);
  const bodyBounds = boundsOfParts(bodyParts);
  const rightArm = boundsOfParts(bodyParts.filter((part) => part.bone === "right_arm"));
  const rightArmRoot = mesh.pivots?.right_hand_item;
  const rightHandAnchor = mesh.handAnchors?.right_hand_item;
  if (!Number.isFinite(rightArm.minX) || rightArm.maxX <= rightArm.minX || !Array.isArray(rightArmRoot)) {
    return emptyForgeAvatarCollisionReport();
  }

  const avatarHeight = Math.max(1, bodyBounds.maxY - bodyBounds.minY);
  const avatarScale = Math.max(0.1, Number.isFinite(mesh.modelScale) && mesh.modelScale > 0
    ? mesh.modelScale
    : avatarHeight / 2.52);
  const toolScale = Math.max(0.52, Math.min(1.02, avatarScale * 0.58));
  const handAnchor = Array.isArray(rightHandAnchor) ? rightHandAnchor : rightArmRoot;
  const targetGrip = forgeAvatarTargetGrip(handAnchor, avatarScale);
  const placement = forgeGripPlacement(runtime.grip, targetGrip, toolScale, runtime.fixedScale ?? 64);
  const avatarBoxes = bodyParts
    .filter((part) => !["left_arm", "right_arm", "right_hand_item"].includes(part.bone))
    .map((part) => ({ name: part.name || part.bone || "body", bounds: avatarRestPartBounds(part, mesh) }));
  const collisions = [];
  for (const itemBox of forgeRuntimeCollisionBoxes(runtime, placement, avatarBoxes, clearance)) {
    for (const avatarBox of avatarBoxes) {
      if (!boundsOverlap(itemBox, avatarBox.bounds, clearance)) continue;
      collisions.push({
        avatarPart: avatarBox.name,
        itemComponent: itemBox.componentIndex,
      });
      if (collisions.length >= 16) break;
    }
    if (collisions.length >= 16) break;
  }
  return {
    collides: collisions.length > 0,
    collisionCount: collisions.length,
    collisionParts: [...new Set(collisions.map((entry) => entry.avatarPart))],
    collisions,
  };
}

export function createAvatarMeshFromNcm4Character(character, {
  scale = 1,
  name = "ncm4_character",
} = {}) {
  if (!character || (!Array.isArray(character.cuboids) && !Array.isArray(character.boxes))) {
    throw new Error("Invalid NCM4 character geometry.");
  }
  const modelScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  const unit = Math.max(0.0001, Number(character.unit ?? character.unitScale ?? 1) || 1);
  const palette = Array.isArray(character.palette) ? character.palette : [];
  const sourceCuboids = character.cuboids ?? character.boxes;
  const sourceParts = sourceCuboids.map((cuboid, index) => ncm4RuntimePart(cuboid, palette, unit, index));
  const bodyParts = sourceParts.filter((part) => part.group === 0);
  const sourceBounds = boundsOfParts(bodyParts.length ? bodyParts : sourceParts);
  const centerX = (sourceBounds.minX + sourceBounds.maxX) * 0.5;
  const centerZ = (sourceBounds.minZ + sourceBounds.maxZ) * 0.5;
  const origin = [centerX, sourceBounds.minY, centerZ];
  const parts = sourceParts.map((part) => ({
    ...part,
    cx: (part.cx - origin[0]) * modelScale,
    cy: (part.cy - origin[1]) * modelScale,
    cz: (part.cz - origin[2]) * modelScale,
    sx: part.sx * modelScale,
    sy: part.sy * modelScale,
    sz: part.sz * modelScale,
  }));
  const skeleton = createNcm4Skeleton(character, unit, origin, modelScale, parts);
  for (const part of parts) part.boneIndex = ncm4BoneIndex(skeleton, part.bone);

  const renderBounds = boundsOfParts(parts);
  const vertices = [];
  const indices = [];
  for (const part of parts) appendPart(vertices, indices, part);
  const vertexArray = new Float32Array(vertices);
  const actions = Array.isArray(character.actions)
    ? character.actions
    : (Array.isArray(character.clips) ? character.clips : []);
  const pivots = {};
  for (const bone of skeleton.bones) {
    pivots[bone.name] = bone.pivot;
    pivots[String(bone.id)] = bone.pivot;
  }

  const mesh = {
    name,
    format: "NCM4",
    ncmVersion: Number(character.version ?? 1),
    vertices: vertexArray,
    runtimeVertices: new Float32Array(vertexArray.length),
    indices: indices.length > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    vertexCount: vertices.length / AVATAR_VERTEX_STRIDE_FLOATS,
    indexCount: indices.length,
    triangleCount: indices.length / 3,
    bounds: {
      height: renderBounds.maxY - renderBounds.minY,
      width: Math.max(renderBounds.maxX - renderBounds.minX, renderBounds.maxZ - renderBounds.minZ),
    },
    renderBounds,
    equipment: [],
    parts,
    pivots,
    boneOffsets: Object.fromEntries(skeleton.bones.map((bone) => [bone.name, [0, 0, 0]])),
    handAnchors: {},
    skeleton,
    actions,
    clips: actions,
    cuboidCount: parts.length,
    boneCount: skeleton.bones.length,
    actionCount: actions.length,
    vertexStrideBytes: AVATAR_VERTEX_STRIDE_FLOATS * 4,
  };
  mesh.vertices.set(updateNcm4AvatarMeshVertices(mesh, {}));
  return mesh;
}

export function decodeNcm(code) {
  const text = resolveAvatarNcmCode(code);
  if (!/^NCM2:/i.test(text)) throw new Error("Chunk.js avatar loader currently expects NCM2 model text.");
  const raw = base64UrlDecode(text.replace(/^NCM2:/i, ""));
  const reader = createByteReader(raw);
  const size = { x: readVar(reader), y: readVar(reader), z: readVar(reader) };
  const scale = readVar(reader);
  const count = readVar(reader);
  const paletteCount = readVar(reader);
  if (size.x <= 0 || size.y <= 0 || size.z <= 0 || scale <= 0 || paletteCount <= 0) throw new Error("Invalid NCM2 avatar payload.");
  const palette = Array.from({ length: paletteCount }, () => rgbToHex(reader.read(), reader.read(), reader.read()));
  const bitReader = createBitReader(raw, reader.offset());
  const colorBits = bitWidth(Math.max(0, palette.length - 1));
  const xBits = bitWidth(Math.max(0, size.x - 1));
  const yBits = bitWidth(Math.max(0, size.y - 1));
  const zBits = bitWidth(Math.max(0, size.z - 1));
  const cuboids = Array.from({ length: count }, () => ({
    color: palette[bitReader.read(colorBits)] ?? "#ffffff",
    x: bitReader.read(xBits),
    y: bitReader.read(yBits),
    z: bitReader.read(zBits),
    w: bitReader.read(xBits) + 1,
    h: bitReader.read(zBits) + 1,
    d: bitReader.read(yBits) + 1,
  }));
  return { v: 1, unit: 100, boxes: cuboidsToCharacterBoxes(cuboids, size, scale) };
}

export function resolveAvatarNcmCode(code) {
  const text = String(code ?? "").trim();
  if (BUILTIN_AVATAR_MODEL_CODES.has(text)) return BUILTIN_AVATAR_MODEL_CODES.get(text);
  if (/^NCM(?:2|4):/i.test(text)) return text;
  return text || DEFAULT_PEASANT_GUY_NCM;
}

// The arm and held item share the shoulder pivot. Applying the same Z delta to
// both keeps the forged grip on the palm while moving long tails clear of the
// torso. Per-model values are calculated once when the avatar mesh is built.
export function avatarRightHandRotations(mesh, equipmentId, {
  armX = 0,
  mining = false,
} = {}) {
  const stored = mesh?.equipmentPoses?.[String(equipmentId || "")];
  const pose = stored ?? DEFAULT_RIGHT_HAND_POSE;
  const fallbackZ = mining ? DEFAULT_RIGHT_HAND_POSE.miningZ : DEFAULT_RIGHT_HAND_POSE.carryZ;
  const candidateZ = Number(mining ? pose.miningZ : pose.carryZ);
  const z = Number.isFinite(candidateZ) ? candidateZ : fallbackZ;
  const x = Number.isFinite(Number(armX)) ? Number(armX) : 0;
  return {
    right_arm: { x, y: 0, z: -Math.PI / 2 + z },
    right_hand_item: { x, y: 0, z },
  };
}

function cuboidsToCharacterBoxes(sourceBoxes, size, scale) {
  const centerX = (size.x - 1) / 2;
  const centerY = (size.y - 1) / 2;
  return sourceBoxes.map((part, index) => {
    const minX = part.x;
    const minY = part.y;
    const minZ = part.z;
    const maxX = part.x + part.w - 1;
    const maxY = part.y + part.d - 1;
    const maxZ = part.z + part.h - 1;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    return {
      n: `ncm_${String(index).padStart(4, "0")}`,
      c: part.color,
      p: [Math.round((cx - centerX) * scale), Math.round((cz + 0.5) * scale), Math.round((centerY - cy) * scale)],
      s: [Math.max(1, Math.round(part.w * scale)), Math.max(1, Math.round(part.h * scale)), Math.max(1, Math.round(part.d * scale))],
      r: [0, 0, 0],
    };
  });
}

export function updateAvatarMeshVertices(mesh, animation = {}) {
  if (!mesh?.parts?.length || !mesh.runtimeVertices) return mesh?.vertices ?? null;
  if (mesh.format === "NCM4") return updateNcm4AvatarMeshVertices(mesh, animation);
  const out = mesh.runtimeVertices;
  let cursor = 0;
  const equipment = avatarEquipmentState(animation);
  const moving = Boolean(animation.moving);
  const t = Number(animation.timeMs ?? performance.now()) * 0.011;
  const clothTimeSeconds = Number(animation.timeMs ?? performance.now()) / 1_000;
  const reducedClothMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const clothMotionScale = Math.max(0, Math.min(2, Number(
    animation.clothMotionScale ?? (reducedClothMotion ? 0.28 : 1),
  ) || 0));
  const swing = moving ? Math.sin(t) * 0.32 : 0;
  const headYaw = moving ? Math.sin(t * 0.5) * 0.04 : Math.sin(t * 0.2) * 0.025;
  const rotations = {
    left_arm: { x: swing, y: 0, z: Math.PI / 2 },
    ...avatarRightHandRotations(mesh, equipment.equipmentId, { armX: -swing }),
    left_leg: { x: -swing, y: 0 },
    right_leg: { x: swing, y: 0 },
    head: { x: 0, y: headYaw },
    torso: { x: 0, y: 0 },
  };
  const miningPose = resolveAvatarMiningPose(animation.miningProgress ?? 0, animation.miningAimPitch ?? 0);
  if (miningPose.active) {
    Object.assign(rotations, avatarRightHandRotations(mesh, equipment.equipmentId, {
      armX: miningPose.armX,
      mining: true,
    }));
  }
  const offsets = mesh.boneOffsets ?? {};
  for (const part of mesh.parts) {
    const equipmentVisible = avatarEquipmentPartVisible(part, equipment);
    const colorOverride = avatarEquipmentPartColor(part, equipment);
    const pivot = mesh.pivots[part.bone] ?? mesh.pivots.torso;
    const rotation = rotations[part.bone] ?? rotations.torso;
    const offset = offsets[part.bone] ?? offsets.torso;
    cursor = part.geometry
      ? appendGeometryToArray(out, cursor, part, pivot, rotation, offset, {
          hidden: !equipmentVisible,
          clothTimeSeconds,
          clothMotionScale,
        })
      : appendBoxToArray(out, cursor, part, pivot, rotation, offset, { hidden: !equipmentVisible, color: colorOverride });
  }
  return out;
}

function toRuntimePart(part, unit, modelBounds) {
  return {
    cx: part.p[0] / unit,
    cy: part.p[1] / unit,
    cz: -part.p[2] / unit,
    sx: part.s[0] / unit,
    sy: part.s[1] / unit,
    sz: part.s[2] / unit,
    color: hexToColor(part.c),
    bone: inferNcmAvatarBone(part, modelBounds),
  };
}

function ncm4RuntimePart(cuboid, palette, unit, index) {
  const origin = vector3(cuboid.origin ?? cuboid.position ?? cuboid.p, [0, 0, 0]);
  const size = vector3(
    cuboid.size ?? cuboid.s,
    [cuboid.w ?? 1, cuboid.h ?? 1, cuboid.d ?? 1],
  ).map((value) => Math.max(0.0001, value));
  const paletteIndex = Math.max(0, Math.trunc(Number(cuboid.paletteIndex ?? cuboid.palette ?? 0) || 0));
  return {
    name: String(cuboid.name ?? `ncm4_${String(index).padStart(4, "0")}`),
    cx: (origin[0] + size[0] * 0.5) / unit,
    cy: (origin[1] + size[1] * 0.5) / unit,
    cz: (origin[2] + size[2] * 0.5) / unit,
    sx: size[0] / unit,
    sy: size[1] / unit,
    sz: size[2] / unit,
    color: hexToColor(cuboid.color ?? palette[paletteIndex] ?? "#ffffff"),
    bone: cuboid.bone ?? cuboid.boneId ?? 0,
    group: Math.max(0, Math.min(31, Math.trunc(Number(cuboid.group ?? cuboid.visibleGroup ?? 0) || 0))),
  };
}

function createNcm4Skeleton(character, unit, origin, scale, parts) {
  const source = Array.isArray(character.bones)
    ? character.bones
    : (Array.isArray(character.rig?.bones) ? character.rig.bones : []);
  const fallbackPivot = [
    0,
    Math.max(0, boundsOfParts(parts).maxY * 0.5),
    0,
  ];
  const bones = source.map((bone, index) => {
    const rawPivot = vector3(
      bone?.pivot ?? character.pivots?.[bone?.id] ?? character.pivots?.[bone?.name],
      null,
    );
    const pivot = rawPivot
      ? [
          (rawPivot[0] / unit - origin[0]) * scale,
          (rawPivot[1] / unit - origin[1]) * scale,
          (rawPivot[2] / unit - origin[2]) * scale,
        ]
      : fallbackPivot;
    return {
      id: bone?.id ?? index,
      name: String(bone?.name ?? `bone_${index}`),
      parentId: bone?.parent ?? bone?.parentId ?? -1,
      parent: -1,
      index,
      pivot,
    };
  });
  if (!bones.length) {
    bones.push({ id: 0, name: "root", parentId: -1, parent: -1, index: 0, pivot: fallbackPivot });
  }
  const indexes = new Map();
  for (const bone of bones) {
    indexes.set(String(bone.id), bone.index);
    indexes.set(bone.name, bone.index);
  }
  for (const bone of bones) {
    const parent = indexes.get(String(bone.parentId));
    bone.parent = parent === undefined || parent === bone.index ? -1 : parent;
  }
  return { bones, indexes };
}

function ncm4BoneIndex(skeleton, boneId) {
  const direct = skeleton.indexes.get(String(boneId));
  if (direct !== undefined) return direct;
  const numeric = Math.trunc(Number(boneId));
  return numeric >= 0 && numeric < skeleton.bones.length ? numeric : 0;
}

function updateNcm4AvatarMeshVertices(mesh, animation) {
  const out = mesh.runtimeVertices;
  const sample = sampleNcm4Action(mesh.actions, animation);
  let cursor = 0;
  for (const part of mesh.parts) {
    const visible = ncm4PartGroupVisible(part.group, sample.visibleGroupMask);
    cursor = visible
      ? appendNcm4BoxToArray(out, cursor, part, part.boneIndex, mesh.skeleton, sample.rotations)
      : appendCollapsedBoxToArray(out, cursor, mesh.skeleton.bones[part.boneIndex]?.pivot);
  }
  mesh.animation = {
    actionId: sample.action?.id ?? null,
    actionName: sample.action?.name ?? "",
    progress: sample.progress,
    visibleGroupMask: sample.visibleGroupMask,
  };
  return out;
}

function appendNcm4BoxToArray(out, cursor, box, boneIndex, skeleton, rotations) {
  const x0 = box.cx - box.sx * 0.5;
  const x1 = box.cx + box.sx * 0.5;
  const y0 = box.cy - box.sy * 0.5;
  const y1 = box.cy + box.sy * 0.5;
  const z0 = box.cz - box.sz * 0.5;
  const z1 = box.cz + box.sz * 0.5;
  const faces = [
    { n: [1, 0, 0], p: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]] },
    { n: [-1, 0, 0], p: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]] },
    { n: [0, 1, 0], p: [[x0, y1, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1]] },
    { n: [0, -1, 0], p: [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]] },
    { n: [0, 0, 1], p: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]] },
    { n: [0, 0, -1], p: [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]] },
  ];
  for (const face of faces) {
    for (const point of face.p) {
      const transformedPoint = transformNcm4Point(point, boneIndex, skeleton, rotations);
      const transformedNormal = transformNcm4Normal(face.n, boneIndex, skeleton, rotations);
      out[cursor++] = transformedPoint[0];
      out[cursor++] = transformedPoint[1];
      out[cursor++] = transformedPoint[2];
      out[cursor++] = transformedNormal[0];
      out[cursor++] = transformedNormal[1];
      out[cursor++] = transformedNormal[2];
      out[cursor++] = box.color[0];
      out[cursor++] = box.color[1];
      out[cursor++] = box.color[2];
      out[cursor++] = box.color[3];
    }
  }
  return cursor;
}

function transformNcm4Point(source, boneIndex, skeleton, rotations) {
  let point = source;
  let index = boneIndex;
  for (let depth = 0; index >= 0 && depth < skeleton.bones.length; depth += 1) {
    const bone = skeleton.bones[index];
    if (!bone) break;
    point = transformPoint(point, bone.pivot, ncm4RotationForBone(rotations, bone));
    index = bone.parent;
  }
  return point;
}

function transformNcm4Normal(source, boneIndex, skeleton, rotations) {
  let normal = source;
  let index = boneIndex;
  for (let depth = 0; index >= 0 && depth < skeleton.bones.length; depth += 1) {
    const bone = skeleton.bones[index];
    if (!bone) break;
    normal = transformNormal(normal, ncm4RotationForBone(rotations, bone));
    index = bone.parent;
  }
  return normal;
}

function vector3(value, fallback) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return [0, 1, 2].map((index) => finiteOr(value[index], fallback?.[index] ?? 0));
  }
  if (value && typeof value === "object") {
    return [
      finiteOr(value.x, fallback?.[0] ?? 0),
      finiteOr(value.y, fallback?.[1] ?? 0),
      finiteOr(value.z, fallback?.[2] ?? 0),
    ];
  }
  return fallback ? [...fallback] : null;
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function createBasicIronPickaxeParts(parts, bodyBounds, rig, scale = 1) {
  return createPickaxeParts(parts, bodyBounds, rig, scale, {
    equipmentId: BASIC_PICKAXE_EQUIPMENT_ID,
  });
}

function createForgedPickaxeParts(parts, bodyBounds, rig, scale = 1) {
  return createPickaxeParts(parts, bodyBounds, rig, scale, {
    equipmentId: FORGED_PICKAXE_EQUIPMENT_ID,
    forged: true,
  });
}

function createBlueprintParts(parts, bodyBounds, rig, scale = 1) {
  return createPickaxeParts(parts, bodyBounds, rig, scale, {
    equipmentId: BLUEPRINT_EQUIPMENT_ID,
    toolCollisionPart: false,
  });
}

function createRestoredForgeEquipment(parts, bodyBounds, rig, scale, runtime) {
  const packedMesh = runtime?.mesh;
  const grip = runtime?.grip;
  if (!packedMesh?.vertices?.byteLength || !packedMesh?.indices?.length || !grip?.offsetQ) return null;
  const rightArm = boundsOfParts(parts.filter((part) => part.bone === "right_arm"));
  const rightArmRoot = rig?.pivots?.right_hand_item;
  const rightHandAnchor = rig?.handAnchors?.right_hand_item;
  if (!Number.isFinite(rightArm.minX) || rightArm.maxX <= rightArm.minX || !Array.isArray(rightArmRoot)) return null;

  const avatarHeight = Math.max(1, bodyBounds.maxY - bodyBounds.minY);
  const avatarScale = Math.max(0.1, Number.isFinite(scale) && scale > 0 ? scale : avatarHeight / 2.52);
  const toolScale = Math.max(0.52, Math.min(1.02, avatarScale * 0.58));
  const handAnchor = Array.isArray(rightHandAnchor) ? rightHandAnchor : rightArmRoot;
  const targetGrip = forgeAvatarTargetGrip(handAnchor, avatarScale);
  const placement = forgeGripPlacement(grip, targetGrip, toolScale, runtime.fixedScale ?? 64);
  const clothComponentIndexes = Array.isArray(runtime.clothComponentIndexes)
    ? runtime.clothComponentIndexes
    : (runtime.components ?? [])
      .map((component, index) => component?.resourceId === "cloth" ? index : -1)
      .filter((index) => index >= 0);
  const geometry = unpackPlacedForgeGeometry(packedMesh, placement, { clothComponentIndexes });
  if (!geometry?.vertices?.length || !geometry?.indices?.length) return null;
  const bounds = boundsOfGeometryVertices(geometry.vertices);
  const renderPart = {
    name: "forgedDesign",
    cx: (bounds.minX + bounds.maxX) * 0.5,
    cy: (bounds.minY + bounds.maxY) * 0.5,
    cz: (bounds.minZ + bounds.maxZ) * 0.5,
    sx: Math.max(0.001, bounds.maxX - bounds.minX),
    sy: Math.max(0.001, bounds.maxY - bounds.minY),
    sz: Math.max(0.001, bounds.maxZ - bounds.minZ),
    color: [1, 1, 1, 1],
    bone: "right_hand_item",
    equipment: true,
    equipmentId: FORGED_PICKAXE_EQUIPMENT_ID,
    forgedTool: true,
    forgeDesignHash: runtime.designHash >>> 0,
    forgeMode: runtime.mode,
    gripBound: true,
    toolCollisionPart: false,
    miningHitPart: true,
    geometry,
  };
  const collisionParts = (packedMesh.pickBounds ?? []).map((pick, index) => {
    const placedBounds = placedForgeBounds(pick.min, pick.max, placement);
    return {
      name: `forgedCollision${index}`,
      cx: (placedBounds.minX + placedBounds.maxX) * 0.5,
      cy: (placedBounds.minY + placedBounds.maxY) * 0.5,
      cz: (placedBounds.minZ + placedBounds.maxZ) * 0.5,
      sx: Math.max(0.001, placedBounds.maxX - placedBounds.minX),
      sy: Math.max(0.001, placedBounds.maxY - placedBounds.minY),
      sz: Math.max(0.001, placedBounds.maxZ - placedBounds.minZ),
      color: [0, 0, 0, 0],
      bone: "right_hand_item",
      equipment: true,
      equipmentId: FORGED_PICKAXE_EQUIPMENT_ID,
      forgeDesignHash: runtime.designHash >>> 0,
      gripBound: true,
      toolCollisionPart: true,
      miningHitPart: true,
    };
  });
  return {
    parts: [renderPart],
    collisionParts,
    pose: createSafeForgedEquipmentPose(parts, collisionParts, rig, scale),
  };
}

function createSafeForgedEquipmentPose(bodyParts, collisionParts, rig, scale) {
  const pivot = rig?.pivots?.right_hand_item;
  if (!Array.isArray(pivot) || !collisionParts.length) return { ...DEFAULT_RIGHT_HAND_POSE };
  const rigMesh = { pivots: rig.pivots, boneOffsets: rig.boneOffsets };
  const avatarBoxes = bodyParts
    .filter((part) => !["left_arm", "right_arm", "right_hand_item"].includes(part.bone))
    .map((part) => avatarRestPartBounds(part, rigMesh));
  const clearance = FORGED_POSE_CLEARANCE * Math.max(0.1, Number(scale) || 1);
  return {
    carryZ: findSafeForgedPoseZ({
      startZ: DEFAULT_RIGHT_HAND_POSE.carryZ,
      armXSamples: FORGED_CARRY_ARM_X_SAMPLES,
      collisionParts,
      avatarBoxes,
      pivot,
      clearance,
    }),
    miningZ: findSafeForgedPoseZ({
      startZ: DEFAULT_RIGHT_HAND_POSE.miningZ,
      armXSamples: FORGED_MINING_ARM_X_SAMPLES,
      collisionParts,
      avatarBoxes,
      pivot,
      clearance,
    }),
    clearance,
    adaptive: true,
  };
}

function findSafeForgedPoseZ({ startZ, armXSamples, collisionParts, avatarBoxes, pivot, clearance }) {
  const stepCount = Math.ceil((FORGED_POSE_MAX_Z - startZ) / FORGED_POSE_STEP);
  for (let step = 0; step <= stepCount; step += 1) {
    const z = Math.min(FORGED_POSE_MAX_Z, startZ + step * FORGED_POSE_STEP);
    if (!forgedPoseCollides({ armXSamples, collisionParts, avatarBoxes, pivot, clearance, z })) {
      return Math.round(z * 1_000_000) / 1_000_000;
    }
  }
  return FORGED_POSE_MAX_Z;
}

function forgedPoseCollides({ armXSamples, collisionParts, avatarBoxes, pivot, clearance, z }) {
  for (const armX of armXSamples) {
    const rotation = { x: armX, y: 0, z };
    for (const part of collisionParts) {
      const itemBounds = avatarPartPoseBounds(part, pivot, rotation);
      if (avatarBoxes.some((bodyBounds) => boundsWithinClearance(itemBounds, bodyBounds, clearance))) return true;
    }
  }
  return false;
}

function forgeGripPlacement(grip, targetGrip, scale, fixedScale) {
  const approach = [0, 0, 0];
  approach[Math.max(0, Math.min(2, Math.trunc(grip.axis ?? 1)))] = Number(grip.sign) >= 0 ? 1 : -1;
  let front = Math.abs(approach[1]) < 0.75 ? [0, 1, 0] : [0, 0, -Math.sign(approach[1]) || -1];
  front = normalizeVector3(subtractVector3(front, scaleVector3(approach, dotVector3(front, approach))));
  const rotation = (Math.trunc(Number(grip.rotation) || 0) & 3) * Math.PI / 2;
  if (rotation) front = rotateAroundAxis(front, approach, rotation);
  const side = normalizeVector3(crossVector3(front, approach));
  return {
    source: { side, front, approach },
    target: { side: [1, 0, 0], front: [0, 0, -1], approach: [0, 1, 0] },
    grip: Array.from(grip.offsetQ, (value) => Number(value) / fixedScale),
    targetGrip,
    scale,
  };
}

function unpackPlacedForgeGeometry(mesh, placement, { clothComponentIndexes = [] } = {}) {
  const stride = mesh.vertexStrideBytes ?? 16;
  const positionScale = mesh.positionScale ?? 128;
  const source = new DataView(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength);
  const vertexCount = Math.floor(mesh.vertices.byteLength / stride);
  const vertices = new Float32Array(vertexCount * AVATAR_VERTEX_STRIDE_FLOATS);
  const clothIndexes = new Set(clothComponentIndexes.map((value) => Math.trunc(Number(value))).filter((value) => value >= 0 && value < 255));
  const clothVertexComponents = clothIndexes.size ? new Uint8Array(vertexCount).fill(255) : null;
  const clothComponentBounds = clothIndexes.size ? [] : null;
  if (clothComponentBounds) {
    for (const componentIndex of clothIndexes) {
      const bound = mesh.pickBounds?.find((candidate) => candidate.index === componentIndex);
      if (!bound) continue;
      const placed = placedForgeBounds(bound.min, bound.max, placement);
      const min = [placed.minX, placed.minY, placed.minZ];
      const max = [placed.maxX, placed.maxY, placed.maxZ];
      const span = max.map((value, axis) => Math.max(0.0001, value - min[axis]));
      const thinAxis = span[0] <= span[1] && span[0] <= span[2] ? 0 : span[1] <= span[2] ? 1 : 2;
      const anchorAxis = thinAxis !== 1 ? 1 : span[0] >= span[2] ? 0 : 2;
      clothComponentBounds[componentIndex] = { min, max, span, thinAxis, anchorAxis, anchorAtMax: anchorAxis === 1 };
    }
  }
  for (let index = 0; index < vertexCount; index += 1) {
    const packedOffset = index * stride;
    const outputOffset = index * AVATAR_VERTEX_STRIDE_FLOATS;
    const point = placeForgePoint([
      source.getInt16(packedOffset, true) / positionScale,
      source.getInt16(packedOffset + 2, true) / positionScale,
      source.getInt16(packedOffset + 4, true) / positionScale,
    ], placement);
    const normal = normalizeVector3(placeForgeVector([
      source.getInt8(packedOffset + 6) / 127,
      source.getInt8(packedOffset + 7) / 127,
      source.getInt8(packedOffset + 8) / 127,
    ], placement));
    vertices[outputOffset] = point[0];
    vertices[outputOffset + 1] = point[1];
    vertices[outputOffset + 2] = point[2];
    vertices[outputOffset + 3] = normal[0];
    vertices[outputOffset + 4] = normal[1];
    vertices[outputOffset + 5] = normal[2];
    vertices[outputOffset + 6] = source.getUint8(packedOffset + 10) / 255;
    vertices[outputOffset + 7] = source.getUint8(packedOffset + 11) / 255;
    vertices[outputOffset + 8] = source.getUint8(packedOffset + 12) / 255;
    vertices[outputOffset + 9] = source.getUint8(packedOffset + 13) / 255;
    const componentIndex = source.getUint16(packedOffset + 14, true);
    if (clothVertexComponents && clothIndexes.has(componentIndex) && clothComponentBounds[componentIndex]) {
      clothVertexComponents[index] = componentIndex;
    }
  }
  return {
    vertices,
    indices: mesh.indices,
    vertexCount,
    triangleCount: mesh.triangleCount ?? mesh.indices.length / 3,
    ...(clothVertexComponents ? { clothVertexComponents, clothComponentBounds } : {}),
  };
}

function placedForgeBounds(min, max, placement) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) includeBoundsPoint(bounds, placeForgePoint([x, y, z], placement));
    }
  }
  return bounds;
}

function forgeRuntimeCollisionBoxes(runtime, placement, avatarBoxes, clearance) {
  const boxes = [];
  const components = runtime.components ?? [];
  if (!components.length) {
    for (const pick of runtime.mesh.pickBounds ?? []) {
      const bounds = placedForgeBounds(pick.min, pick.max, placement);
      if (avatarBoxes.some((entry) => boundsOverlap(bounds, entry.bounds, clearance))) {
        boxes.push({ ...bounds, componentIndex: pick.index ?? 0 });
      }
    }
    return boxes;
  }

  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    const component = components[componentIndex];
    const pick = runtime.mesh.pickBounds?.[componentIndex];
    if (!pick) continue;
    const broadBounds = placedForgeBounds(pick.min, pick.max, placement);
    if (!avatarBoxes.some((entry) => boundsOverlap(broadBounds, entry.bounds, clearance))) continue;
    if (component.solid?.every((value) => value === 1)) {
      boxes.push({ ...broadBounds, componentIndex });
      continue;
    }
    const grid = [14, 10, 14];
    for (let z = 0; z < grid[2]; z += 1) {
      for (let y = 0; y < grid[1]; y += 1) {
        for (let x = 0; x < grid[0]; x += 1) {
          const solidIndex = x + grid[0] * (y + grid[1] * z);
          if (!component.solid?.[solidIndex]) continue;
          const cell = [x, y, z];
          const min = cell.map((coordinate, axis) => forgeCellBoundary(component, axis, coordinate, grid[axis]));
          const max = cell.map((coordinate, axis) => forgeCellBoundary(component, axis, coordinate + 1, grid[axis]));
          const bounds = placedForgeBounds(min, max, placement);
          if (avatarBoxes.some((entry) => boundsOverlap(bounds, entry.bounds, clearance))) {
            boxes.push({ ...bounds, componentIndex });
          }
        }
      }
    }
  }
  return boxes;
}

function forgeCellBoundary(component, axis, coordinate, cells) {
  const position = component.offsetQ[axis] * 2
    - component.dimsQ[axis]
    + Math.round(coordinate * component.dimsQ[axis] * 2 / cells);
  return position / 128;
}

function avatarRestPartBounds(part, mesh) {
  const rotation = {
    left_arm: { x: 0, y: 0, z: Math.PI / 2 },
    right_arm: { x: 0, y: 0, z: -Math.PI / 2 },
  }[part.bone] ?? { x: 0, y: 0, z: 0 };
  const pivot = mesh.pivots?.[part.bone] ?? mesh.pivots?.torso ?? [0, 0, 0];
  const offset = mesh.boneOffsets?.[part.bone] ?? [0, 0, 0];
  return avatarPartPoseBounds(part, pivot, rotation, offset);
}

function avatarPartPoseBounds(part, pivot, rotation, offset = null) {
  const bounds = emptyBounds();
  for (const corner of boxCorners(part)) {
    const local = transformBoxLocalPoint(corner, part);
    const point = transformPoint(local, pivot, rotation);
    includeBoundsPoint(bounds, [
      point[0] + (offset?.[0] || 0),
      point[1] + (offset?.[1] || 0),
      point[2] + (offset?.[2] || 0),
    ]);
  }
  return bounds;
}

function boundsWithinClearance(left, right, clearance = 0) {
  const margin = Math.max(0, Number(clearance) || 0);
  return left.minX < right.maxX + margin
    && left.maxX > right.minX - margin
    && left.minY < right.maxY + margin
    && left.maxY > right.minY - margin
    && left.minZ < right.maxZ + margin
    && left.maxZ > right.minZ - margin;
}

function boundsOverlap(left, right, clearance = 0) {
  const margin = Math.max(0, Number(clearance) || 0);
  return Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX) > margin
    && Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY) > margin
    && Math.min(left.maxZ, right.maxZ) - Math.max(left.minZ, right.minZ) > margin;
}

function emptyForgeAvatarCollisionReport() {
  return { collides: false, collisionCount: 0, collisionParts: [], collisions: [] };
}

function emptyBounds() {
  return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
}

function placeForgePoint(point, placement) {
  const relative = subtractVector3(point, placement.grip);
  const rotated = placeForgeVector(relative, placement);
  return addVector3(placement.targetGrip, scaleVector3(rotated, placement.scale));
}

function placeForgeVector(vector, placement) {
  const side = dotVector3(vector, placement.source.side);
  const front = dotVector3(vector, placement.source.front);
  const approach = dotVector3(vector, placement.source.approach);
  return addVector3(
    addVector3(scaleVector3(placement.target.side, side), scaleVector3(placement.target.front, front)),
    scaleVector3(placement.target.approach, approach),
  );
}

function boundsOfGeometryVertices(vertices) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let offset = 0; offset < vertices.length; offset += AVATAR_VERTEX_STRIDE_FLOATS) {
    includeBoundsPoint(bounds, [vertices[offset], vertices[offset + 1], vertices[offset + 2]]);
  }
  return bounds;
}

function includeBoundsPoint(bounds, point) {
  bounds.minX = Math.min(bounds.minX, point[0]);
  bounds.maxX = Math.max(bounds.maxX, point[0]);
  bounds.minY = Math.min(bounds.minY, point[1]);
  bounds.maxY = Math.max(bounds.maxY, point[1]);
  bounds.minZ = Math.min(bounds.minZ, point[2]);
  bounds.maxZ = Math.max(bounds.maxZ, point[2]);
}

function rotateAroundAxis(vector, axis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return addVector3(
    addVector3(scaleVector3(vector, cosine), scaleVector3(crossVector3(axis, vector), sine)),
    scaleVector3(axis, dotVector3(axis, vector) * (1 - cosine)),
  );
}

function addVector3(left, right) {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtractVector3(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scaleVector3(vector, scale) {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function dotVector3(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function crossVector3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalizeVector3(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 1e-8 ? scaleVector3(vector, 1 / length) : [0, 1, 0];
}

function createPickaxeParts(parts, bodyBounds, rig, scale = 1, style = {}) {
  const rightArm = boundsOfParts(parts.filter((part) => part.bone === "right_arm"));
  const rightArmRoot = rig?.pivots?.right_hand_item;
  const rightHandAnchor = rig?.handAnchors?.right_hand_item;
  if (!Number.isFinite(rightArm.minX) || rightArm.maxX <= rightArm.minX || !Array.isArray(rightArmRoot)) return [];
  const avatarHeight = Math.max(1, bodyBounds.maxY - bodyBounds.minY);
  const k = Math.max(0.1, Number.isFinite(scale) && scale > 0 ? scale : avatarHeight / 2.52);
  // The avatar is scaled from a compact NCM source into block units. Tools need a
  // smaller independent scale, otherwise the pickaxe reads oversized in-hand.
  const toolK = Math.max(0.52, Math.min(1.02, k * 0.58));
  const toolId = style.equipmentId || BASIC_PICKAXE_EQUIPMENT_ID;
  const toolRotation = { x: -0.44, y: 0.18, z: -0.18 };
  const handAnchor = Array.isArray(rightHandAnchor) ? rightHandAnchor : rightArmRoot;
  const toolOffset = Array.isArray(rightHandAnchor)
    ? [-0.01 * k, -0.07 * k, -0.08 * k]
    : [-0.01 * k, -0.44 * k, -0.08 * k];
  const toolOrigin = [
    handAnchor[0] + toolOffset[0],
    handAnchor[1] + toolOffset[1],
    handAnchor[2] + toolOffset[2],
  ];
  const modelParts = createEquipmentModelParts(toolId);
  const part = (modelPart) => {
    const localPosition = modelPart.center;
    const size = modelPart.size;
    const localCenter = rotateVector(
      [localPosition[0] * toolK, localPosition[1] * toolK, localPosition[2] * toolK],
      toolRotation,
    );
    return {
      name: modelPart.name,
      cx: toolOrigin[0] + localCenter[0],
      cy: toolOrigin[1] + localCenter[1],
      cz: toolOrigin[2] + localCenter[2],
      sx: size[0] * toolK,
      sy: size[1] * toolK,
      sz: size[2] * toolK,
      color: modelPart.color,
      bone: "right_hand_item",
      localRotation: toolRotation,
      equipment: true,
      equipmentId: toolId,
      forgedTool: Boolean(style.forged),
      forgedColorRole: style.forged ? modelPart.colorRole : "",
      gripBound: true,
      toolCollisionPart: true,
      miningHitPart: modelPart.miningHitPart,
    };
  };
  return modelParts.map(part);
}

function createHeldBlockParts(parts, bodyBounds, rig, scale = 1) {
  const rightArm = boundsOfParts(parts.filter((part) => part.bone === "right_arm"));
  const rightArmRoot = rig?.pivots?.right_hand_item;
  const rightHandAnchor = rig?.handAnchors?.right_hand_item;
  if (!Number.isFinite(rightArm.minX) || rightArm.maxX <= rightArm.minX || !Array.isArray(rightArmRoot)) return [];
  const avatarHeight = Math.max(1, bodyBounds.maxY - bodyBounds.minY);
  const k = Math.max(0.1, Number.isFinite(scale) && scale > 0 ? scale : avatarHeight / 2.52);
  const heldBlockK = Math.max(0.30, Math.min(0.42, k * 0.22));
  const handAnchor = Array.isArray(rightHandAnchor) ? rightHandAnchor : rightArmRoot;
  const blockOffset = Array.isArray(rightHandAnchor)
    ? [-0.01 * k, -0.07 * k, -0.12 * k]
    : [-0.01 * k, -0.44 * k, -0.12 * k];
  const blockOrigin = [
    handAnchor[0] + blockOffset[0],
    handAnchor[1] + blockOffset[1],
    handAnchor[2] + blockOffset[2],
  ];
  return [{
    name: "heldBlock",
    cx: blockOrigin[0],
    cy: blockOrigin[1],
    cz: blockOrigin[2],
    sx: heldBlockK,
    sy: heldBlockK,
    sz: heldBlockK,
    color: hexToColor("#609e4a"),
    bone: "right_hand_item",
    localRotation: { x: -0.25, y: 0.2, z: -0.12 },
    equipment: true,
    equipmentId: "held_block",
    gripBound: true,
  }];
}

function summarizeEquipmentParts(parts) {
  if (!Array.isArray(parts) || !parts.length) return [];
  const byId = new Map();
  for (const part of parts) {
    if (!part?.equipmentId) continue;
    const entry = byId.get(part.equipmentId) ?? {
      id: part.equipmentId,
      name: equipmentName(part.equipmentId),
      partCount: 0,
      triangleCount: 0,
      designHash: part.forgeDesignHash ?? 0,
      mode: part.forgeMode ?? "",
    };
    entry.partCount += 1;
    entry.triangleCount += part.geometry?.triangleCount ?? 12;
    byId.set(part.equipmentId, entry);
  }
  return [...byId.values()];
}

function avatarEquipmentState(animation = {}) {
  const raw = animation.equipment ?? animation.visibleEquipment;
  const rightHand = typeof raw === "string"
    ? raw
    : String(raw?.rightHand ?? raw?.hand ?? "pickaxe");
  const blockColor = normalizeAvatarColor(raw?.color ?? raw?.blockColor);
  const designHash = normalizeDesignHash(raw?.designHash);
  const forged = Boolean(raw?.forged || raw?.isForged || rightHand === FORGED_PICKAXE_EQUIPMENT_ID || rightHand === "forged_pickaxe" || designHash);
  const normalizedRightHand = rightHand === "forged_pickaxe" ? "pickaxe" : rightHand;
  const equipmentId = String(raw?.equipmentId || raw?.toolEquipmentId || (
    normalizedRightHand === "pickaxe"
      ? (forged ? FORGED_PICKAXE_EQUIPMENT_ID : BASIC_PICKAXE_EQUIPMENT_ID)
      : (normalizedRightHand === "block" ? "held_block" : normalizedRightHand === "empty" ? "" : normalizedRightHand)
  ));
  return {
    rightHand: normalizedRightHand,
    equipmentId,
    blockColor,
    forged,
    designHash,
    forgedColors: forgedPickaxePalette(designHash),
  };
}

function avatarEquipmentPartVisible(part, equipment) {
  if (!part?.equipment) return true;
  return Boolean(equipment.equipmentId && part.equipmentId === equipment.equipmentId);
}

function avatarEquipmentPartColor(part, equipment) {
  if (part.equipmentId === "held_block") return equipment.blockColor;
  if (part.equipmentId !== FORGED_PICKAXE_EQUIPMENT_ID || !part.forgedColorRole) return null;
  return equipment.forgedColors?.[part.forgedColorRole] ?? null;
}

function equipmentName(equipmentId) {
  if (equipmentId === BASIC_PICKAXE_EQUIPMENT_ID) return "basic iron pickaxe";
  if (equipmentId === FORGED_PICKAXE_EQUIPMENT_ID) return "forged pickaxe";
  if (equipmentId === BLUEPRINT_EQUIPMENT_ID) return "blueprint";
  if (equipmentId === "held_block") return "held block";
  return String(equipmentId || "equipment");
}

function normalizeDesignHash(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) >>> 0 : 0;
}

export function resolveAvatarMiningPose(progress, pitchOffset = 0) {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  if (t <= 0 || t >= 1) return { active: false, armX: 0 };
  const offset = Math.max(-1.2, Math.min(1.2, Number(pitchOffset) || 0));
  if (t < 0.2) {
    const raise = easeOut(t / 0.2);
    return { active: true, armX: lerp(0.15, 1.95, raise) + offset };
  }
  const strike = easeIn((t - 0.2) / 0.8);
  return { active: true, armX: lerp(1.95, -0.2, strike) + offset };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

function easeIn(t) {
  return t * t * t;
}

function boundsOfParts(parts) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const part of parts) {
    bounds.minX = Math.min(bounds.minX, part.cx - part.sx * 0.5);
    bounds.maxX = Math.max(bounds.maxX, part.cx + part.sx * 0.5);
    bounds.minY = Math.min(bounds.minY, part.cy - part.sy * 0.5);
    bounds.maxY = Math.max(bounds.maxY, part.cy + part.sy * 0.5);
    bounds.minZ = Math.min(bounds.minZ, part.cz - part.sz * 0.5);
    bounds.maxZ = Math.max(bounds.maxZ, part.cz + part.sz * 0.5);
  }
  if (!Number.isFinite(bounds.minX)) return { minX: -0.5, minY: 0, minZ: -0.5, maxX: 0.5, maxY: 2, maxZ: 0.5 };
  return bounds;
}

function appendPart(vertices, indices, part) {
  if (part?.geometry) appendGeometry(vertices, indices, part.geometry);
  else appendBox(vertices, indices, part);
}

function appendGeometry(vertices, indices, geometry) {
  const base = vertices.length / AVATAR_VERTEX_STRIDE_FLOATS;
  for (const value of geometry.vertices) vertices.push(value);
  for (const index of geometry.indices) indices.push(base + index);
}

function appendBox(vertices, indices, box) {
  const x0 = box.cx - box.sx * 0.5;
  const x1 = box.cx + box.sx * 0.5;
  const y0 = box.cy - box.sy * 0.5;
  const y1 = box.cy + box.sy * 0.5;
  const z0 = box.cz - box.sz * 0.5;
  const z1 = box.cz + box.sz * 0.5;
  const faces = [
    { n: [1, 0, 0], p: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]] },
    { n: [-1, 0, 0], p: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]] },
    { n: [0, 1, 0], p: [[x0, y1, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1]] },
    { n: [0, -1, 0], p: [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]] },
    { n: [0, 0, 1], p: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]] },
    { n: [0, 0, -1], p: [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]] },
  ];
  for (const face of faces) {
    const offset = vertices.length / AVATAR_VERTEX_STRIDE_FLOATS;
    for (const p of face.p) {
      const lp = transformBoxLocalPoint(p, box);
      const ln = transformBoxLocalNormal(face.n, box);
      vertices.push(lp[0], lp[1], lp[2], ln[0], ln[1], ln[2], box.color[0], box.color[1], box.color[2], box.color[3]);
    }
    indices.push(offset, offset + 2, offset + 1, offset, offset + 3, offset + 2);
  }
}

function appendBoxToArray(out, cursor, box, pivot, rotation, offset = null, options = {}) {
  if (options.hidden) return appendCollapsedBoxToArray(out, cursor, pivot, offset);
  const x0 = box.cx - box.sx * 0.5;
  const x1 = box.cx + box.sx * 0.5;
  const y0 = box.cy - box.sy * 0.5;
  const y1 = box.cy + box.sy * 0.5;
  const z0 = box.cz - box.sz * 0.5;
  const z1 = box.cz + box.sz * 0.5;
  const faces = [
    { n: [1, 0, 0], p: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]] },
    { n: [-1, 0, 0], p: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]] },
    { n: [0, 1, 0], p: [[x0, y1, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1]] },
    { n: [0, -1, 0], p: [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]] },
    { n: [0, 0, 1], p: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]] },
    { n: [0, 0, -1], p: [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]] },
  ];
  const color = options.color ?? box.color;
  for (const face of faces) {
    for (const p of face.p) {
      const lp = transformBoxLocalPoint(p, box);
      const ln = transformBoxLocalNormal(face.n, box);
      const tp = transformPoint(lp, pivot, rotation);
      const tn = transformNormal(ln, rotation);
      out[cursor++] = tp[0] + (offset?.[0] || 0);
      out[cursor++] = tp[1] + (offset?.[1] || 0);
      out[cursor++] = tp[2] + (offset?.[2] || 0);
      out[cursor++] = tn[0];
      out[cursor++] = tn[1];
      out[cursor++] = tn[2];
      out[cursor++] = color[0];
      out[cursor++] = color[1];
      out[cursor++] = color[2];
      out[cursor++] = color[3];
    }
  }
  return cursor;
}

function appendGeometryToArray(out, cursor, part, pivot, rotation, offset = null, options = {}) {
  const source = part.geometry.vertices;
  const vertexCount = Math.floor(source.length / AVATAR_VERTEX_STRIDE_FLOATS);
  if (options.hidden) return appendCollapsedVerticesToArray(out, cursor, pivot, offset, vertexCount);
  for (let sourceOffset = 0, vertexIndex = 0; sourceOffset < source.length; sourceOffset += AVATAR_VERTEX_STRIDE_FLOATS, vertexIndex += 1) {
    const point = [source[sourceOffset], source[sourceOffset + 1], source[sourceOffset + 2]];
    applyAvatarClothWind(point, part.geometry, vertexIndex, options.clothTimeSeconds, options.clothMotionScale);
    const tp = transformPoint(
      point,
      pivot,
      rotation,
    );
    const tn = transformNormal(
      [source[sourceOffset + 3], source[sourceOffset + 4], source[sourceOffset + 5]],
      rotation,
    );
    out[cursor++] = tp[0] + (offset?.[0] || 0);
    out[cursor++] = tp[1] + (offset?.[1] || 0);
    out[cursor++] = tp[2] + (offset?.[2] || 0);
    out[cursor++] = tn[0];
    out[cursor++] = tn[1];
    out[cursor++] = tn[2];
    out[cursor++] = source[sourceOffset + 6];
    out[cursor++] = source[sourceOffset + 7];
    out[cursor++] = source[sourceOffset + 8];
    out[cursor++] = source[sourceOffset + 9];
  }
  return cursor;
}

function applyAvatarClothWind(point, geometry, vertexIndex, timeSeconds, motionScale) {
  const componentIndex = geometry.clothVertexComponents?.[vertexIndex] ?? 255;
  const bounds = componentIndex === 255 ? null : geometry.clothComponentBounds?.[componentIndex];
  if (!bounds || !(motionScale > 0)) return point;
  const coordinate = point[bounds.anchorAxis];
  const weight = Math.max(0, Math.min(1, bounds.anchorAtMax
    ? (bounds.max[bounds.anchorAxis] - coordinate) / bounds.span[bounds.anchorAxis]
    : (coordinate - bounds.min[bounds.anchorAxis]) / bounds.span[bounds.anchorAxis]));
  const phase = (Number(timeSeconds) || 0) * 2.15
    + (point[0] * 2.7 + point[1] * 0.65 + point[2] * 2.15) * 2.4
    + componentIndex * 0.73;
  const wave = Math.sin(phase) + Math.sin(phase * 0.47 + 1.8) * 0.42;
  point[bounds.thinAxis] += wave * weight * weight * 0.042 * motionScale;
  return point;
}

function appendCollapsedBoxToArray(out, cursor, pivot, offset = null) {
  return appendCollapsedVerticesToArray(out, cursor, pivot, offset, 24);
}

function appendCollapsedVerticesToArray(out, cursor, pivot, offset, vertexCount) {
  const x = (pivot?.[0] || 0) + (offset?.[0] || 0);
  const y = (pivot?.[1] || 0) + (offset?.[1] || 0);
  const z = (pivot?.[2] || 0) + (offset?.[2] || 0);
  for (let i = 0; i < vertexCount; i += 1) {
    out[cursor++] = x;
    out[cursor++] = y;
    out[cursor++] = z;
    out[cursor++] = 0;
    out[cursor++] = 0;
    out[cursor++] = 0;
    out[cursor++] = 0;
    out[cursor++] = 0;
    out[cursor++] = 0;
    out[cursor++] = 0;
  }
  return cursor;
}

function transformBoxLocalPoint(point, box) {
  if (!box?.localRotation) return point;
  const center = [box.cx, box.cy, box.cz];
  const rotated = rotateVector([point[0] - center[0], point[1] - center[1], point[2] - center[2]], box.localRotation);
  return [center[0] + rotated[0], center[1] + rotated[1], center[2] + rotated[2]];
}

function transformBoxLocalNormal(normal, box) {
  return box?.localRotation ? rotateVector(normal, box.localRotation) : normal;
}

function transformPoint(p, pivot, rotation) {
  let x = p[0] - pivot[0];
  let y = p[1] - pivot[1];
  let z = p[2] - pivot[2];
  const rx = rotation.x || 0;
  const ry = rotation.y || 0;
  const rz = rotation.z || 0;
  if (rz) {
    const c = Math.cos(rz);
    const s = Math.sin(rz);
    const nx = x * c - y * s;
    const ny = x * s + y * c;
    x = nx;
    y = ny;
  }
  if (rx) {
    const c = Math.cos(rx);
    const s = Math.sin(rx);
    const ny = y * c - z * s;
    const nz = y * s + z * c;
    y = ny;
    z = nz;
  }
  if (ry) {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const nx = x * c + z * s;
    const nz = -x * s + z * c;
    x = nx;
    z = nz;
  }
  return [x + pivot[0], y + pivot[1], z + pivot[2]];
}

function transformNormal(n, rotation) {
  return rotateVector(n, rotation);
}

function rotateVector(vector, rotation) {
  let x = vector[0];
  let y = vector[1];
  let z = vector[2];
  const rx = rotation.x || 0;
  const ry = rotation.y || 0;
  const rz = rotation.z || 0;
  if (rz) {
    const c = Math.cos(rz);
    const s = Math.sin(rz);
    const nx = x * c - y * s;
    const ny = x * s + y * c;
    x = nx;
    y = ny;
  }
  if (rx) {
    const c = Math.cos(rx);
    const s = Math.sin(rx);
    const ny = y * c - z * s;
    const nz = y * s + z * c;
    y = ny;
    z = nz;
  }
  if (ry) {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const nx = x * c + z * s;
    const nz = -x * s + z * c;
    x = nx;
    z = nz;
  }
  return [x, y, z];
}

function avatarRig(parts, bounds) {
  const pivots = avatarPivots(bounds);
  const boneOffsets = {
    torso: [0, 0, 0],
    head: [0, 0, 0],
    left_arm: [0, 0, 0],
    right_arm: [0, 0, 0],
    left_leg: [0, 0, 0],
    right_leg: [0, 0, 0],
  };
  const handAnchors = {};
  const torsoBounds = boundsOfParts(parts.filter((part) => part.bone === "torso"));
  const hasTorso = Number.isFinite(torsoBounds.minX) && torsoBounds.maxX > torsoBounds.minX;
  if (!hasTorso) return { pivots, boneOffsets, handAnchors };

  // Rotate each horizontal source arm around its torso-facing end. The previous
  // bounds-derived pivot landed near the limb midpoint, which made swings hinge
  // from the forearm instead of the shoulder.
  const torsoCenterY = (torsoBounds.minY + torsoBounds.maxY) * 0.5;
  const desiredArmCenterY = torsoCenterY - 0.05;
  const armSpecs = [
    { bone: "left_arm", rotation: { x: 0, y: 0, z: Math.PI / 2 }, side: -1 },
    { bone: "right_arm", rotation: { x: 0, y: 0, z: -Math.PI / 2 }, side: 1 },
  ];
  for (const spec of armSpecs) {
    const armParts = parts.filter((part) => part.bone === spec.bone);
    if (!armParts.length) continue;
    const sourceArmBounds = boundsOfParts(armParts);
    pivots[spec.bone] = [
      spec.side < 0 ? sourceArmBounds.maxX : sourceArmBounds.minX,
      (sourceArmBounds.minY + sourceArmBounds.maxY) * 0.5,
      (sourceArmBounds.minZ + sourceArmBounds.maxZ) * 0.5,
    ];
    const armBounds = transformedBoundsForParts(armParts, pivots[spec.bone], spec.rotation);
    if (!Number.isFinite(armBounds.minX) || armBounds.maxX <= armBounds.minX) continue;
    const armCenterY = (armBounds.minY + armBounds.maxY) * 0.5;
    const xOffset = spec.side < 0
      ? torsoBounds.minX - armBounds.maxX
      : torsoBounds.maxX - armBounds.minX;
    const offset = [xOffset, desiredArmCenterY - armCenterY, 0];
    boneOffsets[spec.bone] = offset;
    handAnchors[spec.bone] = [
      (armBounds.minX + armBounds.maxX) * 0.5 + offset[0],
      armBounds.minY + offset[1],
      (armBounds.minZ + armBounds.maxZ) * 0.5 + offset[2],
    ];
  }
  return { pivots, boneOffsets, handAnchors };
}

function addAvatarToolRig(rig) {
  const rightArmPivot = rig?.pivots?.right_arm;
  const rightArmOffset = rig?.boneOffsets?.right_arm ?? [0, 0, 0];
  if (!Array.isArray(rightArmPivot)) return rig;
  rig.pivots.right_hand_item = [
    rightArmPivot[0] + (rightArmOffset[0] || 0),
    rightArmPivot[1] + (rightArmOffset[1] || 0),
    rightArmPivot[2] + (rightArmOffset[2] || 0),
  ];
  rig.boneOffsets.right_hand_item = [0, 0, 0];
  if (rig.handAnchors.right_arm) rig.handAnchors.right_hand_item = [...rig.handAnchors.right_arm];
  return rig;
}

function avatarPivots(bounds) {
  const height = Math.max(0.1, bounds.maxY - bounds.minY);
  const width = Math.max(0.1, bounds.maxX - bounds.minX);
  const shoulderY = bounds.minY + height * 0.64;
  const hipY = bounds.minY + height * 0.39;
  return {
    torso: [0, bounds.minY + height * 0.5, 0],
    head: [0, bounds.minY + height * 0.78, 0],
    left_arm: [-width * 0.32, shoulderY, 0],
    right_arm: [width * 0.32, shoulderY, 0],
    left_leg: [-width * 0.12, hipY, 0],
    right_leg: [width * 0.12, hipY, 0],
  };
}

function transformedBoundsForParts(parts, pivot, rotation) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const part of parts) {
    for (const corner of boxCorners(part)) {
      const p = transformPoint(corner, pivot, rotation);
      bounds.minX = Math.min(bounds.minX, p[0]);
      bounds.maxX = Math.max(bounds.maxX, p[0]);
      bounds.minY = Math.min(bounds.minY, p[1]);
      bounds.maxY = Math.max(bounds.maxY, p[1]);
      bounds.minZ = Math.min(bounds.minZ, p[2]);
      bounds.maxZ = Math.max(bounds.maxZ, p[2]);
    }
  }
  return bounds;
}

function boxCorners(box) {
  const x0 = box.cx - box.sx * 0.5;
  const x1 = box.cx + box.sx * 0.5;
  const y0 = box.cy - box.sy * 0.5;
  const y1 = box.cy + box.sy * 0.5;
  const z0 = box.cz - box.sz * 0.5;
  const z1 = box.cz + box.sz * 0.5;
  return [
    [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
  ];
}

function boundsOfNcmBoxes(boxes) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const part of boxes) {
    bounds.minX = Math.min(bounds.minX, part.p[0] - part.s[0] / 2);
    bounds.maxX = Math.max(bounds.maxX, part.p[0] + part.s[0] / 2);
    bounds.minY = Math.min(bounds.minY, part.p[1] - part.s[1] / 2);
    bounds.maxY = Math.max(bounds.maxY, part.p[1] + part.s[1] / 2);
    bounds.minZ = Math.min(bounds.minZ, part.p[2] - part.s[2] / 2);
    bounds.maxZ = Math.max(bounds.maxZ, part.p[2] + part.s[2] / 2);
  }
  if (bounds.minX !== Infinity) return bounds;
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 1, maxZ: 0 };
}

function inferNcmAvatarBone(part, bounds) {
  const x = part.p[0];
  const y = part.p[1];
  const name = String(part.n || "").toLowerCase();
  if (/(^|_)(head|hair|eye|ear|nose|mouth|face|bang)(_|$)/.test(name)) return "head";
  if (/(^|_)(leg|foot|boot|pants|shorts)(_|$)/.test(name)) return isRightNamedPart(name) ? "right_leg" : "left_leg";
  if (/(^|_)(arm|hand|sleeve|cuff)(_|$)/.test(name)) return isRightNamedPart(name) ? "right_arm" : "left_arm";
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const normalizedY = (y - bounds.minY) / height;
  const absX = Math.abs(x);
  if (absX > 48 && normalizedY > 0.44 && normalizedY < 0.76) return x < 0 ? "left_arm" : "right_arm";
  if (normalizedY > 0.68) return "head";
  if (absX > 36 && normalizedY > 0.48) return x < 0 ? "left_arm" : "right_arm";
  if (normalizedY < 0.48) return x < 6 ? "left_leg" : "right_leg";
  return "torso";
}

function isRightNamedPart(name) {
  return /(^|_)(r|right)(_|$)/.test(name) || /(_r|right)$/.test(name);
}

function base64UrlDecode(value) {
  const text = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  if (typeof atob === "function") return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

function createByteReader(bytes) {
  let cursor = 0;
  return {
    read() {
      if (cursor >= bytes.length) throw new Error("Unexpected end of NCM payload.");
      return bytes[cursor++];
    },
    offset() {
      return cursor;
    },
  };
}

function readVar(reader) {
  let value = 0;
  let shift = 0;
  while (true) {
    const byte = reader.read();
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
}

function createBitReader(bytes, offset = 0) {
  let bitOffset = offset * 8;
  return {
    read(bits) {
      let value = 0;
      for (let i = 0; i < bits; i += 1) {
        const byte = bytes[bitOffset >> 3] ?? 0;
        const bit = (byte >> (bitOffset & 7)) & 1;
        value |= bit << i;
        bitOffset += 1;
      }
      return value >>> 0;
    },
  };
}

function bitWidth(maxValue) {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, maxValue + 1))));
}

function rgbToHex(r, g, b) {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function hexToColor(hex) {
  const text = String(hex || "#ffffff").replace("#", "");
  const value = Number.parseInt(text.length === 3 ? text.split("").map((c) => c + c).join("") : text, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1];
}

function normalizeAvatarColor(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const rgb = value.slice(0, 3).map((entry) => {
    const number = Number(entry);
    if (!Number.isFinite(number)) return 1;
    return number > 1 ? Math.max(0, Math.min(255, number)) / 255 : Math.max(0, Math.min(1, number));
  });
  return [rgb[0], rgb[1], rgb[2], Number.isFinite(Number(value[3])) ? Math.max(0, Math.min(1, Number(value[3]))) : 1];
}
