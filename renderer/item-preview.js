import { BLOCK_ID, RESOURCE_ID, blockDef, blockMaterialIdForFace } from "../world/block-registry.js";
import { CACTUS_MODEL_MAX_Y, CACTUS_MODEL_PARTS } from "../world/cactus-model.js";
import { materialDef } from "../world/material-registry.js";
import { materialList } from "../world/material-registry.js";
import {
  createResourceDropPreviewMesh,
  createSurfaceDecorationPreviewMesh,
  hasResourceDropPreviewModel,
} from "../chunk/chunk-mesher.js";
import { surfaceDecorationName } from "../world/surface-decoration-rules.js";
import {
  createEquipmentModelParts,
  EQUIPMENT_MODEL_ID,
  equipmentModelIdForItem,
} from "./equipment-model.js";
import { DEFAULT_WORLD_LIGHTING } from "./lighting.js";
import {
  createSmeltingMaterialPreviewMesh,
  hasSmeltingMaterialPreviewModel,
} from "./smelting-material-models.js";
import { TextureArrayManager } from "./texture-array-manager.js";

const DEFAULT_ITEM_TEXTURE_SEED = "nicechunk-materials-v1";
const DEFAULT_ITEM_TEXTURE_TILE_SIZE = 32;
const PREVIEW_TEXTURE_MANAGER_LIMIT = 16;
const previewTextureManagers = new Map();
const previewFaceCanvasCache = new WeakMap();
const forgePreviewMeshCache = new WeakMap();
const PREVIEW_MATERIAL_BY_LAYER = new Map(materialList().map((material) => [material.textureLayer, material]));
const PREVIEW_FACE_LIGHTING = Object.freeze({
  0: Object.freeze({ normal: [1, 0, 0], shade: 230 }),
  1: Object.freeze({ normal: [-1, 0, 0], shade: 214 }),
  2: Object.freeze({ normal: [0, 1, 0], shade: 255 }),
  3: Object.freeze({ normal: [0, -1, 0], shade: 184 }),
  4: Object.freeze({ normal: [0, 0, 1], shade: 206 }),
  5: Object.freeze({ normal: [0, 0, -1], shade: 220 }),
});
const PREVIEW_CUBE_SIDE_FACES = Object.freeze([
  Object.freeze({ faceIndex: 4, normalX: 0, normalZ: 1, start: [-0.5, 0.5], end: [0.5, 0.5] }),
  Object.freeze({ faceIndex: 0, normalX: 1, normalZ: 0, start: [0.5, -0.5], end: [0.5, 0.5] }),
  Object.freeze({ faceIndex: 5, normalX: 0, normalZ: -1, start: [0.5, -0.5], end: [-0.5, -0.5] }),
  Object.freeze({ faceIndex: 1, normalX: -1, normalZ: 0, start: [-0.5, 0.5], end: [-0.5, -0.5] }),
]);
const EQUIPMENT_CUBOID_FACES = Object.freeze([
  Object.freeze({ normal: [1, 0, 0], corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] }),
  Object.freeze({ normal: [-1, 0, 0], corners: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] }),
  Object.freeze({ normal: [0, 1, 0], corners: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] }),
  Object.freeze({ normal: [0, -1, 0], corners: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] }),
  Object.freeze({ normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] }),
  Object.freeze({ normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }),
]);

const RESOURCE_NAMES = Object.freeze({
  [RESOURCE_ID.none]: "None",
  [RESOURCE_ID.grassFiber]: "Grass Fiber",
  [RESOURCE_ID.soil]: "Soil",
  [RESOURCE_ID.stone]: "Stone",
  [RESOURCE_ID.sand]: "Sand",
  [RESOURCE_ID.clay]: "Clay",
  [RESOURCE_ID.snow]: "Snow",
  [RESOURCE_ID.basalt]: "Basalt",
  [RESOURCE_ID.water]: "Water",
  [RESOURCE_ID.wood]: "Wood",
  [RESOURCE_ID.leaves]: "Leaves",
  [RESOURCE_ID.coal]: "Coal",
  [RESOURCE_ID.salt]: "Salt",
  [RESOURCE_ID.ice]: "Ice",
  [RESOURCE_ID.lava]: "Lava",
  [RESOURCE_ID.organic]: "Organic",
  [RESOURCE_ID.cactus]: "Cactus",
  [RESOURCE_ID.reed]: "Reed",
  [RESOURCE_ID.moss]: "Moss",
  [RESOURCE_ID.mushroom]: "Mushroom",
  [RESOURCE_ID.aquaticPlant]: "Aquatic Plant",
  [RESOURCE_ID.coral]: "Coral",
  [RESOURCE_ID.shell]: "Shell",
});

