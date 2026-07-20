import { hashCoord3, normalizeSeedBytes } from "../core/hash.js";
import { MATERIAL_ID } from "../world/block-registry.js";
import { materialList } from "../world/material-registry.js";

const MATERIAL_TILE_CACHE = new Map();
const MATERIAL_TILE_CACHE_LIMIT = 256;

export class TextureArrayManager {
  constructor(gl, { tileSize = 32, materials = materialList(), seed = "nicechunk-materials-v1" } = {}) {
    this.gl = gl;
    this.tileSize = tileSize;
    this.materials = materials;
    this.seed = normalizeSeedBytes(seed);
    this.seedKey = Array.from(this.seed, (byte) => byte.toString(16).padStart(2, "0")).join("");
    this.texture = null;
    this.layerCount = Math.max(1, ...materials.map((material) => material.textureLayer + 1));
  }

  createTextureArray(materialTextures = null) {
    const gl = this.gl;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.tileSize, this.tileSize, this.layerCount);
    const blank = new Uint8Array(this.tileSize * this.tileSize * 4);
    for (let layer = 0; layer < this.layerCount; layer += 1) {
      const material = this.materials.find((entry) => entry.textureLayer === layer);
      const pixels = materialTextures?.[layer] ?? (material ? this.generateMaterialTile(material) : blank);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.tileSize, this.tileSize, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    return this.texture;
  }

  uploadLayer(layerIndex, imageOrCanvas) {
    const gl = this.gl;
    if (!this.texture) this.createTextureArray();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    if (imageOrCanvas instanceof Uint8Array) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layerIndex, this.tileSize, this.tileSize, 1, gl.RGBA, gl.UNSIGNED_BYTE, imageOrCanvas);
    } else {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layerIndex, this.tileSize, this.tileSize, 1, gl.RGBA, gl.UNSIGNED_BYTE, imageOrCanvas);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  bind(unit = 0) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
  }

  dispose() {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
  }

  generateMaterialTile(material) {
    // Tiles are baked deterministically on the client from code. They are not
    // downloaded texture assets, which keeps NiceChunk's material rules portable
    // and reproducible from the same seed/schema.
    const size = this.tileSize;
    const cacheKey = `${this.seedKey}:${size}:${material.materialId}`;
    const cached = MATERIAL_TILE_CACHE.get(cacheKey);
    if (cached) return cached;
    const data = new Uint8Array(size * size * 4);
    const [r, g, b, a] = material.baseColor;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (x + y * size) * 4;
        const alpha = alphaForMaterial(material, x, y, size, this.seed);
        const tone = toneForMaterial(material, x, y, size, this.seed);
        const color = colorForMaterial(material, r, g, b, tone, x, y, size, this.seed);
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        const baseAlpha = isMicroVoxelPlantMaterial(material.materialId) ? 255 : (a ?? 255);
        data[i + 3] = clampByte(baseAlpha * alpha);
      }
    }
    MATERIAL_TILE_CACHE.set(cacheKey, data);
    if (MATERIAL_TILE_CACHE.size > MATERIAL_TILE_CACHE_LIMIT) {
      MATERIAL_TILE_CACHE.delete(MATERIAL_TILE_CACHE.keys().next().value);
    }
    return data;
  }
}

