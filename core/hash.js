const defaultSeedBytes = new Uint8Array(32).fill(7);
const seedSaltHashCache = new WeakMap();
const noiseCellCache = new WeakMap();

export function normalizeSeedBytes(input) {
  if (input instanceof Uint8Array || Array.isArray(input)) {
    const bytes = Uint8Array.from(input).slice(0, 32);
    if (bytes.length === 32) return bytes;
    const padded = new Uint8Array(32);
    padded.set(bytes);
    return padded;
  }
  if (typeof input === "string" && /^[0-9a-fA-F]{64}$/.test(input)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(input.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  if (typeof input === "string" && input.length) {
    const encoded = new TextEncoder().encode(input);
    const out = new Uint8Array(32);
    for (let i = 0; i < encoded.length; i += 1) out[i % 32] ^= encoded[i];
    return out;
  }
  return defaultSeedBytes;
}

export function hashCoord3(seed, x, y, z, salt = 0) {
  return hashCoord3FromSeedHash(seedSaltHash(seed, salt), x, y, z);
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
  const corners = [
    hashCoord3FromSeedHash(seedHash, cellX, 0, cellZ) & 255,
    hashCoord3FromSeedHash(seedHash, cellX + 1, 0, cellZ) & 255,
    hashCoord3FromSeedHash(seedHash, cellX, 0, cellZ + 1) & 255,
    hashCoord3FromSeedHash(seedHash, cellX + 1, 0, cellZ + 1) & 255,
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