const BLOCK_COLORS = Object.freeze({
  [BLOCK_ID.grass]: [96, 158, 74],
  [BLOCK_ID.dirt]: [131, 88, 52],
  [BLOCK_ID.stone]: [133, 130, 120],
  [BLOCK_ID.deepStone]: [72, 72, 78],
  [BLOCK_ID.sand]: [218, 193, 114],
  [BLOCK_ID.gravel]: [145, 139, 127],
  [BLOCK_ID.clay]: [178, 124, 92],
  [BLOCK_ID.mud]: [87, 61, 43],
  [BLOCK_ID.dryDirt]: [166, 112, 58],
  [BLOCK_ID.saltFlat]: [229, 225, 203],
  [BLOCK_ID.snow]: [220, 233, 240],
  [BLOCK_ID.ice]: [142, 202, 242],
  [BLOCK_ID.frozenSoil]: [138, 151, 158],
  [BLOCK_ID.basalt]: [64, 65, 67],
  [BLOCK_ID.ash]: [116, 111, 103],
  [BLOCK_ID.water]: [48, 128, 216],
  [BLOCK_ID.swampWater]: [65, 99, 74],
  [BLOCK_ID.toxicWater]: [112, 196, 66],
  [BLOCK_ID.lava]: [255, 92, 36],
  [BLOCK_ID.quicksand]: [190, 158, 83],
  [BLOCK_ID.trunk]: [119, 78, 44],
  [BLOCK_ID.leaves]: [67, 130, 68],
  [BLOCK_ID.pineTrunk]: [103, 75, 48],
  [BLOCK_ID.pineLeaves]: [58, 107, 77],
  [BLOCK_ID.deadWood]: [85, 66, 44],
  [BLOCK_ID.cactus]: [55, 155, 91],
  [BLOCK_ID.coal]: [31, 30, 34],
});

const RESOURCE_COLORS = Object.freeze({
  [RESOURCE_ID.grassFiber]: [104, 174, 82],
  [RESOURCE_ID.soil]: [133, 88, 51],
  [RESOURCE_ID.stone]: [132, 130, 122],
  [RESOURCE_ID.sand]: [218, 193, 114],
  [RESOURCE_ID.clay]: [178, 124, 92],
  [RESOURCE_ID.snow]: [220, 233, 240],
  [RESOURCE_ID.basalt]: [68, 68, 72],
  [RESOURCE_ID.water]: [48, 128, 216],
  [RESOURCE_ID.wood]: [119, 78, 44],
  [RESOURCE_ID.leaves]: [67, 130, 68],
  [RESOURCE_ID.coal]: [31, 30, 34],
  [RESOURCE_ID.salt]: [229, 225, 203],
  [RESOURCE_ID.ice]: [142, 202, 242],
  [RESOURCE_ID.lava]: [255, 92, 36],
  [RESOURCE_ID.organic]: [119, 120, 62],
  [RESOURCE_ID.cactus]: [55, 155, 91],
  [RESOURCE_ID.reed]: [137, 169, 78],
  [RESOURCE_ID.moss]: [76, 143, 82],
  [RESOURCE_ID.mushroom]: [184, 91, 91],
  [RESOURCE_ID.aquaticPlant]: [63, 168, 120],
  [RESOURCE_ID.coral]: [255, 127, 127],
  [RESOURCE_ID.shell]: [228, 214, 181],
});

export function resourceName(resourceId) {
  return RESOURCE_NAMES[resourceId] ?? `Resource ${resourceId}`;
}

export function blockColor(blockId) {
  return BLOCK_COLORS[blockId] ?? [150, 150, 150];
}

export function resourceColor(resourceId) {
  return RESOURCE_COLORS[resourceId] ?? [150, 150, 150];
}

export function getBakedBlockFaceTile(blockId, faceIndex = 2, options = {}) {
  const tileSize = Math.max(8, Math.min(128, Math.trunc(Number(options.textureTileSize) || DEFAULT_ITEM_TEXTURE_TILE_SIZE)));
  const textureSeed = options.textureSeed ?? DEFAULT_ITEM_TEXTURE_SEED;
  const materialId = blockMaterialIdForFace(blockId, faceIndex);
  const material = materialDef(materialId);
  const manager = previewTextureManager(textureSeed, tileSize);
  return {
    blockId,
    faceIndex,
    materialId,
    textureLayer: material.textureLayer,
    tileSize,
    pixels: manager.generateMaterialTile(material),
  };
}