function toneForMaterial(material, x, y, size, seed) {
  const cell = materialCellSize(material, size);
  const cellX = Math.floor(x / cell);
  const cellY = Math.floor(y / cell);
  const big = (hashCoord3(seed, cellX, material.materialId, cellY, 900 + material.materialId) & 63) - 31;
  const broad = (hashCoord3(seed, Math.floor(x / Math.max(1, cell * 2)), material.materialId, Math.floor(y / Math.max(1, cell * 2)), 930 + material.materialId) & 31) - 15;
  const checker = ((cellX + cellY + material.materialId) & 1) ? 1 : -1;
  const edge = edgeTone(x, y, size);
  const facet = cellFacetTone(material, x, y, cell);
  const crack = crackTone(material, x, y, size, seed);
  const highlight = cellHighlight(material, cellX, cellY, seed);
  switch (material.style) {
    case "grass":
    case "grassSide":
    case "leaves":
    case "plant":
      return posterizeTone(big * 0.52 + broad * 0.22 + checker * 4 + facet + highlight + edge + crack, 4);
    case "sand":
    case "salt":
      return posterizeTone(big * 0.34 + broad * 0.18 + checker * 5 + facet * 0.82 + highlight * 0.5 + edge * 0.45 + crack, 4);
    case "snow":
      return posterizeTone(big * 0.28 + broad * 0.14 + checker * 3 + facet * 0.46 + highlight * 0.24 + edge * 0.25 + crack, 4);
    case "water":
      return posterizeTone(big * 0.24 + waveTone(x, y, size) * 16, 3);
    case "lava":
      return posterizeTone(big * 0.38 + waveTone(x, y, size) * 34, 4);
    case "wood":
      return posterizeTone(woodTone(material, x, y, size, seed) + facet * 0.55 + edge * 0.72, 4);
    default:
      return posterizeTone(big * 0.48 + broad * 0.22 + checker * 3 + facet * 0.7 + edge + crack, 4);
  }
}

function colorForMaterial(material, r, g, b, tone, x, y, size, seed) {
  if (material.style === "shadow") return [0, 0, 0];
  if (material.materialId === MATERIAL_ID.cactus) return cactusColor(material, r, g, b, tone, x, y, size, seed);
  if (isMicroVoxelPlantMaterial(material.materialId)) return detailedPlantColor(material, r, g, b, tone, x, y, size, seed);
  if (material.materialId >= MATERIAL_ID.flowerWhite && material.materialId <= MATERIAL_ID.flowerPink) {
    return flowerPetalColor(material, r, g, b, tone, x, y, size, seed);
  }
  if (material.style === "grass") {
    const cell = materialCellSize(material, size);
    const cellX = Math.floor(x / cell);
    const cellY = Math.floor(y / cell);
    const sunPatch = (hashCoord3(seed, cellX, material.materialId, cellY, 1401) & 255) > 210 ? 10 : 0;
    return animeColor([r + tone - 1 + sunPatch * 0.28, g + tone + sunPatch * 0.64, b + tone - 4], 0.78, 14);
  }
  if (material.style === "grassSide") {
    const cell = materialCellSize(material, size);
    const cellX = Math.floor(x / cell);
    const cellY = Math.floor(y / cell);
    const localX = x % Math.max(1, cell);
    const capNoise = hashCoord3(seed, cellX, material.materialId, 0, 1411) & 255;
    const dripNoise = hashCoord3(seed, cellX, material.materialId, cellY, 1412) & 255;
    const columnBand = Math.floor(x / Math.max(1, Math.floor(cell * 0.46)));
    const bandNoise = hashCoord3(seed, columnBand, material.materialId, 0, 1415) & 255;
    const baseGrassLine = Math.floor(size * 0.53) + ((capNoise & 7) - 3);
    const blockStep = Math.trunc(((bandNoise & 31) - 15) / 5);
    const longDrip = bandNoise > 162 ? 3 + ((bandNoise >>> 3) & 7) : 0;
    const extraDrip = dripNoise > 212 && localX > cell * 0.15 && localX < cell * 0.82 ? 2 + (dripNoise & 5) : 0;
    const grassLine = clamp(baseGrassLine + blockStep - longDrip - extraDrip, Math.floor(size * 0.30), Math.floor(size * 0.64));
    const isGrassCap = y >= grassLine;
    const underLip = y >= grassLine - 3;
    if (isGrassCap) {
      const sunPatch = (hashCoord3(seed, cellX, material.materialId, cellY, 1413) & 255) > 212 ? 8 : 0;
      return animeColor([142 + tone + sunPatch * 0.20, 183 + tone + sunPatch * 0.52, 86 + tone * 0.72], 0.76, 12);
    }
    const soilTone = tone + (underLip ? -10 : 0) + ((hashCoord3(seed, cellX, material.materialId, cellY, 1414) & 31) - 15) * 0.20;
    return animeColor([r + soilTone + 4, g + soilTone * 0.68 + 3, b + soilTone * 0.45], 0.88, 5);
  }
  if (material.style === "sand") {
    const cell = materialCellSize(material, size);
    const warm = ((hashCoord3(seed, Math.floor(x / cell), material.materialId, Math.floor(y / cell), 1402) & 31) - 15) * 0.48;
    return animeColor([r + tone + warm + 5, g + tone + warm * 0.42 + 5, b + tone - warm * 0.08 - 2], 0.76, 8);
  }
  if (material.style === "water") {
    const foam = y < 2 || x < 2 || x > size - 3 || y > size - 3 ? 16 : 0;
    return [clampByte(r + tone + foam * 0.16), clampByte(g + tone + foam * 0.52 + 4), clampByte(b + tone + foam + 8)];
  }
  if (material.style === "lava") {
    const hot = (hashCoord3(seed, Math.floor(x / 5), material.materialId, Math.floor(y / 5), 1403) & 255) > 198 ? 42 : 0;
    return [clampByte(r + tone + hot), clampByte(g + tone * 0.4 + hot * 0.38), clampByte(b + tone * 0.2)];
  }
  if (material.style === "leaves" || material.style === "plant") {
    return animeColor([r + tone, g + tone + 5, b + tone - 3], 0.78, 12);
  }
  if (material.style === "wood") {
    return animeColor([r + tone + 5, g + tone * 0.74 + 2, b + tone * 0.50], 0.88, 6);
  }
  if (material.style === "rock" || material.style === "gravel" || material.style === "coal") {
    return animeColor([r + tone + 6, g + tone + 7, b + tone + 9], 0.82, 8);
  }
  if (material.style === "snow") {
    return [clampByte(r + tone + 3), clampByte(g + tone + 5), clampByte(b + tone + 7)];
  }
  if (material.style === "salt") {
    return [clampByte(r + tone + 10), clampByte(g + tone + 13), clampByte(b + tone + 17)];
  }
  return animeColor([r + tone, g + tone, b + tone], 1, 2);
}

