import { TextureArrayManager } from "./texture-array-manager.js";
import { smeltingMaterialSurfaceProfile } from "./smelting-material-models.js";

export const FORGE_MATERIAL_SURFACE_SCHEMA = 2;
export const FORGE_MATERIAL_SURFACE_TILE_SIZE = 32;
export const FORGE_MATERIAL_SURFACE_LAYER_NONE = 255;

const FALLBACK_ELEMENT_COLOR = "#8eeeff";
const SURFACE_TILE_CACHE_LIMIT = 256;
const surfaceTileCache = new Map();
const NO_EMISSIVE = Object.freeze([0, 0, 0]);

const ELEMENT_COLORS = Object.freeze({
  Al: "#9fc3d9",
  C: "#2c2c32",
  Ca: "#d7d0b2",
  Cl: "#b5f46c",
  Cu: "#d88748",
  Fe: "#a66b5b",
  H: "#d7f7ff",
  K: "#b981ff",
  Mg: "#d3e4c7",
  Mn: "#b48a92",
  N: "#72a8ff",
  Na: "#f2d36b",
  Ni: "#9bbf9f",
  O: "#78d8ff",
  S: "#f0da55",
  Si: "#c8b07a",
});

const CLASS_SURFACE_PROFILES = Object.freeze({
  alloy: Object.freeze({ surfaceStyle: "deepStone", roughness: 0.48 }),
  carbon: Object.freeze({ surfaceStyle: "coal", roughness: 0.9 }),
  ceramic: Object.freeze({ surfaceStyle: "clay", roughness: 0.86 }),
  chemical: Object.freeze({ surfaceStyle: "saltFlat", roughness: 0.72 }),
  composite: Object.freeze({ surfaceStyle: "trunk", roughness: 0.82 }),
  crystal: Object.freeze({ surfaceStyle: "ice", roughness: 0.22 }),
  fiber: Object.freeze({ surfaceStyle: "trunk", roughness: 0.94 }),
  glass: Object.freeze({ surfaceStyle: "ice", roughness: 0.18 }),
  metal: Object.freeze({ surfaceStyle: "stone", roughness: 0.62 }),
  polymer: Object.freeze({ surfaceStyle: "mud", roughness: 0.58 }),
});

const DEFAULT_CLASS_SURFACE_PROFILE = Object.freeze({ surfaceStyle: "stone", roughness: 0.78 });

/**
 * Creates an immutable lookup view over the authoritative forge recipes.
 * Recipe identity remains authoritative while a matching Chunk.js visual
 * profile supplies the shared palette and finish.
 */
export function createForgeMaterialCatalog(recipes = []) {
  const source = Array.isArray(recipes) ? recipes : recipes?.materials ?? recipes?.recipes ?? [];
  const ruleSet = Array.isArray(recipes) ? "" : String(recipes?.ruleSet ?? "").trim();
  const byId = new Map();
  for (const candidate of source) {
    const recipe = normalizeForgeMaterialRecipe(candidate);
    if (recipe && !byId.has(recipe.id)) byId.set(recipe.id, recipe);
  }
  const materialIds = Object.freeze([...byId.keys()]);
  const normalizedRecipes = Object.freeze(materialIds.map((materialId) => byId.get(materialId)));
  const signature = catalogSurfaceSignature(ruleSet, normalizedRecipes);
  return Object.freeze({
    ruleSet,
    materialIds,
    recipes: normalizedRecipes,
    signature,
    get(materialId) {
      return byId.get(normalizeMaterialId(materialId)) ?? null;
    },
  });
}