export function createVoxelItemIconCanvas(item = {}, options = {}) {
  const size = Math.max(24, Math.trunc(options.size || 48));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  canvas.className = options.className || "voxel-item-icon";
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, size, size);
  const equipmentModelId = equipmentModelIdForItem(item);
  if (equipmentModelId) {
    const parts = createEquipmentModelParts(equipmentModelId, { designHash: item.designHash });
    drawEquipmentModel(ctx, size, equipmentModelId, parts);
    canvas.dataset.equipmentModelId = equipmentModelId;
    const forgeSource = forgedPreviewSource(item);
    if (equipmentModelId === EQUIPMENT_MODEL_ID.forgedPickaxe && forgeSource) {
      canvas.dataset.forgePreviewState = "loading";
      void upgradeForgedItemPreview(canvas, ctx, size, forgeSource, item.designHash, options);
    }
    return canvas;
  }
  if (item.kind === "smelted_material") {
    const materialId = String(item.materialId || "").trim();
    if (hasSmeltingMaterialPreviewModel(materialId)) {
      const mesh = createSmeltingMaterialPreviewMesh({ materialId });
      const renderVoxelYaw = (yaw = 0) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, size, size);
        drawVoxelPreviewMesh(ctx, size, mesh, yaw, options);
      };
      renderVoxelYaw(options.yaw);
      Object.defineProperty(canvas, "renderVoxelYaw", {
        value: renderVoxelYaw,
        configurable: true,
      });
      canvas.dataset.smeltingMaterialId = materialId;
      return canvas;
    }
    drawSmeltedMaterial(ctx, size, previewColor(item.previewColor, [176, 132, 86]));
    return canvas;
  }
  const decorationId = Math.max(0, Math.trunc(Number(item.decorationId) || 0));
  if (decorationId) {
    const mesh = createSurfaceDecorationPreviewMesh({
      decorationId,
      variantHash: item.decorationVariantHash,
      surfaceBlockId: item.decorationSurfaceBlockId,
      variant: item.decorationVariant,
      flags: item.decorationFlags,
    });
    const renderVoxelYaw = (yaw = 0) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawVoxelPreviewMesh(ctx, size, mesh, yaw, options);
    };
    renderVoxelYaw(options.yaw);
    Object.defineProperty(canvas, "renderVoxelYaw", {
      value: renderVoxelYaw,
      configurable: true,
    });
    canvas.dataset.surfaceDecorationId = String(decorationId);
    return canvas;
  }
  const blockId = Number.isFinite(item.blockId) ? item.blockId : null;
  const resourceId = Number.isFinite(item.resourceId) ? item.resourceId : blockId !== null ? blockDef(blockId).resourceId : RESOURCE_ID.stone;
  if (blockId !== null && hasResourceDropPreviewModel(blockId)) {
    const mesh = createResourceDropPreviewMesh({ blockId });
    const renderVoxelYaw = (yaw = 0) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawVoxelPreviewMesh(ctx, size, mesh, yaw, options);
    };
    renderVoxelYaw(options.yaw);
    Object.defineProperty(canvas, "renderVoxelYaw", {
      value: renderVoxelYaw,
      configurable: true,
    });
    canvas.dataset.resourceDropModelBlockId = String(blockId);
    return canvas;
  }
  if (blockId === BLOCK_ID.cactus || resourceId === RESOURCE_ID.cactus) {
    const bakedFaces = createBakedVoxelCubeFaces(BLOCK_ID.cactus, {
      textureSeed: options.textureSeed,
      textureTileSize: options.textureTileSize,
    });
    const renderVoxelYaw = (yaw = 0) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawBakedVoxelCactus(ctx, size, bakedFaces, yaw);
    };
    renderVoxelYaw(options.yaw);
    Object.defineProperty(canvas, "renderVoxelYaw", {
      value: renderVoxelYaw,
      configurable: true,
    });
    return canvas;
  }
  if (blockId !== null && blockId > BLOCK_ID.air) {
    const bakedFaces = createBakedVoxelCubeFaces(blockId, {
      textureSeed: options.textureSeed,
      textureTileSize: options.textureTileSize,
    });
    const renderVoxelYaw = (yaw = 0) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawBakedVoxelCube(ctx, size, bakedFaces, yaw);
    };
    renderVoxelYaw(options.yaw);
    Object.defineProperty(canvas, "renderVoxelYaw", {
      value: renderVoxelYaw,
      configurable: true,
    });
    return canvas;
  }
  const base = previewColor(item.previewColor, blockId !== null ? blockColor(blockId) : resourceColor(resourceId));
  drawVoxelCube(ctx, size, base);
  return canvas;
}

export function renderVoxelItemIconYaw(canvas, yaw = 0) {
  canvas?.renderVoxelYaw?.(yaw);
  return canvas;
}

export function voxelItemLabel(item = {}) {
  if (item.kind === "tool" || item.itemId === "iron_pickaxe") return "Pickaxe";
  if (item.kind === "forged" || item.itemId === "forged_item") return String(item.label || "").trim() || "Forged Tool";
  if (item.kind === "backpack" || item.itemId === "backpack") return "Backpack";
  if (item.kind === "blueprint" || item.itemId === "blueprint_tool") return "Blueprint";
  if (item.kind === "smelted_material") return item.label || titleCase(item.materialId || "Material");
  if (Number(item.decorationId) > 0) return surfaceDecorationName(item.decorationId);
  if (Number.isFinite(item.blockId)) return blockDef(item.blockId).name;
  if (Number.isFinite(item.resourceId)) return resourceName(item.resourceId);
  return "Empty";
}