function cactusColor(material, r, g, b, tone, x, y, size, seed) {
  const ribWidth = Math.max(2, scaledCell(size, 4));
  const rib = Math.floor(x / ribWidth);
  const localX = x % ribWidth;
  const ridge = localX === 0 ? -18 : localX <= Math.max(1, Math.floor(ribWidth * 0.42)) ? 12 : -5;
  const alternating = (rib & 1) ? -4 : 5;
  const prickCell = Math.max(2, scaledCell(size, 5));
  const prickX = Math.floor(x / prickCell);
  const prickY = Math.floor(y / prickCell);
  const prickHash = hashCoord3(seed, prickX, material.materialId, prickY, 1422);
  const localPrickX = prickHash % prickCell;
  const localPrickY = (prickHash >>> 8) % prickCell;
  if ((prickHash & 255) > 216 && x % prickCell === localPrickX && y % prickCell === localPrickY) {
    const warm = (prickHash >>> 16) & 15;
    return [clampByte(214 + warm), clampByte(220 + warm * 0.55), clampByte(126 + warm * 0.35)];
  }
  const verticalStep = ((Math.floor(y / Math.max(2, scaledCell(size, 6))) + rib) & 1) ? 3 : -2;
  return animeColor([
    r + tone * 0.46 + ridge + alternating - 8 + verticalStep,
    g + tone * 0.70 + ridge + alternating + 7 + verticalStep,
    b + tone * 0.34 + ridge * 0.42 - 11,
  ], 0.94, 7);
}

