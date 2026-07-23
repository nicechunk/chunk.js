import {
  analyzeNcm3Envelope,
  NCM3_MAX_COMMANDS,
  NCM3_MAX_DIMENSION,
  NCM3_MAX_PAYLOAD_BYTES,
  NCM3_MAX_VOXELS,
  NCM_MATERIALS,
  NCM3_PREFIX,
} from "../ncm/blueprint-codec.js";
import { materialDef } from "../world/material-registry.js";

const MAX_BUILDING_CHUNK_SIZE = 16;
const MAX_RESULT_LABEL_LENGTH = 2_048;
const BUILDING_VERTEX_STRIDE_BYTES = 20;
const MAX_QUADS_PER_VOXEL = 6;
const MAX_VERTICES_PER_VOXEL = MAX_QUADS_PER_VOXEL * 4;
const MAX_INDICES_PER_VOXEL = MAX_QUADS_PER_VOXEL * 6;
const MAX_CANONICAL_CODE_LENGTH = NCM3_PREFIX.length + Math.ceil(NCM3_MAX_PAYLOAD_BYTES * 4 / 3);

const RESULT_KEYS = keySet(["building", "placement", "chunks"]);
const BUILDING_KEYS = keySet([
  "id",
  "name",
  "format",
  "formatVersion",
  "canonicalCode",
  "canonical",
  "payloadBytes",
  "codeId",
  "size",
  "contentBounds",
  "voxelCount",
  "commandCount",
  "materials",
  "scale",
]);
const PLACEMENT_KEYS = keySet([
  "id",
  "foundation",
  "fitsFoundation",
  "offsetX",
  "offsetZ",
  "quarterTurns",
  "footprint",
  "origin",
  "bounds",
  "voxelCount",
  "scale",
]);
const FOUNDATION_KEYS = keySet(["id", "minX", "minZ", "surfaceY", "width", "depth", "maxX", "maxZ"]);
const SIZE_KEYS = keySet(["x", "y", "z"]);
const FOOTPRINT_KEYS = keySet(["width", "depth", "height", "quarterTurns"]);
const ORIGIN_KEYS = keySet(["x", "y", "z"]);
const BOUNDS_KEYS = keySet([
  "minX",
  "minY",
  "minZ",
  "maxX",
  "maxY",
  "maxZ",
  "width",
  "height",
  "depth",
]);
const CHUNK_KEYS = keySet([
  "id",
  "buildingId",
  "chunkX",
  "chunkZ",
  "chunkSize",
  "minY",
  "height",
  "voxelCount",
  "visualBlockCount",
  "collisionMask",
  "collisionBlockCount",
  "mesh",
  "visualMesh",
  "meshVersion",
  "visualMeshVersion",
  "version",
  "gpuUploaded",
  "visualGpuUploaded",
  "building",
  "regionBatchEligible",
  "frustumCullEligible",
  "frustumBounds",
]);
const MESH_KEYS = keySet([
  "vertices",
  "indices",
  "vertexCount",
  "indexCount",
  "triangleCount",
  "quadCount",
  "blockCount",
  "vertexStrideBytes",
  "chunkX",
  "chunkZ",
  "chunkSize",
  "minY",
  "height",
  "building",
  "visual",
]);
const FRUSTUM_KEYS = keySet(["centerX", "centerY", "centerZ", "radius"]);

export function createBuildingMeshResult(building, placement, chunks) {
  return {
    building: summarizeBuilding(building),
    placement: summarizePlacement(placement),
    chunks: chunks.map(summarizeChunk),
  };
}

/**
 * Validate an owned Worker result in place. Typed arrays are never copied;
 * callers receive the same result object and buffer views after validation.
 */
export function validateBuildingMeshResult(input, { request = null } = {}) {
  const result = assertShape(input, RESULT_KEYS, "building mesh result");
  const building = validateBuilding(result.building);
  const placement = validatePlacement(result.placement, building);
  const binding = request === null ? null : validateRequestBinding(request, building, placement);
  validateChunks(result.chunks, building, placement, binding);
  return result;
}

export function summarizeBuilding(building) {
  return {
    id: building.id,
    name: building.name,
    format: building.format,
    formatVersion: building.formatVersion,
    canonicalCode: building.canonicalCode,
    canonical: building.canonical,
    payloadBytes: building.payloadBytes,
    codeId: building.codeId,
    size: { ...building.size },
    contentBounds: { ...building.contentBounds },
    voxelCount: building.voxelCount,
    commandCount: building.commandCount,
    materials: [...building.materials],
    scale: building.scale,
  };
}

export function summarizePlacement(placement) {
  return {
    id: placement.id,
    foundation: summarizeFoundation(placement.foundation),
    fitsFoundation: placement.fitsFoundation,
    offsetX: placement.offsetX,
    offsetZ: placement.offsetZ,
    quarterTurns: placement.quarterTurns,
    footprint: { ...placement.footprint },
    origin: { ...placement.origin },
    bounds: { ...placement.bounds },
    voxelCount: placement.voxelCount,
    scale: placement.scale,
  };
}