async function upgradeForgedItemPreview(canvas, ctx, size, source, designHash, options) {
  try {
    const { restoreForgeRuntime } = await import("../forge/forge-runtime-cache.js");
    const expectedDesignHash = normalizedDesignHash(designHash);
    const runtime = restoreForgeRuntime(source, {
      expectedDesignHash: expectedDesignHash || null,
    });
    const mesh = forgeRuntimePreviewMesh(runtime.mesh);
    const renderVoxelYaw = (yaw = 0) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawVoxelPreviewMesh(ctx, size, mesh, yaw, options);
    };
    Object.defineProperty(canvas, "renderVoxelYaw", {
      value: renderVoxelYaw,
      configurable: true,
    });
    renderVoxelYaw(options.yaw);
    canvas.dataset.forgePreviewState = "ready";
    canvas.dataset.forgeDesignHash = String(runtime.designHash >>> 0);
  } catch {
    canvas.dataset.forgePreviewState = "fallback";
  }
}

function forgedPreviewSource(item) {
  if (typeof item?.code === "string" && item.code.trim()) return item.code.trim();
  if (item?.bytes instanceof Uint8Array && item.bytes.length) return item.bytes;
  if (Array.isArray(item?.bytes) && item.bytes.length) return item.bytes;
  return null;
}

function forgeRuntimePreviewMesh(packed) {
  if (!packed?.vertices || !packed?.indices) throw new TypeError("Forged preview mesh is unavailable.");
  const cached = forgePreviewMeshCache.get(packed);
  if (cached) return cached;
  const stride = Math.max(16, Math.trunc(Number(packed.vertexStrideBytes) || 16));
  const positionScale = Math.max(1, Number(packed.positionScale) || 1);
  const count = Math.min(
    Math.trunc(Number(packed.vertexCount) || 0),
    Math.floor(packed.vertices.byteLength / stride),
  );
  const view = new DataView(packed.vertices.buffer, packed.vertices.byteOffset, packed.vertices.byteLength);
  const vertices = Array.from({ length: count }, (_, index) => {
    const offset = index * stride;
    const layer = view.getUint8(offset + 9);
    return {
      p: [
        view.getInt16(offset, true) / positionScale,
        view.getInt16(offset + 2, true) / positionScale,
        view.getInt16(offset + 4, true) / positionScale,
      ],
      n: [view.getInt8(offset + 6), view.getInt8(offset + 7), view.getInt8(offset + 8)],
      layer: layer < 255 ? layer : -1,
      color: [
        view.getUint8(offset + 10),
        view.getUint8(offset + 11),
        view.getUint8(offset + 12),
        view.getUint8(offset + 13),
      ],
      ao: 255,
    };
  });
  const mesh = { vertices, indices: packed.indices };
  forgePreviewMeshCache.set(packed, mesh);
  return mesh;
}

function normalizedDesignHash(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) >>> 0 : 0;
}

function drawVoxelPreviewMesh(ctx, size, mesh, yawValue = 0, options = {}) {
  if (!mesh.vertices.length || !mesh.indices.length) return;
  const yaw = Number.isFinite(Number(yawValue)) ? Number(yawValue) : 0;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const sourceX = mesh.vertices.map((vertex) => Number(vertex.p?.[0]) || 0);
  const sourceZ = mesh.vertices.map((vertex) => Number(vertex.p?.[2]) || 0);
  const centerX = (Math.min(...sourceX) + Math.max(...sourceX)) * 0.5;
  const centerZ = (Math.min(...sourceZ) + Math.max(...sourceZ)) * 0.5;
  const projected = mesh.vertices.map((vertex) => {
    const x = (Number(vertex.p?.[0]) || 0) - centerX;
    const y = Number(vertex.p?.[1]) || 0;
    const z = (Number(vertex.p?.[2]) || 0) - centerZ;
    const rx = x * cosYaw + z * sinYaw;
    const rz = -x * sinYaw + z * cosYaw;
    return {
      x: (rx - rz) * 0.86,
      y: -y + (rx + rz) * 0.36,
      depth: rx + rz + y * 0.12,
      vertex,
    };
  });
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const width = Math.max(0.001, maxX - minX);
  const height = Math.max(0.001, maxY - minY);
  const scale = Math.min(size * 0.78 / width, size * 0.78 / height);
  const offsetX = size * 0.5 - (minX + maxX) * 0.5 * scale;
  const offsetY = size * 0.51 - (minY + maxY) * 0.5 * scale;
  const triangles = [];
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    const points = [
      projected[mesh.indices[index]],
      projected[mesh.indices[index + 1]],
      projected[mesh.indices[index + 2]],
    ];
    if (points.some((point) => !point)) continue;
    if (signedTriangleArea(points) >= -0.000001) continue;
    triangles.push({
      points,
      depth: (points[0].depth + points[1].depth + points[2].depth) / 3,
    });
  }
  triangles.sort((a, b) => a.depth - b.depth);
  ctx.lineJoin = "round";
  ctx.imageSmoothingEnabled = false;
  for (const triangle of triangles) {
    const points = triangle.points.map((point) => [
      point.x * scale + offsetX,
      point.y * scale + offsetY,
    ]);
    const vertices = triangle.points.map((point) => point.vertex);
    const tile = voxelPreviewTile(vertices[0], options);
    if (tile && drawTexturedTriangle(ctx, previewFaceCanvas(tile), points, vertices.map((vertex) => vertex.uv))) continue;
    fillVoxelPreviewTriangle(ctx, points, vertices[0]);
  }
}

