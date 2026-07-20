import {
  FORGE_COMPONENT_GRID,
  FORGE_FIXED_SCALE,
  createForgeDesign,
  forgeVoxelIndex,
} from "./forge-core.js";
import { createForgeRuntimeAsset } from "./forge-runtime-cache.js";
import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
  forgeRuntimeAvatarCollisionReport,
} from "../renderer/avatar-mesh.js";

export const FORGE_GRIP_HAND_SIZE = Object.freeze([0.34, 0.42, 0.32]);
export const FORGE_GRIP_MIN_CONTACT_COVERAGE = 0.18;

const GRID = Object.freeze([
  FORGE_COMPONENT_GRID.x,
  FORGE_COMPONENT_GRID.y,
  FORGE_COMPONENT_GRID.z,
]);
const avatarMeshCache = new Map();

export function forgeComponentsWithSingleGrip(components, componentIndex, grip) {
  return components.map((component, index) => ({
    ...component,
    grip: index === componentIndex && grip
      ? { ...grip, offsetQ: [...grip.offsetQ] }
      : null,
  }));
}

export function validateForgeGripBindings(components, options = {}) {
  const source = Array.isArray(components) ? components : [];
  const gripIndexes = source
    .map((component, index) => component?.grip ? index : -1)
    .filter((index) => index >= 0);
  if (!gripIndexes.length) {
    return {
      valid: true,
      reason: "no-grip",
      componentIndex: -1,
      gripCount: 0,
      blockedByAvatarCollision: false,
      collision: emptyCollisionReport(),
      runtime: null,
    };
  }
  if (gripIndexes.length > 1) {
    return {
      ...invalidSurface("multiple-grips"),
      componentIndex: gripIndexes[0],
      gripCount: gripIndexes.length,
      collision: emptyCollisionReport(),
      runtime: null,
    };
  }
  const componentIndex = gripIndexes[0];
  return {
    ...validateForgeGripPlacement(source, componentIndex, source[componentIndex].grip, options),
    componentIndex,
    gripCount: 1,
  };
}

export function validateForgeGripPlacement(components, componentIndex, grip, options = {}) {
  const component = components?.[componentIndex];
  const surface = validateForgeGripSurface(component, grip);
  if (!surface.valid) return { ...surface, collision: emptyCollisionReport(), runtime: null };

  try {
    const designComponents = forgeComponentsWithSingleGrip(components, componentIndex, grip);
    const design = createForgeDesign({
      components: designComponents,
      equipment: { mass5g: 0, volumeCm3: 0, attributes6: new Uint8Array(12) },
    });
    const runtime = createForgeRuntimeAsset(design);
    const avatarModelCode = String(options.avatarModelCode || DEFAULT_PEASANT_GUY_NCM);
    const collision = forgeRuntimeAvatarCollisionReport(runtime, {
      avatarMesh: cachedAvatarMesh(avatarModelCode),
      avatarModelCode,
    });
    return {
      ...surface,
      valid: !collision.collides,
      reason: collision.collides ? "avatar-collision" : surface.reason,
      blockedByAvatarCollision: collision.collides,
      collision,
      runtime,
    };
  } catch (error) {
    return {
      ...surface,
      valid: false,
      reason: "invalid-design",
      blockedByAvatarCollision: false,
      collision: emptyCollisionReport(),
      runtime: null,
      error,
    };
  }
}

export function validateForgeGripSurface(component, grip) {
  const axis = Number(grip?.axis);
  const sign = Number(grip?.sign) < 0 ? -1 : 1;
  const offsetQ = grip?.offsetQ;
  if (!component || !Number.isInteger(axis) || axis < 0 || axis > 2 || !Array.isArray(offsetQ) || offsetQ.length !== 3) {
    return invalidSurface("invalid-grip");
  }

  const plane = nearestBoundary(component, axis, Number(offsetQ[axis]));
  if (!plane || plane.distanceQ > 1.05) return invalidSurface("not-surface");
  const layer = sign > 0 ? plane.coordinate - 1 : plane.coordinate;
  if (layer < 0 || layer >= GRID[axis]) return invalidSurface("not-surface");
  const cell = [0, 0, 0];
  cell[axis] = layer;
  for (const tangentAxis of tangentAxes(axis)) {
    cell[tangentAxis] = nearestCell(component, tangentAxis, Number(offsetQ[tangentAxis]));
  }
  if (!isExposedFace(component, cell, axis, sign)) return invalidSurface("not-exposed");

  const cells = connectedExposedCells(component, cell, axis, sign);
  if (!cells.length) return invalidSurface("not-exposed");
  const axes = tangentAxes(axis);
  const minCell = [Infinity, Infinity];
  const maxCell = [-Infinity, -Infinity];
  for (const faceCell of cells) {
    for (let index = 0; index < 2; index += 1) {
      minCell[index] = Math.min(minCell[index], faceCell[axes[index]]);
      maxCell[index] = Math.max(maxCell[index], faceCell[axes[index]] + 1);
    }
  }
  const region = axes.map((tangentAxis, index) => ({
    min: componentBoundary(component, tangentAxis, minCell[index]),
    max: componentBoundary(component, tangentAxis, maxCell[index]),
  }));
  const regionSize = region.map((range) => range.max - range.min);
  const palmArea = FORGE_GRIP_HAND_SIZE[0] * FORGE_GRIP_HAND_SIZE[1];
  const regionArea = regionSize[0] * regionSize[1];
  const shapeFits = regionArea <= palmArea + 0.0005
    || Math.min(...regionSize) <= Math.max(FORGE_GRIP_HAND_SIZE[0], FORGE_GRIP_HAND_SIZE[1]) + 0.0005;
  const palmSpans = palmSpansForAxes(axis, grip.rotation);
  const center = offsetQ.map((value) => Number(value) / FORGE_FIXED_SCALE);
  let contactArea = 0;
  for (const faceCell of cells) {
    const area = axes.map((tangentAxis, index) => {
      const cellMin = componentBoundary(component, tangentAxis, faceCell[tangentAxis]);
      const cellMax = componentBoundary(component, tangentAxis, faceCell[tangentAxis] + 1);
      const palmMin = center[tangentAxis] - palmSpans[index] * 0.5;
      const palmMax = center[tangentAxis] + palmSpans[index] * 0.5;
      return Math.max(0, Math.min(cellMax, palmMax) - Math.max(cellMin, palmMin));
    });
    contactArea += area[0] * area[1];
  }
  const contactCoverage = palmArea > 0 ? Math.min(1, contactArea / palmArea) : 0;
  const contactFits = contactCoverage + 1e-8 >= FORGE_GRIP_MIN_CONTACT_COVERAGE;
  return {
    valid: shapeFits && contactFits,
    reason: !shapeFits ? "grip-too-large" : contactFits ? "valid" : "contact-too-small",
    blockedByAvatarCollision: false,
    axis,
    sign,
    plane: plane.coordinate,
    cell,
    connectedCellCount: cells.length,
    regionSize,
    palmSpans,
    contactArea,
    contactCoverage,
    minimumContactCoverage: FORGE_GRIP_MIN_CONTACT_COVERAGE,
  };
}

