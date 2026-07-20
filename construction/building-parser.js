import {
  decodeNcm3,
  encodeNcm3,
  payloadByteLength,
  voxelize,
} from "../ncm/blueprint-codec.js";

export const BUILDING_QUARTER_TURNS = Object.freeze([0, 1, 2, 3]);

/**
 * Parse a declarative NCM3 building without evaluating executable code.
 * One NCM3 voxel always remains one world voxel throughout this module.
 */
export function parseNcm3Building(code, { id = "", name = "" } = {}) {
  const sourceCode = String(code ?? "").trim();
  const blueprint = decodeNcm3(sourceCode);
  const canonicalCode = encodeNcm3(blueprint);
  const voxels = voxelize(blueprint);
  const size = Object.freeze({ ...blueprint.size });
  const analysis = analyzeVoxels(voxels, size);
  const contentBounds = Object.freeze(analysis.bounds);
  const materials = Object.freeze([...analysis.materials].sort((a, b) => a - b));
  const codeId = stableCodeId(canonicalCode);

  return Object.freeze({
    id: String(id || `ncm3-${codeId}`),
    name: String(name || blueprint.name || "NCM3 Building"),
    format: "NCM3",
    formatVersion: 1,
    sourceCode,
    canonicalCode,
    canonical: sourceCode === canonicalCode,
    payloadBytes: payloadByteLength(canonicalCode),
    codeId,
    blueprint,
    size,
    contentBounds,
    voxels,
    voxelCount: voxels.size,
    commandCount: blueprint.commands.length,
    materials,
    scale: 1,
  });
}

export function buildingFootprint(sizeInput, quarterTurns = 0) {
  const size = normalizeSize(sizeInput);
  const turn = normalizeQuarterTurns(quarterTurns);
  return Object.freeze({
    width: turn % 2 === 0 ? size.x : size.z,
    depth: turn % 2 === 0 ? size.z : size.x,
    height: size.y,
    quarterTurns: turn,
  });
}

/**
 * Place a parsed building on a foundation with integer-only translation and
 * quarter-turn rotation. Oversized placement is only allowed for visual
 * previews and is never scaled.
 */
export function createBuildingPlacement(buildingInput, foundationInput, {
  quarterTurns = 0,
  placementId = "",
  materializeWorldVoxels = true,
  allowFoundationOverflow = false,
  offsetX = 0,
  offsetZ = 0,
} = {}) {
  const building = normalizeBuilding(buildingInput);
  const foundation = normalizeFoundation(foundationInput);
  const footprint = buildingFootprint(building.size, quarterTurns);
  const normalizedOffsetX = requireInteger(offsetX, "building X offset");
  const normalizedOffsetZ = requireInteger(offsetZ, "building Z offset");
  const originX = foundation.minX + Math.floor((foundation.width - footprint.width) / 2) + normalizedOffsetX;
  const originY = foundation.surfaceY;
  const originZ = foundation.minZ + Math.floor((foundation.depth - footprint.depth) / 2) + normalizedOffsetZ;
  const maxX = originX + footprint.width - 1;
  const maxZ = originZ + footprint.depth - 1;
  const fitsFoundation = footprint.width <= foundation.width
    && footprint.depth <= foundation.depth
    && originX >= foundation.minX
    && originZ >= foundation.minZ
    && maxX <= foundation.maxX
    && maxZ <= foundation.maxZ;
  if (!fitsFoundation && !allowFoundationOverflow) {
    throw placementError(
      "building-does-not-fit",
      `The ${footprint.width} x ${footprint.depth} building does not fit the ${foundation.width} x ${foundation.depth} foundation.`,
    );
  }

  const worldVoxels = materializeWorldVoxels ? new Map() : null;
  if (worldVoxels) {
    const turn = footprint.quarterTurns;
    const sizeX = building.size.x;
    const sizeZ = building.size.z;
    for (const voxel of building.voxels.values()) {
      const rotated = rotateLocalVoxelNormalized(voxel.x, voxel.z, sizeX, sizeZ, turn);
      const world = {
        x: originX + rotated.x,
        y: originY + voxel.y,
        z: originZ + rotated.z,
        material: voxel.material,
        localX: voxel.x,
        localY: voxel.y,
        localZ: voxel.z,
      };
      worldVoxels.set(voxelKey(world.x, world.y, world.z), world);
    }
  }

  const id = String(placementId || `${foundation.id}:${building.codeId}:${footprint.quarterTurns}`);
  return Object.freeze({
    id,
    building,
    foundation,
    fitsFoundation,
    offsetX: normalizedOffsetX,
    offsetZ: normalizedOffsetZ,
    offset: Object.freeze({ x: normalizedOffsetX, z: normalizedOffsetZ }),
    quarterTurns: footprint.quarterTurns,
    footprint,
    origin: Object.freeze({ x: originX, y: originY, z: originZ }),
    bounds: Object.freeze({
      minX: originX,
      minY: originY,
      minZ: originZ,
      maxX,
      maxY: originY + footprint.height - 1,
      maxZ,
      width: footprint.width,
      height: footprint.height,
      depth: footprint.depth,
    }),
    worldVoxels,
    voxelCount: building.voxelCount,
    compact: !worldVoxels,
    scale: 1,
  });
}