function voxelPreviewTile(vertex, options) {
  const material = PREVIEW_MATERIAL_BY_LAYER.get(vertex?.layer);
  if (!material) return null;
  const tileSize = Math.max(8, Math.min(128, Math.trunc(Number(options.textureTileSize) || DEFAULT_ITEM_TEXTURE_TILE_SIZE)));
  const manager = previewTextureManager(options.textureSeed ?? DEFAULT_ITEM_TEXTURE_SEED, tileSize);
  const normal = normalizePreviewNormal(vertex?.n);
  return {
    faceIndex: previewFaceIndex(normal),
    textureLayer: material.textureLayer,
    tileSize,
    pixels: manager.generateMaterialTile(material),
  };
}

function drawTexturedTriangle(ctx, source, points, uvs) {
  if (!source || points.length !== 3 || uvs.some((uv) => !Array.isArray(uv) || uv.length < 2)) return false;
  const width = source.width;
  const height = source.height;
  const sourcePoints = uvs.map((uv) => [
    fractNumber(Number(uv[0]) || 0, true) * width,
    (1 - fractNumber(Number(uv[1]) || 0, true)) * height,
  ]);
  const transform = affineTriangleTransform(sourcePoints, points);
  if (!transform) return false;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  ctx.lineTo(points[1][0], points[1][1]);
  ctx.lineTo(points[2][0], points[2][1]);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0);
  ctx.restore();
  return true;
}

function affineTriangleTransform(source, target) {
  const [s0, s1, s2] = source;
  const [t0, t1, t2] = target;
  const denominator = s0[0] * (s1[1] - s2[1])
    + s1[0] * (s2[1] - s0[1])
    + s2[0] * (s0[1] - s1[1]);
  if (Math.abs(denominator) < 0.000001) return null;
  return {
    a: (t0[0] * (s1[1] - s2[1]) + t1[0] * (s2[1] - s0[1]) + t2[0] * (s0[1] - s1[1])) / denominator,
    b: (t0[1] * (s1[1] - s2[1]) + t1[1] * (s2[1] - s0[1]) + t2[1] * (s0[1] - s1[1])) / denominator,
    c: (t0[0] * (s2[0] - s1[0]) + t1[0] * (s0[0] - s2[0]) + t2[0] * (s1[0] - s0[0])) / denominator,
    d: (t0[1] * (s2[0] - s1[0]) + t1[1] * (s0[0] - s2[0]) + t2[1] * (s1[0] - s0[0])) / denominator,
    e: (t0[0] * (s1[0] * s2[1] - s2[0] * s1[1]) + t1[0] * (s2[0] * s0[1] - s0[0] * s2[1]) + t2[0] * (s0[0] * s1[1] - s1[0] * s0[1])) / denominator,
    f: (t0[1] * (s1[0] * s2[1] - s2[0] * s1[1]) + t1[1] * (s2[0] * s0[1] - s0[0] * s2[1]) + t2[1] * (s0[0] * s1[1] - s1[0] * s0[1])) / denominator,
  };
}

function fillVoxelPreviewTriangle(ctx, points, vertex) {
  const material = PREVIEW_MATERIAL_BY_LAYER.get(vertex?.layer);
  const base = Array.isArray(vertex?.color) && vertex.color.length >= 3
    ? vertex.color
    : material?.baseColor ?? [140, 160, 110, 255];
  const normal = normalizePreviewNormal(vertex?.n);
  const directional = 0.74
    + Math.max(0, normal[1]) * 0.18
    + Math.max(0, normal[0]) * 0.08
    + Math.max(0, normal[2]) * 0.05;
  const ao = 0.78 + Math.max(0, Math.min(255, Number(vertex?.ao) || 255)) / 255 * 0.22;
  const shade = directional * ao;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  ctx.lineTo(points[1][0], points[1][1]);
  ctx.lineTo(points[2][0], points[2][1]);
  ctx.closePath();
  ctx.fillStyle = `rgba(${Math.round(base[0] * shade)},${Math.round(base[1] * shade)},${Math.round(base[2] * shade)},${(base[3] ?? 255) / 255})`;
  ctx.fill();
}

function signedTriangleArea(points) {
  return (points[1].x - points[0].x) * (points[2].y - points[0].y)
    - (points[1].y - points[0].y) * (points[2].x - points[0].x);
}

function normalizePreviewNormal(value) {
  const normal = Array.isArray(value) ? value : [0, 127, 0];
  const length = Math.hypot(Number(normal[0]) || 0, Number(normal[1]) || 0, Number(normal[2]) || 0) || 1;
  return [
    (Number(normal[0]) || 0) / length,
    (Number(normal[1]) || 0) / length,
    (Number(normal[2]) || 0) / length,
  ];
}

function previewFaceIndex(normal) {
  const axis = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  if (axis[1] >= axis[0] && axis[1] >= axis[2]) return normal[1] >= 0 ? 2 : 3;
  if (axis[0] >= axis[2]) return normal[0] >= 0 ? 0 : 1;
  return normal[2] >= 0 ? 4 : 5;
}

