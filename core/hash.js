export const SEED_BYTE_LENGTH = 32;
export const MAX_DEVELOPMENT_SEED_TEXT_LENGTH = 4096;
export const I32_MIN = -2_147_483_648;
export const I32_MAX = 2_147_483_647;
export const I16_MIN = -32_768;
export const I16_MAX = 32_767;

const defaultSeedBytes = new Uint8Array(SEED_BYTE_LENGTH).fill(7);
const seedSaltHashCache = new WeakMap();
const noiseCellCache = new WeakMap();

export function normalizeSeedBytes(input) {
  if (input == null) return new Uint8Array(defaultSeedBytes);
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes = input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return normalizeSeedByteView(bytes);
  }
  if (Array.isArray(input)) {
    if (!input.length || input.length > SEED_BYTE_LENGTH) {
      throw new RangeError(`Seed byte arrays must contain 1 to ${SEED_BYTE_LENGTH} bytes.`);
    }
    const bytes = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const value = input[index];
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError(`Seed byte at index ${index} must be an integer from 0 to 255.`);
      }
      bytes[index] = value;
    }
    return padSeedBytes(bytes);
  }
  if (typeof input === "string" && /^[0-9a-fA-F]{64}$/.test(input)) {
    const bytes = new Uint8Array(SEED_BYTE_LENGTH);
    for (let i = 0; i < SEED_BYTE_LENGTH; i += 1) bytes[i] = Number.parseInt(input.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  if (typeof input === "string") {
    if (!input.length) throw new RangeError("Seed text must not be empty.");
    if (input.length > MAX_DEVELOPMENT_SEED_TEXT_LENGTH) {
      throw new RangeError(`Seed text exceeds ${MAX_DEVELOPMENT_SEED_TEXT_LENGTH} UTF-16 code units.`);
    }
    const encoded = new TextEncoder().encode(input);
    const out = new Uint8Array(SEED_BYTE_LENGTH);
    for (let i = 0; i < encoded.length; i += 1) out[i % SEED_BYTE_LENGTH] ^= encoded[i];
    return out;
  }
  throw new TypeError("Seed input must be non-empty text, a byte array, or a BufferSource.");
}

function normalizeSeedByteView(bytes) {
  if (!bytes.byteLength || bytes.byteLength > SEED_BYTE_LENGTH) {
    throw new RangeError(`Seed BufferSource input must contain 1 to ${SEED_BYTE_LENGTH} bytes.`);
  }
  return padSeedBytes(bytes);
}

function padSeedBytes(bytes) {
  const normalized = new Uint8Array(SEED_BYTE_LENGTH);
  normalized.set(bytes);
  return normalized;
}

export function hashCoord3(seed, x, y, z, salt = 0) {
  return hashCoord3FromSeedHash(seedSaltHash(seed, salt), x, y, z);
}

export function saturatingAddI32(left, right) {
  return clampInteger(Math.trunc(left) + Math.trunc(right), I32_MIN, I32_MAX);
}

export function saturatingSubI32(left, right) {
  return clampInteger(Math.trunc(left) - Math.trunc(right), I32_MIN, I32_MAX);
}

export function saturatingMulI32(left, right) {
  return clampInteger(Math.trunc(left) * Math.trunc(right), I32_MIN, I32_MAX);
}

export function saturatingAddI16(left, right) {
  return clampInteger(Math.trunc(left) + Math.trunc(right), I16_MIN, I16_MAX);
}

export function saturatingSubI16(left, right) {
  return clampInteger(Math.trunc(left) - Math.trunc(right), I16_MIN, I16_MAX);
}

function hashCoord3FromSeedHash(seedHash, x, y, z) {
  let hash = seedHash;
  hash = hashI32Bytes(hash, x);
  hash = hashI32Bytes(hash, y);
  hash = hashI32Bytes(hash, z);
  hash ^= hash >>> 16;
  hash = Math.imul(hash >>> 0, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash >>> 0, 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function valueNoise2(seed, x, z, scale, salt = 0) {
  const cellX = divFloor(x, scale);
  const cellZ = divFloor(z, scale);
  const localX = positiveModulo(x, scale);
  const localZ = positiveModulo(z, scale);
  const tx = smoothFixed(localX, scale);
  const tz = smoothFixed(localZ, scale);
  const [a, b, c, d] = noiseCellCorners(seed, cellX, cellZ, scale, salt);
  return lerpFixed(lerpFixed(a, b, tx), lerpFixed(c, d, tx), tz);
}

function noiseCellCorners(seed, cellX, cellZ, scale, salt) {
  let byLayer = noiseCellCache.get(seed);
  if (!byLayer) {
    byLayer = new Map();
    noiseCellCache.set(seed, byLayer);
  }
  const layerKey = `${salt >>> 0}:${Math.trunc(scale)}`;
  const cached = byLayer.get(layerKey);
  if (cached?.cellX === cellX && cached.cellZ === cellZ) return cached.corners;
  const seedHash = seedSaltHash(seed, salt);
  const nextCellX = saturatingAddI32(cellX, 1);
  const nextCellZ = saturatingAddI32(cellZ, 1);
  const corners = [
    hashCoord3FromSeedHash(seedHash, cellX, 0, cellZ) & 255,
    hashCoord3FromSeedHash(seedHash, nextCellX, 0, cellZ) & 255,
    hashCoord3FromSeedHash(seedHash, cellX, 0, nextCellZ) & 255,
    hashCoord3FromSeedHash(seedHash, nextCellX, 0, nextCellZ) & 255,
  ];
  byLayer.set(layerKey, { cellX, cellZ, corners });
  return corners;
}

export function smoothRangeFixed(value, edge0, edge1) {
  if (value <= edge0) return 0;
  if (value >= edge1) return 1024;
  return smoothFixed(value - edge0, edge1 - edge0);
}

export function lerpIntFixed(a, b, t) {
  return Math.trunc((a * (1024 - t) + b * t + 512) / 1024);
}

export function scaleByFixed(value, fixed) {
  return Math.trunc((value * fixed) / 1024);
}

function seedSaltHash(seed, salt) {
  let saltCache = seedSaltHashCache.get(seed);
  if (!saltCache) {
    saltCache = new Map();
    seedSaltHashCache.set(seed, saltCache);
  }
  const key = salt >>> 0;
  const cached = saltCache.get(key);
  if (cached !== undefined) return cached;
  let hash = (0x811c9dc5 ^ key) >>> 0;
  for (const byte of seed) hash = Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0;
  saltCache.set(key, hash);
  return hash;
}

function hashI32Bytes(hash, value) {
  const v = Math.trunc(value) | 0;
  hash = Math.imul((hash ^ (v & 255)) >>> 0, 0x01000193) >>> 0;
  hash = Math.imul((hash ^ ((v >>> 8) & 255)) >>> 0, 0x01000193) >>> 0;
  hash = Math.imul((hash ^ ((v >>> 16) & 255)) >>> 0, 0x01000193) >>> 0;
  return Math.imul((hash ^ ((v >>> 24) & 255)) >>> 0, 0x01000193) >>> 0;
}

function divFloor(value, divisor) {
  return Math.floor(Math.trunc(value) / Math.trunc(divisor));
}

function positiveModulo(value, divisor) {
  const d = Math.trunc(divisor);
  return ((Math.trunc(value) % d) + d) % d;
}

function smoothFixed(distance, scale) {
  const fixed = Math.trunc((Math.trunc(distance) * 1024) / Math.trunc(scale));
  return Math.trunc((fixed * fixed * (3072 - fixed * 2)) / (1024 * 1024));
}

function lerpFixed(a, b, t) {
  return Math.trunc((a * (1024 - t) + b * t + 512) / 1024);
}

function clampInteger(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