function summarizeChunk(chunk) {
  return {
    id: chunk.id,
    buildingId: chunk.buildingId,
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
    chunkSize: chunk.chunkSize,
    minY: chunk.minY,
    height: chunk.height,
    voxelCount: chunk.voxelCount,
    visualBlockCount: chunk.visualBlockCount,
    collisionMask: chunk.collisionMask,
    collisionBlockCount: chunk.collisionBlockCount,
    mesh: summarizeMesh(chunk.mesh),
    visualMesh: chunk.visualMesh === null ? null : summarizeMesh(chunk.visualMesh),
    meshVersion: chunk.meshVersion,
    visualMeshVersion: chunk.visualMeshVersion,
    version: chunk.version,
    gpuUploaded: chunk.gpuUploaded,
    visualGpuUploaded: chunk.visualGpuUploaded,
    building: chunk.building,
    regionBatchEligible: chunk.regionBatchEligible,
    frustumCullEligible: chunk.frustumCullEligible,
    frustumBounds: { ...chunk.frustumBounds },
  };
}

function summarizeMesh(mesh) {
  return {
    vertices: mesh.vertices,
    indices: mesh.indices,
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
    triangleCount: mesh.triangleCount,
    quadCount: mesh.quadCount,
    blockCount: mesh.blockCount,
    vertexStrideBytes: mesh.vertexStrideBytes,
    chunkX: mesh.chunkX,
    chunkZ: mesh.chunkZ,
    chunkSize: mesh.chunkSize,
    minY: mesh.minY,
    height: mesh.height,
    building: mesh.building,
    visual: mesh.visual,
  };
}

function summarizeFoundation(foundation) {
  return {
    id: foundation.id,
    minX: foundation.minX,
    minZ: foundation.minZ,
    surfaceY: foundation.surfaceY,
    width: foundation.width,
    depth: foundation.depth,
    maxX: foundation.maxX,
    maxZ: foundation.maxZ,
  };
}

function validateBuilding(input) {
  const building = assertShape(input, BUILDING_KEYS, "building summary");
  requireString(building.id, "building id", MAX_RESULT_LABEL_LENGTH, true);
  requireString(building.name, "building name", MAX_RESULT_LABEL_LENGTH, true);
  requireEqual(building.format, "NCM3", "building format");
  requireEqual(building.formatVersion, 1, "building formatVersion");
  requireString(building.canonicalCode, "building canonicalCode", MAX_CANONICAL_CODE_LENGTH, true);
  if (!building.canonicalCode.startsWith(NCM3_PREFIX)) invalidResult("building canonicalCode is not NCM3");
  requireEqual(building.canonical, true, "building canonical flag");
  const payloadBytes = requireInteger(building.payloadBytes, "building payloadBytes", 1, NCM3_MAX_PAYLOAD_BYTES);
  if (building.canonicalCode.length !== NCM3_PREFIX.length + Math.ceil(payloadBytes * 4 / 3)) {
    invalidResult("building canonicalCode length does not match payloadBytes");
  }
  if (typeof building.codeId !== "string" || !/^[0-9a-f]{8}$/.test(building.codeId)) {
    invalidResult("building codeId must be an eight-character lowercase hexadecimal string");
  }
  requireEqual(building.codeId, stableCodeId(building.canonicalCode), "building codeId/canonicalCode binding");
  const size = validateSize(building.size, "building size");
  const voxelCount = requireInteger(building.voxelCount, "building voxelCount", 0, NCM3_MAX_VOXELS);
  requireInteger(building.commandCount, "building commandCount", 0, NCM3_MAX_COMMANDS);
  validateContentBounds(building.contentBounds, size, voxelCount);
  validateMaterials(building.materials, voxelCount);
  requireEqual(building.scale, 1, "building scale");
  return building;
}

function validateContentBounds(input, size, voxelCount) {
  const bounds = assertShape(input, BOUNDS_KEYS, "building contentBounds");
  if (voxelCount === 0) {
    const empty = { minX: 0, minY: 0, minZ: 0, maxX: -1, maxY: -1, maxZ: -1, width: 0, height: 0, depth: 0 };
    for (const [key, expected] of Object.entries(empty)) requireEqual(bounds[key], expected, `building contentBounds.${key}`);
    return;
  }
  const minX = requireInteger(bounds.minX, "building contentBounds.minX", 0, size.x - 1);
  const minY = requireInteger(bounds.minY, "building contentBounds.minY", 0, size.y - 1);
  const minZ = requireInteger(bounds.minZ, "building contentBounds.minZ", 0, size.z - 1);
  const width = requireInteger(bounds.width, "building contentBounds.width", 1, size.x);
  const height = requireInteger(bounds.height, "building contentBounds.height", 1, size.y);
  const depth = requireInteger(bounds.depth, "building contentBounds.depth", 1, size.z);
  requireEqual(bounds.maxX, minX + width - 1, "building contentBounds.maxX");
  requireEqual(bounds.maxY, minY + height - 1, "building contentBounds.maxY");
  requireEqual(bounds.maxZ, minZ + depth - 1, "building contentBounds.maxZ");
  if (bounds.maxX >= size.x || bounds.maxY >= size.y || bounds.maxZ >= size.z) {
    invalidResult("building contentBounds exceed the declared size");
  }
  if (voxelCount > width * height * depth) invalidResult("building voxelCount exceeds contentBounds volume");
}