export function resolveForgeMaterialRecipe(materialOrId, catalog = null) {
  if (isForgeMaterialRecipe(materialOrId)) return normalizeForgeMaterialRecipe(materialOrId);
  const materialId = normalizeMaterialId(materialOrId);
  if (!materialId || !catalog) return null;
  if (typeof catalog.get === "function") {
    const candidate = catalog.get(materialId);
    return isForgeMaterialRecipe(candidate) ? normalizeForgeMaterialRecipe(candidate) : null;
  }
  if (catalog instanceof Map) {
    const candidate = catalog.get(materialId);
    return isForgeMaterialRecipe(candidate) ? normalizeForgeMaterialRecipe(candidate) : null;
  }
  const list = Array.isArray(catalog) ? catalog : catalog.materials ?? catalog.recipes;
  if (Array.isArray(list)) {
    const candidate = list.find((recipe) => normalizeMaterialId(recipe?.id) === materialId);
    return isForgeMaterialRecipe(candidate) ? normalizeForgeMaterialRecipe(candidate) : null;
  }
  const candidate = catalog[materialId];
  return isForgeMaterialRecipe(candidate) ? normalizeForgeMaterialRecipe(candidate) : null;
}

export function elementColor(symbol) {
  return ELEMENT_COLORS[String(symbol ?? "").trim()] ?? FALLBACK_ELEMENT_COLOR;
}

export const forgeMaterialElementColor = elementColor;

export function forgeMaterialClassSurfaceProfile(className) {
  return CLASS_SURFACE_PROFILES[String(className ?? "").trim().toLowerCase()]
    ?? DEFAULT_CLASS_SURFACE_PROFILE;
}

