import {
  aabbIntersectsAabb,
  clampPointToAabb,
  createAabbFromCenter,
  createBlockAabb,
  sphereIntersectsAabb,
  sweptAabbIntersection,
} from "./motion-collision.js";
import {
  avatarRightHandRotations,
  resolveAvatarMiningPose,
} from "../renderer/avatar-mesh.js";

const BASIC_PICKAXE_EQUIPMENT_ID = "basic_iron_pickaxe";
const FORGED_PICKAXE_EQUIPMENT_ID = "forged_pickaxe";
const TOOL_TARGET_PROGRESS_SAMPLES = Object.freeze([0.22, 0.30, 0.38, 0.46, 0.54, 0.62, 0.70, 0.78, 0.86, 0.92, 0.96, 0.985, 0.998]);
const TOOL_TARGET_YAW_OFFSETS = Object.freeze([
  0,
  -Math.PI / 36, Math.PI / 36,
  -Math.PI / 18, Math.PI / 18,
  -Math.PI / 12, Math.PI / 12,
  -Math.PI / 9, Math.PI / 9,
  -Math.PI / 6, Math.PI / 6,
  -Math.PI / 4, Math.PI / 4,
]);
const TOOL_TARGET_PITCH_OFFSETS = Object.freeze([0, -0.22, 0.22, -0.44, 0.44, -0.70, 0.70, -0.96, 0.96]);