function validateMaterials(input, voxelCount) {
  assertArrayShape(input, "building materials", Math.min(voxelCount, 0xffff));
  if ((voxelCount === 0) !== (input.length === 0)) invalidResult("building materials do not match voxelCount emptiness");
  let previous = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) invalidResult("building materials must be a dense array");
    const material = input[index];
    const id = requireInteger(material, "building material id", 1, 0xffff);
    if (!Object.hasOwn(NCM_MATERIALS, id)) invalidResult("building materials contain an unknown NCM3 material id");
    if (id <= previous) invalidResult("building materials must be unique and strictly sorted");
    previous = id;
  }
}

function validatePlacement(input, building) {
  const placement = assertShape(input, PLACEMENT_KEYS, "building placement summary");
  requireString(placement.id, "placement id", MAX_RESULT_LABEL_LENGTH, true);
  const foundation = validateFoundation(placement.foundation);
  requireBoolean(placement.fitsFoundation, "placement fitsFoundation");
  const offsetX = requireSafeInteger(placement.offsetX, "placement offsetX");
  const offsetZ = requireSafeInteger(placement.offsetZ, "placement offsetZ");
  const quarterTurns = requireInteger(placement.quarterTurns, "placement quarterTurns", 0, 3);
  const footprint = validateFootprint(placement.footprint, building.size, quarterTurns);
  const origin = validateOrigin(placement.origin);
  const expectedOriginX = safeSum(
    foundation.minX,
    Math.floor((foundation.width - footprint.width) / 2),
    offsetX,
    "placement origin X",
  );
  const expectedOriginZ = safeSum(
    foundation.minZ,
    Math.floor((foundation.depth - footprint.depth) / 2),
    offsetZ,
    "placement origin Z",
  );
  requireEqual(origin.x, expectedOriginX, "placement origin.x");
  requireEqual(origin.y, foundation.surfaceY, "placement origin.y");
  requireEqual(origin.z, expectedOriginZ, "placement origin.z");
  validatePlacementBounds(placement.bounds, origin, footprint);
  const fitsFoundation = footprint.width <= foundation.width
    && footprint.depth <= foundation.depth
    && origin.x >= foundation.minX
    && origin.z >= foundation.minZ
    && placement.bounds.maxX <= foundation.maxX
    && placement.bounds.maxZ <= foundation.maxZ;
  requireEqual(placement.fitsFoundation, fitsFoundation, "placement fitsFoundation");
  requireEqual(placement.voxelCount, building.voxelCount, "placement voxelCount");
  requireEqual(placement.scale, 1, "placement scale");
  return placement;
}

function validateFoundation(input) {
  const foundation = assertShape(input, FOUNDATION_KEYS, "building foundation summary");
  requireString(foundation.id, "foundation id", MAX_RESULT_LABEL_LENGTH, true);
  const minX = requireSafeInteger(foundation.minX, "foundation minX");
  const minZ = requireSafeInteger(foundation.minZ, "foundation minZ");
  requireSafeInteger(foundation.surfaceY, "foundation surfaceY");
  const width = requirePositiveSafeInteger(foundation.width, "foundation width");
  const depth = requirePositiveSafeInteger(foundation.depth, "foundation depth");
  requireEqual(foundation.maxX, safeEnd(minX, width, "foundation X range"), "foundation maxX");
  requireEqual(foundation.maxZ, safeEnd(minZ, depth, "foundation Z range"), "foundation maxZ");
  return foundation;
}

function validateFootprint(input, size, quarterTurns) {
  const footprint = assertShape(input, FOOTPRINT_KEYS, "building footprint");
  const width = requireInteger(footprint.width, "building footprint.width", 1, NCM3_MAX_DIMENSION);
  const depth = requireInteger(footprint.depth, "building footprint.depth", 1, NCM3_MAX_DIMENSION);
  requireEqual(footprint.height, size.y, "building footprint.height");
  requireEqual(footprint.quarterTurns, quarterTurns, "building footprint.quarterTurns");
  requireEqual(width, quarterTurns % 2 === 0 ? size.x : size.z, "building footprint.width");
  requireEqual(depth, quarterTurns % 2 === 0 ? size.z : size.x, "building footprint.depth");
  return footprint;
}

