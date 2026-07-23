import {
  FORGE_ATTRIBUTE_KEYS,
  FORGE_COMPONENT_GRID,
  FORGE_FIXED_SCALE,
  FORGE_RESOURCE_IDS,
  Ncf1ValidationError,
  createForgeComponent,
  createForgeDesign,
  forgeVoxelIndex,
} from "./forge-core.js";

// A component consumes one selected material slot in the current forge flow.
// Keep the workbench ceiling aligned with the Rust verifier even though the
// generic NCF1 component codec can represent up to 31 components.
export const FORGE_WORKBENCH_MAX_COMPONENTS = 24;
export const FORGE_WORKBENCH_DEFAULT_INPUT_VOLUME_MM3 = 120_000;
export const FORGE_WORKBENCH_SOLID_CELL_COUNT = FORGE_COMPONENT_GRID.x
  * FORGE_COMPONENT_GRID.y
  * FORGE_COMPONENT_GRID.z;
export const FORGE_WORKBENCH_PAINT_PALETTE = Object.freeze([0xeed, 0xec6, 0xe54, 0x58f, 0xf8c]);
export const FORGE_MACHINING_STATE_KIND = "forge-machining-state-v1";
export const FORGE_MATERIAL_DENSITY_LIMITS = Object.freeze({
  minKgM3: 1,
  maxKgM3: 50_000,
});
export const FORGE_WORKBENCH_MASS_WEIGHT_UNIT = "microgram";
// All 12 equipment scores inherit by physical material mass. `massWeight` is
// the exact integer product `usedVolumeMm3 * densityKgM3`, whose unit is one
// microgram. The independent `densityScore` remains a gameplay attribute.
export const FORGE_WORKBENCH_INHERITANCE_MODE = "used-volume-density-mass-weighted-v1";

// Module-private brands let hot UI paths reuse records created here without
// trusting a caller-controlled string property from storage or the network.
const verifiedForgeProfiles = new WeakSet();
const verifiedForgeMaterials = new WeakSet();
const verifiedForgeMachiningStates = new WeakSet();
const forgeSpatialShapeCache = new WeakMap();
const FORGE_GRID_SIZES = Object.freeze([
  FORGE_COMPONENT_GRID.x,
  FORGE_COMPONENT_GRID.y,
  FORGE_COMPONENT_GRID.z,
]);
const SAW_TRIG_SCALE = 1_000;
const SAW_DISTANCE_HALF_Q = Math.floor(SAW_TRIG_SCALE / 2);
const FORGE_MACHINING_MAX_STAMPS = 128;
const FORGE_MACHINING_OUTSIDE_SCORE = Number.MAX_SAFE_INTEGER;
const SAW_CROSS_BY_ANGLE = Object.freeze({
  0: Object.freeze([0, 1_000]),
  30: Object.freeze([-500, 866]),
  45: Object.freeze([-707, 707]),
  60: Object.freeze([-866, 500]),
  90: Object.freeze([-1_000, 0]),
  120: Object.freeze([-866, -500]),
  150: Object.freeze([-500, -866]),
});

// Archetype kg/m3 values keep legacy previews deterministic when a material
// omits physical metadata. Profiles always mark them as fallbacks; hosts must
// supply and validate recipe/material density for authoritative workbench use.
export const FORGE_MATERIAL_ARCHETYPES = Object.freeze({
  iron: materialArchetype("iron", 0x9ca, [76, 46, 65], 18, 7_850, {
    hardness: 62,
    durability: 72,
    toughness: 74,
    ductility: 52,
    brittleness: 26,
    density: 78,
    heatResistance: 66,
    corrosionResistance: 34,
    conductivity: 46,
    thermalConductivity: 48,
    magnetism: 70,
    workability: 62,
  }),
  copper: materialArchetype("copper", 0xb64, [66, 40, 59], 12, 8_960, {
    hardness: 42,
    durability: 58,
    toughness: 48,
    ductility: 86,
    brittleness: 14,
    density: 82,
    heatResistance: 48,
    corrosionResistance: 58,
    conductivity: 94,
    thermalConductivity: 88,
    magnetism: 2,
    workability: 84,
  }),
  tin: materialArchetype("tin", 0xccb, [59, 36, 54], 10, 7_310, {
    hardness: 34,
    durability: 44,
    toughness: 32,
    ductility: 64,
    brittleness: 38,
    density: 70,
    heatResistance: 42,
    corrosionResistance: 54,
    conductivity: 68,
    thermalConductivity: 62,
    magnetism: 0,
    workability: 78,
  }),
  coal: materialArchetype("coal", 0x222, [58, 36, 54], 38, 250, {
    hardness: 18,
    durability: 35,
    toughness: 22,
    ductility: 5,
    brittleness: 42,
    density: 25,
    heatResistance: 62,
    corrosionResistance: 70,
    conductivity: 22,
    thermalConductivity: 18,
    magnetism: 0,
    workability: 58,
  }),
  handle: materialArchetype("handle", 0x753, [27, 76, 27], 6, 700, {
    hardness: 12,
    durability: 38,
    toughness: 48,
    ductility: 66,
    brittleness: 18,
    density: 14,
    heatResistance: 24,
    corrosionResistance: 42,
    conductivity: 6,
    thermalConductivity: 8,
    magnetism: 0,
    workability: 86,
  }),
  cloth: materialArchetype("cloth", 0xedc, [80, 8, 80], 4, 150, {
    hardness: 6,
    durability: 48,
    toughness: 62,
    ductility: 88,
    brittleness: 6,
    density: 8,
    heatResistance: 18,
    corrosionResistance: 46,
    conductivity: 3,
    thermalConductivity: 5,
    magnetism: 0,
    workability: 94,
  }),
});

export function forgeMaterialArchetypeId(input = {}) {
  if (typeof input === "string") return archetypeIdFromText(input);
  const explicit = firstDefined(
    input?.archetypeId,
    input?.profile?.archetypeId,
    input?.resourceId,
  );
  if (FORGE_RESOURCE_IDS.includes(String(explicit ?? "").toLowerCase())) {
    return String(explicit).toLowerCase();
  }
  const identifiers = [
    input?.materialId,
    input?.id,
    input?.material?.id,
    input?.slot?.materialId,
    input?.transactionInput?.materialId,
    input?.material?.class,
    input?.class,
    input?.material?.renderMode,
    input?.renderMode,
    input?.material?.forgeUse,
    input?.forgeUse,
  ].filter((value) => value != null).join(" ");
  return archetypeIdFromText(identifiers);
}

export function resolveForgeMaterialArchetype(input = {}) {
  return FORGE_MATERIAL_ARCHETYPES[forgeMaterialArchetypeId(input)] ?? FORGE_MATERIAL_ARCHETYPES.tin;
}

// Smelting output may expose its authoritative scores at either
// materialProperties.attributes (a particular smelt) or material.attributes
// (the recipe/base profile). The particular smelt wins when both are present.
export function parseForgeMaterialProfile(input = {}, options = {}) {
  if (verifiedForgeProfiles.has(input) && !hasProfileOverrides(options)) return input;
  if (verifiedForgeProfiles.has(input?.profile) && !hasProfileOverrides(options)) return input.profile;
  const existing = input?.kind === "forge-material-profile-v1"
    ? input
    : input?.profile?.kind === "forge-material-profile-v1"
      ? input.profile
      : null;

  const archetype = resolveForgeMaterialArchetype(existing ?? input ?? options.fallbackResourceId ?? "tin");
  const attributeSources = materialAttributeSources(existing ?? input);
  const attributes = {};
  for (const key of FORGE_ATTRIBUTE_KEYS) {
    attributes[key] = clampInteger(firstAttributeValue(attributeSources, key, archetype.attributes[key]), 0, 100);
  }

  const physicalDensity = resolveForgePhysicalDensity(existing ?? input, archetype);
  const densityScore = clampInteger(firstDefined(
    directMaterialValue(existing ?? input, "densityScore"),
    firstAttributeValue(attributeSources, "density", undefined),
    physicalDensity.source === "material-input"
      ? Math.round(physicalDensity.densityKgM3 / 100)
      : undefined,
    archetype.attributes.density,
  ), 1, 100);
  attributes.density = densityScore;
  const derivedHeat = deriveForgeMaterialHeat(existing ?? input, attributes, archetype);

  const profile = {
    kind: "forge-material-profile-v1",
    archetypeId: archetype.id,
    resourceId: archetype.resourceId,
    color444: normalizeColor444(firstDefined(
      options.color444,
      directMaterialValue(existing ?? input, "color444"),
      directMaterialValue(existing ?? input, "color"),
      archetype.color444,
    )),
    dimsQ: Object.freeze(normalizeDimensionsQ(firstDefined(
      options.dimsQ,
      directMaterialValue(existing ?? input, "dimsQ"),
      archetype.dimsQ,
    ))),
    heat: clampInteger(firstDefined(
      options.heat,
      directMaterialValue(existing ?? input, "heat"),
      derivedHeat,
      archetype.heat,
    ), 0, 100),
    densityScore,
    densityKgM3: physicalDensity.densityKgM3,
    densityKgM3Source: physicalDensity.source,
    physicalDensityFallback: physicalDensity.source === "archetype-fallback",
    attributes: Object.freeze(attributes),
  };
  const result = Object.freeze(profile);
  verifiedForgeProfiles.add(result);
  return result;
}

export function createForgeWorkbenchMaterial(input = {}, options = {}) {
  if (verifiedForgeMaterials.has(input) && !hasMaterialOverrides(options)) return input;
  const rawVolumeMm3 = firstDefined(
    options.volumeMm3,
    directMaterialValue(input, "volumeMm3"),
    options.defaultVolumeMm3,
  );
  if (rawVolumeMm3 == null) {
    throw new Ncf1ValidationError("Forge material input volume is required.", "invalid-material-volume");
  }
  const volumeMm3 = unsigned32(rawVolumeMm3, "forge material input volume");
  if (volumeMm3 < 1) {
    throw new Ncf1ValidationError("Forge material input volume must be positive.", "invalid-material-volume");
  }
  const profile = parseForgeMaterialProfile(input, options);
  const materialId = String(firstDefined(
    directMaterialValue(input, "materialId"),
    directMaterialValue(input, "id"),
    profile.archetypeId,
  ));
  const rawSlotIndex = firstDefined(
    input?.slotIndex,
    input?.index,
    input?.transactionInput?.slotIndex,
    input?.slot?.slotIndex,
    input?.slot?.index,
  );
  const slotIndex = rawSlotIndex == null
    ? null
    : integerInRange(rawSlotIndex, 0, 98, "forge material slot index");
  const result = Object.freeze({
    kind: "forge-workbench-material-v1",
    key: String(firstDefined(input?.key, input?.sourceKey, "")),
    slotIndex,
    materialId,
    volumeMm3,
    profile,
  });
  verifiedForgeMaterials.add(result);
  return result;
}

export function scaleForgeDimensionsForVolume(
  input,
  volumeMm3,
  referenceVolumeMm3 = FORGE_WORKBENCH_DEFAULT_INPUT_VOLUME_MM3,
) {
  const dimsQ = normalizeDimensionsQ(input);
  const volume = unsigned32(volumeMm3, "forge material input volume");
  const reference = positiveSafeInteger(referenceVolumeMm3, "forge reference material volume");
  // A Q6 cube-root scale keeps all calculations inside Number's exact integer
  // range for every u32 backpack volume. The visual scale is clamped to the
  // same useful range as the original workbench.
  const target = volume * 64 * 64 * 64;
  let low = 42;
  let high = 99;
  let scaleQ6 = low;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    if (midpoint * midpoint * midpoint * reference <= target) {
      scaleQ6 = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return dimsQ.map((value) => clampInteger(Math.floor((value * scaleQ6 + 32) / 64), 4, 255));
}

export function forgeWorkbenchComponentOffsetQ(index) {
  const position = integerInRange(index, 0, FORGE_WORKBENCH_MAX_COMPONENTS - 1, "forge component position");
  if (position === 0) return [0, 0, 0];
  // Fill the remaining cells of a 5x5 plane while reserving its center for
  // component zero. An 80-Q pitch keeps the standard material profiles from
  // intersecting before gravity runs while still fitting all 24 on the flat
  // work surface.
  let cell = position - 1;
  if (cell >= 12) cell += 1;
  return [(cell % 5 - 2) * 80, 0, (Math.floor(cell / 5) - 2) * 80];
}

export function createForgeWorkbenchComponent(input = {}, options = {}) {
  const material = createForgeWorkbenchMaterial(input, options);
  const positionIndex = integerInRange(options.positionIndex ?? 0, 0, FORGE_WORKBENCH_MAX_COMPONENTS - 1, "forge component position");
  const dimsQ = options.dimsQ
    ? normalizeDimensionsQ(options.dimsQ)
    : scaleForgeDimensionsForVolume(material.profile.dimsQ, material.volumeMm3);
  const component = createForgeComponent({
    resourceId: material.profile.resourceId,
    color444: material.profile.color444,
    dimsQ,
    offsetQ: options.offsetQ ?? forgeWorkbenchComponentOffsetQ(positionIndex),
    solid: options.solid,
    grip: options.grip,
    paintQuads: options.paintQuads,
  });
  return { component: restoreForgeMachiningState(component, null), material };
}

export function forgeSolidCellCount(input) {
  const solid = input?.solid ?? input;
  assertSolid(solid);
  let count = 0;
  for (let index = 0; index < solid.length; index += 1) count += solid[index] === 1 ? 1 : 0;
  return count;
}

export function forgeComponentSolidFraction(input) {
  const solidCells = forgeSolidCellCount(input);
  return {
    solidCells,
    totalCells: FORGE_WORKBENCH_SOLID_CELL_COUNT,
    bps: Math.floor(solidCells * 10_000 / FORGE_WORKBENCH_SOLID_CELL_COUNT),
  };
}

// Returns the exact packed bounds of the occupied voxel volume. Unlike the
// component envelope, these bounds follow material removed by cutting and
// drilling, so renderers and collision checks can share the visible surface.
export function forgeComponentOccupiedBoundsQ2(input) {
  const component = assertComponent(input);
  const sizes = FORGE_GRID_SIZES;
  const minCell = [...sizes];
  const maxCell = [-1, -1, -1];
  for (let z = 0; z < sizes[2]; z += 1) {
    for (let y = 0; y < sizes[1]; y += 1) {
      for (let x = 0; x < sizes[0]; x += 1) {
        if (!component.solid[forgeVoxelIndex(x, y, z)]) continue;
        minCell[0] = Math.min(minCell[0], x);
        minCell[1] = Math.min(minCell[1], y);
        minCell[2] = Math.min(minCell[2], z);
        maxCell[0] = Math.max(maxCell[0], x);
        maxCell[1] = Math.max(maxCell[1], y);
        maxCell[2] = Math.max(maxCell[2], z);
      }
    }
  }
  if (maxCell[0] < 0) return null;
  const boundaryQ2 = (axis, coordinate) => (
    component.offsetQ[axis] * 2
    - component.dimsQ[axis]
    + Math.round(coordinate * component.dimsQ[axis] * 2 / sizes[axis])
  );
  const minQ2 = minCell.map((coordinate, axis) => boundaryQ2(axis, coordinate));
  const maxQ2 = maxCell.map((coordinate, axis) => boundaryQ2(axis, coordinate + 1));
  return { minQ2, maxQ2, minCell, maxCell };
}

// Returns one positive-volume box for every occupied lattice cell after the
// same P (Q2, 1/128 world unit) boundary quantization used by the forge
// mesher. Very small component dimensions can collapse a lattice cell to a
// zero-width surface; those cells have no collision volume and are omitted.
export function forgeComponentSolidVoxelBoxesQ2(input, options = {}) {
  const component = assertComponent(input);
  const offsetQ = normalizeForgeSpatialOffsetQ(options?.offsetQ ?? component.offsetQ);
  const boundaries = forgeComponentLocalBoundariesQ2(component);
  const boxes = [];
  for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
    const minZ = boundaries[2][z] + offsetQ[2] * 2;
    const maxZ = boundaries[2][z + 1] + offsetQ[2] * 2;
    if (maxZ <= minZ) continue;
    for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
      const minY = boundaries[1][y] + offsetQ[1] * 2;
      const maxY = boundaries[1][y + 1] + offsetQ[1] * 2;
      if (maxY <= minY) continue;
      for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
        const index = forgeVoxelIndex(x, y, z);
        if (!component.solid[index]) continue;
        const minX = boundaries[0][x] + offsetQ[0] * 2;
        const maxX = boundaries[0][x + 1] + offsetQ[0] * 2;
        if (maxX <= minX) continue;
        boxes.push({
          index,
          cell: [x, y, z],
          minQ2: [minX, minY, minZ],
          maxQ2: [maxX, maxY, maxZ],
        });
      }
    }
  }
  return boxes;
}

// Positive volume on all three axes is required. Face, edge, corner, and the
// one-P quantization gap used by workbench support are never collisions.
export function forgeComponentsOverlapQ2(leftInput, rightInput, options = {}) {
  const left = forgeComponentVoxelShapeQ2(
    assertComponent(leftInput),
    normalizeForgeSpatialOffsetQ(options?.leftOffsetQ ?? leftInput.offsetQ),
  );
  const right = forgeComponentVoxelShapeQ2(
    assertComponent(rightInput),
    normalizeForgeSpatialOffsetQ(options?.rightOffsetQ ?? rightInput.offsetQ),
  );
  return forgeVoxelShapesOverlapQ2(left, right);
}

// Validates both the requested endpoint and the complete linear translation,
// preventing a large pointer delta from tunnelling through another component.
// `floorQ2` is the work-surface top in P/Q2 units; omit it when no static floor
// constraint is desired.
export function validateForgeWorkbenchComponentTranslation(
  componentsInput,
  componentIndexInput,
  requestedDeltaQInput,
  options = {},
) {
  return constrainForgeWorkbenchComponentTranslation(
    componentsInput,
    componentIndexInput,
    requestedDeltaQInput,
    options,
  );
}

// Finds the furthest safe integer-Q point on the requested translation ray.
// The dominant-axis DDA has at most 1,023 encodable steps, so binary search
// needs no more than ten collision probes after the known-safe origin. This is
// suitable for a gizmo preview: blocked movement stops on the contact face
// instead of snapping all the way back to its starting position.
export function constrainForgeWorkbenchComponentTranslation(
  componentsInput,
  componentIndexInput,
  requestedDeltaQInput,
  options = {},
) {
  const components = assertForgeSpatialComponents(componentsInput);
  const componentIndex = integerInRange(
    componentIndexInput,
    0,
    components.length - 1,
    "forge translation component index",
  );
  const requestedDeltaQ = integerVector(requestedDeltaQInput, "forge requested translation");
  if (requestedDeltaQ.some((value) => !Number.isSafeInteger(value))) {
    throw new Ncf1ValidationError("Forge requested translations must be safe integers.", "integer-out-of-range");
  }
  const requested = forgeDirectTranslationValidation(
    components,
    componentIndex,
    requestedDeltaQ,
    options,
  );
  if (requested.valid) {
    return forgeTranslationValidationWithConstraint(requested, requestedDeltaQ, requested.candidateOffsetQ);
  }

  const steps = Math.max(...requestedDeltaQ.map(Math.abs));
  if (steps === 0) {
    return forgeTranslationValidationWithConstraint(
      requested,
      [0, 0, 0],
      [...components[componentIndex].offsetQ],
    );
  }
  const origin = forgeDirectTranslationValidation(components, componentIndex, [0, 0, 0], options);
  if (!origin.valid) {
    return forgeTranslationValidationWithConstraint(
      requested,
      [0, 0, 0],
      [...components[componentIndex].offsetQ],
    );
  }

  let low = 0;
  let high = Math.min(steps, 1_023);
  while (low < high) {
    const midpoint = Math.floor((low + high + 1) / 2);
    const deltaQ = forgeTranslationDdaDeltaQ(requestedDeltaQ, midpoint, steps);
    if (forgeDirectTranslationValidation(components, componentIndex, deltaQ, options).valid) low = midpoint;
    else high = midpoint - 1;
  }
  const constrainedDeltaQ = forgeTranslationDdaDeltaQ(requestedDeltaQ, low, steps);
  const constrainedOffsetQ = components[componentIndex].offsetQ.map(
    (value, axis) => value + constrainedDeltaQ[axis],
  );
  return forgeTranslationValidationWithConstraint(requested, constrainedDeltaQ, constrainedOffsetQ);
}

function forgeDirectTranslationValidation(components, componentIndex, requestedDeltaQ, options) {
  const component = components[componentIndex];
  const candidateOffsetQ = component.offsetQ.map((value, axis) => value + requestedDeltaQ[axis]);
  if (candidateOffsetQ.some((value) => value < -512 || value > 511)) {
    return forgeTranslationValidation(false, "offset-range", requestedDeltaQ, candidateOffsetQ, null);
  }

  const currentShape = forgeComponentVoxelShapeQ2(component, component.offsetQ);
  const floorQ2 = normalizeOptionalForgeFloorQ2(options?.floorQ2);
  if (floorQ2 != null && forgeVoxelShapeBottomQ2(currentShape) + requestedDeltaQ[1] * 2 < floorQ2) {
    return forgeTranslationValidation(false, "floor", requestedDeltaQ, candidateOffsetQ, null);
  }

  const sweep = options?.sweep !== false;
  const candidateShape = sweep ? null : forgeComponentVoxelShapeQ2(component, candidateOffsetQ);
  for (let index = 0; index < components.length; index += 1) {
    if (index === componentIndex) continue;
    const obstacle = forgeComponentVoxelShapeQ2(components[index], components[index].offsetQ);
    const blocked = sweep
      ? forgeVoxelShapeTranslationOverlapsQ2(currentShape, obstacle, requestedDeltaQ)
      : forgeVoxelShapesOverlapQ2(candidateShape, obstacle);
    if (blocked) {
      return forgeTranslationValidation(false, "component", requestedDeltaQ, candidateOffsetQ, index);
    }
  }
  return forgeTranslationValidation(true, "ok", requestedDeltaQ, candidateOffsetQ, null);
}