function fractNumber(value, preserveOne = false) {
  if (preserveOne && value === 1) return 1;
  return value - Math.floor(value);
}

function drawSmeltedMaterial(ctx, size, base) {
  const cx = size * 0.5;
  const cy = size * 0.54;
  const w = size * 0.56;
  const h = size * 0.22;
  const d = size * 0.20;
  polygon(ctx, [[cx - w * 0.55, cy - h], [cx + w * 0.42, cy - h * 0.72], [cx + w * 0.62, cy], [cx - w * 0.42, cy + h * 0.12]], tint(base, 40));
  polygon(ctx, [[cx - w * 0.42, cy + h * 0.12], [cx + w * 0.62, cy], [cx + w * 0.48, cy + d], [cx - w * 0.52, cy + d * 0.88]], tint(base, -28));
  ctx.strokeStyle = "rgba(255,255,255,0.34)";
  ctx.lineWidth = Math.max(1, size / 48);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.26, cy - h * 0.48);
  ctx.lineTo(cx + w * 0.22, cy - h * 0.36);
  ctx.strokeStyle = "rgba(255,255,255,0.46)";
  ctx.stroke();
}

function drawVoxelCube(ctx, size, base) {
  const cx = size * 0.5;
  const cy = size * 0.48;
  const w = size * 0.48;
  const h = size * 0.25;
  const d = size * 0.26;
  const top = tint(base, 34);
  const left = tint(base, -18);
  const right = tint(base, -42);
  polygon(ctx, [[cx, cy - h], [cx + w, cy], [cx, cy + h], [cx - w, cy]], top);
  polygon(ctx, [[cx - w, cy], [cx, cy + h], [cx, cy + h + d], [cx - w, cy + d]], left);
  polygon(ctx, [[cx + w, cy], [cx, cy + h], [cx, cy + h + d], [cx + w, cy + d]], right);
  ctx.strokeStyle = "rgba(255,255,255,0.30)";
  ctx.lineWidth = Math.max(1, size / 48);
  ctx.stroke();
}

function createBakedVoxelCubeFaces(blockId, options) {
  return {
    0: getBakedBlockFaceTile(blockId, 0, options),
    1: getBakedBlockFaceTile(blockId, 1, options),
    2: getBakedBlockFaceTile(blockId, 2, options),
    4: getBakedBlockFaceTile(blockId, 4, options),
    5: getBakedBlockFaceTile(blockId, 5, options),
  };
}

function drawBakedVoxelCube(ctx, size, faces, yawValue = 0) {
  const cx = size * 0.5;
  const cy = size * 0.365;
  const w = size * 0.41;
  const h = size * 0.205;
  const d = size * 0.405;
  const yaw = Number.isFinite(Number(yawValue)) ? Number(yawValue) : 0;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const project = (x, z, bottom = false) => {
    const rotatedX = x * cosYaw + z * sinYaw;
    const rotatedZ = -x * sinYaw + z * cosYaw;
    return [
      cx + (rotatedX - rotatedZ) * w,
      cy + (rotatedX + rotatedZ) * h + (bottom ? d : 0),
    ];
  };
  ctx.imageSmoothingEnabled = false;
  for (const face of PREVIEW_CUBE_SIDE_FACES) {
    const rotatedNormalX = face.normalX * cosYaw + face.normalZ * sinYaw;
    const rotatedNormalZ = -face.normalX * sinYaw + face.normalZ * cosYaw;
    if (rotatedNormalX + rotatedNormalZ <= 0.00001) continue;
    const topStart = project(face.start[0], face.start[1]);
    const topEnd = project(face.end[0], face.end[1]);
    drawBakedFace(ctx, faces[face.faceIndex], [
      topStart,
      topEnd,
      project(face.end[0], face.end[1], true),
      project(face.start[0], face.start[1], true),
    ]);
  }
  drawBakedFace(ctx, faces[2], [
    project(-0.5, -0.5),
    project(0.5, -0.5),
    project(0.5, 0.5),
    project(-0.5, 0.5),
  ]);
}