function validateOrigin(input) {
  const origin = assertShape(input, ORIGIN_KEYS, "building placement origin");
  requireSafeInteger(origin.x, "placement origin.x");
  requireSafeInteger(origin.y, "placement origin.y");
  requireSafeInteger(origin.z, "placement origin.z");
  return origin;
}

function validatePlacementBounds(input, origin, footprint) {
  const bounds = assertShape(input, BOUNDS_KEYS, "building placement bounds");
  requireEqual(bounds.minX, origin.x, "placement bounds.minX");
  requireEqual(bounds.minY, origin.y, "placement bounds.minY");
  requireEqual(bounds.minZ, origin.z, "placement bounds.minZ");
  requireEqual(bounds.width, footprint.width, "placement bounds.width");
  requireEqual(bounds.height, footprint.height, "placement bounds.height");
  requireEqual(bounds.depth, footprint.depth, "placement bounds.depth");
  requireEqual(bounds.maxX, safeEnd(origin.x, footprint.width, "placement X range"), "placement bounds.maxX");
  requireEqual(bounds.maxY, safeEnd(origin.y, footprint.height, "placement Y range"), "placement bounds.maxY");
  requireEqual(bounds.maxZ, safeEnd(origin.z, footprint.depth, "placement Z range"), "placement bounds.maxZ");
  return bounds;
}

function validateRequestBinding(input, building, placement) {
  const request = assertRecord(input, "building mesh request");
  const canonicalCode = String(request.code ?? "").trim();
  let envelope;
  try {
    envelope = analyzeNcm3Envelope(canonicalCode);
  } catch (error) {
    invalidResult(`building request code cannot be decoded: ${String(error?.message || error)}`);
  }
  requireEqual(building.canonicalCode, canonicalCode, "building result canonicalCode/request binding");
  requireEqual(building.payloadBytes, envelope.payloadBytes, "building result payloadBytes/request binding");
  requireEqual(building.name, envelope.name, "building result name/request binding");
  requireEqual(building.commandCount, envelope.commandCount, "building result commandCount/request binding");
  for (const key of SIZE_KEYS) {
    requireEqual(building.size[key], envelope.size[key], `building result size.${key}/request binding`);
  }
  for (const key of BOUNDS_KEYS) {
    requireEqual(
      building.contentBounds[key],
      envelope.contentBounds[key],
      `building result contentBounds.${key}/request binding`,
    );
  }
  if (building.voxelCount > envelope.maxVoxelCount) {
    invalidResult("building result voxelCount exceeds its decoded command envelope");
  }
  if ((envelope.commandCount === 0) !== (building.voxelCount === 0)) {
    invalidResult("building result voxelCount emptiness does not match its decoded commands");
  }
  const referencedMaterials = new Set(envelope.referencedMaterials);
  for (const material of building.materials) {
    if (!referencedMaterials.has(material)) {
      invalidResult("building result materials are not referenced by its decoded commands");
    }
  }
  const expectedBuildingId = String(request.buildingId || `ncm3-${building.codeId}`);
  requireString(expectedBuildingId, "requested building id", MAX_RESULT_LABEL_LENGTH, true);
  requireEqual(building.id, expectedBuildingId, "building result id/request binding");

  const foundationInput = assertRecord(request.foundation, "building request foundation");
  const minX = requestInteger(foundationInput.minX ?? foundationInput.worldX ?? foundationInput.x, "requested foundation minX");
  const minZ = requestInteger(foundationInput.minZ ?? foundationInput.worldZ ?? foundationInput.z, "requested foundation minZ");
  const surfaceY = requestInteger(foundationInput.surfaceY ?? foundationInput.y, "requested foundation surfaceY");
  const width = requestPositiveInteger(foundationInput.width, "requested foundation width");
  const depth = requestPositiveInteger(foundationInput.depth, "requested foundation depth");
  const foundationId = String(foundationInput.id || `${foundationInput.owner || "foundation"}:${foundationInput.foundationId ?? 0}`);
  requireString(foundationId, "requested foundation id", MAX_RESULT_LABEL_LENGTH, true);
  requireEqual(placement.foundation.id, foundationId, "foundation result id/request binding");
  requireEqual(placement.foundation.minX, minX, "foundation result minX/request binding");
  requireEqual(placement.foundation.minZ, minZ, "foundation result minZ/request binding");
  requireEqual(placement.foundation.surfaceY, surfaceY, "foundation result surfaceY/request binding");
  requireEqual(placement.foundation.width, width, "foundation result width/request binding");
  requireEqual(placement.foundation.depth, depth, "foundation result depth/request binding");

  const quarterTurns = requestQuarterTurns(request.quarterTurns);
  const offsetX = requestInteger(request.offsetX ?? 0, "requested placement offsetX");
  const offsetZ = requestInteger(request.offsetZ ?? 0, "requested placement offsetZ");
  requireEqual(placement.quarterTurns, quarterTurns, "placement quarterTurns/request binding");
  requireEqual(placement.offsetX, offsetX, "placement offsetX/request binding");
  requireEqual(placement.offsetZ, offsetZ, "placement offsetZ/request binding");
  if (!placement.fitsFoundation && request.allowFoundationOverflow !== true) {
    invalidResult("placement overflow was not authorized by the request");
  }
  const expectedPlacementId = String(request.placementId || `${foundationId}:${building.codeId}:${quarterTurns}`);
  requireString(expectedPlacementId, "requested placement id", MAX_RESULT_LABEL_LENGTH, true);
  requireEqual(placement.id, expectedPlacementId, "placement result id/request binding");

  const chunkSize = requestPositiveInteger(request.chunkSize ?? 16, "requested building chunkSize");
  if (chunkSize > MAX_BUILDING_CHUNK_SIZE) invalidResult("requested building chunkSize exceeds 16");
  const revision = Math.max(1, Math.trunc(Number(request.revision) || 1));
  if (!Number.isSafeInteger(revision)) invalidResult("requested building revision must normalize to a positive safe integer");
  return { chunkSize, revision, envelope };
}