export function canTranslateForgeWorkbenchComponent(
  components,
  componentIndex,
  requestedDeltaQ,
  options = {},
) {
  return validateForgeWorkbenchComponentTranslation(
    components,
    componentIndex,
    requestedDeltaQ,
    options,
  ).valid;
}

// Settling is authoritative integer geometry; animation can interpolate the
// returned offset separately. Component centers remain integer Q, so a face
// resting on an odd Q2 coordinate is rounded upward and has a harmless 1-Q2
// air gap. Every other component field is structurally shared unchanged.
export function settleForgeWorkbenchComponents(componentsInput, options = {}) {
  const components = assertForgeSpatialComponents(componentsInput);
  if (!components.length) return components;
  const floorQ2 = normalizeRequiredForgeFloorQ2(options?.floorQ2 ?? 0);
  const gravity = options?.gravity !== false;
  const offsets = components.map((component) => [...component.offsetQ]);
  let shapes = components.map((component, index) => forgeComponentVoxelShapeQ2(component, offsets[index]));

  // First repair invalid imported/edited states without ever retaining a
  // positive-volume overlap. The lower occupied body (stable index tie-break)
  // keeps its position; each conflicting body is moved above it.
  const repairOrder = forgeSpatialBottomOrder(shapes);
  const repaired = [];
  for (const index of repairOrder) {
    let targetYQ = Math.max(offsets[index][1], forgeFloorContactOffsetQ(shapes[index], floorQ2));
    assertForgeSettledOffsetYQ(targetYQ);
    if (targetYQ !== offsets[index][1]) {
      offsets[index] = forgeOffsetWithY(offsets[index], targetYQ);
      shapes[index] = forgeComponentVoxelShapeQ2(components[index], offsets[index]);
    }
    let repairs = 0;
    while (true) {
      let raisedYQ = offsets[index][1];
      for (const supportIndex of repaired) {
        if (!forgeVoxelShapesOverlapQ2(shapes[index], shapes[supportIndex])) continue;
        raisedYQ = Math.max(
          raisedYQ,
          forgeHighestAboveContactOffsetQ(shapes[index], shapes[supportIndex]),
        );
      }
      if (raisedYQ === offsets[index][1]) break;
      assertForgeSettledOffsetYQ(raisedYQ);
      offsets[index] = forgeOffsetWithY(offsets[index], raisedYQ);
      shapes[index] = forgeComponentVoxelShapeQ2(components[index], offsets[index]);
      repairs += 1;
      if (repairs > repaired.length + 1) {
        throw new Ncf1ValidationError("Forge overlap repair did not converge.", "forge-settle-nonconvergent");
      }
    }
    repaired.push(index);
  }

  if (gravity) {
    // Lower bodies fall first. If one of them moves away from a stack, later
    // bodies see its new exact position in the same pass; additional passes
    // handle unusual interlocking shapes whose occupied-bottom order changes.
    const maxPasses = components.length * components.length + components.length + 2;
    let converged = false;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let changed = false;
      for (const index of forgeSpatialBottomOrder(shapes)) {
        const currentYQ = offsets[index][1];
        let targetYQ = forgeFloorContactOffsetQ(shapes[index], floorQ2);
        for (let supportIndex = 0; supportIndex < shapes.length; supportIndex += 1) {
          if (supportIndex === index) continue;
          const contactYQ = forgeHighestFallingContactOffsetQ(
            shapes[index],
            shapes[supportIndex],
            currentYQ,
          );
          if (contactYQ != null) targetYQ = Math.max(targetYQ, contactYQ);
        }
        targetYQ = Math.max(-512, targetYQ);
        assertForgeSettledOffsetYQ(targetYQ);
        if (targetYQ >= currentYQ) continue;
        offsets[index] = forgeOffsetWithY(offsets[index], targetYQ);
        shapes[index] = forgeComponentVoxelShapeQ2(components[index], offsets[index]);
        changed = true;
      }
      if (!changed) {
        converged = true;
        break;
      }
    }
    if (!converged) {
      throw new Ncf1ValidationError("Forge gravity settling did not converge.", "forge-settle-nonconvergent");
    }
  }
  assertForgeSpatialShapesDoNotOverlap(shapes);

  let changed = false;
  const settled = components.map((component, index) => {
    if (offsets[index].every((value, axis) => value === component.offsetQ[axis])) return component;
    changed = true;
    const next = { ...component, offsetQ: offsets[index] };
    const shape = { ...shapes[index], component: next };
    forgeSpatialShapeCache.set(next, {
      solid: next.solid,
      dimsQ: [...next.dimsQ],
      offsetQ: [...next.offsetQ],
      shape,
    });
    return next;
  });
  return changed ? settled : components;
}

// All components must be reachable through a positive-area shared face.
// Because centers are encoded in integer Q, a non-negative face gap of one Q2
// unit is the quantized equivalent of contact. Edge/corner proximity does not
// create an assembly connection.
export function forgeWorkbenchComponentsConnected(componentsInput) {
  const components = assertForgeSpatialComponents(componentsInput);
  if (!components.length) return false;
  if (components.length === 1) return true;
  const shapes = components.map((component) => forgeComponentVoxelShapeQ2(component, component.offsetQ));
  const visited = new Uint8Array(components.length);
  const queue = [0];
  visited[0] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    for (let candidate = 0; candidate < components.length; candidate += 1) {
      if (visited[candidate]) continue;
      if (!forgeVoxelShapesShareQuantizedFaceQ2(shapes[index], shapes[candidate])) continue;
      visited[candidate] = 1;
      queue.push(candidate);
    }
  }
  return queue.length === components.length;
}

export function cloneForgeComponent(input, { copySolid = true } = {}) {
  const component = assertComponent(input);
  return {
    ...component,
    dimsQ: [...component.dimsQ],
    offsetQ: [...component.offsetQ],
    grip: component.grip ? { ...component.grip, offsetQ: [...component.grip.offsetQ] } : null,
    solid: copySolid ? new Uint8Array(component.solid) : component.solid,
    paintQuads: (component.paintQuads ?? []).map((quad) => ({ ...quad })),
    ...(component.machining ? { machining: cloneForgeMachiningState(component.machining, { copySolid }) } : {}),
  };
}

// Machining state is deliberately workbench-only. Canonical NCF1 design
// normalization drops this property after `solid` has been resolved, so the
// chain codec and Play runtime never need to replay editing operations.
export function serializeForgeMachiningState(input) {
  const component = assertComponent(input);
  if (!component.machining) return null;
  const state = normalizeForgeMachiningState(component, component.machining);
  return {
    kind: FORGE_MACHINING_STATE_KIND,
    referenceDimsQ: [...state.referenceDimsQ],
    baseSolidBits: state.stamps.length ? encodeMachiningSolid(state.baseSolid) : null,
    stamps: state.stamps.map(serializeForgeMachiningStamp),
  };
}

export function restoreForgeMachiningState(input, record) {
  const component = assertComponent(input);
  const state = record == null
    ? createForgeMachiningCheckpoint(component)
    : normalizeSerializedForgeMachiningState(component, record);
  const restored = { ...component, machining: state };
  if (!state.stamps.length) return restored;
  const resolved = rasterizeForgeMachining(restored, state, {
    targetSolidCells: forgeSolidCellCount(component.solid),
  });
  if (!equalSolid(resolved, component.solid)) {
    throw new Ncf1ValidationError("Forge machining state does not match its resolved solid mask.", "machining-solid-mismatch");
  }
  return restored;
}

export function forgeWorkbenchToolOptionsFromHit(input, toolId, hit, options = {}) {
  const component = assertComponent(input);
  const face = hit?.face ?? hit;
  if (!face || face.axis == null || face.side == null) return { ...options };
  const axis = normalizeAxis(face.axis);
  const numericSide = normalizeFaceSide(face.side);
  const side = numericSide ? "high" : "low";
  const resolved = {
    ...options,
    axis,
    side,
    sign: numericSide ? 1 : -1,
  };
  const point = finiteVectorOrNull(hit?.localPoint);
  if (point) {
    resolved.center = forgeGridCellAtPoint(component, point);
    resolved.plane = forgeGridPlaneAtPoint(component, point, axis);
    resolved.offsetQ = point.map((value, coordinate) => clampInteger(
      Math.round(value * FORGE_FIXED_SCALE) - component.offsetQ[coordinate],
      -512,
      511,
    ));
  }
  return resolved;
}

// Resolves the exact deterministic grid cells reached by a surface tool. This
// is local workbench geometry, never an additional on-chain material gate.
// Renderers can consume the same descriptor for previews so the highlighted
// footprint and the transform cannot drift apart.
export function resolveForgeToolFootprint(input, toolId, options = {}) {
  const component = assertComponent(input);
  const id = normalizeWorkbenchToolId(toolId);
  const { hit = null, ...providedOptions } = options ?? {};
  const resolved = hit
    ? forgeWorkbenchToolOptionsFromHit(component, id, hit, providedOptions)
    : providedOptions;
  const axis = normalizeAxis(resolved.axis ?? defaultToolAxis(component, id));
  const side = normalizeFaceSide(resolved.side ?? "high");
  const sizes = FORGE_GRID_SIZES;
  const center = normalizeToolCenter(resolved.center, sizes);
  const plane = clampInteger(
    resolved.plane ?? (side ? sizes[axis] : 0),
    0,
    sizes[axis],
  );
  const surfaceLayer = side ? plane - 1 : plane;
  const inwardStep = side ? -1 : 1;
  const axes = tangentAxes(axis);
  let layers = surfaceLayer >= 0 && surfaceLayer < sizes[axis] ? [surfaceLayer] : [];
  let cells = [];
  const details = {};

  if (id === "hammer") {
    const size = normalizeBrushSize(resolved.size ?? 3);
    const radius = Math.floor(size / 2);
    for (let a = center[axes[0]] - radius; a <= center[axes[0]] + radius; a += 1) {
      for (let b = center[axes[1]] - radius; b <= center[axes[1]] + radius; b += 1) {
        const cell = [...center];
        cell[axis] = surfaceLayer;
        cell[axes[0]] = a;
        cell[axes[1]] = b;
        if (!forgeCellInside(cell)) continue;
        if (!component.solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) continue;
        if (!isExposedForgeFace(component.solid, cell, axis, side)) continue;
        cells.push(cell);
      }
    }
    details.size = size;
  } else if (id === "saw") {
    const depth = enumValue(resolved.depth, ["through", "half", "shallow"], "through");
    layers = forgeInwardLayers(axis, plane, side, toolDepthLayers(sizes[axis], depth));
    const angle = normalizeSawAngle(resolved.angle ?? 0);
    const mode = enumValue(resolved.mode, ["kerf", "trim"], "kerf");
    const requestedTrimSide = enumValue(resolved.trimSide, ["auto", "a", "b"], "auto");
    const trimSide = requestedTrimSide === "auto" && layers.length
      ? automaticSawTrimSide(component.solid, axis, layers[0], center, axes, angle)
      : requestedTrimSide === "auto" ? "a" : requestedTrimSide;
    for (const layer of layers) {
      for (let a = 0; a < sizes[axes[0]]; a += 1) {
        for (let b = 0; b < sizes[axes[1]]; b += 1) {
          const cell = [...center];
          cell[axis] = layer;
          cell[axes[0]] = a;
          cell[axes[1]] = b;
          const distanceQ = signedSawDistanceQ(cell, center, axes, angle);
          const matches = mode === "trim"
            ? trimSide === "b" ? distanceQ <= SAW_DISTANCE_HALF_Q : distanceQ >= -SAW_DISTANCE_HALF_Q
            : Math.abs(distanceQ) <= SAW_DISTANCE_HALF_Q;
          if (matches && component.solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) cells.push(cell);
        }
      }
    }
    Object.assign(details, { angle, mode, trimSide, depth });
  } else if (id === "handDrill") {
    const depth = enumValue(resolved.depth, ["through", "half", "shallow"], "through");
    layers = forgeInwardLayers(axis, plane, side, toolDepthLayers(sizes[axis], depth));
    const size = normalizeBrushSize(resolved.size ?? 1);
    const profile = enumValue(resolved.profile, ["round", "square", "slot"], "round");
    const direction = enumValue(resolved.direction, ["a", "b"], "a");
    const bounds = drillProfileBounds(size, profile, direction);
    for (const layer of layers) {
      for (let a = center[axes[0]] - bounds[0]; a <= center[axes[0]] + bounds[0]; a += 1) {
        for (let b = center[axes[1]] - bounds[1]; b <= center[axes[1]] + bounds[1]; b += 1) {
          if (!drillCellInProfile(a, b, [center[axes[0]], center[axes[1]]], size, profile, direction)) continue;
          const cell = [...center];
          cell[axis] = layer;
          cell[axes[0]] = a;
          cell[axes[1]] = b;
          if (!forgeCellInside(cell)) continue;
          if (component.solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) cells.push(cell);
        }
      }
    }
    Object.assign(details, { size, profile, direction, depth });
  } else if (id === "axe") {
    const startBps = integerInRange(resolved.startBps ?? 6_200, 0, 9_999, "taper start");
    const requestedDepth = Math.max(1, sizes[axis] - Math.floor(sizes[axis] * startBps / 10_000));
    layers = forgeInwardLayers(axis, plane, side, requestedDepth);
    const direction = enumValue(resolved.direction, ["a", "b"], "a");
    const bladeAxis = direction === "b" ? axes[1] : axes[0];
    const thicknessAxis = direction === "b" ? axes[0] : axes[1];
    const bladeRadius = integerInRange(
      resolved.maxInset ?? 3,
      1,
      Math.floor(sizes[bladeAxis] / 2),
      "taper inset",
    );
    const size = normalizeBrushSize(resolved.size ?? 3);
    const surfaceHalfThickness = Math.floor(size / 2);
    for (let depthIndex = 0; depthIndex < layers.length; depthIndex += 1) {
      const halfThickness = Math.max(0, surfaceHalfThickness - Math.floor(
        depthIndex * (surfaceHalfThickness + 1) / Math.max(1, layers.length),
      ));
      for (let blade = center[bladeAxis] - bladeRadius; blade <= center[bladeAxis] + bladeRadius; blade += 1) {
        for (let thickness = center[thicknessAxis] - halfThickness; thickness <= center[thicknessAxis] + halfThickness; thickness += 1) {
          const cell = [...center];
          cell[axis] = layers[depthIndex];
          cell[bladeAxis] = blade;
          cell[thicknessAxis] = thickness;
          if (!forgeCellInside(cell)) continue;
          if (component.solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) cells.push(cell);
        }
      }
    }
    Object.assign(details, { startBps, direction, bladeAxis, thicknessAxis, bladeRadius, size });
  }

  // Destructive tools must leave one material cell. Remove the same
  // lowest-index cell that the transform fallback would preserve so this
  // descriptor remains the exact preview/diff even for an all-covering cut.
  if ((id === "saw" || id === "handDrill" || id === "axe")
    && cells.length === forgeSolidCellCount(component)) {
    const preservedIndex = component.solid.findIndex((value) => value === 1);
    cells = cells.filter((cell) => forgeVoxelIndex(cell[0], cell[1], cell[2]) !== preservedIndex);
  }

  return {
    kind: "forge-tool-footprint-v1",
    toolId: id,
    axis,
    side,
    plane,
    center,
    surfaceLayer,
    inwardStep,
    tangentAxes: axes,
    depthLayers: layers.length,
    layers,
    cells,
    ...details,
  };
}

export function hammerForgeComponent(input, options = {}) {
  const component = assertComponent(input);
  const machining = component.machining
    ? normalizeForgeMachiningState(component, component.machining)
    : createForgeMachiningCheckpoint(component);
  const footprint = resolveForgeToolFootprint(component, "hammer", options);
  const axis = footprint.axis;
  const compressionBps = integerInRange(options.compressionBps ?? 8_800, 1, 10_000, "hammer compression");
  const spreadQ = options.spreadQ == null
    ? null
    : integerInRange(options.spreadQ, 0, 255, "hammer spread");
  let targetAxisQ = Math.max(4, Math.floor((component.dimsQ[axis] * compressionBps + 5_000) / 10_000));
  const hasSide = options.side != null;
  const side = hasSide ? footprint.side : null;
  if (hasSide && (targetAxisQ - component.dimsQ[axis]) % 2 !== 0) {
    if (targetAxisQ > 4) targetAxisQ -= 1;
    else if (targetAxisQ < component.dimsQ[axis]) targetAxisQ += 1;
  }
  const axes = tangentAxes(axis);
  if (!forgeMachiningBaseSupportsDeformation(machining)) return component;
  const axisStepQ = hasSide ? 2 : 1;
  const finalAxisQ = spreadQ == null
    ? component.dimsQ[axis] - axisStepQ
    : component.dimsQ[axis];
  const targetSolidCells = forgeSolidCellCount(component.solid);
  for (let candidateAxisQ = targetAxisQ; candidateAxisQ <= finalAxisQ; candidateAxisQ += axisStepQ) {
    const dimsQ = [...component.dimsQ];
    dimsQ[axis] = candidateAxisQ;
    if (spreadQ == null) {
      const tangentDims = volumeConservingHammerTangents(component.dimsQ, axis, candidateAxisQ);
      dimsQ[axes[0]] = tangentDims[0];
      dimsQ[axes[1]] = tangentDims[1];
    } else {
      for (const candidate of axes) dimsQ[candidate] = Math.min(255, dimsQ[candidate] + spreadQ);
    }
    const offsetQ = [...component.offsetQ];
    if (hasSide) {
      const centerShiftQ = (candidateAxisQ - component.dimsQ[axis]) / 2 * (side ? 1 : -1);
      offsetQ[axis] = clampInteger(offsetQ[axis] + centerShiftQ, -512, 511);
    }
    if (options.center != null) {
      for (const candidate of axes) {
        const deltaQ = dimsQ[candidate] - component.dimsQ[candidate];
        const bias = forgeFootprintAxisBias(footprint, candidate);
        if (!bias || deltaQ % 2 !== 0) continue;
        offsetQ[candidate] = clampInteger(offsetQ[candidate] + bias * deltaQ / 2, -512, 511);
      }
    }
    if (dimsQ.every((value, candidate) => value === component.dimsQ[candidate])
      && offsetQ.every((value, candidate) => value === component.offsetQ[candidate])) continue;
    const nextMachining = forgeMachiningStateFollowingDeformation(
      component,
      { ...component, dimsQ, offsetQ },
      machining,
    );
    const transformed = { ...component, dimsQ, offsetQ, machining: nextMachining };
    if (!nextMachining.stamps.length) return transformed;
    const resolved = resolveForgeMachiningDeformation(
      component,
      transformed,
      machining,
      nextMachining,
      targetSolidCells,
    );
    if (!resolved) continue;
    return {
      ...transformed,
      machining: resolved.machining,
      solid: resolved.solid,
      paintQuads: pruneForgePaintQuads(component.paintQuads, resolved.solid),
    };
  }
  return component;
}

export function normalizeForgeComponent(input, options = {}) {
  const component = assertComponent(input);
  const strengthBps = integerInRange(options.strengthBps ?? 3_400, 1, 10_000, "forge normalize strength");
  const averageQ = Math.round((component.dimsQ[0] + component.dimsQ[1] + component.dimsQ[2]) / 3);
  const dimsQ = component.dimsQ.map((value) => clampInteger(
    value + Math.round((averageQ - value) * strengthBps / 10_000),
    4,
    255,
  ));
  if (dimsQ.every((value, axis) => value === component.dimsQ[axis])) return component;
  if (!component.machining) {
    return forgeSolidCellCount(component.solid) === FORGE_WORKBENCH_SOLID_CELL_COUNT
      ? { ...component, dimsQ }
      : component;
  }
  const machining = normalizeForgeMachiningState(component, component.machining);
  if (!forgeMachiningBaseSupportsDeformation(machining)) return component;
  const nextMachining = forgeMachiningStateFollowingDeformation(
    component,
    { ...component, dimsQ },
    machining,
  );
  const transformed = { ...component, dimsQ, machining: nextMachining };
  if (!nextMachining.stamps.length) return transformed;
  const resolved = resolveForgeMachiningDeformation(
    component,
    transformed,
    machining,
    nextMachining,
    forgeSolidCellCount(component.solid),
  );
  if (!resolved) return component;
  return {
    ...transformed,
    machining: resolved.machining,
    solid: resolved.solid,
    paintQuads: pruneForgePaintQuads(component.paintQuads, resolved.solid),
  };
}

export function sawForgeComponent(input, options = {}) {
  const component = assertComponent(input);
  const axis = options.axis == null ? longestDimensionAxis(component.dimsQ) : normalizeAxis(options.axis);
  if (options.center != null) return sawForgeComponentAtHit(component, axis, options);
  const span = occupiedAxisSpan(component.solid, axis);
  if (!span) return component;
  const cutBps = integerInRange(options.cutBps ?? 1_200, 1, 10_000, "saw cut ratio");
  const requestedLayers = options.layers == null
    ? Math.max(1, Math.floor((span.length * cutBps + 5_000) / 10_000))
    : positiveSafeInteger(options.layers, "saw cut layers");
  const cutLayers = Math.min(span.length, requestedLayers);
  const solid = new Uint8Array(component.solid);
  const firstCutLayer = options.side === "low" ? span.min : span.max - cutLayers + 1;
  const lastCutLayer = options.side === "low" ? span.min + cutLayers - 1 : span.max;
  clearSolidAxisRange(solid, axis, firstCutLayer, lastCutLayer);
  preserveOneSolidCell(component.solid, solid);
  if (equalSolid(component.solid, solid)) return component;
  return checkpointUntrackedSolidMutation(component, {
    ...component,
    solid,
    paintQuads: pruneForgePaintQuads(component.paintQuads, solid),
  });
}

function sawForgeComponentAtHit(component, axis, options) {
  const footprint = resolveForgeToolFootprint(component, "saw", { ...options, axis });
  const machining = appendForgeMachiningStamp(
    component,
    createSawMachiningStamp(component, footprint, options),
  );
  const solid = rasterizeForgeMachining(component, machining);
  if (equalSolid(component.solid, solid)) return component;
  return { ...component, machining, solid, paintQuads: pruneForgePaintQuads(component.paintQuads, solid) };
}

