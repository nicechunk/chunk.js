import {
  BLOCK_ID,
  MATERIAL_ID,
  blockDef,
  blockMaterialIdForFace,
  isLowVegetationBlock,
} from "../world/block-registry.js";
import { cactusModelPartsForQuarterTurn } from "../world/cactus-model.js";
import { materialDef } from "../world/material-registry.js";

const MAX_PIECES_PER_BLOCK = 28;
const FLOWER_MATERIALS = Object.freeze([
  MATERIAL_ID.flowerWhite,
  MATERIAL_ID.flowerYellow,
  MATERIAL_ID.flowerRed,
  MATERIAL_ID.flowerBlue,
  MATERIAL_ID.flowerPink,
]);

const DEFAULT_DYNAMICS = Object.freeze({
  gravity: 14.0,
  drag: 0.34,
  restitution: 0.38,
  groundFriction: 0.68,
  burstSpeed: 2.15,
  liftSpeed: 2.45,
  angularSpeed: 7.4,
  lifeMin: 2.35,
  lifeJitter: 0.75,
  bounceMin: 2,
  bounceJitter: 3,
});

const DYNAMICS_BY_STYLE = Object.freeze({
  rock: dynamics({ gravity: 17.5, restitution: 0.32, groundFriction: 0.60, burstSpeed: 2.0, angularSpeed: 8.2 }),
  gravel: dynamics({ gravity: 16.0, restitution: 0.28, groundFriction: 0.56, burstSpeed: 2.35, angularSpeed: 8.8 }),
  coal: dynamics({ gravity: 16.5, restitution: 0.34, groundFriction: 0.62, burstSpeed: 2.1, angularSpeed: 8.4 }),
  soil: dynamics({ gravity: 14.5, drag: 0.52, restitution: 0.24, groundFriction: 0.48, burstSpeed: 1.9, angularSpeed: 6.6 }),
  sand: dynamics({ gravity: 15.0, drag: 0.62, restitution: 0.20, groundFriction: 0.44, burstSpeed: 2.05, angularSpeed: 6.8 }),
  snow: dynamics({ gravity: 10.5, drag: 0.92, restitution: 0.18, groundFriction: 0.42, burstSpeed: 1.7, liftSpeed: 2.1, angularSpeed: 5.4 }),
  ice: dynamics({ gravity: 15.5, drag: 0.20, restitution: 0.56, groundFriction: 0.82, burstSpeed: 2.45, angularSpeed: 10.5, lifeMin: 2.65 }),
  wood: dynamics({ gravity: 12.0, drag: 0.46, restitution: 0.42, groundFriction: 0.68, burstSpeed: 2.25, angularSpeed: 7.8 }),
  leaves: dynamics({ gravity: 7.2, drag: 1.45, restitution: 0.34, groundFriction: 0.58, burstSpeed: 2.5, liftSpeed: 2.7, angularSpeed: 9.2, lifeMin: 2.65 }),
  plant: dynamics({ gravity: 7.8, drag: 1.28, restitution: 0.31, groundFriction: 0.54, burstSpeed: 2.4, liftSpeed: 2.65, angularSpeed: 9.0, lifeMin: 2.45 }),
  water: dynamics({ gravity: 9.0, drag: 1.8, restitution: 0.16, groundFriction: 0.40, burstSpeed: 1.8, angularSpeed: 5.0, lifeMin: 1.8, lifeJitter: 0.45 }),
  lava: dynamics({ gravity: 11.0, drag: 1.15, restitution: 0.18, groundFriction: 0.46, burstSpeed: 1.9, angularSpeed: 5.6, lifeMin: 2.0 }),
});