function validateChunks(input, building, placement, binding) {
  assertArrayShape(input, "building chunks", building.voxelCount);
  if ((building.voxelCount === 0) !== (input.length === 0)) {
    invalidResult("building chunk count does not match voxelCount emptiness");
  }
  const firstChunkSize = input.length ? requireInteger(input[0]?.chunkSize, "building chunkSize", 1, MAX_BUILDING_CHUNK_SIZE) : null;
  const chunkSize = binding?.chunkSize ?? firstChunkSize;
  if (firstChunkSize !== null && firstChunkSize !== chunkSize) invalidResult("building chunkSize does not match its request");
  if (input.length === 0) return;

  const minChunkX = Math.floor(placement.bounds.minX / chunkSize);
  const maxChunkX = Math.floor(placement.bounds.maxX / chunkSize);
  const minChunkZ = Math.floor(placement.bounds.minZ / chunkSize);
  const maxChunkZ = Math.floor(placement.bounds.maxZ / chunkSize);
  const chunkGridCount = (maxChunkX - minChunkX + 1) * (maxChunkZ - minChunkZ + 1);
  if (!Number.isSafeInteger(chunkGridCount)
    || input.length > chunkGridCount
    || input.length > building.voxelCount) {
    invalidResult("building chunk count exceeds placement or voxel bounds");
  }

  const maxCollisionBytes = chunkGridCount
    * Math.ceil((chunkSize * chunkSize * placement.bounds.height) / 32)
    * Uint32Array.BYTES_PER_ELEMENT;
  const limits = {
    buffers: new Set(),
    collisionBytes: 0,
    maxCollisionBytes,
    meshBlockCount: 0,
    opaqueBlockCount: 0,
    visualBlockCount: 0,
    chunkVoxelCount: 0,
    collisionBlockCount: 0,
    vertexBytes: 0,
    indexBytes: 0,
    maxVertexBytes: building.voxelCount * MAX_VERTICES_PER_VOXEL * BUILDING_VERTEX_STRIDE_BYTES,
    maxIndexBytes: building.voxelCount * MAX_INDICES_PER_VOXEL * Uint32Array.BYTES_PER_ELEMENT,
  };
  const coordinates = new Set();
  let commonVersion = binding?.revision ?? null;
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) invalidResult("building chunks must be a dense array");
    const chunk = validateChunk(input[index], index, building, placement, {
      chunkSize,
      minChunkX,
      maxChunkX,
      minChunkZ,
      maxChunkZ,
      commonVersion,
    }, limits);
    if (commonVersion === null) commonVersion = chunk.version;
    const coordinateKey = `${chunk.chunkX},${chunk.chunkZ}`;
    if (coordinates.has(coordinateKey)) invalidResult("building chunks contain duplicate coordinates");
    coordinates.add(coordinateKey);
  }
  if (limits.chunkVoxelCount !== building.voxelCount) {
    invalidResult("building chunk voxel counts do not match voxelCount");
  }
  if (limits.meshBlockCount > building.voxelCount) invalidResult("building mesh block counts exceed voxelCount");
  if (limits.collisionBlockCount > building.voxelCount) invalidResult("building collision counts exceed voxelCount");
  validateMaterialClassTotals(building, limits);
}

