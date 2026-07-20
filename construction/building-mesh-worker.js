import {
  createBuildingPlacement,
  parseNcm3Building,
} from "./building-parser.js";
import { createBuildingChunkMeshes } from "./building-mesher.js";

self.onmessage = (event) => {
  const request = event.data ?? {};
  const requestId = Number(request.requestId) || 0;
  try {
    const result = buildResult(request);
    self.postMessage({ requestId, ok: true, result }, transferList(result.chunks));
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: {
        code: String(error?.code || "building-mesh-failed"),
        message: String(error?.message || error || "Building mesh failed."),
      },
    });
  }
};

function buildResult(request) {
  const building = parseNcm3Building(request.code, { id: request.buildingId || "" });
  const placement = createBuildingPlacement(building, request.foundation, {
    quarterTurns: request.quarterTurns,
    placementId: request.placementId,
    materializeWorldVoxels: false,
    allowFoundationOverflow: request.allowFoundationOverflow === true,
    offsetX: request.offsetX,
    offsetZ: request.offsetZ,
  });
  const chunks = createBuildingChunkMeshes(placement, {
    chunkSize: request.chunkSize,
    revision: request.revision,
  });
  return {
    building: summarizeBuilding(building),
    placement: summarizePlacement(placement),
    chunks,
  };
}

function summarizeBuilding(building) {
  return {
    id: building.id,
    name: building.name,
    format: building.format,
    formatVersion: building.formatVersion,
    canonicalCode: building.canonicalCode,
    canonical: building.canonical,
    payloadBytes: building.payloadBytes,
    codeId: building.codeId,
    size: building.size,
    contentBounds: building.contentBounds,
    voxelCount: building.voxelCount,
    commandCount: building.commandCount,
    materials: building.materials,
    scale: building.scale,
  };
}

function summarizePlacement(placement) {
  return {
    id: placement.id,
    foundation: placement.foundation,
    fitsFoundation: placement.fitsFoundation,
    offsetX: placement.offsetX,
    offsetZ: placement.offsetZ,
    quarterTurns: placement.quarterTurns,
    footprint: placement.footprint,
    origin: placement.origin,
    bounds: placement.bounds,
    voxelCount: placement.voxelCount,
    scale: placement.scale,
  };
}

function transferList(chunks) {
  const buffers = [];
  for (const chunk of chunks ?? []) {
    if (chunk?.collisionMask?.buffer) buffers.push(chunk.collisionMask.buffer);
    for (const mesh of [chunk?.mesh, chunk?.visualMesh]) {
      if (mesh?.vertices?.buffer) buffers.push(mesh.vertices.buffer);
      if (mesh?.indices?.buffer) buffers.push(mesh.indices.buffer);
    }
  }
  return buffers;
}