export function createAvatarToolCollisionResolver({
  getAvatarMesh = () => null,
  getAvatar = () => null,
  getPlayer = () => null,
  getPlayerWorldFloat = () => [0, 0, 0],
  getSelectedEquipment = () => ({ rightHand: "empty" }),
  playerBodyHeight = 4,
} = {}) {
  let reachCacheMesh = null;
  let reachCacheEquipmentId = "";
  let reachCacheRadius = 0;
  let geometryCache = null;

  return {
    toolCollisionFrame,
    toolReachSphere,
    toolTargetingSolution,
    miningPose: avatarMiningPose,
  };

  function toolCollisionFrame({ progress = 0, yaw = null, pitchOffset = null, swing = null } = {}) {
    const geometry = selectedToolGeometry();
    if (!geometry) return { boxes: [] };
    const resolvedYaw = toolYaw(yaw, swing);
    const resolvedPitchOffset = toolPitchOffset(pitchOffset, swing);
    if (!geometry.collisionParts.length) return { boxes: fallbackPickaxeCollisionBoxes(progress, resolvedYaw, resolvedPitchOffset) };
    const boxes = [];
    for (const part of geometry.collisionParts) {
      boxes.push(avatarPartWorldAabb(part, progress, {}, resolvedYaw, resolvedPitchOffset));
    }
    return { boxes };
  }

  function toolReachSphere({ yaw = null, swing = null } = {}) {
    const geometry = selectedToolGeometry();
    if (!geometry?.avatarMesh || !geometry.collisionParts.length) return fallbackToolReachSphere(toolYaw(yaw, swing));
    const pivot = geometry.avatarMesh.pivots?.right_hand_item ?? geometry.avatarMesh.pivots?.right_arm;
    if (!Array.isArray(pivot)) return fallbackToolReachSphere(toolYaw(yaw, swing));
    if (reachCacheMesh !== geometry.avatarMesh || reachCacheEquipmentId !== geometry.equipmentId) {
      reachCacheMesh = geometry.avatarMesh;
      reachCacheEquipmentId = geometry.equipmentId;
      reachCacheRadius = toolReachRadius(geometry.collisionParts, pivot);
    }
    const center = avatarLocalToWorld(pivot, toolYaw(yaw, swing));
    return {
      x: center[0],
      y: center[1],
      z: center[2],
      centerX: center[0],
      centerY: center[1],
      centerZ: center[2],
      radius: reachCacheRadius,
      radiusSquared: reachCacheRadius * reachCacheRadius,
      equipmentId: geometry.equipmentId,
    };
  }

  function toolTargetingSolution({ worldX, worldY, worldZ, padding = 0.06 } = {}) {
    const geometry = selectedToolGeometry();
    if (!geometry) return { reachable: false, withinReachSphere: false, reason: "no-mining-tool" };
    const targetBox = createBlockAabb(worldX, worldY, worldZ, padding, {});
    const origin = avatarWorldOrigin();
    const targetX = (targetBox.minX + targetBox.maxX) * 0.5;
    const targetZ = (targetBox.minZ + targetBox.maxZ) * 0.5;
    const dx = targetX - origin[0];
    const dz = targetZ - origin[2];
    const currentYaw = toolYaw(null, null);
    const targetYaw = dx * dx + dz * dz > 0.000001 ? Math.atan2(-dx, -dz) : currentYaw;
    let directSphere = null;
    let withinReachSphere = false;

    for (const offset of TOOL_TARGET_YAW_OFFSETS) {
      const yaw = normalizeAngle(targetYaw + offset);
      const reachSphere = toolReachSphere({ yaw });
      if (!directSphere) directSphere = reachSphere;
      if (!sphereIntersectsAabb(reachSphere, targetBox)) continue;
      withinReachSphere = true;
      for (const pitchOffset of TOOL_TARGET_PITCH_OFFSETS) {
        const collision = toolSweepHitTarget(targetBox, yaw, pitchOffset);
        if (!collision?.hit) continue;
        return {
          reachable: true,
          withinReachSphere: true,
          yaw,
          targetYaw,
          yawOffset: normalizeAngle(yaw - targetYaw),
          pitchOffset,
          impactProgress: collision.progress,
          pointX: collision.pointX,
          pointY: collision.pointY,
          pointZ: collision.pointZ,
          reachSphere,
        };
      }
    }

    return {
      reachable: false,
      withinReachSphere,
      targetYaw,
      reachSphere: directSphere,
      reason: withinReachSphere ? "tool-trajectory-miss" : "outside-tool-reach-sphere",
    };
  }

  function selectedToolGeometry() {
    const equipment = getSelectedEquipment() ?? {};
    const rightHand = String(equipment.rightHand || "empty");
    const miningTool = Boolean(equipment.miningTool || equipment.toolEquipmentId || rightHand === "pickaxe");
    if (!miningTool) return null;
    const equipmentId = String(equipment.toolEquipmentId || equipment.equipmentId || (
      rightHand === "pickaxe"
        ? (equipment.forged || equipment.isForged || equipment.designHash ? FORGED_PICKAXE_EQUIPMENT_ID : BASIC_PICKAXE_EQUIPMENT_ID)
        : rightHand
    ));
    const avatarMesh = getAvatarMesh();
    if (geometryCache?.avatarMesh === avatarMesh && geometryCache.equipmentId === equipmentId) return geometryCache;
    const collisionParts = (avatarMesh?.collisionParts ?? avatarMesh?.parts ?? []).filter((part) => (
      part?.equipmentId === equipmentId && part.equipment && part.toolCollisionPart !== false
    ));
    geometryCache = { avatarMesh, equipmentId, collisionParts };
    return geometryCache;
  }

  function toolReachRadius(parts, pivot) {
    let radiusSquared = 0;
    for (const part of parts) {
      for (const corner of avatarBoxCorners(part)) {
        const point = transformAvatarPartPoint(corner, part);
        const dx = point[0] - pivot[0];
        const dy = point[1] - pivot[1];
        const dz = point[2] - pivot[2];
        radiusSquared = Math.max(radiusSquared, dx * dx + dy * dy + dz * dz);
      }
    }
    return Math.sqrt(radiusSquared);
  }

  function toolSweepHitTarget(targetBox, yaw, pitchOffset) {
    let previousBoxes = null;
    for (const progress of TOOL_TARGET_PROGRESS_SAMPLES) {
      const boxes = toolCollisionFrame({ progress, yaw, pitchOffset }).boxes;
      for (let index = 0; index < boxes.length; index += 1) {
        const box = boxes[index];
        if (aabbIntersectsAabb(box, targetBox)) return directCollision(box, targetBox, progress);
        const previous = previousBoxes?.[index];
        if (!previous) continue;
        const collision = sweptAabbIntersection(previous, box, targetBox, {});
        if (collision.hit) {
          return {
            hit: true,
            progress,
            pointX: collision.x,
            pointY: collision.y,
            pointZ: collision.z,
          };
        }
      }
      previousBoxes = boxes;
    }
    return { hit: false };
  }

  function directCollision(box, targetBox, progress) {
    const point = clampPointToAabb(
      (box.minX + box.maxX) * 0.5,
      (box.minY + box.maxY) * 0.5,
      (box.minZ + box.maxZ) * 0.5,
      targetBox,
      {},
    );
    return { hit: true, progress, pointX: point.x, pointY: point.y, pointZ: point.z };
  }

  function avatarPartWorldAabb(part, progress, target, yaw = null, pitchOffset = 0) {
    const corners = avatarBoxCorners(part);
    target.minX = Infinity;
    target.minY = Infinity;
    target.minZ = Infinity;
    target.maxX = -Infinity;
    target.maxY = -Infinity;
    target.maxZ = -Infinity;
    for (const corner of corners) {
      const local = transformAvatarPartPoint(corner, part);
      const posed = transformAvatarBonePoint(local, part, progress, pitchOffset);
      const world = avatarLocalToWorld(posed, yaw);
      target.minX = Math.min(target.minX, world[0]);
      target.maxX = Math.max(target.maxX, world[0]);
      target.minY = Math.min(target.minY, world[1]);
      target.maxY = Math.max(target.maxY, world[1]);
      target.minZ = Math.min(target.minZ, world[2]);
      target.maxZ = Math.max(target.maxZ, world[2]);
    }
    return target;
  }

  function transformAvatarBonePoint(point, part, progress, pitchOffset = 0) {
    const avatarMesh = getAvatarMesh();
    const bone = part?.bone;
    const pivot = avatarMesh?.pivots?.[bone] ?? avatarMesh?.pivots?.torso ?? [0, 0, 0];
    const offset = avatarMesh?.boneOffsets?.[bone] ?? avatarMesh?.boneOffsets?.torso ?? [0, 0, 0];
    const rotation = avatarMiningBoneRotation(avatarMesh, bone, part?.equipmentId, progress, pitchOffset);
    const rotated = rotateAroundPivot(point, pivot, rotation);
    return [
      rotated[0] + (offset[0] || 0),
      rotated[1] + (offset[1] || 0),
      rotated[2] + (offset[2] || 0),
    ];
  }

  function avatarLocalToWorld(point, yawOverride = null) {
    const origin = avatarWorldOrigin();
    const avatar = getAvatar();
    const player = getPlayer();
    const yaw = Number.isFinite(yawOverride)
      ? yawOverride
      : (Number.isFinite(avatar?.yaw) ? avatar.yaw : (Number.isFinite(player?.avatarYaw) ? player.avatarYaw : 0));
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return [
      origin[0] + point[0] * c + point[2] * s,
      origin[1] + point[1],
      origin[2] - point[0] * s + point[2] * c,
    ];
  }

  function avatarWorldOrigin() {
    const avatar = getAvatar();
    if (avatar) {
      return [
        Math.trunc(avatar.worldX || 0) + (avatar.localOffsetX || 0),
        Math.trunc(avatar.worldY || 0) + (avatar.localOffsetY || 0),
        Math.trunc(avatar.worldZ || 0) + (avatar.localOffsetZ || 0),
      ];
    }
    return getPlayerWorldFloat();
  }

  function fallbackPickaxeCollisionBoxes(progress, yawOverride = null, pitchOffset = 0) {
    const [px, py, pz] = getPlayerWorldFloat();
    const player = getPlayer();
    const yaw = Number.isFinite(yawOverride) ? yawOverride : (Number.isFinite(player?.avatarYaw) ? player.avatarYaw : 0);
    const pose = avatarMiningPose(progress, pitchOffset);
    const reach = 1.25 + Math.max(0, Math.sin(clamp(progress, 0, 1) * Math.PI)) * 0.55;
    const height = py + playerBodyHeight * (pose.active ? 0.54 : 0.46);
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const cx = px + forwardX * reach + rightX * 0.18;
    const cz = pz + forwardZ * reach + rightZ * 0.18;
    return [createAabbFromCenter(cx, height, cz, 0.24, 0.42, 0.24, {})];
  }

  function fallbackToolReachSphere(yaw = 0) {
    const [px, py, pz] = getPlayerWorldFloat();
    const shoulderOffset = 0.35;
    return {
      x: px + Math.cos(yaw) * shoulderOffset,
      y: py + playerBodyHeight * 0.72,
      z: pz - Math.sin(yaw) * shoulderOffset,
      radius: 1.95,
      radiusSquared: 1.95 * 1.95,
      equipmentId: BASIC_PICKAXE_EQUIPMENT_ID,
    };
  }

  function toolYaw(yaw, swing) {
    if (Number.isFinite(yaw)) return Number(yaw);
    if (Number.isFinite(swing?.aimYaw)) return Number(swing.aimYaw);
    const avatar = getAvatar();
    const player = getPlayer();
    return Number.isFinite(avatar?.yaw) ? avatar.yaw : (Number.isFinite(player?.avatarYaw) ? player.avatarYaw : 0);
  }

  function toolPitchOffset(pitchOffset, swing) {
    if (Number.isFinite(pitchOffset)) return clamp(Number(pitchOffset), -1.2, 1.2);
    if (Number.isFinite(swing?.aimPitch)) return clamp(Number(swing.aimPitch), -1.2, 1.2);
    return 0;
  }
}