function validateChunk(input, index, building, placement, expected, limits) {
  const label = `building chunk ${index}`;
  const chunk = assertShape(input, CHUNK_KEYS, label);
  const chunkX = requireSafeInteger(chunk.chunkX, `${label}.chunkX`);
  const chunkZ = requireSafeInteger(chunk.chunkZ, `${label}.chunkZ`);
  if (chunkX < expected.minChunkX || chunkX > expected.maxChunkX
    || chunkZ < expected.minChunkZ || chunkZ > expected.maxChunkZ) {
    invalidResult(`${label} lies outside placement bounds`);
  }
  requireEqual(chunk.chunkSize, expected.chunkSize, `${label}.chunkSize`);
  requireEqual(chunk.id, `building:${placement.id}:${chunkX},${chunkZ}`, `${label}.id`);
  requireEqual(chunk.buildingId, placement.id, `${label}.buildingId`);
  const minY = requireSafeInteger(chunk.minY, `${label}.minY`);
  const height = requireInteger(chunk.height, `${label}.height`, 1, placement.bounds.height);
  if (minY < placement.bounds.minY || safeEnd(minY, height, `${label} Y range`) > placement.bounds.maxY) {
    invalidResult(`${label} Y range lies outside placement bounds`);
  }
  const chunkCellCapacity = expected.chunkSize * expected.chunkSize * height;
  const chunkVoxelCount = requireInteger(
    chunk.voxelCount,
    `${label}.voxelCount`,
    1,
    Math.min(building.voxelCount, chunkCellCapacity),
  );
  const visualBlockCount = requireInteger(
    chunk.visualBlockCount,
    `${label}.visualBlockCount`,
    0,
    chunkVoxelCount,
  );

  validateCollisionMask(chunk, label, expected.chunkSize, height, chunkVoxelCount, limits);
  const opaqueBlockCount = validateMesh(
    chunk.mesh,
    `${label}.mesh`,
    chunk,
    placement,
    false,
    chunkVoxelCount,
    limits,
  );
  let representedVisualBlockCount = 0;
  if (chunk.visualMesh === null) {
    requireEqual(chunk.visualMeshVersion, -1, `${label}.visualMeshVersion`);
  } else {
    representedVisualBlockCount = validateMesh(
      chunk.visualMesh,
      `${label}.visualMesh`,
      chunk,
      placement,
      true,
      chunkVoxelCount,
      limits,
    );
    requireEqual(representedVisualBlockCount, visualBlockCount, `${label}.visualBlockCount/visualMesh binding`);
  }
  if (opaqueBlockCount + visualBlockCount !== chunkVoxelCount) {
    invalidResult(`${label} opaque and visual block counts do not match voxelCount`);
  }
  if (opaqueBlockCount + representedVisualBlockCount > chunkVoxelCount) {
    invalidResult(`${label} represented mesh block counts exceed voxelCount`);
  }
  const version = requirePositiveSafeInteger(chunk.version, `${label}.version`);
  requireEqual(chunk.meshVersion, version, `${label}.meshVersion`);
  requireEqual(chunk.visualMeshVersion, chunk.visualMesh === null ? -1 : version, `${label}.visualMeshVersion`);
  if (expected.commonVersion !== null) requireEqual(version, expected.commonVersion, `${label}.version/request binding`);
  requireEqual(chunk.gpuUploaded, false, `${label}.gpuUploaded`);
  requireEqual(chunk.visualGpuUploaded, false, `${label}.visualGpuUploaded`);
  requireEqual(chunk.building, true, `${label}.building`);
  requireEqual(chunk.regionBatchEligible, false, `${label}.regionBatchEligible`);
  requireEqual(chunk.frustumCullEligible, true, `${label}.frustumCullEligible`);
  validateFrustumBounds(chunk.frustumBounds, label, chunkX, chunkZ, expected.chunkSize, minY, height);
  limits.chunkVoxelCount += chunkVoxelCount;
  if (limits.chunkVoxelCount > building.voxelCount) {
    invalidResult("building chunk voxel counts exceed voxelCount");
  }
  limits.opaqueBlockCount += opaqueBlockCount;
  limits.visualBlockCount += visualBlockCount;
  return chunk;
}

function validateMaterialClassTotals(building, limits) {
  // The decoded command set may include materials that later writes replace
  // completely. Classify the result's claimed final set, which is separately
  // constrained to decoded references, and keep these rules aligned with the
  // building mesher's materialRenderInfo().
  let hasOpaque = false;
  let hasVisual = false;
  let hasColliding = false;
  let hasNonColliding = false;
  for (const material of building.materials) {
    const shaderType = materialDef(material).shaderType;
    const visual = shaderType === "transparent" || shaderType === "fluid" || shaderType === "cutout";
    const colliding = shaderType === "opaque" || shaderType === "transparent";
    hasOpaque ||= !visual;
    hasVisual ||= visual;
    hasColliding ||= colliding;
    hasNonColliding ||= !colliding;
  }
  validateMaterialClassPartition({
    total: building.voxelCount,
    firstCount: limits.opaqueBlockCount,
    secondCount: limits.visualBlockCount,
    hasFirst: hasOpaque,
    hasSecond: hasVisual,
    label: "opaque/visual block counts",
  });
  validateMaterialClassPartition({
    total: building.voxelCount,
    firstCount: limits.collisionBlockCount,
    secondCount: building.voxelCount - limits.collisionBlockCount,
    hasFirst: hasColliding,
    hasSecond: hasNonColliding,
    label: "colliding/non-colliding block counts",
  });
}