export function compositionRangeMidpoint(range) {
  const values = String(range ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (!values.length) return 0;
  if (values.length === 1) return values[0];
  return (values[0] + values[1]) / 2;
}

export const forgeMaterialCompositionRangeMidpoint = compositionRangeMidpoint;

export function forgeMaterialBaseColor(materialOrId, options = {}) {
  const recipe = resolveForgeMaterialRecipe(materialOrId, options.catalog);
  if (!recipe) return null;
  const visualProfile = smeltingMaterialSurfaceProfile(recipe.id);
  if (visualProfile?.baseColor) return opaqueColor(visualProfile.baseColor);
  let totalWeight = 0;
  const mixed = [0, 0, 0];
  for (const [symbol, range] of recipe.composition) {
    const weight = compositionRangeMidpoint(range);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const color = hexToRgb(elementColor(symbol));
    mixed[0] += color[0] * weight;
    mixed[1] += color[1] * weight;
    mixed[2] += color[2] * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return Object.freeze([...hexToRgb(FALLBACK_ELEMENT_COLOR), 255]);
  return Object.freeze([
    clampByte(mixed[0] / totalWeight),
    clampByte(mixed[1] / totalWeight),
    clampByte(mixed[2] / totalWeight),
    255,
  ]);
}

export function activeForgeMaterialSurfaceSet(materialIds = [], options = {}) {
  const requestedRecipes = Array.from(materialIds ?? [], (materialOrId) => (
    resolveForgeMaterialRecipe(materialOrId, options.catalog)
  ));
  const uniqueById = new Map();
  for (const recipe of requestedRecipes) {
    if (recipe && !uniqueById.has(recipe.id)) uniqueById.set(recipe.id, recipe);
  }
  const activeIds = [...uniqueById.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const recipes = Object.freeze(activeIds.map((materialId) => uniqueById.get(materialId)));
  const layerByMaterialId = new Map(activeIds.map((materialId, textureLayer) => [materialId, textureLayer]));
  const componentLayers = Object.freeze(requestedRecipes.map((recipe) => (
    recipe ? layerByMaterialId.get(recipe.id) : FORGE_MATERIAL_SURFACE_LAYER_NONE
  )));
  return Object.freeze({
    materialIds: Object.freeze(activeIds),
    recipes,
    componentLayers,
    layerByMaterialId,
    signature: catalogSurfaceSignature(catalogRuleSet(options.catalog, options.ruleSet), recipes),
  });
}

export function forgeMaterialTextureMaterials(materialIds = [], options = {}) {
  const active = activeForgeMaterialSurfaceSet(materialIds, options);
  return Object.freeze(active.recipes.map((recipe, textureLayer) => {
    const classProfile = forgeMaterialClassSurfaceProfile(recipe.class);
    const visualProfile = smeltingMaterialSurfaceProfile(recipe.id);
    return Object.freeze({
      materialId: 0x4600 + textureLayer,
      sourceMaterialId: recipe.id,
      className: recipe.class,
      textureLayer,
      baseColor: forgeMaterialBaseColor(recipe),
      shaderType: "opaque",
      style: "forge",
      surfaceStyle: classProfile.surfaceStyle,
      roughness: visualProfile?.finish.roughness ?? classProfile.roughness,
      translucency: visualProfile?.finish.translucency ?? 0,
      emissive: visualProfile?.finish.emissive ?? NO_EMISSIVE,
      visualRevision: visualProfile?.visualRevision ?? "",
      visualCacheSignature: visualProfile?.cacheSignature ?? "",
    });
  }));
}

export function bakeForgeMaterialSurfaceTile(materialOrId, options = {}) {
  const recipe = resolveForgeMaterialRecipe(materialOrId, options.catalog);
  if (!recipe) return null;
  const tileSize = normalizeTileSize(options.tileSize);
  const seedText = materialPatternSeed(recipe.id, options.seed);
  const ruleSet = catalogRuleSet(options.catalog, options.ruleSet);
  const cacheKey = `${FORGE_MATERIAL_SURFACE_SCHEMA}:${tileSize}:${seedText}:${ruleSet}:${recipeSurfaceSignature(recipe)}`;
  const cached = surfaceTileCache.get(cacheKey);
  if (cached) return cached;
  const pixels = bakeRecipeSurface(recipe, tileSize, seedText);
  surfaceTileCache.set(cacheKey, pixels);
  if (surfaceTileCache.size > SURFACE_TILE_CACHE_LIMIT) {
    surfaceTileCache.delete(surfaceTileCache.keys().next().value);
  }
  return pixels;
}

export function bakeForgeMaterialSurfaceTiles(options = {}) {
  const active = activeForgeMaterialSurfaceSet(options.materialIds, options);
  return active.recipes.map((recipe) => bakeForgeMaterialSurfaceTile(recipe, options));
}

export function createForgeMaterialTextureArray(gl, options = {}) {
  const tileSize = normalizeTileSize(options.tileSize);
  const active = activeForgeMaterialSurfaceSet(options.materialIds, options);
  if (!active.recipes.length) return emptyTextureArray(active, tileSize);
  const materials = forgeMaterialTextureMaterials(active.recipes);
  const manager = new TextureArrayManager(gl, {
    tileSize,
    seed: options.seed ?? "",
    materials,
  });
  manager.createTextureArray(active.recipes.map((recipe) => (
    bakeForgeMaterialSurfaceTile(recipe, {
      tileSize,
      seed: options.seed,
      ruleSet: catalogRuleSet(options.catalog, options.ruleSet),
    })
  )));
  return textureArrayResult(active, tileSize, manager);
}

export function renderForgeMaterialSurfaceCanvas(canvas, materialOrId, options = {}) {
  const recipe = resolveForgeMaterialRecipe(materialOrId, options.catalog);
  const context = canvas?.getContext?.("2d");
  if (!recipe || !context) return false;
  const tileSize = normalizeTileSize(options.tileSize);
  const pixels = bakeForgeMaterialSurfaceTile(recipe, {
    tileSize,
    seed: options.seed,
    ruleSet: catalogRuleSet(options.catalog, options.ruleSet),
  });
  canvas.width = tileSize;
  canvas.height = tileSize;
  const image = context.createImageData(tileSize, tileSize);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  if (canvas.dataset) canvas.dataset.forgeMaterialSurface = recipe.id;
  return true;
}

function bakeRecipeSurface(recipe, size, seedText) {
  const visualProfile = smeltingMaterialSurfaceProfile(recipe.id);
  const baseColor = forgeMaterialBaseColor(recipe);
  const pixels = new Uint8Array(size * size * 4);
  fillOpaque(pixels, baseColor);
  const random = seededRandom(seedText);
  const accents = materialSurfaceAccents(recipe, visualProfile);
  const strokeCoverage = new Float32Array(size * size);
  for (let index = 0; index < accents.length; index += 1) {
    const { color, weight } = accents[index];
    const patchCount = Math.max(2, Math.round(2 + weight * 7));
    for (let patchIndex = 0; patchIndex < patchCount; patchIndex += 1) {
      paintRadialPatch(pixels, size, {
        x: random() * size,
        y: random() * size,
        radius: size * (0.08 + random() * 0.18 + weight * 0.08),
        color,
        centerAlpha: 0.34 + weight * 0.22,
        middleAlpha: 0.11 + weight * 0.12,
      });
    }
    for (let strokeIndex = 0; strokeIndex < 2; strokeIndex += 1) {
      const startX = random() * size;
      const startY = random() * size;
      paintBezierStroke(pixels, size, {
        startX,
        startY,
        control1X: startX + (random() - 0.5) * size * (70 / 96),
        control1Y: startY + (random() - 0.5) * size * (70 / 96),
        control2X: random() * size,
        control2Y: random() * size,
        endX: random() * size,
        endY: random() * size,
        width: Math.max(0.75, (2.2 + weight * 4) * size / 96),
        color,
        alpha: 0.12 + weight * 0.14,
      }, strokeCoverage);
    }
    if (index === 0) blendSolid(pixels, color, 0.08 + weight * 0.08);
  }
  applyClassFinish(pixels, size, recipe.class, seedText, visualProfile?.finish);
  applyCanonicalFinish(pixels, visualProfile?.finish);
  paintLightSpecks(pixels, size, random);
  return pixels;
}

function materialSurfaceAccents(recipe, visualProfile) {
  if (visualProfile?.palette?.length > 1) {
    return visualProfile.palette.slice(1, 8).map((sourceColor, index) => {
      const alpha = Number(sourceColor[3]);
      const opacity = Number.isFinite(alpha) ? clamp(alpha / 255, 0, 1) : 1;
      return {
        color: sourceColor.slice(0, 3),
        weight: clamp((0.52 - index * 0.055) * (0.55 + opacity * 0.45), 0.08, 0.52),
      };
    });
  }
  return recipe.composition.slice(0, 7).map(([symbol, range]) => ({
    color: hexToRgb(elementColor(symbol)),
    weight: clamp(compositionRangeMidpoint(range) / 100, 0.05, 0.9),
  }));
}

function paintRadialPatch(pixels, size, patch) {
  const minX = Math.max(0, Math.floor(patch.x - patch.radius));
  const maxX = Math.min(size - 1, Math.ceil(patch.x + patch.radius));
  const minY = Math.max(0, Math.floor(patch.y - patch.radius));
  const maxY = Math.min(size - 1, Math.ceil(patch.y + patch.radius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - patch.x, y + 0.5 - patch.y) / patch.radius;
      if (distance >= 1) continue;
      let alpha;
      if (distance <= 0.08) {
        alpha = patch.centerAlpha;
      } else if (distance <= 0.62) {
        alpha = lerp(patch.centerAlpha, patch.middleAlpha, (distance - 0.08) / 0.54);
      } else {
        alpha = lerp(patch.middleAlpha, 0, (distance - 0.62) / 0.38);
      }
      blendPixel(pixels, (x + y * size) * 4, patch.color, alpha);
    }
  }
}

function paintBezierStroke(pixels, size, stroke, coverage) {
  const points = [];
  const segmentCount = Math.max(12, Math.round(size * 0.5));
  for (let segment = 0; segment <= segmentCount; segment += 1) {
    const t = segment / segmentCount;
    const inverse = 1 - t;
    points.push([
      inverse ** 3 * stroke.startX
        + 3 * inverse ** 2 * t * stroke.control1X
        + 3 * inverse * t ** 2 * stroke.control2X
        + t ** 3 * stroke.endX,
      inverse ** 3 * stroke.startY
        + 3 * inverse ** 2 * t * stroke.control1Y
        + 3 * inverse * t ** 2 * stroke.control2Y
        + t ** 3 * stroke.endY,
    ]);
  }
  const radius = stroke.width * 0.5;
  coverage.fill(0);
  for (let segment = 1; segment < points.length; segment += 1) {
    const start = points[segment - 1];
    const end = points[segment];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const steps = Math.max(1, Math.ceil(length * 1.5));
    for (let step = 0; step <= steps; step += 1) {
      const amount = step / steps;
      const pointX = lerp(start[0], end[0], amount);
      const pointY = lerp(start[1], end[1], amount);
      const minX = Math.max(0, Math.floor(pointX - radius - 1));
      const maxX = Math.min(size - 1, Math.ceil(pointX + radius + 1));
      const minY = Math.max(0, Math.floor(pointY - radius - 1));
      const maxY = Math.min(size - 1, Math.ceil(pointY + radius + 1));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const value = clamp(radius + 0.75 - Math.hypot(x + 0.5 - pointX, y + 0.5 - pointY), 0, 1);
          const cursor = x + y * size;
          if (value > coverage[cursor]) coverage[cursor] = value;
        }
      }
    }
  }
  for (let cursor = 0; cursor < coverage.length; cursor += 1) {
    if (coverage[cursor] > 0) blendPixel(pixels, cursor * 4, stroke.color, stroke.alpha * coverage[cursor]);
  }
}

