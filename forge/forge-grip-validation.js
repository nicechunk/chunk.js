import {
  FORGE_COMPONENT_GRID,
  FORGE_FIXED_SCALE,
  createForgeDesign,
  forgeVoxelIndex,
} from "./forge-core.js";
import { createForgeRuntimeAsset } from "./forge-runtime-cache.js?v=62e1412238d51189";
import {
  DEFAULT_PEASANT_GUY_NCM,
  createAvatarMeshFromNcm,
  forgeRuntimeAvatarCollisionReport,
} from "../renderer/avatar-mesh.js";

// Physical metres, matching the 1.75 m avatar rather than its source-model
// coordinates. Small objects can be held between fingers instead of having
// to cover a fixed fraction of an entire palm.
export const FORGE_GRIP_HAND_SIZE = Object.freeze([0.08, 0.10, 0.065]);
export const FORGE_GRIP_MIN_CONTACT_COVERAGE = 0.18;
export const FORGE_GRIP_MIN_CONTACT_AREA = 0.000025; // 5 mm x 5 mm

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
  const surface = validateForgeGripSurface(component, grip, { components, componentIndex });
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

export function validateForgeGripSurface(component, grip, options = {}) {
  const axis = Number(grip?.axis);
  const sign = Number(grip?.sign) < 0 ? -1 : 1;
  const offsetQ = grip?.offsetQ;
  if (!component || !Number.isInteger(axis) || axis < 0 || axis > 2 || !Array.isArray(offsetQ) || offsetQ.length !== 3) {
    return invalidSurface("invalid-grip");
  }

  if (offsetQ.some((value) => !Number.isFinite(Number(value)))) return invalidSurface("invalid-grip");
  const exposure = forgeGripFaceExposure(component, axis, sign, options);
  const exposed = (cell) => isExposedFace(component, cell, axis, sign) && exposure.area(cell) > 1e-12;
  const surface = nearestExposedFace(component, axis, sign, offsetQ, exposed);
  if (!surface) return invalidSurface("not-exposed");
  const { cell, plane } = surface;

  const cells = connectedExposedCells(component, cell, axis, sign, exposed);
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
  const palmSpans = palmSpansForAxes(axis, grip.rotation);
  const center = offsetQ.map((value) => Number(value) / FORGE_FIXED_SCALE);
  // A wide blade may share one exposed plane with a narrow handle. Check the
  // section near the hand too, so remote geometry cannot disqualify the shaft.
  const frontIndex = palmSpans.indexOf(FORGE_GRIP_HAND_SIZE[1]);
  const sideIndex = 1 - frontIndex;
  const localMin = [Infinity, Infinity], localMax = [-Infinity, -Infinity];
  for (const faceCell of cells) {
    const ranges = axes.map((tangentAxis) => [
      componentBoundary(component, tangentAxis, faceCell[tangentAxis]),
      componentBoundary(component, tangentAxis, faceCell[tangentAxis] + 1),
    ]);
    ranges[frontIndex][0] = Math.max(ranges[frontIndex][0], center[axes[frontIndex]] - palmSpans[frontIndex] / 2);
    ranges[frontIndex][1] = Math.min(ranges[frontIndex][1], center[axes[frontIndex]] + palmSpans[frontIndex] / 2);
    if (ranges[frontIndex][1] <= ranges[frontIndex][0]) continue;
    for (let index = 0; index < 2; index += 1) {
      localMin[index] = Math.min(localMin[index], ranges[index][0]);
      localMax[index] = Math.max(localMax[index], ranges[index][1]);
    }
  }
  const gripRegionSize = localMin.map((value, index) => Math.max(0, localMax[index] - value));
  const shapeFits = regionArea <= palmArea + 0.0005
    || Math.min(...regionSize) <= Math.max(...FORGE_GRIP_HAND_SIZE) + 0.0005
    || gripRegionSize[sideIndex] <= Math.max(...FORGE_GRIP_HAND_SIZE) + 0.0005
    || gripRegionSize[0] * gripRegionSize[1] <= palmArea + 0.0005;
  let contactArea = 0;
  let surfaceArea = 0;
  for (const faceCell of cells) {
    surfaceArea += exposure.area(faceCell);
    const palm = axes.map((tangentAxis, index) => [
      center[tangentAxis] - palmSpans[index] * 0.5,
      center[tangentAxis] + palmSpans[index] * 0.5,
    ]);
    contactArea += exposure.area(faceCell, palm);
  }
  const referenceArea = Math.min(palmArea, surfaceArea);
  const contactCoverage = referenceArea > 0 ? Math.min(1, contactArea / referenceArea) : 0;
  const contactFits = contactArea + 1e-10 >= FORGE_GRIP_MIN_CONTACT_AREA
    && contactCoverage + 1e-8 >= FORGE_GRIP_MIN_CONTACT_COVERAGE;
  return {
    valid: shapeFits && contactFits,
    reason: !shapeFits ? "grip-too-large" : contactFits ? "valid" : "contact-too-small",
    blockedByAvatarCollision: false,
    axis,
    sign,
    plane,
    cell,
    connectedCellCount: cells.length,
    regionSize,
    gripRegionSize,
    palmSpans,
    contactArea,
    surfaceArea,
    referenceArea,
    contactCoverage,
    minimumContactCoverage: FORGE_GRIP_MIN_CONTACT_COVERAGE,
  };
}