function validateMaterialClassPartition({
  total,
  firstCount,
  secondCount,
  hasFirst,
  hasSecond,
  label,
}) {
  if (hasFirst && hasSecond) {
    if (firstCount === 0 || secondCount === 0) {
      invalidResult(`${label} omit a reported material class`);
    }
    return;
  }
  requireEqual(firstCount, hasFirst ? total : 0, label);
  requireEqual(secondCount, hasSecond ? total : 0, label);
}

function validateCollisionMask(chunk, label, chunkSize, height, voxelCount, limits) {
  const mask = requireTypedArray(chunk.collisionMask, Uint32Array, `${label}.collisionMask`, limits.buffers);
  const expectedWords = Math.ceil((chunkSize * chunkSize * height) / 32);
  if (mask.length !== expectedWords) invalidResult(`${label}.collisionMask length is inconsistent with chunk dimensions`);
  limits.collisionBytes += mask.byteLength;
  if (limits.collisionBytes > limits.maxCollisionBytes) invalidResult("building collision buffers exceed placement bounds");
  const collisionBlockCount = requireInteger(
    chunk.collisionBlockCount,
    `${label}.collisionBlockCount`,
    0,
    Math.min(voxelCount, chunkSize * chunkSize * height),
  );
  let setBits = 0;
  for (const word of mask) setBits += popCount32(word);
  if (setBits !== collisionBlockCount) invalidResult(`${label}.collisionMask does not match collisionBlockCount`);
  const usedTailBits = (chunkSize * chunkSize * height) & 31;
  if (usedTailBits && (mask[mask.length - 1] & ~(0xffffffff >>> (32 - usedTailBits)))) {
    invalidResult(`${label}.collisionMask sets bits outside its declared dimensions`);
  }
  limits.collisionBlockCount += collisionBlockCount;
}

function validateMesh(input, label, chunk, placement, visual, voxelCount, limits) {
  const mesh = assertShape(input, MESH_KEYS, label);
  const vertices = requireTypedArray(mesh.vertices, Uint8Array, `${label}.vertices`, limits.buffers);
  const indices = requireIndexArray(mesh.indices, `${label}.indices`, limits.buffers);
  const blockCount = requireInteger(mesh.blockCount, `${label}.blockCount`, 0, voxelCount);
  const quadCount = requireInteger(mesh.quadCount, `${label}.quadCount`, 0, blockCount * MAX_QUADS_PER_VOXEL);
  const vertexCount = requireInteger(mesh.vertexCount, `${label}.vertexCount`, 0, quadCount * 4);
  const indexCount = requireInteger(mesh.indexCount, `${label}.indexCount`, 0, quadCount * 6);
  requireEqual(vertexCount, quadCount * 4, `${label}.vertexCount`);
  requireEqual(indexCount, quadCount * 6, `${label}.indexCount`);
  requireEqual(mesh.triangleCount, quadCount * 2, `${label}.triangleCount`);
  requireEqual(mesh.vertexStrideBytes, BUILDING_VERTEX_STRIDE_BYTES, `${label}.vertexStrideBytes`);
  if (vertices.byteLength !== vertexCount * BUILDING_VERTEX_STRIDE_BYTES) {
    invalidResult(`${label}.vertices length does not match vertexCount`);
  }
  if (indices.length !== indexCount) invalidResult(`${label}.indices length does not match indexCount`);
  const expectedIndexType = vertexCount > 0xffff ? Uint32Array : Uint16Array;
  if (!(indices instanceof expectedIndexType)) invalidResult(`${label}.indices use the wrong integer width`);
  for (const vertexIndex of indices) {
    if (vertexIndex >= vertexCount) invalidResult(`${label}.indices contain an out-of-range vertex`);
  }
  requireEqual(mesh.chunkX, chunk.chunkX, `${label}.chunkX`);
  requireEqual(mesh.chunkZ, chunk.chunkZ, `${label}.chunkZ`);
  requireEqual(mesh.chunkSize, chunk.chunkSize, `${label}.chunkSize`);
  requireEqual(mesh.minY, placement.bounds.minY, `${label}.minY`);
  requireEqual(mesh.height, placement.bounds.height, `${label}.height`);
  requireEqual(mesh.building, true, `${label}.building`);
  requireEqual(mesh.visual, visual, `${label}.visual`);

  limits.meshBlockCount += blockCount;
  limits.vertexBytes += vertices.byteLength;
  limits.indexBytes += indices.byteLength;
  if (limits.vertexBytes > limits.maxVertexBytes || limits.indexBytes > limits.maxIndexBytes) {
    invalidResult("building mesh buffers exceed voxel-derived bounds");
  }
  return blockCount;
}