export function drillForgeComponent(input, options = {}) {
  const component = assertComponent(input);
  const footprint = resolveForgeToolFootprint(component, "handDrill", options);
  const machining = appendForgeMachiningStamp(
    component,
    createDrillMachiningStamp(component, footprint, options),
  );
  const solid = rasterizeForgeMachining(component, machining);
  if (equalSolid(component.solid, solid)) return component;
  return { ...component, machining, solid, paintQuads: pruneForgePaintQuads(component.paintQuads, solid) };
}

export function gripForgeComponent(input, options = {}) {
  const component = assertComponent(input);
  const offsetQ = normalizeOffsetQ(options.offsetQ ?? [0, 0, 0]);
  return {
    ...component,
    grip: {
      offsetQ,
      axis: normalizeAxis(options.axis ?? 1),
      sign: Number(options.sign ?? 1) < 0 ? -1 : 1,
      rotation: integerInRange(options.rotation ?? 0, 0, 3, "forge grip rotation"),
    },
  };
}

export function taperForgeComponent(input, options = {}) {
  const component = assertComponent(input);
  if (options.center != null) {
    const footprint = resolveForgeToolFootprint(component, "axe", options);
    const solid = new Uint8Array(component.solid);
    for (const cell of footprint.cells) solid[forgeVoxelIndex(cell[0], cell[1], cell[2])] = 0;
    preserveOneSolidCell(component.solid, solid);
    if (equalSolid(component.solid, solid)) return component;
    return checkpointUntrackedSolidMutation(component, {
      ...component,
      solid,
      paintQuads: pruneForgePaintQuads(component.paintQuads, solid),
    });
  }
  const startBps = integerInRange(options.startBps ?? 6_200, 0, 9_999, "taper start");
  const axis = normalizeAxis(options.axis ?? 1);
  const side = normalizeFaceSide(options.side ?? "high");
  const axes = tangentAxes(axis);
  const insetAxis = axes[0];
  const maxInset = integerInRange(
    options.maxInset ?? 3,
    1,
    Math.floor(FORGE_GRID_SIZES[insetAxis] / 2),
    "taper inset",
  );
  const startLayer = Math.floor(FORGE_GRID_SIZES[axis] * startBps / 10_000);
  const lowRegionMax = FORGE_GRID_SIZES[axis] - startLayer - 1;
  const solid = new Uint8Array(component.solid);
  for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
    for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
      for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
        const cell = [x, y, z];
        const normalCoordinate = cell[axis];
        const inRegion = side ? normalCoordinate >= startLayer : normalCoordinate <= lowRegionMax;
        if (!inRegion) continue;
        const inset = Math.min(
          maxInset,
          side ? normalCoordinate - startLayer + 1 : lowRegionMax - normalCoordinate + 1,
        );
        if (cell[insetAxis] < inset || cell[insetAxis] >= FORGE_GRID_SIZES[insetAxis] - inset) {
          solid[forgeVoxelIndex(x, y, z)] = 0;
        }
      }
    }
  }
  preserveOneSolidCell(component.solid, solid);
  if (equalSolid(component.solid, solid)) return component;
  return checkpointUntrackedSolidMutation(component, {
    ...component,
    solid,
    paintQuads: pruneForgePaintQuads(component.paintQuads, solid),
  });
}

export function paintForgeComponent(input, options = {}) {
  const component = assertComponent(input);
  const palette = options.palette ?? FORGE_WORKBENCH_PAINT_PALETTE;
  if ((!Array.isArray(palette) && !ArrayBuffer.isView(palette)) || palette.length < 1) {
    throw new Ncf1ValidationError("Forge paint palettes require at least one color.", "invalid-paint-palette");
  }
  const colors = Array.from(palette, normalizeColor444);
  const explicit = options.color444 ?? options.color;
  const paintCells = forgePaintCellMap(component.paintQuads);
  const axis = options.axis == null ? null : normalizeAxis(options.axis);
  const side = options.side == null ? null : normalizeFaceSide(options.side);
  const plane = axis == null || side == null
    ? null
    : clampInteger(options.plane ?? (side ? FORGE_GRID_SIZES[axis] : 0), 0, FORGE_GRID_SIZES[axis]);
  const center = options.center == null ? null : normalizeToolCenter(options.center);
  const axes = axis == null ? null : tangentAxes(axis);
  const centerColor = axis == null || side == null || plane == null || !center
    ? component.color444
    : paintCells.get(paintFaceCellKey(axis, side, plane, center[axes[0]], center[axes[1]]))?.color444 ?? component.color444;
  const currentIndex = colors.indexOf(centerColor);
  const color444 = explicit == null
    ? colors[currentIndex < 0 ? 0 : (currentIndex + 1) % colors.length]
    : normalizeColor444(explicit);
  if (axis != null && side != null) {
    const mode = enumValue(options.mode, ["paint", "erase"], "paint");
    const brushSize = normalizeBrushSize(options.size ?? 1);
    const radius = Math.floor(brushSize / 2);
    const uCenter = center?.[axes[0]] ?? Math.floor(FORGE_GRID_SIZES[axes[0]] / 2);
    const vCenter = center?.[axes[1]] ?? Math.floor(FORGE_GRID_SIZES[axes[1]] / 2);
    const uMin = center ? uCenter - radius : 0;
    const uMax = center ? uCenter + radius : FORGE_GRID_SIZES[axes[0]] - 1;
    const vMin = center ? vCenter - radius : 0;
    const vMax = center ? vCenter + radius : FORGE_GRID_SIZES[axes[1]] - 1;
    for (let v = vMin; v <= vMax; v += 1) {
      for (let u = uMin; u <= uMax; u += 1) {
        if (u < 0 || v < 0 || u >= FORGE_GRID_SIZES[axes[0]] || v >= FORGE_GRID_SIZES[axes[1]]) continue;
        const cell = [0, 0, 0];
        cell[axis] = side ? plane - 1 : plane;
        cell[axes[0]] = u;
        cell[axes[1]] = v;
        if (!forgeCellInside(cell) || !component.solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) continue;
        if (!isExposedForgeFace(component.solid, cell, axis, side)) continue;
        const key = paintFaceCellKey(axis, side, plane, u, v);
        if (mode === "erase" || color444 === component.color444) paintCells.delete(key);
        else paintCells.set(key, { axis, side, plane, u, v, color444 });
      }
    }
    return { ...component, paintQuads: forgePaintQuadsFromCellMap(paintCells) };
  }
  return color444 === component.color444 ? component : { ...component, color444 };
}

export function rotateForgeComponent(input, axisInput = "y") {
  const component = assertComponent(input);
  const axis = normalizeAxis(typeof axisInput === "object" ? axisInput.axis ?? "y" : axisInput);
  const mapping = forgeQuarterTurnMapping(axis);
  const dimsQ = [0, 0, 0];
  for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
    dimsQ[mapping[sourceAxis].targetAxis] = component.dimsQ[sourceAxis];
  }
  const rotatedSolid = rotateForgeSolid(component.solid, mapping);
  const machining = component.machining
    ? rotateForgeMachiningState(component, component.machining, mapping)
    : null;
  const transformed = {
    ...component,
    dimsQ,
    solid: rotatedSolid,
    ...(machining ? { machining } : {}),
  };
  const solid = machining?.stamps.length
    ? rasterizeForgeMachining(transformed, machining, {
      targetSolidCells: forgeSolidCellCount(component.solid),
    })
    : rotatedSolid;
  const paintQuads = rotateForgePaint(component, solid, mapping);
  const grip = rotateForgeGrip(component.grip, mapping);
  return { ...transformed, solid, paintQuads, grip };
}

export function translateForgeComponent(input, deltaQ = [0, 0, 0]) {
  const component = assertComponent(input);
  const delta = integerVector(deltaQ, "forge translation");
  const offsetQ = component.offsetQ.map((value, axis) => clampInteger(value + delta[axis], -512, 511));
  if (offsetQ.every((value, axis) => value === component.offsetQ[axis])) return component;
  return { ...component, offsetQ };
}

export function normalizeForgeWorkbench(input) {
  const { components } = unpackWorkbench(input);
  if (!components.length) return [];
  components.forEach(assertComponent);
  const bounds = componentBoundsQ2(components);
  const centerQ = bounds.minQ2.map((value, axis) => Math.round((value + bounds.maxQ2[axis]) / 4));
  if (centerQ.every((value) => value === 0)) return components;
  return components.map((component) => translateForgeComponent(component, centerQ.map((value) => -value)));
}

export function applyForgeWorkbenchTool(input, toolId, options = {}) {
  const id = String(toolId ?? "");
  const { hit = null, ...toolOptions } = options ?? {};
  const resolvedOptions = hit
    ? forgeWorkbenchToolOptionsFromHit(input, id, hit, toolOptions)
    : toolOptions;
  if (id === "gloves" || id === "") return assertComponent(input);
  if (id === "hammer") return hammerForgeComponent(input, resolvedOptions);
  if (id === "saw") return sawForgeComponent(input, resolvedOptions);
  if (id === "handDrill" || id === "drill") return drillForgeComponent(input, resolvedOptions);
  if (id === "grip") return gripForgeComponent(input, resolvedOptions);
  if (id === "axe" || id === "taper") return taperForgeComponent(input, resolvedOptions);
  if (id === "paintBrush" || id === "paint") return paintForgeComponent(input, resolvedOptions);
  throw new Ncf1ValidationError(`Unknown forge workbench tool: ${id}`, "unknown-forge-tool");
}

export function forgeWorkbenchEquipment(input, materialInputs = null, options = {}) {
  return analyzeForgeWorkbench(input, materialInputs, options).equipment;
}

export function createForgeWorkbenchDesign(input, materialInputs = null, options = {}) {
  const workbench = unpackWorkbench(input, materialInputs);
  if (!workbench.components.length) {
    throw new Ncf1ValidationError("Forge designs require at least one component.", "invalid-component-count");
  }
  return createForgeDesign({
    components: workbench.components,
    equipment: forgeWorkbenchEquipment(workbench.components, workbench.materialInputs, options),
  });
}

export function forgeWorkbenchStats(input, materialInputs = null, options = {}) {
  const analysis = analyzeForgeWorkbench(input, materialInputs, options);
  if (!analysis.components.length) return null;
  const bounds = componentBoundsQ2(analysis.components);
  const dimensionsQ = bounds.minQ2.map((value, axis) => Math.round((bounds.maxQ2[axis] - value) / 2));
  const componentBreakdown = forgeComponentBreakdown(analysis);
  const materialBreakdown = forgeMaterialBreakdown(componentBreakdown, analysis.massWeightTotal);
  const materials = [];
  const densityKgM3Sources = [];
  let heatTotal = 0n;
  let heatWeight = 0n;
  for (let index = 0; index < analysis.materials.length; index += 1) {
    const profile = analysis.materials[index].profile;
    if (!materials.includes(profile.resourceId)) materials.push(profile.resourceId);
    if (!densityKgM3Sources.includes(profile.densityKgM3Source)) {
      densityKgM3Sources.push(profile.densityKgM3Source);
    }
    const weight = BigInt(analysis.componentMassWeights[index]);
    heatTotal += BigInt(profile.heat) * weight;
    heatWeight += weight;
  }
  return {
    inheritanceMode: FORGE_WORKBENCH_INHERITANCE_MODE,
    equipment: analysis.equipment,
    massGrams: analysis.equipment.mass5g * 5,
    massWeight: analysis.massWeightTotal,
    massWeightUnit: FORGE_WORKBENCH_MASS_WEIGHT_UNIT,
    massMicrograms: analysis.massWeightTotal,
    massMilligrams: roundedSafeIntegerRatio(analysis.massWeightTotal, 1_000),
    densityScore: analysis.attributes.density,
    densityKgM3: analysis.usedVolumeMm3
      ? roundedSafeIntegerRatio(analysis.massWeightTotal, analysis.usedVolumeMm3)
      : 0,
    densityKgM3Sources,
    physicalDensityFallback: analysis.materials.some((material) => material.profile.physicalDensityFallback),
    attributes: analysis.attributes,
    dimensionsQ,
    dimensions: dimensionsQ.map((value) => value / 64),
    materials,
    heat: heatWeight ? Number((heatTotal + heatWeight / 2n) / heatWeight) : 0,
    componentCount: analysis.components.length,
    componentVolumesMm3: analysis.componentVolumesMm3,
    componentBreakdown,
    materialBreakdown,
    solidCellCount: analysis.solidCellCount,
    totalCellCount: analysis.components.length * FORGE_WORKBENCH_SOLID_CELL_COUNT,
    solidFractionBps: analysis.inputVolumeMm3
      ? Math.floor(analysis.usedVolumeMm3 * 10_000 / analysis.inputVolumeMm3)
      : 0,
    inputVolumeMm3: analysis.inputVolumeMm3,
    usedVolumeMm3: analysis.usedVolumeMm3,
    unusedVolumeMm3: analysis.inputVolumeMm3 - analysis.usedVolumeMm3,
    requiredVolumeMm3: analysis.equipment.volumeCm3 * 1_000,
    volumeHeadroomMm3: analysis.inputVolumeMm3 - analysis.equipment.volumeCm3 * 1_000,
    requirementsWithinInputs: analysis.equipment.volumeCm3 * 1_000 <= analysis.inputVolumeMm3,
    chainReady: analysis.equipment.mass5g > 0 && analysis.equipment.volumeCm3 > 0,
    physicsAdvisory: forgePhysicalAdvisory(analysis),
  };
}

// These mass-distribution metrics are deterministic workbench hints for
// rendering, handling feel, and UI warnings. They are deliberately derived
// after equipment validation and are never consulted by chainReady or the
// material requirement encoder.
export function forgeWorkbenchPhysicalAdvisory(input, materialInputs = null, options = {}) {
  const analysis = analyzeForgeWorkbench(input, materialInputs, options);
  if (!analysis.components.length) return null;
  return forgePhysicalAdvisory(analysis);
}

function forgePhysicalAdvisory(analysis) {
  // 140 is divisible by 2*14 and 2*10, so every cell center is an exact
  // integer on this private lattice even though the component dimensions use
  // Q6 coordinates. Every occupied cell of one material receives the same
  // volume*density weight; the common 1/1960 factor cancels from all ratios.
  const coordinateScale = 140n;
  let totalMomentWeight = 0n;
  const centerMoment = [0n, 0n, 0n];
  const originInertiaMoment12 = [0n, 0n, 0n];
  for (let componentIndex = 0; componentIndex < analysis.components.length; componentIndex += 1) {
    const material = analysis.materials[componentIndex];
    const cellWeight = BigInt(material.volumeMm3) * BigInt(material.profile.densityKgM3);
    const moments = forgeComponentMassMoments(analysis.components[componentIndex]);
    totalMomentWeight += cellWeight * BigInt(moments.solidCellCount);
    for (let axis = 0; axis < 3; axis += 1) {
      centerMoment[axis] += cellWeight * BigInt(moments.centerMomentQ140[axis]);
      originInertiaMoment12[axis] += cellWeight * BigInt(moments.originInertiaMoment12[axis]);
    }
  }
  if (totalMomentWeight === 0n) {
    return {
      kind: "forge-physics-advisory-v1",
      advisoryOnly: true,
      physicalDensityFallback: analysis.materials.some((material) => material.profile.physicalDensityFallback),
      centerOfMassQ: [0, 0, 0],
      inertiaQ2: [0, 0, 0],
      gripTorque: forgeGripTorqueAdvisory(analysis, [0, 0, 0]),
    };
  }

  const centerQ140 = centerMoment.map((value) => roundedSignedBigIntRatio(value, totalMomentWeight));
  const centerOfMassQ = centerQ140.map((value) => Number(roundedSignedBigIntRatio(value, coordinateScale)));

  // A cell is treated as a uniform cuboid. Compute its origin moment and use
  // the parallel-axis theorem as one exact rational expression, avoiding a
  // second voxel pass and avoiding any dependence on the rounded display COM.
  const inertiaDenominator = totalMomentWeight * totalMomentWeight * 12n
    * coordinateScale * coordinateScale;
  const inertiaQ2 = originInertiaMoment12.map((originMoment, axis) => {
    const axes = tangentAxes(axis);
    const centeredNumerator = originMoment * totalMomentWeight
      - 12n * (
        centerMoment[axes[0]] * centerMoment[axes[0]]
        + centerMoment[axes[1]] * centerMoment[axes[1]]
      );
    return Number(roundedSignedBigIntRatio(centeredNumerator, inertiaDenominator));
  });

  return {
    kind: "forge-physics-advisory-v1",
    advisoryOnly: true,
    physicalDensityFallback: analysis.materials.some((material) => material.profile.physicalDensityFallback),
    centerOfMassQ,
    inertiaQ2,
    gripTorque: forgeGripTorqueAdvisory(analysis, centerOfMassQ),
  };
}

function forgeComponentMassMoments(component) {
  const coordinateScale = 140;
  const spanQ140 = FORGE_GRID_SIZES.map((size, axis) => component.dimsQ[axis] * (coordinateScale / size));
  const centersQ140 = FORGE_GRID_SIZES.map((size, axis) => Array.from({ length: size }, (_, cell) => (
    component.offsetQ[axis] * coordinateScale
      + (2 * cell + 1 - size) * component.dimsQ[axis] * (coordinateScale / (2 * size))
  )));
  const cellInertia12 = [
    spanQ140[1] * spanQ140[1] + spanQ140[2] * spanQ140[2],
    spanQ140[0] * spanQ140[0] + spanQ140[2] * spanQ140[2],
    spanQ140[0] * spanQ140[0] + spanQ140[1] * spanQ140[1],
  ];
  const centerMomentQ140 = [0, 0, 0];
  const originInertiaMoment12 = [0, 0, 0];
  let solidCellCount = 0;
  for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
    const centerZ = centersQ140[2][z];
    for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
      const centerY = centersQ140[1][y];
      for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
        if (!component.solid[forgeVoxelIndex(x, y, z)]) continue;
        solidCellCount += 1;
        const centerX = centersQ140[0][x];
        centerMomentQ140[0] += centerX;
        centerMomentQ140[1] += centerY;
        centerMomentQ140[2] += centerZ;
        originInertiaMoment12[0] += 12 * (centerY * centerY + centerZ * centerZ) + cellInertia12[0];
        originInertiaMoment12[1] += 12 * (centerX * centerX + centerZ * centerZ) + cellInertia12[1];
        originInertiaMoment12[2] += 12 * (centerX * centerX + centerY * centerY) + cellInertia12[2];
      }
    }
  }
  return { solidCellCount, centerMomentQ140, originInertiaMoment12 };
}

function forgeGripTorqueAdvisory(analysis, centerOfMassQ) {
  const componentIndex = analysis.components.findIndex((component) => component.grip);
  if (componentIndex < 0) return null;
  const component = analysis.components[componentIndex];
  const grip = component.grip;
  const pointQ = grip.offsetQ.map((value, axis) => value + component.offsetQ[axis]);
  const centerOffsetQ = centerOfMassQ.map((value, axis) => value - pointQ[axis]);
  const radialAxes = tangentAxes(grip.axis);
  const radialLeverArmQ = roundedIntegerHypot(
    centerOffsetQ[radialAxes[0]],
    centerOffsetQ[radialAxes[1]],
  );
  // Gravity is a workbench-local -Y advisory only. It intentionally does not
  // assume a real-world unit conversion for Q coordinates.
  const gravityLeverArmQ = roundedIntegerHypot(centerOffsetQ[0], centerOffsetQ[2]);
  const massMilligrams = roundedSafeIntegerRatio(analysis.massWeightTotal, 1_000);
  const radialTorque = BigInt(massMilligrams) * BigInt(radialLeverArmQ);
  const gravityTorque = BigInt(massMilligrams) * BigInt(gravityLeverArmQ);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return {
    componentIndex,
    pointQ,
    axis: grip.axis,
    sign: grip.sign,
    centerOffsetQ,
    radialLeverArmQ,
    gravityLeverArmQ,
    radialTorqueMgQ: Number(radialTorque > maxSafe ? maxSafe : radialTorque),
    gravityTorqueMgQ: Number(gravityTorque > maxSafe ? maxSafe : gravityTorque),
    torqueClamped: radialTorque > maxSafe || gravityTorque > maxSafe,
  };
}

function roundedIntegerHypot(a, b) {
  const square = BigInt(a) * BigInt(a) + BigInt(b) * BigInt(b);
  const floor = integerSquareRoot(square);
  const next = floor + 1n;
  return Number(square - floor * floor < next * next - square ? floor : next);
}

function integerSquareRoot(input) {
  if (input < 2n) return input;
  let low = 1n;
  let high = input;
  while (low <= high) {
    const midpoint = (low + high) >> 1n;
    const square = midpoint * midpoint;
    if (square === input) return midpoint;
    if (square < input) low = midpoint + 1n;
    else high = midpoint - 1n;
  }
  return high;
}