function applyClassFinish(pixels, size, className, seedText, finish = null) {
  const classKey = String(className ?? "").trim().toLowerCase();
  const seed = hashText(`${seedText}:${classKey}:class-finish`);
  const classProfile = forgeMaterialClassSurfaceProfile(classKey);
  const roughness = clamp(finish?.roughness ?? classProfile.roughness, 0, 1);
  const toneScale = 0.55 + roughness * 0.65;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const hash = hashPixel(seed, x, y);
      let tone = ((hash >>> 25) & 7) - 3;
      if (classKey === "metal" || classKey === "alloy") {
        tone += (y + (seed & 3)) % 4 === 0 ? 6 : -1;
        if ((hash & 255) > 248) tone += 8;
      } else if (classKey === "fiber") {
        tone += (x + Math.floor(y / 3) + (seed & 3)) % 5 === 0 ? 7 : -2;
      } else if (classKey === "carbon") {
        tone += (hash & 255) > 205 ? -8 : -2;
      } else if (classKey === "glass" || classKey === "crystal") {
        tone += (x + y + (seed & 7)) % 9 === 0 ? 10 : 1;
      } else if (classKey === "ceramic") {
        tone += (x % 8 === 0 || y % 8 === 0) ? -4 : 1;
      } else if (classKey === "composite") {
        tone += (x % 8 === 0 || y % 8 === 0) ? -6 : 1;
      } else if (classKey === "polymer" || classKey === "chemical") {
        tone += (hash & 255) > 242 ? 7 : 0;
      }
      tone = Math.round(tone * toneScale);
      const cursor = (x + y * size) * 4;
      pixels[cursor] = clampByte(pixels[cursor] + tone);
      pixels[cursor + 1] = clampByte(pixels[cursor + 1] + tone);
      pixels[cursor + 2] = clampByte(pixels[cursor + 2] + tone);
      pixels[cursor + 3] = 255;
    }
  }
}