function connectedExposedCells(component, start, axis, sign, exposed = (cell) => isExposedFace(component, cell, axis, sign)) {
  const axes = tangentAxes(axis);
  const pending = [[...start]];
  const visited = new Set();
  const cells = [];
  while (pending.length) {
    const cell = pending.pop();
    const key = cell.join(",");
    if (visited.has(key)) continue;
    visited.add(key);
    if (!exposed(cell)) continue;
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

function nearestExposedFace(component, axis, sign, offsetQ, exposed = (cell) => isExposedFace(component, cell, axis, sign)) {
  let best = null;
  const axes = tangentAxes(axis);
  // The NCF1 anchor is integer Q6, so a real surface can be at most half a
  // Q away from its rounded anchor. Never round each voxel boundary first:
  // doing so collapses most cells in centimetre-sized stock.
  for (let layer = 0; layer < GRID[axis]; layer += 1) {
    const plane = layer + (sign > 0 ? 1 : 0);
    const normalDistance = Math.abs(Number(offsetQ[axis]) - componentBoundaryQ(component, axis, plane));
    if (normalDistance > 0.501) continue;
    for (let u = 0; u < GRID[axes[0]]; u += 1) {
      for (let v = 0; v < GRID[axes[1]]; v += 1) {
        const cell = [0, 0, 0];
        cell[axis] = layer;
        cell[axes[0]] = u;
        cell[axes[1]] = v;
        if (!exposed(cell)) continue;
        let distance = normalDistance * normalDistance;
        let centerDistance = 0;
        let nearby = true;
        for (const tangentAxis of axes) {
          const low = componentBoundaryQ(component, tangentAxis, cell[tangentAxis]);
          const high = componentBoundaryQ(component, tangentAxis, cell[tangentAxis] + 1);
          const value = Number(offsetQ[tangentAxis]);
          const delta = Math.max(low - value, value - high, 0);
          if (delta > 0.501) nearby = false;
          distance += delta * delta;
          centerDistance += (value - (low + high) * 0.5) ** 2;
        }
        if (nearby && (!best || distance < best.distance - 1e-10
          || Math.abs(distance - best.distance) < 1e-10 && centerDistance < best.centerDistance)) {
          best = { cell, plane, distance, centerDistance };
        }
      }
    }
  }
  return best;
}

// A surface belongs to the whole assembly. Subtract the actual solid slices
// of other components instead of treating buried component faces as graspable.
function forgeGripFaceExposure(component, axis, sign, options) {
  const axes = tangentAxes(axis);
  const peers = (options.components ?? []).filter((peer, index) => peer
    && peer !== component && index !== options.componentIndex);
  const slices = new Map();
  const fullAreas = new Map();
  function blockers(plane) {
    if (slices.has(plane)) return slices.get(plane);
    const pointQ = component.offsetQ[axis] + componentBoundaryQ(component, axis, plane) + sign * 1e-6;
    const rectangles = [];
    for (const peer of peers) {
      const position = (pointQ - peer.offsetQ[axis]) / peer.dimsQ[axis] + 0.5;
      if (position < 0 || position >= 1) continue;
      const cell = [0, 0, 0];
      cell[axis] = Math.floor(position * GRID[axis]);
      for (let v = 0; v < GRID[axes[1]]; v += 1) {
        cell[axes[1]] = v;
        let start = -1;
        for (let u = 0; u <= GRID[axes[0]]; u += 1) {
          cell[axes[0]] = u;
          const solid = u < GRID[axes[0]] && peer.solid[forgeVoxelIndex(...cell)];
          if (solid && start < 0) start = u;
          if (!solid && start >= 0) {
            rectangles.push(axes.map((tangentAxis, index) => [index ? v : start, index ? v + 1 : u]
              .map((coordinate) => (peer.offsetQ[tangentAxis]
                + componentBoundaryQ(peer, tangentAxis, coordinate) - component.offsetQ[tangentAxis]) / FORGE_FIXED_SCALE)));
            start = -1;
          }
        }
      }
    }
    slices.set(plane, rectangles);
    return rectangles;
  }
  return {
    area(cell, clip = null) {
      const key = cell.join(":");
      if (!clip && fullAreas.has(key)) return fullAreas.get(key);
      const rectangle = axes.map((tangentAxis, index) => [
        Math.max(componentBoundary(component, tangentAxis, cell[tangentAxis]), clip?.[index]?.[0] ?? -Infinity),
        Math.min(componentBoundary(component, tangentAxis, cell[tangentAxis] + 1), clip?.[index]?.[1] ?? Infinity),
      ]);
      const area = uncoveredRectangleArea(rectangle, blockers(cell[axis] + (sign > 0 ? 1 : 0)));
      if (!clip) fullAreas.set(key, area);
      return area;
    },
  };
}

function uncoveredRectangleArea(rectangle, blockers) {
  if (rectangle.some(([low, high]) => high <= low)) return 0;
  const clipped = blockers.map((blocker) => blocker.map(([low, high], axis) => [
    Math.max(low, rectangle[axis][0]), Math.min(high, rectangle[axis][1]),
  ])).filter((blocker) => blocker.every(([low, high]) => high > low));
  if (!clipped.length) return (rectangle[0][1] - rectangle[0][0]) * (rectangle[1][1] - rectangle[1][0]);
  const xs = [...new Set([rectangle[0][0], rectangle[0][1], ...clipped.flatMap((blocker) => blocker[0])])].sort((a, b) => a - b);
  let area = 0;
  for (let index = 1; index < xs.length; index += 1) {
    const lowX = xs[index - 1], highX = xs[index];
    const intervals = clipped.filter((blocker) => blocker[0][0] < highX && blocker[0][1] > lowX)
      .map((blocker) => blocker[1]).sort((a, b) => a[0] - b[0]);
    let covered = 0, end = rectangle[1][0];
    for (const [low, high] of intervals) {
      covered += Math.max(0, high - Math.max(low, end));
      end = Math.max(end, high);
    }
    area += (highX - lowX) * Math.max(0, rectangle[1][1] - rectangle[1][0] - covered);
  }
  return area;
}

function componentBoundary(component, axis, coordinate) {
  return componentBoundaryQ(component, axis, coordinate) / FORGE_FIXED_SCALE;
}

function componentBoundaryQ(component, axis, coordinate) {
  return component.dimsQ[axis] * (coordinate / GRID[axis] - 0.5);
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