function roundedSignedBigIntRatio(numerator, denominator) {
  if (denominator <= 0n) return 0n;
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

function analyzeForgeWorkbench(input, materialInputs, options) {
  const workbench = unpackWorkbench(input, materialInputs);
  const components = workbench.components;
  if (components.length > FORGE_WORKBENCH_MAX_COMPONENTS) {
    throw new Ncf1ValidationError("Forge workbenches support at most 24 material components.", "invalid-component-count");
  }
  if (!components.length) {
    return {
      components,
      materials: [],
      equipment: emptyForgeEquipment(),
      attributes: emptyAttributeScores(),
      componentVolumesMm3: [],
      componentSolidCellCounts: [],
      componentMassWeights: [],
      solidCellCount: 0,
      inputVolumeMm3: 0,
      usedVolumeMm3: 0,
      massWeightTotal: 0,
    };
  }
  if (workbench.materialInputs.length !== components.length) {
    throw new Ncf1ValidationError("Each forge component requires one material input.", "material-component-mismatch");
  }

  const materials = new Array(components.length);
  const componentVolumesMm3 = new Array(components.length);
  const componentSolidCellCounts = new Array(components.length);
  const componentMassWeights = new Array(components.length);
  const attributeTotals = new Array(FORGE_ATTRIBUTE_KEYS.length).fill(0n);
  let solidCellCount = 0;
  let inputVolumeMm3 = 0;
  let usedVolumeMm3 = 0;
  let massWeightTotal = 0;

  for (let index = 0; index < components.length; index += 1) {
    const component = assertComponent(components[index]);
    const materialInput = workbench.materialInputs[index];
    const fallbackVolumeMm3 = firstDefined(options.fallbackVolumeMm3, options.defaultVolumeMm3);
    // Re-validate even branded-looking objects. `kind` is serialized data, not
    // a security boundary, and may come from storage or an untrusted caller.
    const material = createForgeWorkbenchMaterial(materialInput ?? { resourceId: component.resourceId }, {
      fallbackResourceId: component.resourceId,
      defaultVolumeMm3: fallbackVolumeMm3,
    });
    materials[index] = material;
    inputVolumeMm3 = checkedSafeAdd(inputVolumeMm3, material.volumeMm3, "total forge input volume");
    const componentSolidCells = forgeSolidCellCount(component.solid);
    componentSolidCellCounts[index] = componentSolidCells;
    solidCellCount += componentSolidCells;
    const componentVolumeMm3 = Math.floor(material.volumeMm3 * componentSolidCells / FORGE_WORKBENCH_SOLID_CELL_COUNT);
    componentVolumesMm3[index] = componentVolumeMm3;
    usedVolumeMm3 = checkedSafeAdd(usedVolumeMm3, componentVolumeMm3, "used forge material volume");
    // With integer kg/m3 and mm3 inputs, this product is an exact microgram
    // count. The public density ceiling keeps the 24-component total inside
    // Number's safe-integer range; BigInt below preserves exact score weights.
    const massWeight = componentVolumeMm3 * material.profile.densityKgM3;
    componentMassWeights[index] = massWeight;
    massWeightTotal = checkedSafeAdd(massWeightTotal, massWeight, "forge material mass weight");
    for (let attributeIndex = 0; attributeIndex < FORGE_ATTRIBUTE_KEYS.length; attributeIndex += 1) {
      const key = FORGE_ATTRIBUTE_KEYS[attributeIndex];
      attributeTotals[attributeIndex] += BigInt(material.profile.attributes[key]) * BigInt(massWeight);
    }
  }

  const attributes = {};
  const attributes6 = new Uint8Array(FORGE_ATTRIBUTE_KEYS.length);
  for (let index = 0; index < FORGE_ATTRIBUTE_KEYS.length; index += 1) {
    const score = massWeightTotal
      ? clampInteger(Number(
        (attributeTotals[index] + BigInt(Math.floor(massWeightTotal / 2))) / BigInt(massWeightTotal)
      ), 0, 100)
      : 0;
    attributes[FORGE_ATTRIBUTE_KEYS[index]] = score;
    attributes6[index] = Math.floor((score * 63 + 50) / 100);
  }
  const volumeCm3 = Math.min(0xffff, Math.floor(usedVolumeMm3 / 1_000));
  // Five grams equal 5,000,000 micrograms. Round the physical mass to the
  // existing u16 NCF1 field, retaining its required nonzero sentinel when an
  // encodable nonempty volume would otherwise round to zero.
  let mass5g = Math.min(0xffff, Math.floor((massWeightTotal + 2_500_000) / 5_000_000));
  if (volumeCm3 > 0 && mass5g === 0) mass5g = 1;
  const equipment = { mass5g, volumeCm3, attributes6 };
  if (equipment.volumeCm3 * 1_000 > inputVolumeMm3) {
    throw new Ncf1ValidationError("Forge equipment volume exceeds selected material inputs.", "forge-volume-exceeds-inputs");
  }
  return {
    components,
    materials,
    equipment,
    attributes,
    componentVolumesMm3,
    componentSolidCellCounts,
    componentMassWeights,
    solidCellCount,
    inputVolumeMm3,
    usedVolumeMm3,
    massWeightTotal,
  };
}

function forgeComponentBreakdown(analysis) {
  return analysis.components.map((component, componentIndex) => {
    const material = analysis.materials[componentIndex];
    const inputVolumeMm3 = material.volumeMm3;
    const usedVolumeMm3 = analysis.componentVolumesMm3[componentIndex];
    const solidCellCount = analysis.componentSolidCellCounts[componentIndex];
    const massWeight = analysis.componentMassWeights[componentIndex];
    return {
      inheritanceMode: FORGE_WORKBENCH_INHERITANCE_MODE,
      componentIndex,
      key: material.key,
      slotIndex: material.slotIndex,
      materialId: material.materialId,
      resourceId: material.profile.resourceId,
      inputVolumeMm3,
      usedVolumeMm3,
      unusedVolumeMm3: inputVolumeMm3 - usedVolumeMm3,
      solidCellCount,
      totalCellCount: FORGE_WORKBENCH_SOLID_CELL_COUNT,
      solidFractionBps: Math.floor(solidCellCount * 10_000 / FORGE_WORKBENCH_SOLID_CELL_COUNT),
      densityScore: material.profile.densityScore,
      densityKgM3: material.profile.densityKgM3,
      densityKgM3Source: material.profile.densityKgM3Source,
      physicalDensityFallback: material.profile.physicalDensityFallback,
      massWeight,
      massWeightUnit: FORGE_WORKBENCH_MASS_WEIGHT_UNIT,
      massMicrograms: massWeight,
      massMilligrams: roundedSafeIntegerRatio(massWeight, 1_000),
      weightBps: safeIntegerRatioBps(massWeight, analysis.massWeightTotal),
      heat: material.profile.heat,
      attributes: copyForgeAttributeScores(material.profile.attributes),
    };
  });
}

function forgeMaterialBreakdown(componentBreakdown, massWeightTotal) {
  const groups = new Map();
  for (const component of componentBreakdown) {
    let group = groups.get(component.materialId);
    if (!group) {
      group = {
        materialId: component.materialId,
        resourceIds: [],
        componentIndices: [],
        sourceKeys: [],
        slotIndices: [],
        inputVolumeMm3: 0,
        usedVolumeMm3: 0,
        unusedVolumeMm3: 0,
        solidCellCount: 0,
        totalCellCount: 0,
        massWeight: 0,
        physicalDensityFallback: false,
        densityKgM3Sources: [],
        heatTotal: 0n,
        attributeTotals: new Array(FORGE_ATTRIBUTE_KEYS.length).fill(0n),
      };
      groups.set(component.materialId, group);
    }
    if (!group.resourceIds.includes(component.resourceId)) group.resourceIds.push(component.resourceId);
    group.componentIndices.push(component.componentIndex);
    if (component.key && !group.sourceKeys.includes(component.key)) group.sourceKeys.push(component.key);
    if (component.slotIndex != null && !group.slotIndices.includes(component.slotIndex)) group.slotIndices.push(component.slotIndex);
    group.inputVolumeMm3 = checkedSafeAdd(group.inputVolumeMm3, component.inputVolumeMm3, "material breakdown input volume");
    group.usedVolumeMm3 = checkedSafeAdd(group.usedVolumeMm3, component.usedVolumeMm3, "material breakdown used volume");
    group.unusedVolumeMm3 = checkedSafeAdd(group.unusedVolumeMm3, component.unusedVolumeMm3, "material breakdown unused volume");
    group.solidCellCount += component.solidCellCount;
    group.totalCellCount += component.totalCellCount;
    group.massWeight = checkedSafeAdd(group.massWeight, component.massWeight, "material breakdown mass weight");
    group.physicalDensityFallback ||= component.physicalDensityFallback;
    if (!group.densityKgM3Sources.includes(component.densityKgM3Source)) {
      group.densityKgM3Sources.push(component.densityKgM3Source);
    }
    group.heatTotal += BigInt(component.heat) * BigInt(component.massWeight);
    for (let index = 0; index < FORGE_ATTRIBUTE_KEYS.length; index += 1) {
      group.attributeTotals[index] += BigInt(component.attributes[FORGE_ATTRIBUTE_KEYS[index]])
        * BigInt(component.massWeight);
    }
  }
  return [...groups.values()].map((group) => {
    const attributes = forgeInheritedAttributeScores(group.attributeTotals, group.massWeight);
    return {
      inheritanceMode: FORGE_WORKBENCH_INHERITANCE_MODE,
      materialId: group.materialId,
      resourceId: group.resourceIds[0] ?? "tin",
      resourceIds: group.resourceIds,
      componentCount: group.componentIndices.length,
      componentIndices: group.componentIndices,
      sourceKeys: group.sourceKeys,
      slotIndices: group.slotIndices,
      inputVolumeMm3: group.inputVolumeMm3,
      usedVolumeMm3: group.usedVolumeMm3,
      unusedVolumeMm3: group.unusedVolumeMm3,
      solidCellCount: group.solidCellCount,
      totalCellCount: group.totalCellCount,
      solidFractionBps: group.totalCellCount
        ? Math.floor(group.solidCellCount * 10_000 / group.totalCellCount)
        : 0,
      densityScore: attributes.density,
      densityKgM3: group.usedVolumeMm3
        ? roundedSafeIntegerRatio(group.massWeight, group.usedVolumeMm3)
        : 0,
      densityKgM3Sources: group.densityKgM3Sources,
      physicalDensityFallback: group.physicalDensityFallback,
      massWeight: group.massWeight,
      massWeightUnit: FORGE_WORKBENCH_MASS_WEIGHT_UNIT,
      massMicrograms: group.massWeight,
      massMilligrams: roundedSafeIntegerRatio(group.massWeight, 1_000),
      weightBps: safeIntegerRatioBps(group.massWeight, massWeightTotal),
      heat: group.massWeight
        ? Number((group.heatTotal + BigInt(Math.floor(group.massWeight / 2))) / BigInt(group.massWeight))
        : 0,
      attributes,
    };
  });
}

function forgeInheritedAttributeScores(attributeTotals, massWeight) {
  const attributes = {};
  for (let index = 0; index < FORGE_ATTRIBUTE_KEYS.length; index += 1) {
    attributes[FORGE_ATTRIBUTE_KEYS[index]] = massWeight
      ? clampInteger(Number(
        (attributeTotals[index] + BigInt(Math.floor(massWeight / 2))) / BigInt(massWeight)
      ), 0, 100)
      : 0;
  }
  return attributes;
}

function copyForgeAttributeScores(attributes) {
  return Object.fromEntries(FORGE_ATTRIBUTE_KEYS.map((key) => [key, attributes[key]]));
}

function roundedSafeIntegerRatio(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || numerator < 0 || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Ncf1ValidationError("Forge integer ratios require non-negative safe integers.", "integer-out-of-range");
  }
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function safeIntegerRatioBps(numerator, denominator) {
  if (!denominator) return 0;
  if (!Number.isSafeInteger(numerator) || numerator < 0 || !Number.isSafeInteger(denominator) || denominator < 0) {
    throw new Ncf1ValidationError("Forge integer ratios require non-negative safe integers.", "integer-out-of-range");
  }
  if (numerator <= Math.floor(Number.MAX_SAFE_INTEGER / 10_000)) {
    return Math.floor(numerator * 10_000 / denominator);
  }
  return Number(BigInt(numerator) * 10_000n / BigInt(denominator));
}

function unpackWorkbench(input, materialInputs = null) {
  if (Array.isArray(input)) {
    if (input.length && input[0]?.component) {
      return {
        components: input.map((entry) => entry.component),
        materialInputs: input.map((entry) => entry.material ?? entry.source),
      };
    }
    return { components: input, materialInputs: materialInputs ?? [] };
  }
  const entries = input?.entries;
  if (Array.isArray(entries)) {
    return {
      components: entries.map((entry) => entry.component),
      materialInputs: entries.map((entry) => entry.material ?? entry.source),
    };
  }
  return {
    components: Array.isArray(input?.components) ? input.components : [],
    materialInputs: materialInputs
      ?? input?.materials
      ?? input?.materialInputs
      ?? input?.componentSources
      ?? [],
  };
}

function materialArchetype(id, color444, dimsQ, heat, densityKgM3, attributes) {
  return Object.freeze({
    id,
    resourceId: id,
    color444,
    dimsQ: Object.freeze(dimsQ),
    heat,
    densityKgM3,
    attributes: Object.freeze(attributes),
  });
}

function archetypeIdFromText(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (/(?:cotton[ _-]*cloth|cloth|fabric|textile)/u.test(text)) return "cloth";
  if (/(?:^|[^a-z])copper(?:[^a-z]|$)/u.test(text)) return "copper";
  if (/(?:^|[^a-z])tin(?:[^a-z]|$)/u.test(text)) return "tin";
  if (/(?:char|coal|carbon[ _-]*plate)/u.test(text)) return "coal";
  if (/(?:fiber|fibre|resin|wood|timber|handle|polymer)/u.test(text)) return "handle";
  if (/(?:iron|steel|nickel|metal|alloy)/u.test(text)) return "iron";
  if (/carbon/u.test(text)) return "coal";
  return "tin";
}

function materialAttributeSources(input) {
  return [
    input?.materialProperties?.attributes,
    input?.properties?.attributes,
    input?.material?.materialProperties?.attributes,
    input?.slot?.materialProperties?.attributes,
    input?.transactionInput?.materialProperties?.attributes,
    input?.attributes,
    input?.material?.attributes,
    input?.slot?.material?.attributes,
  ].filter((source) => source && typeof source === "object");
}

function firstAttributeValue(sources, key, fallback) {
  for (const source of sources) if (source[key] != null) return source[key];
  return fallback;
}

function directMaterialValue(input, key) {
  return firstDefined(
    input?.[key],
    input?.materialProperties?.[key],
    input?.properties?.[key],
    input?.transactionInput?.[key],
    input?.material?.[key],
    input?.slot?.[key],
    input?.slot?.materialProperties?.[key],
    input?.slot?.material?.[key],
  );
}

function resolveForgePhysicalDensity(input, archetype) {
  for (const source of physicalMaterialSources(input)) {
    const rawDensityKgM3 = firstDefined(source?.densityKgM3, source?.physical?.densityKgM3);
    if (rawDensityKgM3 != null) {
      return {
        densityKgM3: normalizeForgePhysicalDensity(rawDensityKgM3),
        source: normalizePhysicalDensitySource(input, "material-input"),
      };
    }
    const rawDensityGcm3 = firstDefined(source?.densityGcm3, source?.physical?.densityGcm3);
    if (rawDensityGcm3 != null) {
      const densityGcm3 = forgePhysicalDensityNumber(rawDensityGcm3, "densityGcm3");
      return {
        densityKgM3: normalizeForgePhysicalDensity(densityGcm3 * 1_000),
        source: normalizePhysicalDensitySource(input, "material-input"),
      };
    }
  }
  return {
    densityKgM3: archetype.densityKgM3,
    source: "archetype-fallback",
  };
}

function physicalMaterialSources(input) {
  return [
    input,
    input?.materialProperties,
    input?.properties,
    input?.transactionInput?.materialProperties,
    input?.transactionInput,
    input?.slot?.materialProperties,
    input?.slot,
    input?.material?.materialProperties,
    input?.material,
    input?.slot?.material,
  ].filter((source) => source && typeof source === "object");
}

function normalizePhysicalDensitySource(input, fallback) {
  return directMaterialValue(input, "densityKgM3Source") === "archetype-fallback"
    || directMaterialValue(input, "physicalDensityFallback") === true
    ? "archetype-fallback"
    : fallback;
}

function normalizeForgePhysicalDensity(input) {
  const densityKgM3 = forgePhysicalDensityNumber(input, "densityKgM3");
  const rounded = Math.round(densityKgM3);
  if (rounded < FORGE_MATERIAL_DENSITY_LIMITS.minKgM3
    || rounded > FORGE_MATERIAL_DENSITY_LIMITS.maxKgM3) {
    throw new Ncf1ValidationError(
      `Forge material densityKgM3 must round to ${FORGE_MATERIAL_DENSITY_LIMITS.minKgM3}-${FORGE_MATERIAL_DENSITY_LIMITS.maxKgM3}.`,
      "invalid-material-density",
    );
  }
  return rounded;
}

function forgePhysicalDensityNumber(input, label) {
  if ((typeof input !== "number" && typeof input !== "string")
    || (typeof input === "string" && !input.trim())) {
    throw new Ncf1ValidationError(`Forge material ${label} must be a positive finite number.`, "invalid-material-density");
  }
  const numeric = Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Ncf1ValidationError(`Forge material ${label} must be a positive finite number.`, "invalid-material-density");
  }
  return numeric;
}

function deriveForgeMaterialHeat(input, attributes, archetype) {
  const requiredHeatTier = forgeMaterialHeatTier(directMaterialValue(input, "requiredHeatTier"));
  const heatTier = forgeMaterialHeatTier(directMaterialValue(input, "heatTier"));
  const forgeUse = String(directMaterialValue(input, "forgeUse") ?? "").trim().toLowerCase();
  const fuel = Boolean(directMaterialValue(input, "fuel")) || forgeUse === "fuel";
  if (fuel) {
    const tier = heatTier ?? requiredHeatTier;
    if (tier != null) return Math.max(archetype.heat, tier * 18);
  }
  if (requiredHeatTier != null) {
    const heatResistance = clampInteger(attributes?.heatResistance ?? 0, 0, 100);
    return Math.max(6, requiredHeatTier * 9 + Math.floor((heatResistance + 4) / 8));
  }
  if (heatTier != null) return Math.max(archetype.heat, heatTier * 18);
  return undefined;
}

function forgeMaterialHeatTier(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return clampInteger(numeric, 1, 255);
}

function hasProfileOverrides(options) {
  return options.color444 != null || options.dimsQ != null || options.heat != null;
}

function hasMaterialOverrides(options) {
  return options.volumeMm3 != null || options.defaultVolumeMm3 != null || hasProfileOverrides(options);
}

function normalizeDimensionsQ(input) {
  const values = integerVector(input, "forge material dimensions");
  return values.map((value) => clampInteger(value, 4, 255));
}

function normalizeOffsetQ(input) {
  return integerVector(input, "forge grip offset").map((value) => clampInteger(value, -512, 511));
}

function normalizeAxis(input) {
  if (typeof input === "string") {
    const axis = { x: 0, y: 1, z: 2 }[input.toLowerCase()];
    if (axis != null) return axis;
  }
  return integerInRange(input, 0, 2, "forge axis");
}

function normalizeFaceSide(input) {
  if (input === "low" || input === "negative" || input === "-") return 0;
  if (input === "high" || input === "positive" || input === "+") return 1;
  return integerInRange(input, 0, 1, "forge face side");
}

function normalizeToolCenter(input, sizes = FORGE_GRID_SIZES) {
  return [0, 1, 2].map((axis) => clampInteger(
    input?.[axis] ?? Math.floor(sizes[axis] / 2),
    0,
    sizes[axis] - 1,
  ));
}

function normalizeBrushSize(input) {
  const value = clampInteger(input, 1, 5);
  return value <= 1 ? 1 : value <= 3 ? 3 : 5;
}

function normalizeWorkbenchToolId(input) {
  const id = String(input ?? "");
  if (id === "handDrill" || id === "drill") return "handDrill";
  if (id === "axe" || id === "taper") return "axe";
  if (id === "paintBrush" || id === "paint") return "paintBrush";
  if (["", "gloves", "hammer", "saw", "grip"].includes(id)) return id;
  throw new Ncf1ValidationError(`Unknown forge workbench tool: ${id}`, "unknown-forge-tool");
}

function defaultToolAxis(component, toolId) {
  if (toolId === "saw") return longestDimensionAxis(component.dimsQ);
  if (toolId === "handDrill") return 2;
  return 1;
}

function forgeInwardLayers(axis, plane, side, requestedCount) {
  const size = FORGE_GRID_SIZES[axis];
  const start = side ? plane - 1 : plane;
  const step = side ? -1 : 1;
  const count = Math.max(0, Math.floor(Number(requestedCount) || 0));
  const layers = [];
  for (let depth = 0; depth < count; depth += 1) {
    const layer = start + step * depth;
    if (layer < 0 || layer >= size) break;
    layers.push(layer);
  }
  return layers;
}

// A component has one affine envelope, so a local hammer dent cannot be
// represented without either losing material or adding codec state. Preserve
// the solid mask and choose the closest same-parity tangent dimensions whose
// envelope volume matches the pre-strike envelope. Same parity lets an edge
// strike expand one boundary by shifting the integer-Q center exactly.
function volumeConservingHammerTangents(dimsQ, axis, nextAxisQ) {
  const axes = tangentAxes(axis);
  const oldA = dimsQ[axes[0]];
  const oldB = dimsQ[axes[1]];
  const targetProduct = dimsQ[axis] * oldA * oldB;
  let best = [oldA, oldB];
  let bestScore = null;
  const firstA = oldA % 2 ? 5 : 4;
  const firstB = oldB % 2 ? 5 : 4;
  for (let a = firstA; a <= 255; a += 2) {
    for (let b = firstB; b <= 255; b += 2) {
      const volumeError = Math.abs(nextAxisQ * a * b - targetProduct);
      const volumeErrorBps = Math.floor(volumeError * 10_000 / Math.max(1, targetProduct));
      const aspectCrossA = a * oldB;
      const aspectCrossB = b * oldA;
      const aspectError = Math.abs(aspectCrossA - aspectCrossB);
      const aspectErrorBps = Math.floor(aspectError * 20_000 / Math.max(1, aspectCrossA + aspectCrossB));
      const score = [
        volumeErrorBps * 4 + aspectErrorBps,
        volumeErrorBps,
        aspectErrorBps,
        volumeError,
        Math.abs(a - oldA) + Math.abs(b - oldB),
        a,
        b,
      ];
      if (!bestScore || compareIntegerTuples(score, bestScore) < 0) {
        best = [a, b];
        bestScore = score;
      }
    }
  }
  return best;
}