function connectedExposedCells(component, start, axis, sign) {
  const axes = tangentAxes(axis);
  const pending = [[...start]];
  const visited = new Set();
  const cells = [];
  while (pending.length) {
    const cell = pending.pop();
    const key = cell.join(",");
    if (visited.has(key)) continue;
    visited.add(key);
    if (!isExposedFace(component, cell, axis, sign)) continue;
    cells.push(cell);
    for (const tangentAxis of axes) {
      for (const delta of [-1, 1]) {
        const next = [...cell];
        next[tangentAxis] += delta;
        if (insideGrid(next)) pending.push(next);
      }
    }
  }
  return cells;
}

function isExposedFace(component, cell, axis, sign) {
  if (!insideGrid(cell) || !component.solid?.[forgeVoxelIndex(cell[0], cell[1], cell[2])]) return false;
  const neighbor = [...cell];
  neighbor[axis] += sign;
  return !insideGrid(neighbor) || !component.solid[forgeVoxelIndex(neighbor[0], neighbor[1], neighbor[2])];
}

function insideGrid(cell) {
  return cell.every((value, axis) => Number.isInteger(value) && value >= 0 && value < GRID[axis]);
}

function nearestBoundary(component, axis, valueQ) {
  let best = null;
  for (let coordinate = 0; coordinate <= GRID[axis]; coordinate += 1) {
    const boundaryQ = componentBoundaryQ(component, axis, coordinate);
    const distanceQ = Math.abs(valueQ - boundaryQ);
    if (!best || distanceQ < best.distanceQ) best = { coordinate, boundaryQ, distanceQ };
  }
  return best;
}

function nearestCell(component, axis, valueQ) {
  let bestCell = 0;
  let bestDistance = Infinity;
  for (let coordinate = 0; coordinate < GRID[axis]; coordinate += 1) {
    const centerQ = (componentBoundaryQ(component, axis, coordinate)
      + componentBoundaryQ(component, axis, coordinate + 1)) * 0.5;
    const distance = Math.abs(valueQ - centerQ);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCell = coordinate;
    }
  }
  return bestCell;
}

function componentBoundary(component, axis, coordinate) {
  return componentBoundaryQ(component, axis, coordinate) / FORGE_FIXED_SCALE;
}

function componentBoundaryQ(component, axis, coordinate) {
  const boundaryP = -component.dimsQ[axis]
    + Math.round(coordinate * component.dimsQ[axis] * 2 / GRID[axis]);
  return boundaryP * 0.5;
}

function palmSpansForAxes(normalAxis, rotationInput) {
  const axes = tangentAxes(normalAxis);
  const frontAxis = normalAxis === 1 ? 2 : 1;
  const sideAxis = axes.find((axis) => axis !== frontAxis);
  const odd = (Math.trunc(Number(rotationInput) || 0) & 1) === 1;
  const sideSpan = odd ? FORGE_GRIP_HAND_SIZE[1] : FORGE_GRIP_HAND_SIZE[0];
  const frontSpan = odd ? FORGE_GRIP_HAND_SIZE[0] : FORGE_GRIP_HAND_SIZE[1];
  return axes.map((axis) => axis === sideAxis ? sideSpan : frontSpan);
}

function tangentAxes(axis) {
  return [0, 1, 2].filter((candidate) => candidate !== axis);
}

function cachedAvatarMesh(code) {
  let mesh = avatarMeshCache.get(code);
  if (!mesh) {
    mesh = createAvatarMeshFromNcm(code, {
      attachIronPickaxe: false,
      attachForgedPickaxe: false,
    });
    avatarMeshCache.set(code, mesh);
  }
  return mesh;
}

function invalidSurface(reason) {
  return {
    valid: false,
    reason,
    blockedByAvatarCollision: false,
    connectedCellCount: 0,
    regionSize: [0, 0],
    palmSpans: [FORGE_GRIP_HAND_SIZE[0], FORGE_GRIP_HAND_SIZE[1]],
    contactArea: 0,
    contactCoverage: 0,
    minimumContactCoverage: FORGE_GRIP_MIN_CONTACT_COVERAGE,
  };
}

function emptyCollisionReport() {
  return { collides: false, collisionCount: 0, collisionParts: [], collisions: [] };
}