function drawBakedVoxelCactus(ctx, size, faces, yawValue = 0) {
  const yaw = Number.isFinite(Number(yawValue)) ? Number(yawValue) : 0;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const fitScale = Math.min(1, 1.32 / Math.max(1, CACTUS_MODEL_MAX_Y));
  const project = ([x, y, z]) => {
    const rotatedX = x * cosYaw + z * sinYaw;
    const rotatedZ = -x * sinYaw + z * cosYaw;
    return [
      size * 0.5 + (rotatedX - rotatedZ) * size * 0.43 * fitScale,
      size * 0.88 + (rotatedX + rotatedZ) * size * 0.215 * fitScale - y * size * 0.57 * fitScale,
    ];
  };
  const visibleFaces = [];
  for (const part of CACTUS_MODEL_PARTS) {
    const x0 = part.x - part.sx * 0.5;
    const x1 = part.x + part.sx * 0.5;
    const y0 = part.y - part.sy * 0.5;
    const y1 = part.y + part.sy * 0.5;
    const z0 = part.z - part.sz * 0.5;
    const z1 = part.z + part.sz * 0.5;
    const partFaces = [
      { faceIndex: 0, normal: [1, 0, 0], points: [[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]] },
      { faceIndex: 1, normal: [-1, 0, 0], points: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]] },
      { faceIndex: 2, normal: [0, 1, 0], points: [[x0, y1, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1]] },
      { faceIndex: 4, normal: [0, 0, 1], points: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]] },
      { faceIndex: 5, normal: [0, 0, -1], points: [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]] },
    ];
    for (const face of partFaces) {
      if (face.normal[1] === 0) {
        const normalX = face.normal[0] * cosYaw + face.normal[2] * sinYaw;
        const normalZ = -face.normal[0] * sinYaw + face.normal[2] * cosYaw;
        if (normalX + normalZ <= 0.00001) continue;
      }
      const depth = face.points.reduce((sum, point) => {
        const rotatedX = point[0] * cosYaw + point[2] * sinYaw;
        const rotatedZ = -point[0] * sinYaw + point[2] * cosYaw;
        return sum + rotatedX + rotatedZ + point[1] * 1.35;
      }, 0) / face.points.length;
      visibleFaces.push({ faceIndex: face.faceIndex, points: face.points.map(project), depth });
    }
  }
  visibleFaces.sort((a, b) => a.depth - b.depth);
  ctx.imageSmoothingEnabled = false;
  for (const face of visibleFaces) drawBakedFace(ctx, faces[face.faceIndex], face.points);
}

function drawBakedFace(ctx, tile, points) {
  const source = previewFaceCanvas(tile);
  const [origin, xAxis, , yAxis] = points;
  const size = tile.tileSize;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index][0], points[index][1]);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(
    (xAxis[0] - origin[0]) / size,
    (xAxis[1] - origin[1]) / size,
    (yAxis[0] - origin[0]) / size,
    (yAxis[1] - origin[1]) / size,
    origin[0],
    origin[1],
  );
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, size, size);
  ctx.restore();
}

function previewFaceCanvas(tile) {
  let faces = previewFaceCanvasCache.get(tile.pixels);
  if (!faces) {
    faces = new Map();
    previewFaceCanvasCache.set(tile.pixels, faces);
  }
  const cacheKey = tile.faceIndex;
  const cached = faces.get(cacheKey);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = tile.tileSize;
  canvas.height = tile.tileSize;
  const context = canvas.getContext("2d");
  if (context) {
    const image = context.createImageData(tile.tileSize, tile.tileSize);
    image.data.set(worldLitPreviewPixels(tile));
    context.putImageData(image, 0, 0);
  }
  faces.set(cacheKey, canvas);
  return canvas;
}

function worldLitPreviewPixels(tile) {
  const face = PREVIEW_FACE_LIGHTING[tile.faceIndex] || PREVIEW_FACE_LIGHTING[2];
  const lighting = DEFAULT_WORLD_LIGHTING;
  const sun = Math.max(dot3(face.normal, lighting.sunDirection), 0);
  const toonSun = mixNumber(sun, smoothstepNumber(0.10, 0.82, sun), 0.55);
  const hemiUp = face.normal[1] * 0.5 + 0.5;
  const light = [0, 1, 2].map((channel) => {
    const ambient = lighting.skyLightColor[channel] * lighting.ambientStrength;
    const hemisphere = mixNumber(lighting.groundLightColor[channel], lighting.skyLightColor[channel], hemiUp) * lighting.hemiStrength;
    const direct = lighting.sunColor[channel] * toonSun * lighting.sunStrength;
    return ambient + hemisphere + direct;
  });
  const ao = Math.max(0, Math.min(1, face.shade / 255));
  const isWater = tile.textureLayer >= 17 && tile.textureLayer <= 19;
  const aoFactor = isWater ? mixNumber(0.78, 1, ao) : mixNumber(0.64, 1, ao);
  const topFace = smoothstepNumber(0.42, 0.88, face.normal[1]);
  const sideFace = 1 - smoothstepNumber(0.35, 0.82, Math.abs(face.normal[1]));
  const sideShade = sideFace * (0.10 + (1 - toonSun) * 0.42);
  const sideFactor = mixNumber(1, 0.925, sideShade);
  const size = tile.tileSize;
  const output = new Uint8ClampedArray(tile.pixels.length);
  for (let sourceY = 0; sourceY < size; sourceY += 1) {
    const targetY = size - 1 - sourceY;
    for (let x = 0; x < size; x += 1) {
      const sourceIndex = (x + sourceY * size) * 4;
      const targetIndex = (x + targetY * size) * 4;
      const color = [0, 1, 2].map((channel) => {
        const lit = (tile.pixels[sourceIndex + channel] / 255) * light[channel] * aoFactor;
        const lifted = (lit + [0.040, 0.035, 0.012][channel] * topFace) * sideFactor * lighting.exposure;
        return lifted;
      });
      const graded = animeGradeRgb(color);
      output[targetIndex] = Math.round(Math.max(0, Math.min(1, graded[0])) * 255);
      output[targetIndex + 1] = Math.round(Math.max(0, Math.min(1, graded[1])) * 255);
      output[targetIndex + 2] = Math.round(Math.max(0, Math.min(1, graded[2])) * 255);
      const alpha = tile.pixels[sourceIndex + 3];
      output[targetIndex + 3] = alpha < 21 ? 0 : alpha;
    }
  }
  return output;
}