function compareIntegerTuples(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function forgeFootprintAxisBias(footprint, axis) {
  const cells = footprint.cells ?? [];
  const size = FORGE_GRID_SIZES[axis];
  let signal = 0;
  if (cells.length) {
    for (const cell of cells) signal += 2 * cell[axis] + 1 - size;
  } else {
    signal = 2 * footprint.center[axis] + 1 - size;
  }
  // The two central cells of an even grid form a neutral band so a centered
  // strike expands symmetrically instead of jumping between opposite edges.
  if (Math.abs(signal) <= Math.max(1, cells.length)) return 0;
  return signal < 0 ? -1 : 1;
}

function createForgeMachiningCheckpoint(component) {
  return finalizeForgeMachiningState(
    [...component.dimsQ],
    new Uint8Array(component.solid),
    [],
  );
}

function checkpointUntrackedSolidMutation(previous, next) {
  if (!previous.machining) return next;
  return { ...next, machining: createForgeMachiningCheckpoint(next) };
}

function cloneForgeMachiningState(input, { copySolid = true } = {}) {
  const state = normalizeForgeMachiningState(null, input);
  return finalizeForgeMachiningState(
    [...state.referenceDimsQ],
    copySolid ? new Uint8Array(state.baseSolid) : state.baseSolid,
    state.stamps.map((stamp) => cloneForgeMachiningStamp(stamp)),
  );
}

function normalizeForgeMachiningState(component, input) {
  if (verifiedForgeMachiningStates.has(input)) return input;
  if (!input || typeof input !== "object" || input.kind !== FORGE_MACHINING_STATE_KIND) {
    throw new Ncf1ValidationError("Forge machining state is invalid.", "invalid-machining-state");
  }
  const referenceDimsQ = integerVector(input.referenceDimsQ, "forge machining reference dimensions")
    .map((value, axis) => integerInRange(value, 1, 255, `forge machining reference dimension ${axis}`));
  const baseSolid = new Uint8Array(input.baseSolid ?? component?.solid ?? []);
  assertSolid(baseSolid);
  const sourceStamps = Array.isArray(input.stamps) ? input.stamps : [];
  if (sourceStamps.length > FORGE_MACHINING_MAX_STAMPS) {
    throw new Ncf1ValidationError("Forge machining stamp limit exceeded.", "too-many-machining-stamps");
  }
  return finalizeForgeMachiningState(
    referenceDimsQ,
    baseSolid,
    sourceStamps.map(normalizeForgeMachiningStamp),
  );
}

function normalizeSerializedForgeMachiningState(component, record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.kind !== FORGE_MACHINING_STATE_KIND) {
    throw new Ncf1ValidationError("Forge machining draft state is invalid.", "invalid-machining-state");
  }
  assertSerializedMachiningKeys(
    record,
    ["kind", "referenceDimsQ", "baseSolidBits", "stamps"],
    "Forge machining draft state",
    "invalid-machining-state",
  );
  assertSerializedMachiningIntegerVector(
    record.referenceDimsQ,
    1,
    255,
    "Forge machining reference dimensions",
    "invalid-machining-state",
  );
  if (!Array.isArray(record.stamps)) {
    throw new Ncf1ValidationError("Forge machining draft stamps must be an array.", "invalid-machining-state");
  }
  if (record.stamps.length > FORGE_MACHINING_MAX_STAMPS) {
    throw new Ncf1ValidationError("Forge machining stamp limit exceeded.", "too-many-machining-stamps");
  }
  const stamps = record.stamps.map(normalizeSerializedForgeMachiningStamp);
  if (stamps.length && typeof record.baseSolidBits !== "string") {
    throw new Ncf1ValidationError("Forge machining draft base solid is missing.", "invalid-machining-state");
  }
  if (!stamps.length && record.baseSolidBits !== null) {
    throw new Ncf1ValidationError("Forge machining draft base solid must be null without stamps.", "invalid-machining-state");
  }
  const baseSolid = stamps.length
    ? decodeMachiningSolid(record.baseSolidBits)
    : new Uint8Array(component.solid);
  return normalizeForgeMachiningState(component, {
    kind: FORGE_MACHINING_STATE_KIND,
    referenceDimsQ: record.referenceDimsQ,
    baseSolid,
    stamps,
  });
}

function normalizeSerializedForgeMachiningStamp(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Ncf1ValidationError("Forge machining draft stamps must be objects.", "invalid-machining-stamp");
  }
  const toolId = serializedMachiningEnum(
    input.toolId,
    ["handDrill", "saw"],
    "Forge machining stamp tool",
  );
  const commonKeys = ["toolId", "axis", "side", "centerQ", "sizeQ", "depthQ"];
  const toolKeys = toolId === "handDrill"
    ? ["profile", "direction"]
    : ["normalQ", "angle", "mode", "trimSide"];
  assertSerializedMachiningKeys(
    input,
    [...commonKeys, ...toolKeys],
    "Forge machining draft stamp",
    "invalid-machining-stamp",
  );
  assertSerializedMachiningInteger(input.axis, 0, 2, "Forge machining stamp axis", "invalid-machining-stamp");
  assertSerializedMachiningInteger(input.side, 0, 1, "Forge machining stamp side", "invalid-machining-stamp");
  assertSerializedMachiningIntegerVector(
    input.centerQ,
    -2048,
    2047,
    "Forge machining stamp center",
    "invalid-machining-stamp",
  );
  assertSerializedMachiningIntegerVector(
    input.sizeQ,
    1,
    2047,
    "Forge machining stamp size",
    "invalid-machining-stamp",
  );
  assertSerializedMachiningInteger(input.depthQ, 0, 2047, "Forge machining stamp depth", "invalid-machining-stamp");
  if (toolId === "handDrill") {
    serializedMachiningEnum(
      input.profile,
      ["round", "square", "slot"],
      "Forge machining drill profile",
    );
    serializedMachiningEnum(input.direction, ["a", "b"], "Forge machining drill direction");
  } else {
    assertSerializedMachiningIntegerVector(
      input.normalQ,
      -SAW_TRIG_SCALE,
      SAW_TRIG_SCALE,
      "Forge machining saw normal",
      "invalid-machining-stamp",
    );
    serializedMachiningEnum(
      input.angle,
      Object.keys(SAW_CROSS_BY_ANGLE).map(Number),
      "Forge machining saw angle",
    );
    serializedMachiningEnum(input.mode, ["kerf", "trim"], "Forge machining saw mode");
    serializedMachiningEnum(input.trimSide, ["a", "b"], "Forge machining saw trim side");
  }
  return normalizeForgeMachiningStamp(input);
}

function assertSerializedMachiningKeys(input, expectedKeys, label, code) {
  const actual = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Ncf1ValidationError(`${label} has invalid fields.`, code);
  }
}

function assertSerializedMachiningInteger(input, min, max, label, code) {
  if (!Number.isInteger(input) || input < min || input > max) {
    throw new Ncf1ValidationError(`${label} must be an integer between ${min} and ${max}.`, code);
  }
}

function assertSerializedMachiningIntegerVector(input, min, max, label, code) {
  if (!Array.isArray(input) || input.length !== 3) {
    throw new Ncf1ValidationError(`${label} must contain three integers.`, code);
  }
  for (const value of input) assertSerializedMachiningInteger(value, min, max, label, code);
}

function serializedMachiningEnum(input, allowed, label) {
  if (!allowed.includes(input)) {
    throw new Ncf1ValidationError(`${label} is invalid.`, "invalid-machining-stamp");
  }
  return input;
}

function finalizeForgeMachiningState(referenceDimsQ, baseSolid, stamps) {
  const state = {
    kind: FORGE_MACHINING_STATE_KIND,
    referenceDimsQ: Object.freeze([...referenceDimsQ]),
    baseSolid,
    stamps: Object.freeze(stamps.map((stamp) => Object.freeze(cloneForgeMachiningStamp(stamp)))),
  };
  Object.freeze(state);
  verifiedForgeMachiningStates.add(state);
  return state;
}

function cloneForgeMachiningStamp(input) {
  return {
    ...input,
    centerQ: [...input.centerQ],
    sizeQ: [...input.sizeQ],
    ...(input.normalQ ? { normalQ: [...input.normalQ] } : {}),
  };
}

function normalizeForgeMachiningStamp(input) {
  if (!input || typeof input !== "object") {
    throw new Ncf1ValidationError("Forge machining stamps must be objects.", "invalid-machining-stamp");
  }
  const toolId = enumValue(input.toolId, ["handDrill", "saw"], "");
  if (!toolId) throw new Ncf1ValidationError("Forge machining stamp tool is invalid.", "invalid-machining-stamp");
  const axis = normalizeAxis(input.axis);
  const side = normalizeFaceSide(input.side);
  const centerQ = integerVector(input.centerQ, "forge machining stamp center")
    .map((value, coordinate) => integerInRange(value, -2048, 2047, `forge machining stamp center ${coordinate}`));
  const sizeQ = integerVector(input.sizeQ, "forge machining stamp size")
    .map((value, coordinate) => integerInRange(value, 1, 2047, `forge machining stamp size ${coordinate}`));
  const depthQ = integerInRange(input.depthQ ?? 0, 0, 2047, "forge machining stamp depth");
  if (toolId === "handDrill") {
    return Object.freeze({
      toolId,
      axis,
      side,
      centerQ: Object.freeze(centerQ),
      sizeQ: Object.freeze(sizeQ),
      depthQ,
      profile: enumValue(input.profile, ["round", "square", "slot"], "round"),
      direction: enumValue(input.direction, ["a", "b"], "a"),
    });
  }
  const normalQ = integerVector(input.normalQ, "forge saw normal")
    .map((value, coordinate) => integerInRange(value, -SAW_TRIG_SCALE, SAW_TRIG_SCALE, `forge saw normal ${coordinate}`));
  if (normalQ.every((value) => value === 0) || normalQ[axis] !== 0) {
    throw new Ncf1ValidationError("Forge saw normals must lie in the cut surface.", "invalid-machining-stamp");
  }
  return Object.freeze({
    toolId,
    axis,
    side,
    centerQ: Object.freeze(centerQ),
    sizeQ: Object.freeze(sizeQ),
    depthQ,
    normalQ: Object.freeze(normalQ),
    angle: normalizeSawAngle(input.angle ?? 0),
    mode: enumValue(input.mode, ["kerf", "trim"], "kerf"),
    trimSide: enumValue(input.trimSide, ["a", "b"], "a"),
  });
}

function appendForgeMachiningStamp(component, stampInput) {
  const current = component.machining
    ? normalizeForgeMachiningState(component, component.machining)
    : createForgeMachiningCheckpoint(component);
  if (current.stamps.length >= FORGE_MACHINING_MAX_STAMPS) {
    throw new Ncf1ValidationError("Forge machining stamp limit exceeded.", "too-many-machining-stamps");
  }
  return finalizeForgeMachiningState(
    current.referenceDimsQ,
    current.baseSolid,
    [...current.stamps, normalizeForgeMachiningStamp(stampInput)],
  );
}

function createDrillMachiningStamp(component, footprint, options) {
  const state = component.machining
    ? normalizeForgeMachiningState(component, component.machining)
    : createForgeMachiningCheckpoint(component);
  const axes = tangentAxes(footprint.axis);
  const centerQ = machiningStampCenterQ(component, footprint, options);
  const pitchQ = state.referenceDimsQ.map((value, axis) => Math.max(1, Math.round(value / FORGE_GRID_SIZES[axis])));
  const sizeQ = [...pitchQ];
  if (footprint.profile === "slot") {
    const bounds = drillProfileBounds(footprint.size, footprint.profile, footprint.direction);
    sizeQ[axes[0]] = Math.max(1, (bounds[0] * 2 + 1) * pitchQ[axes[0]]);
    sizeQ[axes[1]] = Math.max(1, (bounds[1] * 2 + 1) * pitchQ[axes[1]]);
  } else if (footprint.profile === "round") {
    const commonPitchQ = Math.min(pitchQ[axes[0]], pitchQ[axes[1]]);
    const diameterQ = Math.max(2, Math.round(
      (Math.floor(footprint.size / 2) * 200 + 24) * commonPitchQ / 100,
    ));
    sizeQ[axes[0]] = diameterQ;
    sizeQ[axes[1]] = diameterQ;
  } else {
    const diameterQ = Math.max(1, footprint.size * Math.min(pitchQ[axes[0]], pitchQ[axes[1]]));
    sizeQ[axes[0]] = diameterQ;
    sizeQ[axes[1]] = diameterQ;
  }
  return {
    toolId: "handDrill",
    axis: footprint.axis,
    side: footprint.side,
    centerQ,
    sizeQ,
    depthQ: machiningDepthQ(state, footprint),
    profile: footprint.profile,
    direction: footprint.direction,
  };
}

function createSawMachiningStamp(component, footprint, options) {
  const state = component.machining
    ? normalizeForgeMachiningState(component, component.machining)
    : createForgeMachiningCheckpoint(component);
  const axes = tangentAxes(footprint.axis);
  const pitchQ = state.referenceDimsQ.map((value, axis) => Math.max(1, Math.round(value / FORGE_GRID_SIZES[axis])));
  const kerfQ = Math.max(1, Math.min(pitchQ[axes[0]], pitchQ[axes[1]]));
  const sizeQ = [...pitchQ];
  sizeQ[axes[0]] = kerfQ;
  sizeQ[axes[1]] = kerfQ;
  const cross = SAW_CROSS_BY_ANGLE[footprint.angle] ?? SAW_CROSS_BY_ANGLE[0];
  const normalQ = [0, 0, 0];
  normalQ[axes[0]] = cross[0];
  normalQ[axes[1]] = cross[1];
  return {
    toolId: "saw",
    axis: footprint.axis,
    side: footprint.side,
    centerQ: machiningStampCenterQ(component, footprint, options),
    sizeQ,
    depthQ: machiningDepthQ(state, footprint),
    normalQ,
    angle: footprint.angle,
    mode: footprint.mode,
    trimSide: footprint.trimSide,
  };
}

function machiningStampCenterQ(component, footprint, options) {
  const explicit = integerVectorOrNull(options.offsetQ);
  if (explicit) return explicit;
  return FORGE_GRID_SIZES.map((cells, axis) => {
    if (axis === footprint.axis) {
      return Math.round(-component.dimsQ[axis] / 2 + footprint.plane * component.dimsQ[axis] / cells);
    }
    return Math.round(
      -component.dimsQ[axis] / 2
      + (footprint.center[axis] + 0.5) * component.dimsQ[axis] / cells,
    );
  });
}

function machiningDepthQ(state, footprint) {
  if (footprint.depth === "through") return 0;
  const pitchQ = Math.max(1, Math.round(state.referenceDimsQ[footprint.axis] / FORGE_GRID_SIZES[footprint.axis]));
  return Math.max(1, footprint.depthLayers * pitchQ);
}

function rasterizeForgeMachining(
  component,
  stateInput,
  { targetSolidCells = null, ownerIndices = null } = {},
) {
  const state = normalizeForgeMachiningState(component, stateInput);
  if (!state.stamps.length) return new Uint8Array(state.baseSolid);
  const canonicalStamps = [...state.stamps].sort(compareForgeMachiningStampsCanonical);
  const centersQ2 = FORGE_GRID_SIZES.map((cells, axis) => Array.from(
    { length: cells },
    (_, coordinate) => -component.dimsQ[axis]
      + Math.round((coordinate * 2 + 1) * component.dimsQ[axis] / cells),
  ));
  const boundariesQ2 = FORGE_GRID_SIZES.map((cells, axis) => Array.from(
    { length: cells + 1 },
    (_, coordinate) => -component.dimsQ[axis]
      + Math.round(coordinate * 2 * component.dimsQ[axis] / cells),
  ));
  const solid = new Uint8Array(state.baseSolid);
  const candidates = targetSolidCells == null ? null : [];
  const scores = targetSolidCells == null ? null : new Float64Array(FORGE_WORKBENCH_SOLID_CELL_COUNT);
  const tieKeys = targetSolidCells == null ? null : new Uint16Array(FORGE_WORKBENCH_SOLID_CELL_COUNT);
  for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
    for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
      for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
        const index = forgeVoxelIndex(x, y, z);
        if (!state.baseSolid[index]) continue;
        let score = FORGE_MACHINING_OUTSIDE_SCORE;
        let bestStampIndex = 0;
        for (let stampIndex = 0; stampIndex < canonicalStamps.length; stampIndex += 1) {
          const stamp = canonicalStamps[stampIndex];
          const candidateScore = forgeMachiningStampScore(
            stamp,
            centersQ2[0][x],
            centersQ2[1][y],
            centersQ2[2][z],
          );
          if (candidateScore < score) {
            score = candidateScore;
            bestStampIndex = stampIndex;
          }
        }
        if (ownerIndices) ownerIndices[index] = bestStampIndex;
        if (targetSolidCells == null) {
          if (score <= 0) solid[index] = 0;
        } else {
          candidates.push(index);
          scores[index] = score;
          tieKeys[index] = forgeMachiningStampTieKey(canonicalStamps[bestStampIndex], x, y, z);
        }
      }
    }
  }
  if (targetSolidCells != null) {
    const baseCells = candidates.length;
    const keepCells = integerInRange(
      targetSolidCells,
      1,
      Math.max(1, baseCells),
      "forge machining target solid cells",
    );
    const removeCells = Math.max(0, baseCells - keepCells);
    const mandatory = forgeMachiningThroughAnchorCells(
      state.baseSolid,
      canonicalStamps,
      centersQ2,
      boundariesQ2,
    );
    if (mandatory.size > removeCells) {
      throw new Ncf1ValidationError(
        "Forge machining target cannot preserve every through-cut anchor.",
        "machining-target-budget-too-small",
      );
    }
    for (const index of mandatory) solid[index] = 0;
    const ranked = candidates.filter((index) => !mandatory.has(index));
    ranked.sort((left, right) => scores[left] - scores[right] || tieKeys[left] - tieKeys[right] || left - right);
    const remaining = removeCells - mandatory.size;
    if (remaining > ranked.length) {
      throw new Ncf1ValidationError(
        "Forge machining target exceeds the available solid-cell budget.",
        "machining-target-budget-too-small",
      );
    }
    for (let index = 0; index < remaining; index += 1) solid[ranked[index]] = 0;
    if (forgeSolidCellCount(solid) !== keepCells) {
      throw new Ncf1ValidationError(
        "Forge machining target did not resolve to its exact solid-cell count.",
        "machining-target-count-mismatch",
      );
    }
  }
  preserveOneSolidCell(state.baseSolid, solid);
  return solid;
}

function forgeMachiningThroughAnchorCells(baseSolid, stamps, centersQ2, boundariesQ2) {
  const mandatory = new Set();
  for (const stamp of stamps) {
    if (stamp.depthQ !== 0) continue;
    const axes = tangentAxes(stamp.axis);
    const anchorsA = forgeMachiningCellsContainingQ(
      boundariesQ2[axes[0]],
      centersQ2[axes[0]],
      stamp.centerQ[axes[0]] * 2,
    );
    const anchorsB = forgeMachiningCellsContainingQ(
      boundariesQ2[axes[1]],
      centersQ2[axes[1]],
      stamp.centerQ[axes[1]] * 2,
    );
    for (const coordinateA of anchorsA) {
      for (const coordinateB of anchorsB) {
        const anchor = [0, 0, 0];
        anchor[axes[0]] = coordinateA;
        anchor[axes[1]] = coordinateB;
        for (let coordinate = 0; coordinate < FORGE_GRID_SIZES[stamp.axis]; coordinate += 1) {
          anchor[stamp.axis] = coordinate;
          const index = forgeVoxelIndex(anchor[0], anchor[1], anchor[2]);
          if (baseSolid[index]) mandatory.add(index);
        }
      }
    }
  }
  return mandatory;
}

function forgeMachiningCellsContainingQ(boundariesQ2, centersQ2, targetQ2) {
  const coordinates = [];
  for (let coordinate = 0; coordinate < centersQ2.length; coordinate += 1) {
    if (targetQ2 >= boundariesQ2[coordinate] && targetQ2 <= boundariesQ2[coordinate + 1]) {
      coordinates.push(coordinate);
    }
  }
  return coordinates.length ? coordinates : [closestForgeMachiningCell(centersQ2, targetQ2)];
}

function closestForgeMachiningCell(centersQ2, targetQ2) {
  let best = 0;
  let bestDistance = Math.abs(centersQ2[0] - targetQ2);
  for (let coordinate = 1; coordinate < centersQ2.length; coordinate += 1) {
    const distance = Math.abs(centersQ2[coordinate] - targetQ2);
    if (distance < bestDistance) {
      best = coordinate;
      bestDistance = distance;
    }
  }
  return best;
}

// The canonical component grid has a fixed resolution. Once a physical tool
// footprint would leave the component or differ by more than one grid cell,
// another deformation cannot preserve both the machining geometry and the
// exact material-cell budget. Reject that deformation instead of stretching
// the hole or kerf into an unrelated shape.
function forgeMachiningFitsDeformedGrid(component, state, previousComponent = component, previousState = state) {
  for (let stampIndex = 0; stampIndex < state.stamps.length; stampIndex += 1) {
    const stamp = state.stamps[stampIndex];
    const previousStamp = previousState.stamps[stampIndex] ?? stamp;
    const axes = tangentAxes(stamp.axis);
    if (stamp.toolId === "handDrill") {
      for (const axis of axes) {
        if (!forgeMachiningFootprintFitsAxis(
          component,
          stamp,
          axis,
          stamp.sizeQ[axis],
          previousComponent,
          previousStamp,
        )) return false;
        if (!forgeMachiningSpanFitsGrid(component, state, axis, stamp.sizeQ[axis])) return false;
      }
    } else {
      const kerfQ = Math.max(stamp.sizeQ[axes[0]], stamp.sizeQ[axes[1]]);
      for (const axis of axes) {
        const projectedKerfQ = Math.ceil(kerfQ * Math.abs(stamp.normalQ[axis]) / SAW_TRIG_SCALE);
        if (!forgeMachiningFootprintFitsAxis(
          component,
          stamp,
          axis,
          projectedKerfQ,
          previousComponent,
          previousStamp,
        )) return false;
        if (projectedKerfQ && !forgeMachiningSpanFitsGrid(component, state, axis, projectedKerfQ)) return false;
      }
    }
    if (stamp.depthQ && !forgeMachiningDepthFitsComponent(component, state, stamp)) return false;
  }
  return true;
}

function forgeMachiningBaseSupportsDeformation(state) {
  return forgeSolidCellCount(state.baseSolid) === FORGE_WORKBENCH_SOLID_CELL_COUNT;
}

