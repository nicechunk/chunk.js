const WORLD_ITEM_VERTEX_STRIDE_FLOATS = 10;

export function createForgedWorldItemMesh(runtime) {
  const packed = runtime?.mesh;
  if (runtime?.kind !== "ncf1-forge-runtime-v1" || !packed?.vertices || !packed?.indices?.length) {
    throw new TypeError("A verified NCF1 runtime mesh is required.");
  }
  const stride = Math.max(16, Math.trunc(Number(packed.vertexStrideBytes) || 16));
  const positionScale = Math.max(1, Number(packed.positionScale) || 1);
  const vertexCount = Math.min(
    Math.trunc(Number(packed.vertexCount) || 0),
    Math.floor(packed.vertices.byteLength / stride),
  );
  if (vertexCount <= 0) throw new TypeError("The NCF1 runtime mesh has no vertices.");

  const source = new DataView(packed.vertices.buffer, packed.vertices.byteOffset, packed.vertices.byteLength);
  const positions = new Float32Array(vertexCount * 3);
  const bounds = emptyBounds();
  for (let index = 0; index < vertexCount; index += 1) {
    const sourceOffset = index * stride;
    const positionOffset = index * 3;
    const x = source.getInt16(sourceOffset, true) / positionScale;
    const y = source.getInt16(sourceOffset + 2, true) / positionScale;
    const z = source.getInt16(sourceOffset + 4, true) / positionScale;
    positions[positionOffset] = x;
    positions[positionOffset + 1] = y;
    positions[positionOffset + 2] = z;
    includePoint(bounds, x, y, z);
  }

  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const vertices = new Float32Array(vertexCount * WORLD_ITEM_VERTEX_STRIDE_FLOATS);
  for (let index = 0; index < vertexCount; index += 1) {
    const sourceOffset = index * stride;
    const positionOffset = index * 3;
    const outputOffset = index * WORLD_ITEM_VERTEX_STRIDE_FLOATS;
    vertices[outputOffset] = positions[positionOffset] - centerX;
    vertices[outputOffset + 1] = positions[positionOffset + 1] - bounds.minY;
    vertices[outputOffset + 2] = positions[positionOffset + 2] - centerZ;
    vertices[outputOffset + 3] = source.getInt8(sourceOffset + 6) / 127;
    vertices[outputOffset + 4] = source.getInt8(sourceOffset + 7) / 127;
    vertices[outputOffset + 5] = source.getInt8(sourceOffset + 8) / 127;
    vertices[outputOffset + 6] = source.getUint8(sourceOffset + 10) / 255;
    vertices[outputOffset + 7] = source.getUint8(sourceOffset + 11) / 255;
    vertices[outputOffset + 8] = source.getUint8(sourceOffset + 12) / 255;
    vertices[outputOffset + 9] = source.getUint8(sourceOffset + 13) / 255;
  }

  const width = Math.max(0.001, bounds.maxX - bounds.minX);
  const height = Math.max(0.001, bounds.maxY - bounds.minY);
  const depth = Math.max(0.001, bounds.maxZ - bounds.minZ);
  return Object.freeze({
    name: `forged_world_item_${runtime.designHash >>> 0}`,
    vertices,
    indices: packed.indices,
    vertexCount,
    indexCount: packed.indices.length,
    triangleCount: packed.triangleCount ?? packed.indices.length / 3,
    vertexStrideBytes: WORLD_ITEM_VERTEX_STRIDE_FLOATS * 4,
    bounds: Object.freeze({ width, height, depth }),
    localBounds: Object.freeze({
      minX: -width * 0.5,
      minY: 0,
      minZ: -depth * 0.5,
      maxX: width * 0.5,
      maxY: height,
      maxZ: depth * 0.5,
    }),
    designHash: runtime.designHash >>> 0,
  });
}

function emptyBounds() {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

function includePoint(bounds, x, y, z) {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}