export function createVoxelFracturePieces(options = {}) {
  const blockId = normalizedBlockId(options.blockId);
  const worldX = integer(options.worldX ?? options.x);
  const worldY = integer(options.worldY ?? options.y);
  const worldZ = integer(options.worldZ ?? options.z);
  const seed = fractureHash(worldX, worldY, worldZ, blockId);
  const pieceLimit = clampInt(options.pieceLimit ?? MAX_PIECES_PER_BLOCK, 1, MAX_PIECES_PER_BLOCK);
  let pieces;
  if (blockId === BLOCK_ID.cactus) pieces = cactusPieces(seed);
  else if (isLowVegetationBlock(blockId)) pieces = vegetationPieces(blockId, seed);
  else pieces = cubePieces(blockId, seed);
  const selected = limitPieces(pieces, pieceLimit, seed);
  return selected.map((piece, index) => finishPiece(piece, blockId, seed + index * 97));
}

export function voxelFractureDynamics(blockId) {
  const normalized = normalizedBlockId(blockId);
  if (normalized === BLOCK_ID.cactus) return DYNAMICS_BY_STYLE.plant;
  const style = materialDef(blockDef(normalized).materialId).style;
  return DYNAMICS_BY_STYLE[style] ?? DEFAULT_DYNAMICS;
}

function cubePieces(blockId, seed) {
  const style = materialDef(blockDef(blockId).materialId).style;
  const counts = style === "wood" ? [3, 4, 2] : [3, 3, 3];
  const cutsX = irregularCuts(counts[0], seed + 101);
  const cutsY = irregularCuts(counts[1], seed + 211);
  const cutsZ = irregularCuts(counts[2], seed + 307);
  const pieces = [];
  for (let iz = 0; iz < counts[2]; iz += 1) {
    for (let iy = 0; iy < counts[1]; iy += 1) {
      for (let ix = 0; ix < counts[0]; ix += 1) {
        const x0 = cutsX[ix];
        const x1 = cutsX[ix + 1];
        const y0 = cutsY[iy];
        const y1 = cutsY[iy + 1];
        const z0 = cutsZ[iz];
        const z1 = cutsZ[iz + 1];
        pieces.push(box(
          (x0 + x1) * 0.5,
          (y0 + y1) * 0.5,
          (z0 + z1) * 0.5,
          x1 - x0,
          y1 - y0,
          z1 - z0,
          {
            cubePiece: true,
            outerSide: ix === 0 || ix === counts[0] - 1 || iz === 0 || iz === counts[2] - 1,
            outerTop: iy === counts[1] - 1,
            outerBottom: iy === 0,
          },
        ));
      }
    }
  }
  return pieces;
}

function cactusPieces(seed) {
  const pieces = [];
  const parts = cactusModelPartsForQuarterTurn((seed >>> 29) & 3);
  for (const part of parts) {
    const axis = longestAxis(part.sx, part.sy, part.sz);
    const length = axis === 0 ? part.sx : axis === 1 ? part.sy : part.sz;
    const segments = clampInt(Math.ceil(length / 0.29), 2, 6);
    const cuts = irregularCuts(segments, seed ^ hashString(part.id));
    for (let index = 0; index < segments; index += 1) {
      const from = cuts[index] - 0.5;
      const to = cuts[index + 1] - 0.5;
      const center = (from + to) * 0.5 * length;
      const span = (to - from) * length;
      pieces.push(box(
        0.5 + part.x + (axis === 0 ? center : 0),
        part.y + (axis === 1 ? center : 0),
        0.5 + part.z + (axis === 2 ? center : 0),
        axis === 0 ? span : part.sx,
        axis === 1 ? span : part.sy,
        axis === 2 ? span : part.sz,
      ));
    }
  }
  return pieces;
}

function vegetationPieces(blockId, seed) {
  if (blockId === BLOCK_ID.grassPlant || blockId === BLOCK_ID.dryGrass || blockId === BLOCK_ID.swampGrass) {
    return grassPieces(blockId, seed);
  }
  if (blockId === BLOCK_ID.bush || blockId === BLOCK_ID.snowBush) return bushPieces(blockId, seed);
  if (blockId === BLOCK_ID.deadBush || blockId === BLOCK_ID.thorn) return branchPieces(blockId, seed);
  if (blockId === BLOCK_ID.reed) return reedPieces(seed);
  if (blockId === BLOCK_ID.moss || blockId === BLOCK_ID.lichen) return groundPatchPieces(blockId, seed);
  if (blockId === BLOCK_ID.mushroom || blockId === BLOCK_ID.glowMycelium) return mushroomPieces(blockId, seed);
  if (blockId === BLOCK_ID.vine) return vinePieces(seed);
  if (blockId === BLOCK_ID.seaweed || blockId === BLOCK_ID.aquaticPlant) return aquaticPieces(blockId, seed);
  return grassPieces(blockId, seed);
}