function forgeMachiningFootprintFitsAxis(
  component,
  stamp,
  axis,
  spanQ,
  previousComponent,
  previousStamp,
) {
  // A surface operation may start clipped by an existing material edge. That
  // is a valid hole or kerf, so requiring its nominal tool footprint to be
  // fully enclosed would block every later hammer strike. Preserve the
  // existing clipped amount instead: deformation may expose more of the fixed
  // physical footprint, but it may not consume more of it at the boundary.
  const overflowQ = Math.max(0, Math.abs(stamp.centerQ[axis]) * 2 + spanQ - component.dimsQ[axis]);
  const previousOverflowQ = Math.max(
    0,
    Math.abs(previousStamp.centerQ[axis]) * 2 + spanQ - previousComponent.dimsQ[axis],
  );
  return overflowQ <= previousOverflowQ;
}

function forgeMachiningSpanFitsGrid(component, state, axis, spanQ) {
  const referenceDimensionQ = state.referenceDimsQ[axis];
  const spanCells = Math.max(1, Math.ceil(spanQ * FORGE_GRID_SIZES[axis] / referenceDimensionQ));
  const dimensionQ = component.dimsQ[axis];
  if (dimensionQ * (spanCells + 1) < referenceDimensionQ * spanCells) return false;
  return spanCells === 1 || dimensionQ * (spanCells - 1) <= referenceDimensionQ * spanCells;
}

function forgeMachiningDepthFitsComponent(component, state, stamp) {
  const startQ2 = stamp.centerQ[stamp.axis] * 2;
  const endQ2 = startQ2 + (stamp.side ? -1 : 1) * stamp.depthQ * 2;
  const halfExtentQ2 = component.dimsQ[stamp.axis];
  if (startQ2 < -halfExtentQ2 || startQ2 > halfExtentQ2
    || endQ2 < -halfExtentQ2 || endQ2 > halfExtentQ2) return false;
  return forgeMachiningSpanFitsGrid(component, state, stamp.axis, stamp.depthQ);
}

function resolveForgeMachiningDeformation(
  previousComponent,
  transformedComponent,
  previousState,
  machining,
  targetSolidCells,
) {
  const candidate = { ...transformedComponent, machining };
  if (!forgeMachiningFitsDeformedGrid(candidate, machining, previousComponent, previousState)) return null;
  const rasterized = rasterizeForgeMachiningDeformation(candidate, machining, targetSolidCells);
  return rasterized && forgeMachiningRasterGeometryFits(
    candidate,
    machining,
    rasterized.solid,
    rasterized.ownerIndices,
  )
    ? { machining, solid: rasterized.solid }
    : null;
}

function forgeMachiningStateFollowingDeformation(previousComponent, transformedComponent, stateInput) {
  const state = normalizeForgeMachiningState(previousComponent, stateInput);
  const stamps = state.stamps.map((stamp) => {
    const centerQ = stamp.centerQ.map((value, axis) => roundSignedRatio(
      value * transformedComponent.dimsQ[axis],
      previousComponent.dimsQ[axis],
    ));
    for (const axis of tangentAxes(stamp.axis)) {
      const spanQ = forgeMachiningStampSpanQ(stamp, axis);
      const previousOverflowQ = Math.max(
        0,
        Math.abs(stamp.centerQ[axis]) * 2 + spanQ - previousComponent.dimsQ[axis],
      );
      const maximumCenterQ = Math.floor(
        (transformedComponent.dimsQ[axis] + previousOverflowQ - spanQ) / 2,
      );
      if (maximumCenterQ < 0) continue;
      centerQ[axis] = clampInteger(centerQ[axis], -maximumCenterQ, maximumCenterQ);
    }
    const maximumSurfaceCenterQ = Math.floor(transformedComponent.dimsQ[stamp.axis] / 2);
    centerQ[stamp.axis] = clampInteger(
      centerQ[stamp.axis],
      -maximumSurfaceCenterQ,
      maximumSurfaceCenterQ,
    );
    return { ...cloneForgeMachiningStamp(stamp), centerQ };
  });
  return finalizeForgeMachiningState(state.referenceDimsQ, state.baseSolid, stamps);
}

function roundSignedRatio(numerator, denominator) {
  const magnitude = Math.floor((Math.abs(numerator) + Math.floor(denominator / 2)) / denominator);
  return numerator < 0 ? -magnitude : magnitude;
}

function forgeMachiningStampSpanQ(stamp, axis) {
  if (stamp.toolId === "handDrill") return stamp.sizeQ[axis];
  const axes = tangentAxes(stamp.axis);
  const kerfQ = Math.max(stamp.sizeQ[axes[0]], stamp.sizeQ[axes[1]]);
  return Math.ceil(kerfQ * Math.abs(stamp.normalQ[axis]) / SAW_TRIG_SCALE);
}

function forgeMachiningRasterGeometryFits(component, stateInput, solid, ownerIndices = null) {
  const state = normalizeForgeMachiningState(component, stateInput);
  if (!state.stamps.length) return true;
  const stamps = [...state.stamps].sort(compareForgeMachiningStampsCanonical);
  const centersQ2 = FORGE_GRID_SIZES.map((cells, axis) => Array.from(
    { length: cells },
    (_, coordinate) => -component.dimsQ[axis]
      + Math.round((coordinate * 2 + 1) * component.dimsQ[axis] / cells),
  ));
  const boundariesQ2 = FORGE_GRID_SIZES.map((cells, axis) => Array.from(
    { length: cells + 1 },
    (_, coordinate) => -component.dimsQ[axis]
      + Math.round(coordinate * 2 * component.dimsQ[axis] / cells),
  ));
  const maxPitchQ2 = boundariesQ2.map((boundaries) => {
    let maximum = 1;
    for (let coordinate = 0; coordinate < boundaries.length - 1; coordinate += 1) {
      maximum = Math.max(maximum, boundaries[coordinate + 1] - boundaries[coordinate]);
    }
    return maximum;
  });
  const geometry = stamps.map(() => ({
    cells: 0,
    minQ2: [Infinity, Infinity, Infinity],
    maxQ2: [-Infinity, -Infinity, -Infinity],
    minSawDistance: Infinity,
    maxSawDistance: -Infinity,
  }));
  for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
    for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
      for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
        const index = forgeVoxelIndex(x, y, z);
        if (!state.baseSolid[index] || solid[index]) continue;
        let owner = ownerIndices?.[index] ?? 0;
        if (!ownerIndices) {
          let ownerScore = forgeMachiningStampScore(
            stamps[0],
            centersQ2[0][x],
            centersQ2[1][y],
            centersQ2[2][z],
          );
          for (let stampIndex = 1; stampIndex < stamps.length; stampIndex += 1) {
            const score = forgeMachiningStampScore(
              stamps[stampIndex],
              centersQ2[0][x],
              centersQ2[1][y],
              centersQ2[2][z],
            );
            if (score < ownerScore) {
              owner = stampIndex;
              ownerScore = score;
            }
          }
        }
        const owned = geometry[owner];
        const stamp = stamps[owner];
        const cell = [x, y, z];
        owned.cells += 1;
        for (let axis = 0; axis < 3; axis += 1) {
          owned.minQ2[axis] = Math.min(owned.minQ2[axis], boundariesQ2[axis][cell[axis]]);
          owned.maxQ2[axis] = Math.max(owned.maxQ2[axis], boundariesQ2[axis][cell[axis] + 1]);
        }
        if (stamp.toolId === "saw") {
          const axes = tangentAxes(stamp.axis);
          for (const aQ2 of [boundariesQ2[axes[0]][cell[axes[0]]], boundariesQ2[axes[0]][cell[axes[0]] + 1]]) {
            for (const bQ2 of [boundariesQ2[axes[1]][cell[axes[1]]], boundariesQ2[axes[1]][cell[axes[1]] + 1]]) {
              const distance = (aQ2 - stamp.centerQ[axes[0]] * 2) * stamp.normalQ[axes[0]]
                + (bQ2 - stamp.centerQ[axes[1]] * 2) * stamp.normalQ[axes[1]];
              owned.minSawDistance = Math.min(owned.minSawDistance, distance);
              owned.maxSawDistance = Math.max(owned.maxSawDistance, distance);
            }
          }
        }
      }
    }
  }
  for (let stampIndex = 0; stampIndex < stamps.length; stampIndex += 1) {
    const stamp = stamps[stampIndex];
    const owned = geometry[stampIndex];
    const axes = tangentAxes(stamp.axis);
    if (!owned.cells) {
      if (stamp.toolId === "saw" && stamp.mode === "trim") {
        const projectedCell = Math.abs(stamp.normalQ[axes[0]]) * maxPitchQ2[axes[0]]
          + Math.abs(stamp.normalQ[axes[1]]) * maxPitchQ2[axes[1]];
        if (forgeMachiningTrimRetreats(
          state.baseSolid,
          solid,
          stamp,
          centersQ2,
          boundariesQ2,
          projectedCell + 2 * SAW_TRIG_SCALE + 128,
        )) return false;
      }
      continue;
    }
    if (stamp.toolId === "handDrill") {
      for (const axis of axes) {
        const centerQ2 = stamp.centerQ[axis] * 2;
        const idealLowQ2 = Math.max(-stamp.sizeQ[axis], -component.dimsQ[axis] - centerQ2);
        const idealHighQ2 = Math.min(stamp.sizeQ[axis], component.dimsQ[axis] - centerQ2);
        const actualLowQ2 = owned.minQ2[axis] - centerQ2;
        const actualHighQ2 = owned.maxQ2[axis] - centerQ2;
        if (!forgeMachiningIntervalFits(
          actualLowQ2,
          actualHighQ2,
          idealLowQ2,
          idealHighQ2,
          maxPitchQ2[axis] + 2,
        )) return false;
      }
    } else if (stamp.mode === "kerf") {
      const normalA = stamp.normalQ[axes[0]];
      const normalB = stamp.normalQ[axes[1]];
      const relativeA = [
        -component.dimsQ[axes[0]] - stamp.centerQ[axes[0]] * 2,
        component.dimsQ[axes[0]] - stamp.centerQ[axes[0]] * 2,
      ];
      const relativeB = [
        -component.dimsQ[axes[1]] - stamp.centerQ[axes[1]] * 2,
        component.dimsQ[axes[1]] - stamp.centerQ[axes[1]] * 2,
      ];
      const boxDistances = [
        relativeA[0] * normalA + relativeB[0] * normalB,
        relativeA[0] * normalA + relativeB[1] * normalB,
        relativeA[1] * normalA + relativeB[0] * normalB,
        relativeA[1] * normalA + relativeB[1] * normalB,
      ];
      const halfKerf = Math.max(stamp.sizeQ[axes[0]], stamp.sizeQ[axes[1]]) * SAW_TRIG_SCALE;
      const idealLow = Math.max(-halfKerf, Math.min(...boxDistances));
      const idealHigh = Math.min(halfKerf, Math.max(...boxDistances));
      const allowance = Math.abs(normalA) * maxPitchQ2[axes[0]]
        + Math.abs(normalB) * maxPitchQ2[axes[1]]
        + 2 * SAW_TRIG_SCALE
        + 128;
      if (!forgeMachiningIntervalFits(
        owned.minSawDistance,
        owned.maxSawDistance,
        idealLow,
        idealHigh,
        allowance,
      )) return false;
    } else if (stamp.mode === "trim") {
      // Exact material conservation may otherwise force ranked cells across
      // the retained side or pull the boundary back into the selected side
      // after repeated deformation. Keep either drift inside one projected
      // grid cell.
      const selectedMinimum = stamp.trimSide === "b"
        ? -owned.maxSawDistance
        : owned.minSawDistance;
      const projectedCell = Math.abs(stamp.normalQ[axes[0]]) * maxPitchQ2[axes[0]]
        + Math.abs(stamp.normalQ[axes[1]]) * maxPitchQ2[axes[1]];
      const allowance = projectedCell + 2 * SAW_TRIG_SCALE + 128;
      if (selectedMinimum < -allowance) return false;
      if (forgeMachiningTrimRetreats(
        state.baseSolid,
        solid,
        stamp,
        centersQ2,
        boundariesQ2,
        allowance,
      )) return false;
    }
    if (stamp.depthQ) {
      const centerQ2 = stamp.centerQ[stamp.axis] * 2;
      const envelopeLowQ2 = stamp.side
        ? centerQ2 - component.dimsQ[stamp.axis]
        : -component.dimsQ[stamp.axis] - centerQ2;
      const envelopeHighQ2 = stamp.side
        ? centerQ2 + component.dimsQ[stamp.axis]
        : component.dimsQ[stamp.axis] - centerQ2;
      const idealLowQ2 = Math.max(0, envelopeLowQ2);
      const idealHighQ2 = Math.min(stamp.depthQ * 2, envelopeHighQ2);
      const actualLowQ2 = stamp.side
        ? centerQ2 - owned.maxQ2[stamp.axis]
        : owned.minQ2[stamp.axis] - centerQ2;
      const actualHighQ2 = stamp.side
        ? centerQ2 - owned.minQ2[stamp.axis]
        : owned.maxQ2[stamp.axis] - centerQ2;
      if (!forgeMachiningIntervalFits(
        actualLowQ2,
        actualHighQ2,
        idealLowQ2,
        idealHighQ2,
        maxPitchQ2[stamp.axis] + 2,
      )) return false;
    }
  }
  return true;
}

function forgeMachiningTrimRetreats(
  baseSolid,
  solid,
  stamp,
  centersQ2,
  boundariesQ2,
  allowance,
) {
  const axes = tangentAxes(stamp.axis);
  const selectedSign = stamp.trimSide === "b" ? -1 : 1;
  const selectedNormalA = stamp.normalQ[axes[0]] * selectedSign;
  const selectedNormalB = stamp.normalQ[axes[1]] * selectedSign;
  for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
    for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
      for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
        const index = forgeVoxelIndex(x, y, z);
        if (!baseSolid[index] || !solid[index]) continue;
        const cell = [x, y, z];
        const inwardQ2 = stamp.side
          ? stamp.centerQ[stamp.axis] * 2 - centersQ2[stamp.axis][cell[stamp.axis]]
          : centersQ2[stamp.axis][cell[stamp.axis]] - stamp.centerQ[stamp.axis] * 2;
        if (inwardQ2 < 0 || (stamp.depthQ && inwardQ2 > stamp.depthQ * 2)) continue;
        const relativeALow = boundariesQ2[axes[0]][cell[axes[0]]] - stamp.centerQ[axes[0]] * 2;
        const relativeAHigh = boundariesQ2[axes[0]][cell[axes[0]] + 1] - stamp.centerQ[axes[0]] * 2;
        const relativeBLow = boundariesQ2[axes[1]][cell[axes[1]]] - stamp.centerQ[axes[1]] * 2;
        const relativeBHigh = boundariesQ2[axes[1]][cell[axes[1]] + 1] - stamp.centerQ[axes[1]] * 2;
        const selectedMaximum = Math.max(
          relativeALow * selectedNormalA,
          relativeAHigh * selectedNormalA,
        ) + Math.max(
          relativeBLow * selectedNormalB,
          relativeBHigh * selectedNormalB,
        );
        if (selectedMaximum > allowance) return true;
      }
    }
  }
  return false;
}

function forgeMachiningIntervalFits(actualLow, actualHigh, idealLow, idealHigh, allowance) {
  if (idealHigh < idealLow || actualHigh < actualLow) return false;
  return Math.max(Math.abs(actualLow - idealLow), Math.abs(actualHigh - idealHigh)) <= allowance
    && Math.abs((actualHigh - actualLow) - (idealHigh - idealLow)) <= allowance;
}

function rasterizeForgeMachiningDeformation(component, state, targetSolidCells) {
  try {
    const ownerIndices = new Uint8Array(FORGE_WORKBENCH_SOLID_CELL_COUNT);
    const solid = rasterizeForgeMachining(component, state, { targetSolidCells, ownerIndices });
    return { solid, ownerIndices };
  } catch (error) {
    if (error?.code === "machining-target-budget-too-small"
      || error?.code === "machining-target-count-mismatch") return null;
    throw error;
  }
}

function compareForgeMachiningStampsCanonical(left, right) {
  return compareIntegerTuples(
    forgeMachiningStampCanonicalTuple(left),
    forgeMachiningStampCanonicalTuple(right),
  );
}

function forgeMachiningStampCanonicalTuple(stamp) {
  return [
    stamp.toolId === "handDrill" ? 0 : 1,
    stamp.axis,
    stamp.side,
    ...stamp.centerQ,
    ...stamp.sizeQ,
    stamp.depthQ,
    stamp.profile === "round" ? 0 : stamp.profile === "square" ? 1 : stamp.profile === "slot" ? 2 : 3,
    stamp.direction === "a" ? 0 : stamp.direction === "b" ? 1 : 2,
    ...(stamp.normalQ ?? [0, 0, 0]),
    stamp.angle ?? 0,
    stamp.mode === "kerf" ? 0 : stamp.mode === "trim" ? 1 : 2,
    stamp.trimSide === "a" ? 0 : stamp.trimSide === "b" ? 1 : 2,
  ];
}

function forgeMachiningStampTieKey(stamp, x, y, z) {
  const axisA = stamp.axis === 0 ? 1 : 0;
  const axisB = stamp.axis === 2 ? 1 : 2;
  const coordinateA = axisA === 0 ? x : axisA === 1 ? y : z;
  const coordinateB = axisB === 0 ? x : axisB === 1 ? y : z;
  const coordinateNormal = stamp.axis === 0 ? x : stamp.axis === 1 ? y : z;
  return (
    coordinateA
    + FORGE_GRID_SIZES[axisA] * coordinateB
  ) * FORGE_GRID_SIZES[stamp.axis] + coordinateNormal;
}

function forgeMachiningStampScore(stamp, xQ2, yQ2, zQ2) {
  const centerQ2 = stamp.axis === 0 ? xQ2 : stamp.axis === 1 ? yQ2 : zQ2;
  const stampCenterQ2 = stamp.centerQ[stamp.axis] * 2;
  const inwardQ2 = stamp.side ? stampCenterQ2 - centerQ2 : centerQ2 - stampCenterQ2;
  const depthScore = stamp.depthQ
    ? Math.max(-inwardQ2, inwardQ2 - stamp.depthQ * 2) * 1_000_000
    : -1_000_000;
  const axisA = stamp.axis === 0 ? 1 : 0;
  const axisB = stamp.axis === 2 ? 1 : 2;
  const coordinateA = axisA === 0 ? xQ2 : axisA === 1 ? yQ2 : zQ2;
  const coordinateB = axisB === 0 ? xQ2 : axisB === 1 ? yQ2 : zQ2;
  const da = coordinateA - stamp.centerQ[axisA] * 2;
  const db = coordinateB - stamp.centerQ[axisB] * 2;
  let surfaceScore;
  if (stamp.toolId === "handDrill" && stamp.profile === "round") {
    const radiusQ2 = Math.max(1, stamp.sizeQ[axisA]);
    surfaceScore = Math.floor((da * da + db * db) * 1_000_000 / (radiusQ2 * radiusQ2)) - 1_000_000;
  } else if (stamp.toolId === "handDrill") {
    surfaceScore = Math.max(
      Math.floor(Math.abs(da) * 1_000_000 / Math.max(1, stamp.sizeQ[axisA])) - 1_000_000,
      Math.floor(Math.abs(db) * 1_000_000 / Math.max(1, stamp.sizeQ[axisB])) - 1_000_000,
    );
  } else {
    const signedDistance = da * stamp.normalQ[axisA] + db * stamp.normalQ[axisB];
    const halfKerfScaled = Math.max(1, stamp.sizeQ[axisA]) * SAW_TRIG_SCALE;
    if (stamp.mode === "trim") {
      const selectedDistance = stamp.trimSide === "b" ? -signedDistance : signedDistance;
      surfaceScore = -selectedDistance;
    } else {
      surfaceScore = Math.abs(signedDistance) - halfKerfScaled;
    }
  }
  return Math.max(depthScore, surfaceScore);
}

function rotateForgeMachiningState(component, stateInput, mapping) {
  const state = normalizeForgeMachiningState(component, stateInput);
  const referenceDimsQ = [0, 0, 0];
  for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
    referenceDimsQ[mapping[sourceAxis].targetAxis] = state.referenceDimsQ[sourceAxis];
  }
  const stamps = state.stamps.map((stamp) => {
    const centerQ = [0, 0, 0];
    const sizeQ = [0, 0, 0];
    const normalQ = stamp.normalQ ? [0, 0, 0] : null;
    for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
      const entry = mapping[sourceAxis];
      centerQ[entry.targetAxis] = stamp.centerQ[sourceAxis] * entry.sign;
      sizeQ[entry.targetAxis] = stamp.sizeQ[sourceAxis];
      if (normalQ) normalQ[entry.targetAxis] = stamp.normalQ[sourceAxis] * entry.sign;
    }
    const normalMapping = mapping[stamp.axis];
    return {
      ...cloneForgeMachiningStamp(stamp),
      axis: normalMapping.targetAxis,
      side: normalMapping.sign > 0 ? stamp.side : 1 - stamp.side,
      centerQ,
      sizeQ,
      ...(normalQ ? { normalQ } : {}),
    };
  });
  return finalizeForgeMachiningState(
    referenceDimsQ,
    rotateForgeSolid(state.baseSolid, mapping),
    stamps,
  );
}

function serializeForgeMachiningStamp(stamp) {
  const serialized = cloneForgeMachiningStamp(stamp);
  return serialized;
}