export function avatarMiningPose(progress, pitchOffset = 0) {
  return resolveAvatarMiningPose(progress, pitchOffset);
}

function avatarMiningBoneRotation(mesh, bone, equipmentId, progress, pitchOffset = 0) {
  const pose = avatarMiningPose(progress, pitchOffset);
  if (bone === "right_hand_item" || bone === "right_arm") {
    const rotations = avatarRightHandRotations(mesh, equipmentId, {
      armX: pose.active ? pose.armX : 0,
      mining: pose.active,
    });
    return rotations[bone];
  }
  if (bone === "left_arm") return { x: 0, y: 0, z: Math.PI / 2 };
  return { x: 0, y: 0, z: 0 };
}

function transformAvatarPartPoint(point, part) {
  if (!part?.localRotation) return point;
  const center = [part.cx, part.cy, part.cz];
  const rotated = rotateVec3([point[0] - center[0], point[1] - center[1], point[2] - center[2]], part.localRotation);
  return [center[0] + rotated[0], center[1] + rotated[1], center[2] + rotated[2]];
}

function avatarBoxCorners(box) {
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

function rotateAroundPivot(point, pivot, rotation) {
  const rotated = rotateVec3([point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]], rotation);
  return [rotated[0] + pivot[0], rotated[1] + pivot[1], rotated[2] + pivot[2]];
}

function rotateVec3(vector, rotation = {}) {
  let x = vector[0];
  let y = vector[1];
  let z = vector[2];
  const rz = rotation.z || 0;
  const rx = rotation.x || 0;
  const ry = rotation.y || 0;
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(value) {
  let angle = Number(value) || 0;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}