function applyCanonicalFinish(pixels, finish) {
  if (!finish) return;
  const translucencyLift = clamp(finish.translucency, 0, 1) * 0.035;
  const emissive = Array.isArray(finish.emissive) ? finish.emissive : [0, 0, 0];
  for (let cursor = 0; cursor < pixels.length; cursor += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[cursor + channel] = clampByte(
        lerp(pixels[cursor + channel], 255, translucencyLift)
          + clamp(emissive[channel], 0, 1) * 24,
      );
    }
    pixels[cursor + 3] = 255;
  }
}

function paintLightSpecks(pixels, size, random) {
  const speckCount = Math.max(8, Math.round(90 * (size / 96) ** 2));
  for (let index = 0; index < speckCount; index += 1) {
    const alpha = 0.035 + random() * 0.045;
    const x = Math.min(size - 1, Math.floor(random() * size));
    const y = Math.min(size - 1, Math.floor(random() * size));
    const width = Math.max(1, Math.ceil((1 + random() * 2) * size / 96));
    const height = Math.max(1, Math.ceil((1 + random() * 2) * size / 96));
    for (let offsetY = 0; offsetY < height && y + offsetY < size; offsetY += 1) {
      for (let offsetX = 0; offsetX < width && x + offsetX < size; offsetX += 1) {
        blendPixel(pixels, (x + offsetX + (y + offsetY) * size) * 4, [255, 255, 255], alpha);
      }
    }
  }
}