function encodeMachiningSolid(solid) {
  assertSolid(solid);
  const packed = new Uint8Array(Math.ceil(solid.length / 8));
  for (let index = 0; index < solid.length; index += 1) {
    if (solid[index]) packed[index >> 3] |= 1 << (index & 7);
  }
  let binary = "";
  for (const value of packed) binary += String.fromCharCode(value);
  const encoded = typeof globalThis.btoa === "function"
    ? globalThis.btoa(binary)
    : globalThis.Buffer?.from(binary, "binary").toString("base64");
  if (!encoded) throw new Ncf1ValidationError("Forge machining solid encoding is unavailable.", "machining-codec-unavailable");
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeMachiningSolid(input) {
  const value = String(input ?? "");
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Ncf1ValidationError("Forge machining solid encoding is invalid.", "invalid-machining-state");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary;
  try {
    binary = typeof globalThis.atob === "function"
      ? globalThis.atob(padded)
      : globalThis.Buffer?.from(padded, "base64").toString("binary");
  } catch {
    throw new Ncf1ValidationError("Forge machining solid encoding is invalid.", "invalid-machining-state");
  }
  const expectedBytes = Math.ceil(FORGE_WORKBENCH_SOLID_CELL_COUNT / 8);
  if (typeof binary !== "string" || binary.length !== expectedBytes) {
    throw new Ncf1ValidationError("Forge machining solid encoding has an invalid length.", "invalid-machining-state");
  }
  const solid = new Uint8Array(FORGE_WORKBENCH_SOLID_CELL_COUNT);
  for (let index = 0; index < solid.length; index += 1) {
    solid[index] = (binary.charCodeAt(index >> 3) >> (index & 7)) & 1;
  }
  if (encodeMachiningSolid(solid) !== value) {
    throw new Ncf1ValidationError("Forge machining solid encoding must be canonical.", "invalid-machining-state");
  }
  return solid;
}

function integerVectorOrNull(input) {
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== 3) return null;
  const values = Array.from(input);
  return values.every(Number.isInteger) ? values : null;
}

function toolDepthLayers(fullDepth, mode) {
  if (mode === "shallow") return Math.max(1, Math.ceil(fullDepth / 4));
  if (mode === "half") return Math.max(1, Math.ceil(fullDepth / 2));
  return fullDepth;
}

function normalizeSawAngle(input) {
  const numeric = Number(input);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = ((Math.round(numeric) % 180) + 180) % 180;
  return Object.keys(SAW_CROSS_BY_ANGLE)
    .map(Number)
    .reduce((best, angle) => Math.abs(angle - normalized) < Math.abs(best - normalized) ? angle : best, 0);
}

function signedSawDistanceQ(cell, center, axes, angle) {
  const cross = SAW_CROSS_BY_ANGLE[angle] ?? SAW_CROSS_BY_ANGLE[0];
  return (cell[axes[0]] - center[axes[0]]) * cross[0]
    + (cell[axes[1]] - center[axes[1]]) * cross[1];
}

function automaticSawTrimSide(solid, axis, layer, center, axes, angle) {
  const counts = { a: 0, b: 0 };
  for (let a = 0; a < FORGE_GRID_SIZES[axes[0]]; a += 1) {
    for (let b = 0; b < FORGE_GRID_SIZES[axes[1]]; b += 1) {
      const cell = [...center];
      cell[axis] = layer;
      cell[axes[0]] = a;
      cell[axes[1]] = b;
      if (!solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) continue;
      const distanceQ = signedSawDistanceQ(cell, center, axes, angle);
      if (distanceQ > SAW_DISTANCE_HALF_Q) counts.a += 1;
      else if (distanceQ < -SAW_DISTANCE_HALF_Q) counts.b += 1;
    }
  }
  if (counts.a === counts.b) {
    return center[axes[0]] >= FORGE_GRID_SIZES[axes[0]] / 2 ? "a" : "b";
  }
  return counts.a <= counts.b ? "a" : "b";
}

function drillProfileBounds(size, profile, direction) {
  const half = Math.floor(size / 2);
  if (profile !== "slot") return [half, half];
  const longHalf = size <= 1 ? 0 : half + 1;
  const shortHalf = size >= 5 ? 1 : 0;
  return direction === "b" ? [shortHalf, longHalf] : [longHalf, shortHalf];
}

function drillCellInProfile(a, b, center, size, profile, direction) {
  const da = a - center[0];
  const db = b - center[1];
  if (profile === "square") {
    const half = Math.floor(size / 2);
    return Math.abs(da) <= half && Math.abs(db) <= half;
  }
  if (profile === "slot") {
    const bounds = drillProfileBounds(size, profile, direction);
    return Math.abs(da) <= bounds[0] && Math.abs(db) <= bounds[1];
  }
  const radiusQ = Math.floor(size / 2) * 100 + 12;
  return (da * da + db * db) * 10_000 <= radiusQ * radiusQ;
}

function forgeCellInside(cell) {
  return cell.every((value, axis) => value >= 0 && value < FORGE_GRID_SIZES[axis]);
}

function enumValue(input, allowed, fallback) {
  const value = String(input ?? "");
  return allowed.includes(value) ? value : fallback;
}

function finiteVectorOrNull(input) {
  const values = Array.isArray(input) || ArrayBuffer.isView(input)
    ? Array.from(input).slice(0, 3)
    : null;
  if (!values || values.length !== 3 || values.some((value) => !Number.isFinite(Number(value)))) return null;
  return values.map(Number);
}

function forgeGridCellAtPoint(component, point) {
  return FORGE_GRID_SIZES.map((cells, axis) => {
    const minQ2 = component.offsetQ[axis] * 2 - component.dimsQ[axis];
    const pointQ2 = point[axis] * FORGE_FIXED_SCALE * 2;
    const coordinate = Math.floor((pointQ2 - minQ2) * cells / (component.dimsQ[axis] * 2));
    return clampInteger(coordinate, 0, cells - 1);
  });
}

function forgeGridPlaneAtPoint(component, point, axis) {
  const minQ2 = component.offsetQ[axis] * 2 - component.dimsQ[axis];
  const pointQ2 = point[axis] * FORGE_FIXED_SCALE * 2;
  return clampInteger(
    (pointQ2 - minQ2) * FORGE_GRID_SIZES[axis] / (component.dimsQ[axis] * 2),
    0,
    FORGE_GRID_SIZES[axis],
  );
}

function normalizeColor444(input) {
  if (Number.isInteger(input) && input >= 0 && input <= 0xfff) return input;
  let rgb = input;
  if (typeof input === "string" && /^#[0-9a-f]{3}$/iu.test(input)) return Number.parseInt(input.slice(1), 16);
  if (typeof input === "string" && /^#[0-9a-f]{6}$/iu.test(input)) rgb = Number.parseInt(input.slice(1), 16);
  if (!Number.isInteger(rgb) || rgb < 0 || rgb > 0xffffff) {
    throw new Ncf1ValidationError("Forge colors must be rgb444, #rgb, #rrggbb, or 24-bit RGB.", "invalid-color");
  }
  const r = Math.round(((rgb >> 16) & 255) * 15 / 255);
  const g = Math.round(((rgb >> 8) & 255) * 15 / 255);
  const b = Math.round((rgb & 255) * 15 / 255);
  return (r << 8) | (g << 4) | b;
}

function assertComponent(input) {
  if (!input || typeof input !== "object") {
    throw new Ncf1ValidationError("Forge component state is required.", "invalid-component");
  }
  const dimsQ = input.dimsQ;
  const offsetQ = input.offsetQ;
  if ((!Array.isArray(dimsQ) && !ArrayBuffer.isView(dimsQ)) || dimsQ.length !== 3) {
    throw new Ncf1ValidationError("Forge component dimensions require three integers.", "invalid-component");
  }
  if ((!Array.isArray(offsetQ) && !ArrayBuffer.isView(offsetQ)) || offsetQ.length !== 3) {
    throw new Ncf1ValidationError("Forge component offsets require three integers.", "invalid-component");
  }
  for (const value of dimsQ) integerInRange(value, 1, 255, "forge component dimension");
  for (const value of offsetQ) integerInRange(value, -512, 511, "forge component offset");
  assertSolid(input.solid);
  return input;
}

function assertSolid(input) {
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== FORGE_WORKBENCH_SOLID_CELL_COUNT) {
    throw new Ncf1ValidationError("Forge solid masks require exactly 1,960 cells.", "invalid-solid-length");
  }
  return input;
}

function longestDimensionAxis(dimsQ) {
  let axis = 0;
  for (let candidate = 1; candidate < 3; candidate += 1) {
    if (dimsQ[candidate] > dimsQ[axis]) axis = candidate;
  }
  return axis;
}

function occupiedAxisSpan(solid, axis) {
  const sizes = FORGE_GRID_SIZES;
  let min = sizes[axis];
  let max = -1;
  for (let z = 0; z < sizes[2]; z += 1) {
    for (let y = 0; y < sizes[1]; y += 1) {
      for (let x = 0; x < sizes[0]; x += 1) {
        if (!solid[forgeVoxelIndex(x, y, z)]) continue;
        const coordinate = axis === 0 ? x : axis === 1 ? y : z;
        min = Math.min(min, coordinate);
        max = Math.max(max, coordinate);
      }
    }
  }
  return max < min ? null : { min, max, length: max - min + 1 };
}

function clearSolidAxisRange(solid, axis, min, max) {
  const sizes = FORGE_GRID_SIZES;
  for (let z = 0; z < sizes[2]; z += 1) {
    for (let y = 0; y < sizes[1]; y += 1) {
      for (let x = 0; x < sizes[0]; x += 1) {
        const coordinate = axis === 0 ? x : axis === 1 ? y : z;
        if (coordinate >= min && coordinate <= max) solid[forgeVoxelIndex(x, y, z)] = 0;
      }
    }
  }
}

function preserveOneSolidCell(before, after) {
  if (forgeSolidCellCount(after) > 0) return;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index]) {
      after[index] = 1;
      return;
    }
  }
}

function equalSolid(left, right) {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

// Each entry describes where one source axis lands after a positive 90-degree
// right-handed turn. The sign applies to both coordinates and normals.
function forgeQuarterTurnMapping(axis) {
  if (axis === 0) {
    return [
      { targetAxis: 0, sign: 1 },
      { targetAxis: 2, sign: 1 },
      { targetAxis: 1, sign: -1 },
    ];
  }
  if (axis === 1) {
    return [
      { targetAxis: 2, sign: -1 },
      { targetAxis: 1, sign: 1 },
      { targetAxis: 0, sign: 1 },
    ];
  }
  return [
    { targetAxis: 1, sign: 1 },
    { targetAxis: 0, sign: -1 },
    { targetAxis: 2, sign: 1 },
  ];
}

// The NCF1 component lattice is 14x10x14. Y rotations are an exact
// permutation. X/Z rotations exchange unequal 10/14 axes, so exact cell
// geometry is not representable in the fixed lattice. For those turns we use
// exact rational overlap coverage, then retain the same number of highest-
// coverage target cells. This is deterministic and conserves material volume.
function rotateForgeSolid(source, mapping) {
  const solidCells = forgeSolidCellCount(source);
  const overlapTables = mapping.map((entry, sourceAxis) => axisOverlapTable(
    FORGE_GRID_SIZES[entry.targetAxis],
    FORGE_GRID_SIZES[sourceAxis],
    entry.sign,
  ));
  const scores = new Uint32Array(FORGE_WORKBENCH_SOLID_CELL_COUNT);
  for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
    for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
      for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
        const target = [x, y, z];
        const xOverlaps = overlapTables[0][target[mapping[0].targetAxis]];
        const yOverlaps = overlapTables[1][target[mapping[1].targetAxis]];
        const zOverlaps = overlapTables[2][target[mapping[2].targetAxis]];
        let score = 0;
        for (const [sourceX, overlapX] of xOverlaps) {
          for (const [sourceY, overlapY] of yOverlaps) {
            for (const [sourceZ, overlapZ] of zOverlaps) {
              if (source[forgeVoxelIndex(sourceX, sourceY, sourceZ)]) {
                score += overlapX * overlapY * overlapZ;
              }
            }
          }
        }
        scores[forgeVoxelIndex(x, y, z)] = score;
      }
    }
  }
  const order = Array.from({ length: scores.length }, (_, index) => index);
  order.sort((left, right) => scores[right] - scores[left] || left - right);
  const result = new Uint8Array(source.length);
  for (let index = 0; index < solidCells; index += 1) result[order[index]] = 1;
  return result;
}

function axisOverlapTable(targetSize, sourceSize, sign) {
  const table = new Array(targetSize);
  for (let target = 0; target < targetSize; target += 1) {
    const mappedTarget = sign > 0 ? target : targetSize - 1 - target;
    const targetMin = mappedTarget * sourceSize;
    const targetMax = (mappedTarget + 1) * sourceSize;
    const overlaps = [];
    for (let source = 0; source < sourceSize; source += 1) {
      const overlap = Math.min(targetMax, (source + 1) * targetSize)
        - Math.max(targetMin, source * targetSize);
      if (overlap > 0) overlaps.push([source, overlap]);
    }
    table[target] = overlaps;
  }
  return table;
}

function rotateForgeGrip(grip, mapping) {
  if (!grip) return null;
  const offsetQ = [0, 0, 0];
  for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
    const entry = mapping[sourceAxis];
    offsetQ[entry.targetAxis] = clampInteger(grip.offsetQ[sourceAxis] * entry.sign, -512, 511);
  }
  const normal = mapping[grip.axis];
  return {
    offsetQ,
    axis: normal.targetAxis,
    sign: grip.sign * normal.sign,
    rotation: grip.rotation,
  };
}

function rotateForgePaint(component, targetSolid, mapping) {
  if (!component.paintQuads?.length) return [];
  const sourcePaint = new Map();
  for (const quad of component.paintQuads) {
    for (let v = quad.v0; v < quad.v1; v += 1) {
      for (let u = quad.u0; u < quad.u1; u += 1) {
        sourcePaint.set(paintFaceCellKey(quad.axis, quad.side, quad.plane, u, v), quad.color444);
      }
    }
  }
  const targetPlanes = new Map();
  for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
    for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
      for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
        if (!targetSolid[forgeVoxelIndex(x, y, z)]) continue;
        const targetCell = [x, y, z];
        const sourceCell = sourceCellForTargetCell(targetCell, mapping);
        for (let targetAxis = 0; targetAxis < 3; targetAxis += 1) {
          for (const targetSide of [0, 1]) {
            if (!isExposedForgeFace(targetSolid, targetCell, targetAxis, targetSide)) continue;
            const sourceNormal = sourceNormalForTargetNormal(targetAxis, targetSide, mapping);
            const sourceTangents = tangentAxes(sourceNormal.axis);
            const sourcePlane = sourceCell[sourceNormal.axis] + (sourceNormal.side ? 1 : 0);
            const color444 = sourcePaint.get(paintFaceCellKey(
              sourceNormal.axis,
              sourceNormal.side,
              sourcePlane,
              sourceCell[sourceTangents[0]],
              sourceCell[sourceTangents[1]],
            ));
            if (color444 == null) continue;
            const targetTangents = tangentAxes(targetAxis);
            const targetPlane = targetCell[targetAxis] + (targetSide ? 1 : 0);
            const planeKey = `${targetAxis}:${targetSide}:${targetPlane}`;
            let plane = targetPlanes.get(planeKey);
            if (!plane) {
              const width = FORGE_GRID_SIZES[targetTangents[0]];
              const height = FORGE_GRID_SIZES[targetTangents[1]];
              plane = { targetAxis, targetSide, targetPlane, width, height, colors: new Uint16Array(width * height) };
              targetPlanes.set(planeKey, plane);
            }
            const u = targetCell[targetTangents[0]];
            const v = targetCell[targetTangents[1]];
            plane.colors[u + plane.width * v] = color444 + 1;
          }
        }
      }
    }
  }
  const result = [];
  for (const plane of targetPlanes.values()) appendGreedyPaintQuads(result, plane);
  result.sort(comparePaintQuads);
  return result;
}

function forgePaintCellMap(paintQuads = []) {
  const cells = new Map();
  for (const quad of paintQuads ?? []) {
    for (let v = quad.v0; v < quad.v1; v += 1) {
      for (let u = quad.u0; u < quad.u1; u += 1) {
        cells.set(
          paintFaceCellKey(quad.axis, quad.side, quad.plane, u, v),
          { axis: quad.axis, side: quad.side, plane: quad.plane, u, v, color444: quad.color444 },
        );
      }
    }
  }
  return cells;
}

function forgePaintQuadsFromCellMap(cells) {
  const planes = new Map();
  for (const cell of cells.values()) {
    const axes = tangentAxes(cell.axis);
    const planeKey = `${cell.axis}:${cell.side}:${cell.plane}`;
    let plane = planes.get(planeKey);
    if (!plane) {
      const width = FORGE_GRID_SIZES[axes[0]];
      const height = FORGE_GRID_SIZES[axes[1]];
      plane = {
        targetAxis: cell.axis,
        targetSide: cell.side,
        targetPlane: cell.plane,
        width,
        height,
        colors: new Uint16Array(width * height),
      };
      planes.set(planeKey, plane);
    }
    if (cell.u < 0 || cell.v < 0 || cell.u >= plane.width || cell.v >= plane.height) continue;
    plane.colors[cell.u + plane.width * cell.v] = cell.color444 + 1;
  }
  const result = [];
  for (const plane of planes.values()) appendGreedyPaintQuads(result, plane);
  result.sort(comparePaintQuads);
  return result;
}

function pruneForgePaintQuads(paintQuads, solid) {
  if (!paintQuads?.length) return [];
  const retained = new Map();
  for (const paint of forgePaintCellMap(paintQuads).values()) {
    const axes = tangentAxes(paint.axis);
    const cell = [0, 0, 0];
    cell[paint.axis] = paint.side ? paint.plane - 1 : paint.plane;
    cell[axes[0]] = paint.u;
    cell[axes[1]] = paint.v;
    if (!forgeCellInside(cell) || !solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) continue;
    if (!isExposedForgeFace(solid, cell, paint.axis, paint.side)) continue;
    retained.set(paintFaceCellKey(paint.axis, paint.side, paint.plane, paint.u, paint.v), paint);
  }
  return forgePaintQuadsFromCellMap(retained);
}

function sourceCellForTargetCell(targetCell, mapping) {
  const sourceCell = [0, 0, 0];
  for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
    const entry = mapping[sourceAxis];
    const targetSize = FORGE_GRID_SIZES[entry.targetAxis];
    const sourceSize = FORGE_GRID_SIZES[sourceAxis];
    const target = targetCell[entry.targetAxis];
    const centerNumerator = entry.sign > 0 ? 2 * target + 1 : 2 * (targetSize - target) - 1;
    sourceCell[sourceAxis] = Math.min(sourceSize - 1, Math.floor(centerNumerator * sourceSize / (2 * targetSize)));
  }
  return sourceCell;
}

function sourceNormalForTargetNormal(targetAxis, targetSide, mapping) {
  for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
    const entry = mapping[sourceAxis];
    if (entry.targetAxis !== targetAxis) continue;
    return {
      axis: sourceAxis,
      side: entry.sign > 0 ? targetSide : 1 - targetSide,
    };
  }
  throw new Ncf1ValidationError("Forge rotation normal mapping is incomplete.", "invalid-rotation");
}

function isExposedForgeFace(solid, cell, axis, side) {
  const neighbor = [...cell];
  neighbor[axis] += side ? 1 : -1;
  if (neighbor[axis] < 0 || neighbor[axis] >= FORGE_GRID_SIZES[axis]) return true;
  return solid[forgeVoxelIndex(neighbor[0], neighbor[1], neighbor[2])] === 0;
}

function appendGreedyPaintQuads(result, plane) {
  const mask = plane.colors;
  for (let v = 0; v < plane.height; v += 1) {
    for (let u = 0; u < plane.width; u += 1) {
      const value = mask[u + plane.width * v];
      if (!value) continue;
      let width = 1;
      while (u + width < plane.width && mask[u + width + plane.width * v] === value) width += 1;
      let height = 1;
      scan: while (v + height < plane.height) {
        for (let x = 0; x < width; x += 1) {
          if (mask[u + x + plane.width * (v + height)] !== value) break scan;
        }
        height += 1;
      }
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) mask[u + x + plane.width * (v + y)] = 0;
      }
      result.push({
        axis: plane.targetAxis,
        side: plane.targetSide,
        plane: plane.targetPlane,
        u0: u,
        u1: u + width,
        v0: v,
        v1: v + height,
        color444: value - 1,
      });
    }
  }
}

function comparePaintQuads(left, right) {
  return left.axis - right.axis
    || left.side - right.side
    || left.plane - right.plane
    || left.u0 - right.u0
    || left.v0 - right.v0
    || left.u1 - right.u1
    || left.v1 - right.v1
    || left.color444 - right.color444;
}

function paintFaceCellKey(axis, side, plane, u, v) {
  return `${axis}:${side}:${plane}:${u}:${v}`;
}

function tangentAxes(axis) {
  return axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
}

function assertForgeSpatialComponents(input) {
  if (!Array.isArray(input)) {
    throw new Ncf1ValidationError("Forge spatial operations require a component array.", "invalid-component-list");
  }
  input.forEach(assertComponent);
  return input;
}

function normalizeForgeSpatialOffsetQ(input) {
  const offsetQ = integerVector(input, "forge spatial offset");
  for (const value of offsetQ) {
    if (value < -512 || value > 511) {
      throw new Ncf1ValidationError("Forge spatial offsets must be between -512 and 511.", "integer-out-of-range");
    }
  }
  return offsetQ;
}

function normalizeOptionalForgeFloorQ2(input) {
  return input == null ? null : normalizeRequiredForgeFloorQ2(input);
}

function normalizeRequiredForgeFloorQ2(input) {
  const floorQ2 = finiteInteger(input, "forge floor Q2");
  if (!Number.isSafeInteger(floorQ2)) {
    throw new Ncf1ValidationError("Forge floor Q2 must be a safe integer.", "integer-out-of-range");
  }
  return floorQ2;
}

function forgeComponentLocalBoundariesQ2(component) {
  return FORGE_GRID_SIZES.map((cells, axis) => {
    const boundaries = new Int16Array(cells + 1);
    for (let coordinate = 0; coordinate <= cells; coordinate += 1) {
      boundaries[coordinate] = -component.dimsQ[axis]
        + Math.round(coordinate * component.dimsQ[axis] * 2 / cells);
    }
    return boundaries;
  });
}