function detailedPlantColor(material, r, g, b, tone, x, y, size, seed) {
  const id = material.materialId;
  const nx = x / Math.max(1, size - 1);
  const ny = y / Math.max(1, size - 1);
  const cell = Math.max(2, scaledCell(size, 4));
  const cellX = Math.floor(x / cell);
  const cellY = Math.floor(y / cell);
  const noise = (hashCoord3(seed, cellX, id, cellY, 1810 + id) & 31) - 15;

  if (id === MATERIAL_ID.grassPlant || id === MATERIAL_ID.dryGrass || id === MATERIAL_ID.reed
    || id === MATERIAL_ID.swampGrass || id === MATERIAL_ID.vine
    || id === MATERIAL_ID.seaweed || id === MATERIAL_ID.aquaticPlant) {
    const veinWidth = Math.max(2, scaledCell(size, id === MATERIAL_ID.reed ? 5 : 4));
    const localX = x % veinWidth;
    const centerDistance = Math.abs(localX - (veinWidth - 1) * 0.5) / Math.max(1, veinWidth * 0.5);
    const vein = centerDistance < 0.34 ? 13 : centerDistance > 0.78 ? -9 : 2;
    const vertical = (ny - 0.5) * (id === MATERIAL_ID.dryGrass ? 11 : 19);
    const wetLift = id === MATERIAL_ID.seaweed || id === MATERIAL_ID.aquaticPlant ? 8 : 0;
    return animeColor([
      r + tone * 0.42 + vein + vertical * 0.25 + noise * 0.18 - wetLift,
      g + tone * 0.68 + vein + vertical + noise * 0.28 + wetLift,
      b + tone * 0.34 + vein * 0.42 + vertical * 0.28 + wetLift * 1.5,
    ], id === MATERIAL_ID.dryGrass ? 0.72 : 0.90, 7);
  }

  if (id === MATERIAL_ID.bush || id === MATERIAL_ID.snowBush) {
    const leafCell = Math.max(2, scaledCell(size, 6));
    const lx = x % leafCell;
    const ly = y % leafCell;
    const leafEdge = lx === 0 || ly === 0 ? -13 : lx === leafCell - 1 || ly === leafCell - 1 ? -8 : 7;
    const leafSpot = (hashCoord3(seed, Math.floor(x / leafCell), id, Math.floor(y / leafCell), 1841) & 255) > 214 ? 15 : 0;
    return animeColor([
      r + tone * 0.44 + leafEdge + leafSpot * 0.25 + noise * 0.20,
      g + tone * 0.72 + leafEdge + leafSpot + noise * 0.34,
      b + tone * 0.38 + leafEdge * 0.62 + leafSpot * 0.18,
    ], 0.92, 8);
  }

  if (id === MATERIAL_ID.deadBush || id === MATERIAL_ID.thorn) {
    const stripe = ((x + Math.floor(y / Math.max(2, scaledCell(size, 7)))) % Math.max(3, scaledCell(size, 6))) === 0 ? -17 : 4;
    const thornLift = id === MATERIAL_ID.thorn && ((cellX + cellY) & 3) === 0 ? 12 : 0;
    return animeColor([
      r + tone * 0.56 + stripe + thornLift + noise * 0.24,
      g + tone * 0.38 + stripe * 0.72 + thornLift * 0.45 + noise * 0.15,
      b + tone * 0.22 + stripe * 0.46 + noise * 0.10,
    ], 0.68, 5);
  }

  if (id === MATERIAL_ID.moss || id === MATERIAL_ID.lichen || id === MATERIAL_ID.glowMycelium) {
    const patch = hashCoord3(seed, cellX, id, cellY, 1867) & 255;
    const island = patch > 176 ? 15 : patch < 52 ? -14 : 2;
    const glow = id === MATERIAL_ID.glowMycelium ? 18 + Math.sin((nx + ny) * Math.PI * 4) * 8 : 0;
    return animeColor([
      r + tone * 0.42 + island * 0.50 + glow * 0.18,
      g + tone * 0.70 + island + glow,
      b + tone * 0.38 + island * 0.42 + glow * 0.80,
    ], id === MATERIAL_ID.lichen ? 0.68 : 0.88, id === MATERIAL_ID.glowMycelium ? 14 : 7);
  }

  if (id === MATERIAL_ID.mushroom) {
    const spotCell = Math.max(2, scaledCell(size, 5));
    const spotHash = hashCoord3(seed, Math.floor(x / spotCell), id, Math.floor(y / spotCell), 1889);
    const spot = (spotHash & 255) > 196
      && x % spotCell === spotHash % spotCell
      && y % spotCell === (spotHash >>> 8) % spotCell;
    if (spot) return [238, 221, 168];
    const capBand = Math.abs(nx - 0.5) * 13 + (ny - 0.5) * 8;
    return animeColor([r + tone * 0.62 - capBand + noise * 0.22, g + tone * 0.34 - capBand * 0.58, b + tone * 0.30 - capBand * 0.42], 0.92, 7);
  }

  return animeColor([r + tone, g + tone + 5, b + tone - 3], 0.78, 12);
}