function previewTextureManager(textureSeed, tileSize) {
  const cacheKey = `${tileSize}:${previewSeedKey(textureSeed)}`;
  let manager = previewTextureManagers.get(cacheKey);
  if (manager) return manager;
  manager = new TextureArrayManager(null, { tileSize, seed: textureSeed });
  previewTextureManagers.set(cacheKey, manager);
  if (previewTextureManagers.size > PREVIEW_TEXTURE_MANAGER_LIMIT) {
    previewTextureManagers.delete(previewTextureManagers.keys().next().value);
  }
  return manager;
}

function previewSeedKey(seed) {
  if (seed instanceof Uint8Array || Array.isArray(seed)) return Array.from(seed).join(",");
  return String(seed ?? DEFAULT_ITEM_TEXTURE_SEED);
}

function animeGradeRgb(color) {
  const luma = color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
  return color.map((channel, index) => Math.min((mixNumber(luma, channel, 0.98) * 1.018) + [0.016, 0.017, 0.012][index], 1.07));
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mixNumber(a, b, t) {
  return a + (b - a) * t;
}

function smoothstepNumber(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(0.000001, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function previewColor(value, fallback) {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return value.slice(0, 3).map((entry) => Math.max(0, Math.min(255, Math.trunc(Number(entry) || 0))));
}

function titleCase(value) {
  return String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function drawEquipmentModel(ctx, size, modelId, parts) {
  if (!parts.length) return;
  const basis = equipmentPreviewBasis(modelId);
  const light = normalize3([0.35, 0.82, 0.45]);
  const faces = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const part of parts) {
    for (const face of EQUIPMENT_CUBOID_FACES) {
      if (dot3(face.normal, basis.forward) <= 0.0001) continue;
      const points3d = face.corners.map((corner) => [
        part.center[0] + corner[0] * part.size[0] * 0.5,
        part.center[1] + corner[1] * part.size[1] * 0.5,
        part.center[2] + corner[2] * part.size[2] * 0.5,
      ]);
      const points = points3d.map((point) => [dot3(point, basis.right), dot3(point, basis.up)]);
      for (const point of points) {
        minX = Math.min(minX, point[0]);
        minY = Math.min(minY, point[1]);
        maxX = Math.max(maxX, point[0]);
        maxY = Math.max(maxY, point[1]);
      }
      faces.push({
        points,
        depth: points3d.reduce((sum, point) => sum + dot3(point, basis.forward), 0) / points3d.length,
        color: part.color,
        shade: 0.70 + Math.max(0, dot3(face.normal, light)) * 0.30,
      });
    }
  }
  if (!faces.length || !Number.isFinite(minX)) return;
  const spanX = Math.max(0.001, maxX - minX);
  const spanY = Math.max(0.001, maxY - minY);
  const fit = modelId === EQUIPMENT_MODEL_ID.backpack ? 0.78 : 0.88;
  const scale = size * fit / Math.max(spanX, spanY);
  const offsetX = size * 0.5 - (minX + maxX) * 0.5 * scale;
  const offsetY = size * 0.5 - (minY + maxY) * 0.5 * scale;
  faces.sort((left, right) => left.depth - right.depth);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(0.65, size / 80);
  for (const face of faces) {
    const points = face.points.map((point) => [offsetX + point[0] * scale, offsetY + point[1] * scale]);
    polygon(ctx, points, equipmentFaceColor(face.color, face.shade));
    ctx.strokeStyle = "rgba(28, 30, 29, 0.24)";
    ctx.stroke();
  }
  ctx.restore();
}

function equipmentPreviewBasis(modelId) {
  const right = modelId === EQUIPMENT_MODEL_ID.backpack
    ? normalize3([0.88, 0, 0.48])
    : normalize3([0, 0.78, 0.52]);
  const up = modelId === EQUIPMENT_MODEL_ID.backpack
    ? normalize3([0.08, -0.95, 0.22])
    : normalize3([-0.18, -0.25, 0.72]);
  return { right, up, forward: normalize3(cross3(up, right)) };
}

function equipmentFaceColor(color, shade) {
  const channels = [0, 1, 2].map((index) => Math.max(0, Math.min(255, Math.round((color[index] ?? 1) * shade * 255))));
  return `rgba(${channels[0]},${channels[1]},${channels[2]},${Math.max(0, Math.min(1, color[3] ?? 1))})`;
}

function normalize3(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return vector.map((value) => value / length);
}

function cross3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function polygon(ctx, points, color) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function tint(rgb, amount) {
  return `rgb(${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel + amount)))).join(",")})`;
}