function grassPieces(blockId, seed) {
  const pieces = [];
  const jitter = ((seed >>> 16) & 15) / 15;
  const height = (0.22 + jitter * 0.12) * 2;
  const bladeCount = 6;
  for (let blade = 0; blade < bladeCount; blade += 1) {
    const angle = (blade / bladeCount) * Math.PI * 2 + rand(seed + blade * 43) * 0.45;
    const radius = 0.045 + rand(seed + blade * 59) * 0.13;
    const x = 0.5 + Math.cos(angle) * radius;
    const z = 0.5 + Math.sin(angle) * radius;
    const bladeHeight = height * (0.76 + rand(seed + blade * 71) * 0.24);
    const width = 0.035 + rand(seed + blade * 83) * 0.025;
    pieces.push(box(x, 0.035 + bladeHeight * 0.25, z, width, bladeHeight * 0.5, width));
    pieces.push(box(x + Math.cos(angle) * 0.025, 0.035 + bladeHeight * 0.75, z + Math.sin(angle) * 0.025, width * 0.82, bladeHeight * 0.5, width * 0.82));
  }
  if (blockId === BLOCK_ID.grassPlant && (seed & 7) <= 2) appendFlowerPieces(pieces, seed, height);
  return pieces;
}

function appendFlowerPieces(pieces, seed, height) {
  const petalMaterialId = FLOWER_MATERIALS[(seed >>> 12) % FLOWER_MATERIALS.length];
  const cy = 0.035 + height * 0.92;
  pieces.push(box(0.5, cy - 0.11, 0.5, 0.045, 0.22, 0.045));
  pieces.push(box(0.5 - 0.075, cy, 0.5, 0.105, 0.045, 0.075, { materialId: petalMaterialId }));
  pieces.push(box(0.5 + 0.075, cy, 0.5, 0.105, 0.045, 0.075, { materialId: petalMaterialId }));
  pieces.push(box(0.5, cy, 0.5 - 0.075, 0.075, 0.045, 0.105, { materialId: petalMaterialId }));
  pieces.push(box(0.5, cy, 0.5 + 0.075, 0.075, 0.045, 0.105, { materialId: petalMaterialId }));
  pieces.push(box(0.5, cy + 0.025, 0.5, 0.072, 0.055, 0.072, { materialId: MATERIAL_ID.flowerYellow }));
}

function bushPieces(blockId, seed) {
  const pieces = [];
  for (let index = 0; index < 13; index += 1) {
    const angle = rand(seed + index * 41) * Math.PI * 2;
    const radius = index < 4 ? 0.10 : 0.12 + rand(seed + index * 53) * 0.22;
    const y = 0.20 + rand(seed + index * 67) * 0.52;
    const size = 0.17 + rand(seed + index * 79) * 0.14;
    const snowCap = blockId === BLOCK_ID.snowBush && y > 0.52 && (index & 1) === 0;
    pieces.push(box(
      0.5 + Math.cos(angle) * radius,
      y,
      0.5 + Math.sin(angle) * radius,
      size,
      size * (0.78 + rand(seed + index * 89) * 0.30),
      size,
      snowCap ? { materialId: MATERIAL_ID.snow } : null,
    ));
  }
  return pieces;
}