function flowerPetalColor(material, r, g, b, tone, x, y, size, seed) {
  const cell = Math.max(2, scaledCell(size, 6));
  const facet = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) ? 8 : -5;
  const highlight = (hashCoord3(seed, Math.floor(x / cell), material.materialId, Math.floor(y / cell), 1901) & 255) > 220 ? 14 : 0;
  return animeColor([r + tone * 0.56 + facet + highlight, g + tone * 0.52 + facet + highlight, b + tone * 0.48 + facet + highlight * 0.72], 0.94, 8);
}

function alphaForMaterial(material, x, y, size, seed) {
  if (material.style === "shadow") {
    const nx = (x / Math.max(1, size - 1)) * 2 - 1;
    const ny = (y / Math.max(1, size - 1)) * 2 - 1;
    const ellipse = nx * nx * 0.72 + ny * ny * 1.18;
    const soft = 1 - smoothstep(0.18, 1.0, ellipse);
    const broken = 0.90 + (((hashCoord3(seed, x >> 2, material.materialId, y >> 2, 1511) & 31) - 15) / 255);
    return Math.max(0, Math.min(0.68, soft * broken));
  }
  if (material.shaderType === "fluid") return 1;
  if (material.shaderType !== "cutout") return 1;
  if (isMicroVoxelPlantMaterial(material.materialId)) return 1;
  const nx = x / Math.max(1, size - 1);
  const ny = y / Math.max(1, size - 1);
  if (material.style === "moss") {
    const dx = nx - 0.5;
    const dy = ny - 0.52;
    return dx * dx * 1.8 + dy * dy < 0.28 ? 1 : 0;
  }
  const blade = Math.abs(nx - 0.5) < mix(0.05, 0.28, 1 - ny);
  const sideBlade = Math.abs(nx - 0.28 - Math.sin(ny * 7) * 0.08) < 0.045 && ny > 0.2;
  const otherBlade = Math.abs(nx - 0.72 + Math.cos(ny * 6) * 0.06) < 0.04 && ny > 0.28;
  const cap = material.style === "plant" && ny < 0.23 && Math.abs(nx - 0.5) < 0.2;
  const noiseKeep = (hashCoord3(seed, x, material.materialId, y, 1501) & 255) > 12;
  return (blade || sideBlade || otherBlade || cap) && noiseKeep ? 1 : 0;
}

function crackTone(material, x, y, size, seed) {
  if (!["rock", "gravel", "coal", "basalt", "ash"].includes(material.style)) return 0;
  const cell = materialCellSize(material, size);
  const lx = x % cell;
  const ly = y % cell;
  const nearBlockEdge = lx === 0 || ly === 0 || lx === cell - 1 || ly === cell - 1;
  const broken = (hashCoord3(seed, Math.floor(x / cell), material.materialId, Math.floor(y / cell), 1200 + material.materialId) & 255) > 174;
  return nearBlockEdge && broken ? -18 : 0;
}

function woodTone(material, x, y, size, seed) {
  const cell = scaledCell(size, 5);
  const stripeCell = Math.floor(x / Math.max(1, cell));
  const stripe = ((hashCoord3(seed, stripeCell, material.materialId, 0, 1600) & 31) - 15) * 0.85;
  const knot = (hashCoord3(seed, Math.floor(x / scaledCell(size, 8)), material.materialId, Math.floor(y / scaledCell(size, 10)), 1601) & 255) > 224 ? -22 : 0;
  return Math.trunc(stripe + knot);
}