function fillOpaque(pixels, color) {
  for (let cursor = 0; cursor < pixels.length; cursor += 4) {
    pixels[cursor] = color[0];
    pixels[cursor + 1] = color[1];
    pixels[cursor + 2] = color[2];
    pixels[cursor + 3] = 255;
  }
}

function blendSolid(pixels, color, alpha) {
  for (let cursor = 0; cursor < pixels.length; cursor += 4) blendPixel(pixels, cursor, color, alpha);
}

function blendPixel(pixels, cursor, color, alpha) {
  const amount = clamp(alpha, 0, 1);
  pixels[cursor] = clampByte(lerp(pixels[cursor], color[0], amount));
  pixels[cursor + 1] = clampByte(lerp(pixels[cursor + 1], color[1], amount));
  pixels[cursor + 2] = clampByte(lerp(pixels[cursor + 2], color[2], amount));
  pixels[cursor + 3] = 255;
}

function textureArrayResult(active, tileSize, manager) {
  return Object.freeze({
    ...active,
    texture: manager.texture,
    layerCount: active.recipes.length,
    tileSize,
    manager,
    bind(unit = 0) { manager.bind(unit); },
    dispose() { manager.dispose(); },
  });
}

function emptyTextureArray(active, tileSize) {
  return Object.freeze({
    ...active,
    texture: null,
    layerCount: 0,
    tileSize,
    manager: null,
    bind() {},
    dispose() {},
  });
}

function normalizeForgeMaterialRecipe(recipe) {
  if (!isForgeMaterialRecipe(recipe)) return null;
  return Object.freeze({
    id: normalizeMaterialId(recipe.id),
    class: String(recipe.class).trim(),
    composition: Object.freeze(recipe.composition.map(([symbol, range]) => Object.freeze([
      String(symbol ?? "").trim(),
      String(range ?? "").trim(),
    ]))),
  });
}

function isForgeMaterialRecipe(recipe) {
  return recipe !== null
    && typeof recipe === "object"
    && Boolean(normalizeMaterialId(recipe.id))
    && typeof recipe.class === "string"
    && Boolean(recipe.class.trim())
    && Array.isArray(recipe.composition)
    && recipe.composition.every((entry) => Array.isArray(entry) && entry.length >= 2);
}

function recipeSurfaceSignature(recipe) {
  return JSON.stringify([
    recipe.id,
    recipe.class,
    recipe.composition,
    smeltingMaterialSurfaceProfile(recipe.id)?.cacheSignature ?? "composition-fallback",
  ]);
}

function catalogSurfaceSignature(ruleSet, recipes) {
  return JSON.stringify([
    String(ruleSet ?? ""),
    recipes.map((recipe) => [
      recipe.id,
      recipe.class,
      recipe.composition,
      smeltingMaterialSurfaceProfile(recipe.id)?.cacheSignature ?? "composition-fallback",
    ]),
  ]);
}

function catalogRuleSet(catalog, explicitRuleSet = "") {
  return String(explicitRuleSet || catalog?.ruleSet || "").trim();
}

function materialPatternSeed(materialId, salt) {
  const base = `${materialId}:material-pattern`;
  const suffix = String(salt ?? "").trim();
  return suffix ? `${base}:${suffix}` : base;
}

function seededRandom(seedText) {
  let state = hashText(seedText);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashText(value) {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashPixel(seed, x, y) {
  let value = seed ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca77);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function hexToRgb(hex) {
  const value = Number.parseInt(String(hex).replace("#", ""), 16);
  if (!Number.isFinite(value)) return [142, 238, 255];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function opaqueColor(color) {
  return Object.freeze([
    clampByte(color?.[0]),
    clampByte(color?.[1]),
    clampByte(color?.[2]),
    255,
  ]);
}

function normalizeMaterialId(value) {
  return String(value ?? "").trim();
}

function normalizeTileSize(value) {
  return Math.max(8, Math.min(128, Math.trunc(Number(value) || FORGE_MATERIAL_SURFACE_TILE_SIZE)));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}