export function rotateLocalVoxel(xValue, zValue, sizeInput, quarterTurns = 0) {
  const size = normalizeSize(sizeInput);
  const x = requireInteger(xValue, "x");
  const z = requireInteger(zValue, "z");
  const turn = normalizeQuarterTurns(quarterTurns);
  return rotateLocalVoxelNormalized(x, z, size.x, size.z, turn);
}

export function normalizeQuarterTurns(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw placementError("invalid-rotation", "Building rotation must be an integer quarter turn.");
  const turns = Math.abs(number) > 3 && number % 90 === 0 ? number / 90 : number;
  return ((turns % 4) + 4) % 4;
}

export async function sha256Ncm3Code(code) {
  const canonicalCode = encodeNcm3(decodeNcm3(String(code ?? "").trim()));
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable.");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalCode)));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function voxelKey(x, y, z) {
  return `${x},${y},${z}`;
}

function normalizeBuilding(input) {
  if (input?.format === "NCM3" && input?.voxels instanceof Map) return input;
  if (typeof input === "string") return parseNcm3Building(input);
  throw placementError("invalid-building", "A parsed NCM3 building is required.");
}

function normalizeFoundation(input = {}) {
  const minX = requireInteger(input.minX ?? input.worldX ?? input.x, "foundation minX");
  const minZ = requireInteger(input.minZ ?? input.worldZ ?? input.z, "foundation minZ");
  const surfaceY = requireInteger(input.surfaceY ?? input.y, "foundation surfaceY");
  const width = requirePositiveInteger(input.width, "foundation width");
  const depth = requirePositiveInteger(input.depth, "foundation depth");
  assertSafeWorldEnd(minX, width, "foundation X range");
  assertSafeWorldEnd(minZ, depth, "foundation Z range");
  return Object.freeze({
    ...input,
    id: String(input.id || `${input.owner || "foundation"}:${input.foundationId ?? 0}`),
    minX,
    minZ,
    surfaceY,
    width,
    depth,
    maxX: minX + width - 1,
    maxZ: minZ + depth - 1,
  });
}

function normalizeSize(input = {}) {
  return {
    x: requirePositiveInteger(input.x, "building size X"),
    y: requirePositiveInteger(input.y, "building size Y"),
    z: requirePositiveInteger(input.z, "building size Z"),
  };
}

function analyzeVoxels(voxels, size) {
  if (!voxels.size) return {
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: -1, maxY: -1, maxZ: -1, width: 0, height: 0, depth: 0 },
    materials: new Set(),
  };
  let minX = size.x;
  let minY = size.y;
  let minZ = size.z;
  let maxX = -1;
  let maxY = -1;
  let maxZ = -1;
  const materials = new Set();
  for (const voxel of voxels.values()) {
    minX = Math.min(minX, voxel.x);
    minY = Math.min(minY, voxel.y);
    minZ = Math.min(minZ, voxel.z);
    maxX = Math.max(maxX, voxel.x);
    maxY = Math.max(maxY, voxel.y);
    maxZ = Math.max(maxZ, voxel.z);
    materials.add(voxel.material);
  }
  return {
    bounds: { minX, minY, minZ, maxX, maxY, maxZ, width: maxX - minX + 1, height: maxY - minY + 1, depth: maxZ - minZ + 1 },
    materials,
  };
}

function rotateLocalVoxelNormalized(x, z, sizeX, sizeZ, turn) {
  if (turn === 1) return { x: sizeZ - 1 - z, z: x };
  if (turn === 2) return { x: sizeX - 1 - x, z: sizeZ - 1 - z };
  if (turn === 3) return { x: z, z: sizeX - 1 - x };
  return { x, z };
}

function stableCodeId(code) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function assertSafeWorldEnd(start, length, label) {
  const end = start + length - 1;
  if (!Number.isSafeInteger(end)) throw placementError("unsafe-coordinate", `${label} exceeds safe integer coordinates.`);
}

function requirePositiveInteger(value, label) {
  const number = requireInteger(value, label);
  if (number <= 0) throw placementError("invalid-dimension", `${label} must be greater than zero.`);
  return number;
}

function requireInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw placementError("invalid-integer", `${label} must be a safe integer.`);
  return number;
}

function placementError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