// A collision shape stores merged vertical runs per X/Z lattice column. It is
// exactly the same union as the exported per-voxel boxes but keeps overlap,
// gravity, and pointer-move checks bounded by the 14x14x10 component lattice.
function forgeComponentVoxelShapeQ2(component, offsetQInput) {
  const offsetQ = normalizeForgeSpatialOffsetQ(offsetQInput);
  const cacheable = offsetQ.every((value, axis) => value === component.offsetQ[axis]);
  const cached = cacheable ? forgeSpatialShapeCache.get(component) : null;
  if (cached
    && cached.solid === component.solid
    && cached.offsetQ.every((value, axis) => value === component.offsetQ[axis])
    && cached.dimsQ.every((value, axis) => value === component.dimsQ[axis])) {
    return cached.shape;
  }
  const boundaries = forgeComponentLocalBoundariesQ2(component);
  const columns = [];
  const minQ2 = [Infinity, Infinity, Infinity];
  const maxQ2 = [-Infinity, -Infinity, -Infinity];
  for (let x = 0; x < FORGE_GRID_SIZES[0]; x += 1) {
    const minXQ2 = boundaries[0][x] + offsetQ[0] * 2;
    const maxXQ2 = boundaries[0][x + 1] + offsetQ[0] * 2;
    if (maxXQ2 <= minXQ2) continue;
    for (let z = 0; z < FORGE_GRID_SIZES[2]; z += 1) {
      const minZQ2 = boundaries[2][z] + offsetQ[2] * 2;
      const maxZQ2 = boundaries[2][z + 1] + offsetQ[2] * 2;
      if (maxZQ2 <= minZQ2) continue;
      const intervalsY = [];
      for (let y = 0; y < FORGE_GRID_SIZES[1]; y += 1) {
        if (!component.solid[forgeVoxelIndex(x, y, z)]) continue;
        const minYQ2 = boundaries[1][y];
        const maxYQ2 = boundaries[1][y + 1];
        if (maxYQ2 <= minYQ2) continue;
        const previous = intervalsY.at(-1);
        if (previous?.maxQ2 === minYQ2) previous.maxQ2 = maxYQ2;
        else intervalsY.push({ minQ2: minYQ2, maxQ2: maxYQ2 });
      }
      if (!intervalsY.length) continue;
      columns.push({ minXQ2, maxXQ2, minZQ2, maxZQ2, intervalsY });
      minQ2[0] = Math.min(minQ2[0], minXQ2);
      maxQ2[0] = Math.max(maxQ2[0], maxXQ2);
      minQ2[2] = Math.min(minQ2[2], minZQ2);
      maxQ2[2] = Math.max(maxQ2[2], maxZQ2);
      minQ2[1] = Math.min(minQ2[1], intervalsY[0].minQ2 + offsetQ[1] * 2);
      maxQ2[1] = Math.max(maxQ2[1], intervalsY.at(-1).maxQ2 + offsetQ[1] * 2);
    }
  }
  columns.sort((left, right) => left.minXQ2 - right.minXQ2
    || left.maxXQ2 - right.maxXQ2
    || left.minZQ2 - right.minZQ2
    || left.maxZQ2 - right.maxZQ2);
  const occupiedBounds = forgeComponentOccupiedBoundsQ2(component);
  const fallbackBottomQ2 = occupiedBounds?.minQ2?.[1]
    ?? component.offsetQ[1] * 2 - component.dimsQ[1];
  const shape = {
    component,
    offsetQ,
    columns,
    full: forgeSolidCellCount(component.solid) === FORGE_WORKBENCH_SOLID_CELL_COUNT,
    bounds: columns.length ? { minQ2, maxQ2 } : null,
    fallbackBottomLocalQ2: fallbackBottomQ2 - component.offsetQ[1] * 2,
  };
  if (cacheable) {
    forgeSpatialShapeCache.set(component, {
      solid: component.solid,
      dimsQ: [...component.dimsQ],
      offsetQ: [...component.offsetQ],
      shape,
    });
  }
  return shape;
}

function forgeVoxelShapesOverlapQ2(left, right) {
  if (!forgeBoundsOverlapPositiveQ2(left.bounds, right.bounds)) return false;
  if (left.full && right.full) return true;
  for (const leftColumn of left.columns) {
    for (const rightColumn of right.columns) {
      if (rightColumn.minXQ2 >= leftColumn.maxXQ2) break;
      if (!forgeIntervalsOverlapPositiveQ2(
        leftColumn.minXQ2,
        leftColumn.maxXQ2,
        rightColumn.minXQ2,
        rightColumn.maxXQ2,
      )) continue;
      if (!forgeIntervalsOverlapPositiveQ2(
        leftColumn.minZQ2,
        leftColumn.maxZQ2,
        rightColumn.minZQ2,
        rightColumn.maxZQ2,
      )) continue;
      if (forgeColumnYIntervalsOverlapQ2(left, leftColumn, right, rightColumn)) return true;
    }
  }
  return false;
}

function forgeBoundsOverlapPositiveQ2(left, right) {
  if (!left || !right) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    if (!forgeIntervalsOverlapPositiveQ2(
      left.minQ2[axis],
      left.maxQ2[axis],
      right.minQ2[axis],
      right.maxQ2[axis],
    )) return false;
  }
  return true;
}

function forgeIntervalsOverlapPositiveQ2(leftMin, leftMax, rightMin, rightMax) {
  return leftMin < rightMax && rightMin < leftMax;
}

function forgeColumnYIntervalsOverlapQ2(leftShape, leftColumn, rightShape, rightColumn) {
  const leftOffsetQ2 = leftShape.offsetQ[1] * 2;
  const rightOffsetQ2 = rightShape.offsetQ[1] * 2;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftColumn.intervalsY.length && rightIndex < rightColumn.intervalsY.length) {
    const left = leftColumn.intervalsY[leftIndex];
    const right = rightColumn.intervalsY[rightIndex];
    const leftMin = left.minQ2 + leftOffsetQ2;
    const leftMax = left.maxQ2 + leftOffsetQ2;
    const rightMin = right.minQ2 + rightOffsetQ2;
    const rightMax = right.maxQ2 + rightOffsetQ2;
    if (forgeIntervalsOverlapPositiveQ2(leftMin, leftMax, rightMin, rightMax)) return true;
    if (leftMax <= rightMin) leftIndex += 1;
    else rightIndex += 1;
  }
  return false;
}

function forgeTranslationValidation(valid, reason, requestedDeltaQ, candidateOffsetQ, collisionIndex) {
  return {
    valid,
    reason,
    requestedDeltaQ: [...requestedDeltaQ],
    candidateOffsetQ: [...candidateOffsetQ],
    collisionIndex,
  };
}

function forgeTranslationValidationWithConstraint(validation, constrainedDeltaQ, constrainedOffsetQ) {
  return {
    ...validation,
    constrainedDeltaQ: [...constrainedDeltaQ],
    constrainedOffsetQ: [...constrainedOffsetQ],
  };
}

function forgeTranslationDdaDeltaQ(requestedDeltaQ, step, steps) {
  if (step === steps) return [...requestedDeltaQ];
  return requestedDeltaQ.map((value) => Math.trunc(value / steps * step) || 0);
}

function forgeVoxelShapeTranslationOverlapsQ2(moving, obstacle, deltaQ) {
  if (!moving.bounds || !obstacle.bounds) return false;
  const deltaQ2 = deltaQ.map((value) => value * 2);
  const sweptBounds = {
    minQ2: moving.bounds.minQ2.map((value, axis) => value + Math.min(0, deltaQ2[axis])),
    maxQ2: moving.bounds.maxQ2.map((value, axis) => value + Math.max(0, deltaQ2[axis])),
  };
  if (!forgeBoundsOverlapPositiveQ2(sweptBounds, obstacle.bounds)) return false;
  if (moving.full && obstacle.full) {
    return forgeOpenBoxesSweepOverlapQ2(
      moving.bounds.minQ2,
      moving.bounds.maxQ2,
      obstacle.bounds.minQ2,
      obstacle.bounds.maxQ2,
      deltaQ2,
    );
  }
  for (const movingColumn of moving.columns) {
    const sweptMinX = movingColumn.minXQ2 + Math.min(0, deltaQ2[0]);
    const sweptMaxX = movingColumn.maxXQ2 + Math.max(0, deltaQ2[0]);
    const sweptMinZ = movingColumn.minZQ2 + Math.min(0, deltaQ2[2]);
    const sweptMaxZ = movingColumn.maxZQ2 + Math.max(0, deltaQ2[2]);
    for (const obstacleColumn of obstacle.columns) {
      if (!forgeIntervalsOverlapPositiveQ2(
        sweptMinX,
        sweptMaxX,
        obstacleColumn.minXQ2,
        obstacleColumn.maxXQ2,
      )) continue;
      if (!forgeIntervalsOverlapPositiveQ2(
        sweptMinZ,
        sweptMaxZ,
        obstacleColumn.minZQ2,
        obstacleColumn.maxZQ2,
      )) continue;
      for (const movingY of movingColumn.intervalsY) {
        const movingMinQ2 = [
          movingColumn.minXQ2,
          movingY.minQ2 + moving.offsetQ[1] * 2,
          movingColumn.minZQ2,
        ];
        const movingMaxQ2 = [
          movingColumn.maxXQ2,
          movingY.maxQ2 + moving.offsetQ[1] * 2,
          movingColumn.maxZQ2,
        ];
        const sweptMinY = movingMinQ2[1] + Math.min(0, deltaQ2[1]);
        const sweptMaxY = movingMaxQ2[1] + Math.max(0, deltaQ2[1]);
        for (const obstacleY of obstacleColumn.intervalsY) {
          const obstacleMinQ2 = [
            obstacleColumn.minXQ2,
            obstacleY.minQ2 + obstacle.offsetQ[1] * 2,
            obstacleColumn.minZQ2,
          ];
          const obstacleMaxQ2 = [
            obstacleColumn.maxXQ2,
            obstacleY.maxQ2 + obstacle.offsetQ[1] * 2,
            obstacleColumn.maxZQ2,
          ];
          if (!forgeIntervalsOverlapPositiveQ2(
            sweptMinY,
            sweptMaxY,
            obstacleMinQ2[1],
            obstacleMaxQ2[1],
          )) continue;
          if (forgeOpenBoxesSweepOverlapQ2(
            movingMinQ2,
            movingMaxQ2,
            obstacleMinQ2,
            obstacleMaxQ2,
            deltaQ2,
          )) return true;
        }
      }
    }
  }
  return false;
}

function forgeOpenBoxesSweepOverlapQ2(movingMin, movingMax, obstacleMin, obstacleMax, deltaQ2) {
  let entry = -Infinity;
  let exit = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const delta = deltaQ2[axis];
    if (delta === 0) {
      if (!forgeIntervalsOverlapPositiveQ2(
        movingMin[axis],
        movingMax[axis],
        obstacleMin[axis],
        obstacleMax[axis],
      )) return false;
      continue;
    }
    const axisEntry = delta > 0
      ? (obstacleMin[axis] - movingMax[axis]) / delta
      : (obstacleMax[axis] - movingMin[axis]) / delta;
    const axisExit = delta > 0
      ? (obstacleMax[axis] - movingMin[axis]) / delta
      : (obstacleMin[axis] - movingMax[axis]) / delta;
    entry = Math.max(entry, axisEntry);
    exit = Math.min(exit, axisExit);
    if (entry >= exit) return false;
  }
  return Math.max(entry, 0) < Math.min(exit, 1);
}

function forgeVoxelShapeBottomQ2(shape) {
  return shape.bounds?.minQ2?.[1]
    ?? shape.fallbackBottomLocalQ2 + shape.offsetQ[1] * 2;
}

function forgeFloorContactOffsetQ(shape, floorQ2) {
  const bottomLocalQ2 = forgeVoxelShapeBottomQ2(shape) - shape.offsetQ[1] * 2;
  return Math.ceil((floorQ2 - bottomLocalQ2) / 2);
}

function forgeSpatialBottomOrder(shapes) {
  return shapes.map((shape, index) => index).sort((left, right) => (
    forgeVoxelShapeBottomQ2(shapes[left]) - forgeVoxelShapeBottomQ2(shapes[right])
    || shapes[left].offsetQ[1] - shapes[right].offsetQ[1]
    || left - right
  ));
}

function forgeHighestFallingContactOffsetQ(moving, support, currentYQ) {
  if (!forgeVoxelShapeBoundsOverlapXZPositiveQ2(moving, support)) return null;
  if (moving.full && support.full) {
    const movingBottomLocalQ2 = moving.bounds.minQ2[1] - moving.offsetQ[1] * 2;
    const contactYQ = Math.ceil((support.bounds.maxQ2[1] - movingBottomLocalQ2) / 2);
    return contactYQ <= currentYQ ? contactYQ : null;
  }
  let highest = null;
  for (const movingColumn of moving.columns) {
    for (const supportColumn of support.columns) {
      if (supportColumn.minXQ2 >= movingColumn.maxXQ2) break;
      if (!forgeColumnsOverlapXZPositiveQ2(movingColumn, supportColumn)) continue;
      for (const movingY of movingColumn.intervalsY) {
        for (const supportY of supportColumn.intervalsY) {
          const supportTopQ2 = supportY.maxQ2 + support.offsetQ[1] * 2;
          const contactYQ = Math.ceil((supportTopQ2 - movingY.minQ2) / 2);
          if (contactYQ <= currentYQ && (highest == null || contactYQ > highest)) highest = contactYQ;
        }
      }
    }
  }
  return highest;
}

function forgeHighestAboveContactOffsetQ(moving, support) {
  if (!forgeVoxelShapeBoundsOverlapXZPositiveQ2(moving, support)) {
    throw new Ncf1ValidationError("Overlapping forge components have no separating contact plane.", "forge-settle-invalid-shape");
  }
  if (moving.full && support.full) {
    const movingBottomLocalQ2 = moving.bounds.minQ2[1] - moving.offsetQ[1] * 2;
    return Math.ceil((support.bounds.maxQ2[1] - movingBottomLocalQ2) / 2);
  }
  let highest = null;
  for (const movingColumn of moving.columns) {
    for (const supportColumn of support.columns) {
      if (supportColumn.minXQ2 >= movingColumn.maxXQ2) break;
      if (!forgeColumnsOverlapXZPositiveQ2(movingColumn, supportColumn)) continue;
      const movingBottomLocalQ2 = movingColumn.intervalsY[0].minQ2;
      const supportTopQ2 = supportColumn.intervalsY.at(-1).maxQ2 + support.offsetQ[1] * 2;
      const contactYQ = Math.ceil((supportTopQ2 - movingBottomLocalQ2) / 2);
      if (highest == null || contactYQ > highest) highest = contactYQ;
    }
  }
  if (highest == null) {
    throw new Ncf1ValidationError("Overlapping forge components have no separating contact plane.", "forge-settle-invalid-shape");
  }
  return highest;
}

function forgeColumnsOverlapXZPositiveQ2(left, right) {
  return forgeIntervalsOverlapPositiveQ2(left.minXQ2, left.maxXQ2, right.minXQ2, right.maxXQ2)
    && forgeIntervalsOverlapPositiveQ2(left.minZQ2, left.maxZQ2, right.minZQ2, right.maxZQ2);
}

function forgeVoxelShapeBoundsOverlapXZPositiveQ2(left, right) {
  return Boolean(left.bounds && right.bounds)
    && forgeIntervalsOverlapPositiveQ2(
      left.bounds.minQ2[0],
      left.bounds.maxQ2[0],
      right.bounds.minQ2[0],
      right.bounds.maxQ2[0],
    )
    && forgeIntervalsOverlapPositiveQ2(
      left.bounds.minQ2[2],
      left.bounds.maxQ2[2],
      right.bounds.minQ2[2],
      right.bounds.maxQ2[2],
    );
}

function assertForgeSettledOffsetYQ(value) {
  if (!Number.isInteger(value) || value < -512 || value > 511) {
    throw new Ncf1ValidationError(
      "Forge components cannot settle without exceeding the encoded offset range.",
      "forge-settle-offset-range",
    );
  }
}

function forgeOffsetWithY(offsetQ, value) {
  return [offsetQ[0], value, offsetQ[2]];
}

function assertForgeSpatialShapesDoNotOverlap(shapes) {
  for (let left = 0; left < shapes.length; left += 1) {
    for (let right = left + 1; right < shapes.length; right += 1) {
      if (forgeVoxelShapesOverlapQ2(shapes[left], shapes[right])) {
        throw new Ncf1ValidationError("Forge settling retained a component overlap.", "forge-settle-overlap");
      }
    }
  }
}

function forgeVoxelShapesShareQuantizedFaceQ2(left, right) {
  if (!left.columns.length || !right.columns.length) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    if (forgeIntervalSeparationQ2(
      left.bounds.minQ2[axis],
      left.bounds.maxQ2[axis],
      right.bounds.minQ2[axis],
      right.bounds.maxQ2[axis],
    ) > 1) return false;
  }
  if (left.full && right.full) return forgeBoundsShareQuantizedFaceQ2(left.bounds, right.bounds);
  for (const leftColumn of left.columns) {
    for (const rightColumn of right.columns) {
      const xGapQ2 = forgeIntervalSeparationQ2(
        leftColumn.minXQ2,
        leftColumn.maxXQ2,
        rightColumn.minXQ2,
        rightColumn.maxXQ2,
      );
      const zGapQ2 = forgeIntervalSeparationQ2(
        leftColumn.minZQ2,
        leftColumn.maxZQ2,
        rightColumn.minZQ2,
        rightColumn.maxZQ2,
      );
      const xOverlap = xGapQ2 < 0;
      const zOverlap = zGapQ2 < 0;
      for (const leftY of leftColumn.intervalsY) {
        const leftMinYQ2 = leftY.minQ2 + left.offsetQ[1] * 2;
        const leftMaxYQ2 = leftY.maxQ2 + left.offsetQ[1] * 2;
        for (const rightY of rightColumn.intervalsY) {
          const rightMinYQ2 = rightY.minQ2 + right.offsetQ[1] * 2;
          const rightMaxYQ2 = rightY.maxQ2 + right.offsetQ[1] * 2;
          const yGapQ2 = forgeIntervalSeparationQ2(
            leftMinYQ2,
            leftMaxYQ2,
            rightMinYQ2,
            rightMaxYQ2,
          );
          const yOverlap = yGapQ2 < 0;
          if (xGapQ2 >= 0 && xGapQ2 <= 1 && yOverlap && zOverlap) return true;
          if (yGapQ2 >= 0 && yGapQ2 <= 1 && xOverlap && zOverlap) return true;
          if (zGapQ2 >= 0 && zGapQ2 <= 1 && xOverlap && yOverlap) return true;
        }
      }
    }
  }
  return false;
}

function forgeBoundsShareQuantizedFaceQ2(left, right) {
  for (let axis = 0; axis < 3; axis += 1) {
    const gapQ2 = forgeIntervalSeparationQ2(
      left.minQ2[axis],
      left.maxQ2[axis],
      right.minQ2[axis],
      right.maxQ2[axis],
    );
    if (gapQ2 < 0 || gapQ2 > 1) continue;
    const axes = tangentAxes(axis);
    if (forgeIntervalsOverlapPositiveQ2(
      left.minQ2[axes[0]], left.maxQ2[axes[0]], right.minQ2[axes[0]], right.maxQ2[axes[0]],
    ) && forgeIntervalsOverlapPositiveQ2(
      left.minQ2[axes[1]], left.maxQ2[axes[1]], right.minQ2[axes[1]], right.maxQ2[axes[1]],
    )) return true;
  }
  return false;
}

function forgeIntervalSeparationQ2(leftMin, leftMax, rightMin, rightMax) {
  if (leftMax <= rightMin) return rightMin - leftMax;
  if (rightMax <= leftMin) return leftMin - rightMax;
  return -1;
}

function componentBoundsQ2(components) {
  const minQ2 = [Infinity, Infinity, Infinity];
  const maxQ2 = [-Infinity, -Infinity, -Infinity];
  for (const component of components) {
    for (let axis = 0; axis < 3; axis += 1) {
      minQ2[axis] = Math.min(minQ2[axis], component.offsetQ[axis] * 2 - component.dimsQ[axis]);
      maxQ2[axis] = Math.max(maxQ2[axis], component.offsetQ[axis] * 2 + component.dimsQ[axis]);
    }
  }
  return { minQ2, maxQ2 };
}

function emptyForgeEquipment() {
  return { mass5g: 0, volumeCm3: 0, attributes6: new Uint8Array(FORGE_ATTRIBUTE_KEYS.length) };
}

function emptyAttributeScores() {
  return Object.fromEntries(FORGE_ATTRIBUTE_KEYS.map((key) => [key, 0]));
}

function integerVector(input, label) {
  const values = Array.isArray(input) || ArrayBuffer.isView(input)
    ? Array.from(input).slice(0, 3)
    : [input?.x, input?.y, input?.z];
  if (values.length !== 3) throw new Ncf1ValidationError(`${label} requires three integers.`, "invalid-vector");
  return values.map((value, axis) => finiteInteger(value, `${label} axis ${axis}`));
}

function finiteInteger(input, label) {
  const value = Number(input);
  if (!Number.isInteger(value)) throw new Ncf1ValidationError(`${label} must be an integer.`, "invalid-integer");
  return value;
}

function integerInRange(input, min, max, label) {
  const value = finiteInteger(input, label);
  if (value < min || value > max) {
    throw new Ncf1ValidationError(`${label} must be between ${min} and ${max}.`, "integer-out-of-range");
  }
  return value;
}

function positiveSafeInteger(input, label) {
  const value = finiteInteger(input, label);
  if (value < 1 || !Number.isSafeInteger(value)) {
    throw new Ncf1ValidationError(`${label} must be a positive safe integer.`, "integer-out-of-range");
  }
  return value;
}

function unsigned32(input, label) {
  const value = finiteInteger(input, label);
  if (value < 0 || value > 0xffffffff) {
    throw new Ncf1ValidationError(`${label} must fit u32.`, "integer-out-of-range");
  }
  return value;
}

function checkedSafeAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new Ncf1ValidationError(`${label} exceeds the safe-integer range.`, "integer-out-of-range");
  }
  return value;
}

function clampInteger(input, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(input) || 0)));
}

function firstDefined(...values) {
  for (const value of values) if (value != null) return value;
  return undefined;
}