function validateFrustumBounds(input, label, chunkX, chunkZ, chunkSize, minY, height) {
  const bounds = assertShape(input, FRUSTUM_KEYS, `${label}.frustumBounds`);
  const padding = 0.25;
  const width = chunkSize + padding * 2;
  const paddedHeight = height + padding * 2;
  requireEqual(bounds.centerX, chunkX * chunkSize + chunkSize * 0.5, `${label}.frustumBounds.centerX`);
  requireEqual(bounds.centerY, minY + height * 0.5, `${label}.frustumBounds.centerY`);
  requireEqual(bounds.centerZ, chunkZ * chunkSize + chunkSize * 0.5, `${label}.frustumBounds.centerZ`);
  requireEqual(bounds.radius, Math.hypot(width, paddedHeight, width) * 0.5, `${label}.frustumBounds.radius`);
}

function validateSize(input, label) {
  const size = assertShape(input, SIZE_KEYS, label);
  requireInteger(size.x, `${label}.x`, 1, NCM3_MAX_DIMENSION);
  requireInteger(size.y, `${label}.y`, 1, NCM3_MAX_DIMENSION);
  requireInteger(size.z, `${label}.z`, 1, NCM3_MAX_DIMENSION);
  return size;
}

function requireTypedArray(input, Type, label, buffers) {
  if (!(input instanceof Type)) invalidResult(`${label} must be ${Type.name}`);
  return requireWholeArrayBufferView(input, label, buffers);
}

function requireIndexArray(input, label, buffers) {
  if (!(input instanceof Uint16Array) && !(input instanceof Uint32Array)) {
    invalidResult(`${label} must be Uint16Array or Uint32Array`);
  }
  return requireWholeArrayBufferView(input, label, buffers);
}

function requireWholeArrayBufferView(view, label, buffers) {
  if (!(view.buffer instanceof ArrayBuffer)
    || view.byteOffset !== 0
    || view.byteLength !== view.buffer.byteLength
    || view.buffer.resizable === true) {
    invalidResult(`${label} must own one fixed, complete ArrayBuffer`);
  }
  if (buffers.has(view.buffer)) invalidResult(`${label} reuses an already-owned result buffer`);
  buffers.add(view.buffer);
  return view;
}

function assertShape(input, keys, label) {
  const value = assertRecord(input, label);
  let ownKeyCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    ownKeyCount += 1;
    if (!keys.has(key)) invalidResult(`${label} contains unexpected field ${key}`);
  }
  if (ownKeyCount !== keys.size) invalidResult(`${label} has missing fields`);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalidResult(`${label} is missing field ${key}`);
  }
  return value;
}

function assertRecord(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidResult(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalidResult(`${label} must be a plain object`);
  return input;
}

function assertArrayShape(input, label, maxLength) {
  if (!Array.isArray(input) || input.length > maxLength) invalidResult(`${label} exceed their array bounds`);
  for (const key in input) {
    if (!Object.hasOwn(input, key)) continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= input.length || String(index) !== key) {
      invalidResult(`${label} contain an unexpected field ${key}`);
    }
  }
  return input;
}

function requireString(value, label, maxLength, nonEmpty = false) {
  if (typeof value !== "string" || value.length > maxLength || (nonEmpty && value.length === 0)) {
    invalidResult(`${label} must be ${nonEmpty ? "a non-empty " : "a "}bounded string`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") invalidResult(`${label} must be boolean`);
  return value;
}

function requireInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalidResult(`${label} is outside its integer bounds`);
  }
  return value;
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) invalidResult(`${label} must be a safe integer`);
  return value;
}

function requirePositiveSafeInteger(value, label) {
  const number = requireSafeInteger(value, label);
  if (number <= 0) invalidResult(`${label} must be greater than zero`);
  return number;
}

function requestInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) invalidResult(`${label} must normalize to a safe integer`);
  return number;
}

function requestPositiveInteger(value, label) {
  const number = requestInteger(value, label);
  if (number <= 0) invalidResult(`${label} must be greater than zero`);
  return number;
}

function requestQuarterTurns(value) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number)) invalidResult("requested building rotation must be an integer quarter turn");
  const turns = Math.abs(number) > 3 && number % 90 === 0 ? number / 90 : number;
  return ((turns % 4) + 4) % 4;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) invalidResult(`${label} is inconsistent`);
  return actual;
}

function safeEnd(start, length, label) {
  return safeSum(start, length, -1, label);
}

function safeSum(...values) {
  const label = values.pop();
  const sum = values.reduce((total, value) => total + BigInt(value), 0n);
  if (sum < BigInt(Number.MIN_SAFE_INTEGER) || sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalidResult(`${label} exceeds safe integer coordinates`);
  }
  return Number(sum);
}

function popCount32(input) {
  let value = input >>> 0;
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function stableCodeId(code) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function keySet(keys) {
  return new Set(keys);
}

function invalidResult(message) {
  const error = new Error(`Invalid building mesh result: ${message}.`);
  error.code = "building-mesh-result-invalid";
  throw error;
}