function waveTone(x, y, size) {
  return Math.sin((x / size) * Math.PI * 4) * 0.55 + Math.cos((y / size) * Math.PI * 5) * 0.45;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(0.000001, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function materialCellSize(material, size) {
  switch (material.style) {
    case "grass":
    case "grassSide":
    case "sand":
    case "snow":
    case "salt":
    case "leaves":
      return scaledCell(size, 13);
    case "rock":
    case "gravel":
    case "coal":
      return scaledCell(size, 12);
    case "wood":
      return scaledCell(size, 8);
    case "water":
    case "lava":
      return scaledCell(size, 10);
    default:
      return scaledCell(size, 11);
  }
}

function scaledCell(size, cellAt32) {
  return Math.max(1, Math.round(size * cellAt32 / 32));
}

function edgeTone(x, y, size) {
  const max = size - 1;
  const hard = x === 0 || y === 0 || x === max || y === max;
  if (hard) return -10;
  const softShadow = x === max - 1 || y === max - 1 ? -5 : 0;
  const softLight = x === 1 || y === 1 ? 3 : 0;
  return softShadow + softLight;
}

function cellFacetTone(material, x, y, cell) {
  if (material.style === "water" || material.style === "lava") return 0;
  const safeCell = Math.max(2, cell);
  const lx = x % safeCell;
  const ly = y % safeCell;
  const bevel = Math.max(1, Math.round(safeCell * 0.13));
  const leftOrTop = lx === 0 || ly === 0;
  const rightOrBottom = lx === safeCell - 1 || ly === safeCell - 1;
  const innerLight = (lx < bevel && ly <= Math.max(bevel, Math.floor(safeCell * 0.42))) || (ly < bevel && lx <= Math.max(bevel, Math.floor(safeCell * 0.62)));
  const innerShadow = lx >= safeCell - 1 - bevel || ly >= safeCell - 1 - bevel;
  const cornerLight = lx < bevel && ly < bevel;
  const cornerShadow = lx >= safeCell - bevel && ly >= safeCell - bevel;
  const strength = material.style === "snow" ? 0.34
    : material.style === "salt" ? 0.58
    : material.style === "sand" ? 0.72
      : material.style === "plant" || material.style === "leaves" || material.style === "grass" ? 0.88
        : 1.0;
  let tone = 0;
  if (leftOrTop) tone += material.style === "coal" ? 2 : 5;
  if (rightOrBottom) tone -= material.style === "snow" ? 2 : material.style === "salt" ? 3 : 7;
  if (innerLight) tone += 4;
  if (innerShadow) tone -= 5;
  if (cornerLight) tone += 2;
  if (cornerShadow) tone -= 3;
  return Math.trunc(tone * strength);
}

function cellHighlight(material, cellX, cellY, seed) {
  const roll = hashCoord3(seed, cellX, material.materialId, cellY, 1701 + material.materialId) & 255;
  if (roll > 238) return material.style === "snow" ? 4 : material.style === "sand" ? 10 : 8;
  if (roll < 18) return -7;
  return 0;
}

function isMicroVoxelPlantMaterial(materialId) {
  return materialId === MATERIAL_ID.grassPlant
    || materialId === MATERIAL_ID.dryGrass
    || materialId === MATERIAL_ID.bush
    || materialId === MATERIAL_ID.deadBush
    || materialId === MATERIAL_ID.reed
    || materialId === MATERIAL_ID.swampGrass
    || materialId === MATERIAL_ID.snowBush
    || materialId === MATERIAL_ID.thorn
    || materialId === MATERIAL_ID.moss
    || materialId === MATERIAL_ID.lichen
    || materialId === MATERIAL_ID.vine
    || materialId === MATERIAL_ID.glowMycelium
    || materialId === MATERIAL_ID.mushroom
    || materialId === MATERIAL_ID.seaweed
    || materialId === MATERIAL_ID.aquaticPlant;
}

function posterizeTone(value, step) {
  const safeStep = Math.max(1, Math.trunc(step || 1));
  return Math.trunc(value / safeStep) * safeStep;
}

function animeColor(color, saturation = 1, lift = 0) {
  const luma = color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
  return [
    clampByte((luma + (color[0] - luma) * saturation) + lift),
    clampByte((luma + (color[1] - luma) * saturation) + lift),
    clampByte((luma + (color[2] - luma) * saturation) + lift),
  ];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.trunc(value)));
}