function branchPieces(blockId, seed) {
  const pieces = [box(0.5, 0.22, 0.5, 0.075, 0.40, 0.075)];
  for (let index = 0; index < 9; index += 1) {
    const angle = (index / 9) * Math.PI * 2 + rand(seed + index * 31) * 0.6;
    const radius = 0.10 + rand(seed + index * 47) * 0.18;
    const y = 0.20 + rand(seed + index * 61) * 0.34;
    const long = blockId === BLOCK_ID.thorn ? 0.24 : 0.20;
    pieces.push(box(
      0.5 + Math.cos(angle) * radius,
      y,
      0.5 + Math.sin(angle) * radius,
      Math.abs(Math.cos(angle)) * long + 0.045,
      0.065,
      Math.abs(Math.sin(angle)) * long + 0.045,
    ));
  }
  return pieces;
}

function reedPieces(seed) {
  const pieces = [];
  for (let stalk = 0; stalk < 5; stalk += 1) {
    const x = 0.5 + (rand(seed + stalk * 43) - 0.5) * 0.38;
    const z = 0.5 + (rand(seed + stalk * 59) - 0.5) * 0.38;
    const height = 0.58 + rand(seed + stalk * 71) * 0.28;
    pieces.push(box(x, 0.035 + height * 0.25, z, 0.045, height * 0.5, 0.045));
    pieces.push(box(x, 0.035 + height * 0.75, z, 0.042, height * 0.5, 0.042));
    pieces.push(box(x, 0.035 + height + 0.055, z, 0.075, 0.11, 0.065, { materialBlockId: BLOCK_ID.deadBush }));
  }
  return pieces;
}

function groundPatchPieces(blockId, seed) {
  const pieces = [];
  for (let index = 0; index < 12; index += 1) {
    const angle = rand(seed + index * 37) * Math.PI * 2;
    const radius = rand(seed + index * 53) * 0.30;
    pieces.push(box(
      0.5 + Math.cos(angle) * radius,
      0.055 + rand(seed + index * 67) * 0.035,
      0.5 + Math.sin(angle) * radius,
      0.11 + rand(seed + index * 71) * 0.10,
      0.045 + rand(seed + index * 83) * 0.035,
      0.11 + rand(seed + index * 97) * 0.10,
    ));
  }
  return pieces;
}

function mushroomPieces(blockId, seed) {
  const height = 0.22 + rand(seed + 13) * 0.13;
  const capMaterialId = blockDef(blockId).materialId;
  return [
    box(0.5, 0.035 + height * 0.25, 0.5, 0.075, height * 0.5, 0.075, { materialBlockId: BLOCK_ID.sand }),
    box(0.5, 0.035 + height * 0.75, 0.5, 0.070, height * 0.5, 0.070, { materialBlockId: BLOCK_ID.sand }),
    box(0.5, 0.035 + height + 0.025, 0.5, 0.26, 0.075, 0.24, { materialId: capMaterialId }),
    box(0.43, 0.035 + height + 0.065, 0.5, 0.13, 0.07, 0.18, { materialId: capMaterialId }),
    box(0.57, 0.035 + height + 0.065, 0.5, 0.13, 0.07, 0.18, { materialId: capMaterialId }),
  ];
}

function vinePieces(seed) {
  const pieces = [];
  for (let index = 0; index < 11; index += 1) {
    const y = 0.08 + index * 0.065;
    const bend = Math.sin(index * 0.78 + rand(seed + index * 29)) * 0.10;
    pieces.push(box(0.5 + bend, y, 0.5, 0.055, 0.09, 0.055));
  }
  return pieces;
}

function aquaticPieces(blockId, seed) {
  const pieces = grassPieces(blockId, seed);
  for (const piece of pieces) {
    piece.sy *= 1.15;
    piece.cy *= 1.15;
  }
  return pieces;
}

function finishPiece(piece, blockId, seed) {
  const layers = layersForPiece(piece, blockId);
  const definition = piece.materialId !== undefined
    ? materialDef(piece.materialId)
    : materialDef(blockDef(piece.materialBlockId ?? blockId).materialId);
  const tone = 0.91 + rand(seed) * 0.17;
  return {
    centerX: piece.cx,
    centerY: piece.cy,
    centerZ: piece.cz,
    sizeX: Math.max(0.018, piece.sx),
    sizeY: Math.max(0.018, piece.sy),
    sizeZ: Math.max(0.018, piece.sz),
    sourceX: piece.cx,
    sourceY: piece.cy,
    sourceZ: piece.cz,
    sideLayer: layers.side,
    topLayer: layers.top,
    bottomLayer: layers.bottom,
    tintR: tone,
    tintG: tone,
    tintB: tone,
    alpha: clamp01((definition.baseColor?.[3] ?? 255) / 255),
  };
}

function layersForPiece(piece, fallbackBlockId) {
  if (piece.materialId !== undefined) {
    const layer = materialDef(piece.materialId).textureLayer;
    return { side: layer, top: layer, bottom: layer };
  }
  const blockId = normalizedBlockId(piece.materialBlockId ?? fallbackBlockId);
  const interiorLayer = materialDef(interiorMaterialId(blockId)).textureLayer;
  return {
    side: piece.cubePiece && !piece.outerSide ? interiorLayer : materialDef(blockMaterialIdForFace(blockId, 0)).textureLayer,
    top: piece.cubePiece && !piece.outerTop ? interiorLayer : materialDef(blockMaterialIdForFace(blockId, 2)).textureLayer,
    bottom: piece.cubePiece && !piece.outerBottom ? interiorLayer : materialDef(blockMaterialIdForFace(blockId, 3)).textureLayer,
  };
}

function interiorMaterialId(blockId) {
  if (blockId === BLOCK_ID.grass) return MATERIAL_ID.dirt;
  return blockDef(blockId).materialId;
}

function limitPieces(pieces, limit, seed) {
  if (pieces.length <= limit) return pieces;
  return pieces
    .map((piece, index) => ({ piece, order: fractureHash(index, pieces.length, seed, index + 1) }))
    .sort((left, right) => left.order - right.order)
    .slice(0, limit)
    .map((entry) => entry.piece);
}

function irregularCuts(count, seed) {
  const weights = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const weight = 0.76 + rand(seed + index * 101) * 0.48;
    weights.push(weight);
    total += weight;
  }
  const cuts = [0];
  let cursor = 0;
  for (const weight of weights) {
    cursor += weight / total;
    cuts.push(cursor);
  }
  cuts[cuts.length - 1] = 1;
  return cuts;
}

function box(cx, cy, cz, sx, sy, sz, options = null) {
  return { cx, cy, cz, sx, sy, sz, ...(options ?? {}) };
}

function dynamics(overrides) {
  return Object.freeze({ ...DEFAULT_DYNAMICS, ...overrides });
}

function longestAxis(x, y, z) {
  if (y >= x && y >= z) return 1;
  return x >= z ? 0 : 2;
}

function normalizedBlockId(value) {
  const blockId = Math.trunc(Number(value));
  return Number.isFinite(blockId) && blockDef(blockId).blockId === blockId ? blockId : BLOCK_ID.stone;
}

function integer(value) {
  return Math.trunc(Number(value) || 0);
}

function fractureHash(x, y, z, salt) {
  let h = 0x811c9dc5;
  h = hashI32(h, x);
  h = hashI32(h, y);
  h = hashI32(h, z);
  h = hashI32(h, salt * 2654435761);
  h ^= h >>> 16;
  h = Math.imul(h >>> 0, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h >>> 0, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function hashI32(hash, value) {
  const v = Math.trunc(value) | 0;
  hash = Math.imul((hash ^ (v & 255)) >>> 0, 0x01000193) >>> 0;
  hash = Math.imul((hash ^ ((v >>> 8) & 255)) >>> 0, 0x01000193) >>> 0;
  hash = Math.imul((hash ^ ((v >>> 16) & 255)) >>> 0, 0x01000193) >>> 0;
  return Math.imul((hash ^ ((v >>> 24) & 255)) >>> 0, 0x01000193) >>> 0;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function rand(seed) {
  let value = (seed >>> 0) + 0x6d2b79f5;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || min)));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
