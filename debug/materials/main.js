import { MATERIAL_ID, RESOURCE_ID, blockDefs } from "../../world/block-registry.js";
import { materialList } from "../../world/material-registry.js";
import { buildDebugVisualModelAssets } from "../../chunk/chunk-mesher.js";
import { buildCloudDebugAsset } from "../../renderer/cloud-layer.js";
import { createAvatarMeshFromNcm } from "../../renderer/avatar-mesh.js";
import { TextureArrayManager } from "../../renderer/texture-array-manager.js";

const STORAGE_KEY = "nicechunk.chunkjs.material-bake-overrides.v1";
const DEFAULT_SEED = "nicechunk-mainnet-001";
const STYLE_OPTIONS = [
  "generic",
  ...new Set(materialList().map((material) => material.style).filter(Boolean)),
  "soil",
  "basalt",
  "ash",
];
const ASSET_DESCRIPTION_OVERRIDES = Object.freeze({
  cloud_layer: "Clouds use a merged mesh in fixed sky coordinates. They are visual only and do not participate in collision or gameplay calculations.",
  grass_tuft: "A low-density micro voxel grass tuft merged into the visual chunk without collision.",
  micro_sprout_patch: "A lightweight grass accent using a few tiny voxel blades to enrich ground detail.",
  micro_flower_sprig: "A tiny voxel flower accent sparsely distributed across grass surfaces.",
  dry_grass_tuft: "A micro voxel dry-grass tuft for sand and dry-soil visual layers.",
  micro_cactus: "The exact five-part canonical cactus resource model used by runtime chunk rendering.",
  voxel_bush: "A volumetric voxel bush assembled from a small set of leaf clusters without visual-layer collision.",
  voxel_snow_bush: "An evergreen voxel bush with separate snow caps that preserve a readable winter silhouette.",
  voxel_dead_bush: "A volumetric dead-bush and dry-branch voxel model replacing the old flat plant.",
  voxel_thorn: "A dry forked shrub with pointed thorn offshoots instead of a generic vegetation cube.",
  voxel_reed_cluster: "A waterside voxel reed cluster assembled from multiple slender stalks and seed heads.",
  swamp_grass_tuft: "Low voxel swamp grass used by wetland and muddy-ground resource rules.",
  white_flower_clump: "Voxel stems, centers, and petals generated at low density and uploaded with grass geometry.",
  warm_flower_clump: "A warm-toned voxel flower assembled from existing sand and snow layers.",
  red_flower_clump: "A red voxel flower sharing the same three-view blueprint as the white, yellow, blue, and pink variants.",
  blue_flower_clump: "A blue voxel flower merged into the visual chunk at low density.",
  pink_flower_clump: "A pink voxel flower merged into the visual chunk at low density.",
  micro_pebble_cluster: "Low voxel pebbles and soil fragments that add visual breakup without collision.",
  micro_moss_patch: "A ground-hugging voxel moss patch for moist resource zones without visual-layer collision.",
  voxel_lichen: "Overlapping irregular lichen patches that hug rock and snow surfaces without becoming a block slab.",
  voxel_vine: "Bent segmented vine stems with side leaves, merged into the visual chunk as low-cost geometry.",
  micro_mushroom: "A low-probability voxel mushroom for wetlands and forests without visual-layer collision.",
  voxel_glow_mycelium: "A two-cap luminous mushroom cluster rooted in an irregular emissive mycelium patch.",
  voxel_seaweed: "A volumetric underwater voxel plant cluster without visual-layer collision.",
  voxel_aquatic_plant: "Bent broad underwater leaves with side shoots, distinct from the taller seaweed silhouette.",
  broadleaf_tree_proxy: "A whole-tree proxy built from a small number of boxes to avoid rendering leaves block by block.",
  pine_tree_proxy: "A pine proxy with three canopy box layers sourced from the same runtime model as the game.",
  snowy_cedar_tree_proxy: "A snowy cedar proxy for elevations above the snowline, adding low-cost snow coverage to the pine canopy.",
});

const elements = {
  form: document.querySelector("#bakeForm"),
  seed: document.querySelector("#seedInput"),
  tileSize: document.querySelector("#tileSizeInput"),
  repeat: document.querySelector("#repeatInput"),
  filter: document.querySelector("#filterInput"),
  materialCount: document.querySelector("#materialCountValue"),
  layerCount: document.querySelector("#layerCountValue"),
  assetCount: document.querySelector("#assetCountValue"),
  tileBytes: document.querySelector("#tileBytesValue"),
  bakeTime: document.querySelector("#bakeTimeValue"),
  grid: document.querySelector("#materialGrid"),
  template: document.querySelector("#materialCardTemplate"),
  assetGrid: document.querySelector("#assetGrid"),
  assetTemplate: document.querySelector("#assetCardTemplate"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedMeta: document.querySelector("#selectedMeta"),
  selectedTile: document.querySelector("#selectedTileCanvas"),
  selectedRepeat: document.querySelector("#selectedRepeatCanvas"),
  editorForm: document.querySelector("#editorForm"),
  baseColor: document.querySelector("#baseColorInput"),
  alpha: document.querySelector("#alphaInput"),
  alphaValue: document.querySelector("#alphaValue"),
  roughness: document.querySelector("#roughnessInput"),
  roughnessValue: document.querySelector("#roughnessValue"),
  style: document.querySelector("#styleInput"),
  shaderType: document.querySelector("#shaderTypeInput"),
  emissive: document.querySelector("#emissiveInput"),
  resetMaterial: document.querySelector("#resetMaterialButton"),
  copySnippet: document.querySelector("#copySnippetButton"),
  overrideText: document.querySelector("#overrideText"),
  exportButton: document.querySelector("#exportButton"),
  importButton: document.querySelector("#importButton"),
  resetAll: document.querySelector("#resetAllButton"),
  status: document.querySelector("#statusText"),
};

const materialIdNames = Object.fromEntries(Object.entries(MATERIAL_ID).map(([name, id]) => [id, name]));
const resourceIdNames = Object.fromEntries(Object.entries(RESOURCE_ID).map(([name, id]) => [id, name]));
const materials = materialList().sort((a, b) => a.textureLayer - b.textureLayer || a.materialId - b.materialId);
const blocksByMaterialId = groupBlocksByMaterialId();
const resourcesByMaterialId = groupResourcesByMaterialId();
const state = {
  selectedId: materials[0]?.materialId ?? null,
  overrides: loadOverrides(),
  tiles: new Map(),
  assets: [],
  manager: null,
  tileSize: Number(elements.tileSize.value) || 32,
  repeat: Number(elements.repeat.value) || 4,
  seed: elements.seed.value.trim() || DEFAULT_SEED,
  bakeQueued: false,
  editing: false,
};

init();

function init() {
  populateStyleOptions();
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    readBakeControls();
    bakeAndRender("Rebake complete");
  });
  elements.filter.addEventListener("input", () => renderGrid());
  for (const input of [elements.baseColor, elements.alpha, elements.roughness, elements.style, elements.shaderType, elements.emissive]) {
    input.addEventListener("input", () => updateSelectedOverride());
    input.addEventListener("change", () => updateSelectedOverride());
  }
  elements.resetMaterial.addEventListener("click", resetSelectedMaterial);
  elements.copySnippet.addEventListener("click", copySelectedSnippet);
  elements.exportButton.addEventListener("click", exportOverrides);
  elements.importButton.addEventListener("click", importOverrides);
  elements.resetAll.addEventListener("click", resetAllOverrides);
  bakeAndRender("Material bake complete");
}

function populateStyleOptions() {
  const unique = [...new Set(STYLE_OPTIONS)].sort();
  elements.style.replaceChildren(...unique.map((style) => {
    const option = document.createElement("option");
    option.value = style;
    option.textContent = style;
    return option;
  }));
}

function readBakeControls() {
  state.seed = elements.seed.value.trim() || DEFAULT_SEED;
  state.tileSize = Number(elements.tileSize.value) || 32;
  state.repeat = Number(elements.repeat.value) || 4;
}

function queueBake(message = "Parameters updated") {
  if (state.bakeQueued) return;
  state.bakeQueued = true;
  requestAnimationFrame(() => {
    state.bakeQueued = false;
    bakeAndRender(message);
  });
}

function bakeAndRender(message = "Material bake complete") {
  readBakeControls();
  const start = performance.now();
  state.manager = new TextureArrayManager(null, { tileSize: state.tileSize, materials, seed: state.seed });
  state.tiles.clear();
  for (const material of materials) {
    const effective = materialWithOverride(material);
    state.tiles.set(material.materialId, {
      material,
      effective,
      pixels: state.manager.generateMaterialTile(effective),
    });
  }
  elements.materialCount.textContent = String(materials.length);
  elements.layerCount.textContent = String(state.manager.layerCount);
  elements.tileBytes.textContent = formatBytes(state.tileSize * state.tileSize * 4 * state.manager.layerCount);
  elements.bakeTime.textContent = `${(performance.now() - start).toFixed(1)} ms`;
  state.assets = buildRuntimeVisualAssets();
  elements.assetCount.textContent = String(state.assets.length);
  renderAssets();
  renderGrid();
  renderEditor();
  setStatus(message);
}

function buildRuntimeVisualAssets() {
  const assets = [];
  try {
    assets.push(buildCloudDebugAsset({ seed: state.seed, radius: 260, baseHeight: 0 }));
  } catch (error) {
    console.warn("cloud preview failed", error);
  }
  try {
    assets.push(...buildDebugVisualModelAssets());
  } catch (error) {
    console.warn("visual model preview failed", error);
  }
  try {
    const avatar = createAvatarMeshFromNcm(null, { scale: 1.74, name: "peasant_guy" });
    assets.push({
      id: "avatar_peasant_guy",
      name: "peasant guy avatar",
      category: "avatar",
      description: "The NCM voxel villager avatar used by the current playable demo.",
      vertexFormat: "float10-color",
      vertices: avatar.vertices,
      indices: avatar.indices,
      stride: 10,
      triangleCount: avatar.triangleCount,
      vertexCount: avatar.vertexCount,
      collision: true,
    });
  } catch (error) {
    console.warn("avatar preview failed", error);
  }
  assets.push({
    id: "sky_gradient_pass",
    name: "sky gradient pass",
    category: "sky visual",
    description: "Fullscreen sky gradient pass with deep blue overhead, bright cyan through the middle, and a white horizon transition. It uses no texture or collision and costs one draw call.",
    vertexFormat: "fullscreen-sky",
    triangleCount: 1,
    vertexCount: 3,
    collision: false,
  });
  assets.push({
    id: "water_surface_shader",
    name: "water surface shader",
    category: "shader visual",
    description: "The water surface combines water material layers with runtime ripples, highlights, and distance-based color instead of using a separate model.",
    vertexFormat: "water-shader",
    triangleCount: 0,
    vertexCount: 0,
    layers: [17, 18, 19],
    collision: false,
  });
  assets.push({
    id: "horizon_fog_grade",
    name: "horizon fog grade",
    category: "shader visual",
    description: "Shader fog blends the sea horizon and distant scenery without a hard cutoff or additional geometry.",
    vertexFormat: "horizon-fog",
    triangleCount: 0,
    vertexCount: 0,
    collision: false,
  });
  assets.push({
    id: "sun_disc_billboard",
    name: "sun disc billboard",
    category: "sky visual",
    description: "The sun is a shader billboard rather than a texture. This preview shows its runtime visual rules.",
    vertexFormat: "sun-disc",
    triangleCount: 2,
    vertexCount: 4,
    collision: false,
  });
  return assets;
}

function renderAssets() {
  const fragment = document.createDocumentFragment();
  for (const asset of state.assets) {
    const card = elements.assetTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".asset-category").textContent = asset.category;
    card.querySelector("h3").textContent = asset.name;
    card.querySelector(".badge").textContent = `${Math.round(asset.triangleCount || 0)} tris`;
    card.querySelector(".asset-description").textContent = ASSET_DESCRIPTION_OVERRIDES[asset.id] ?? asset.description ?? "";
    drawModelPreview(card.querySelector(".model-canvas"), asset);
    renderMeta(card.querySelector(".material-meta"), [
      ["id", asset.id],
      ["verts", String(Math.round(asset.vertexCount || 0))],
      ["layers", assetLayerText(asset)],
      ["collision", asset.collision ? "yes" : "no"],
    ]);
    fragment.append(card);
  }
  elements.assetGrid.replaceChildren(fragment);
}

function renderGrid() {
  const filter = elements.filter.value;
  const fragment = document.createDocumentFragment();
  const visible = materials.filter((material) => shouldShowMaterial(material, filter));
  for (const material of visible) {
    const data = state.tiles.get(material.materialId);
    if (!data) continue;
    const card = elements.template.content.firstElementChild.cloneNode(true);
    const id = material.materialId;
    card.dataset.materialId = String(id);
    card.classList.toggle("is-selected", id === state.selectedId);
    card.classList.toggle("is-edited", Boolean(state.overrides[id]));
    card.querySelector(".layer-index").textContent = `Layer ${data.effective.textureLayer}`;
    card.querySelector("h3").textContent = materialDisplayName(material);
    const badge = card.querySelector(".badge");
    badge.textContent = state.overrides[id] ? "edited" : data.effective.shaderType;
    drawTile(card.querySelector(".tile-canvas"), data.pixels, state.tileSize);
    drawRepeat(card.querySelector(".repeat-canvas"), data.pixels, state.tileSize, state.repeat);
    renderMeta(card.querySelector(".material-meta"), [
      ["id", String(id)],
      ["style", data.effective.style],
      ["type", data.effective.shaderType],
      ["base", rgbaText(data.effective.baseColor)],
      ["blocks", blockNamesForMaterial(data.effective.materialId)],
      ["resources", resourceNamesForMaterial(data.effective.materialId)],
    ]);
    card.addEventListener("click", () => selectMaterial(id));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectMaterial(id);
      }
    });
    fragment.append(card);
  }
  elements.grid.replaceChildren(fragment);
}

function shouldShowMaterial(material, filter) {
  if (filter === "all") return true;
  if (filter === "edited") return Boolean(state.overrides[material.materialId]);
  const effective = state.tiles.get(material.materialId)?.effective ?? materialWithOverride(material);
  return effective.shaderType === filter;
}

function selectMaterial(materialId) {
  state.selectedId = materialId;
  renderGrid();
  renderEditor();
}

function renderEditor() {
  const selected = selectedMaterial();
  if (!selected) return;
  const data = state.tiles.get(selected.materialId);
  const effective = data?.effective ?? materialWithOverride(selected);
  elements.selectedTitle.textContent = materialDisplayName(selected);
  elements.selectedMeta.textContent = `materialId ${selected.materialId} · textureLayer ${effective.textureLayer} · ${effective.shaderType} · ${effective.style}`;
  if (data) {
    drawTile(elements.selectedTile, data.pixels, state.tileSize);
    drawRepeat(elements.selectedRepeat, data.pixels, state.tileSize, state.repeat);
  }
  state.editing = true;
  elements.baseColor.value = rgbToHex(effective.baseColor);
  elements.alpha.value = String(effective.baseColor[3] ?? 255);
  elements.alphaValue.textContent = String(effective.baseColor[3] ?? 255);
  elements.roughness.value = String(effective.roughness ?? 1);
  elements.roughnessValue.textContent = Number(effective.roughness ?? 1).toFixed(2);
  ensureStyleOption(effective.style);
  elements.style.value = effective.style;
  elements.shaderType.value = effective.shaderType;
  elements.emissive.value = (effective.emissive ?? [0, 0, 0]).map((value) => Number(value).toFixed(2).replace(/\.00$/, "")).join(",");
  state.editing = false;
}

function updateSelectedOverride() {
  if (state.editing) return;
  const material = selectedMaterial();
  if (!material) return;
  elements.alphaValue.textContent = elements.alpha.value;
  elements.roughnessValue.textContent = Number(elements.roughness.value || 0).toFixed(2);
  const override = normalizeOverride({
    baseColor: elements.baseColor.value,
    alpha: Number(elements.alpha.value),
    roughness: Number(elements.roughness.value),
    style: elements.style.value,
    shaderType: elements.shaderType.value,
    emissive: parseEmissive(elements.emissive.value),
  });
  if (overrideEqualsMaterial(override, material)) delete state.overrides[material.materialId];
  else state.overrides[material.materialId] = override;
  saveOverrides();
  queueBake("Local material override updated");
}

function materialWithOverride(material) {
  const override = state.overrides[material.materialId];
  if (!override) return material;
  const alpha = clampByte(Number.isFinite(override.alpha) ? override.alpha : material.baseColor[3]);
  return {
    ...material,
    baseColor: [...hexToRgb(override.baseColor ?? rgbToHex(material.baseColor)), alpha],
    roughness: clamp(Number.isFinite(override.roughness) ? override.roughness : material.roughness, 0, 1),
    emissive: Array.isArray(override.emissive) ? override.emissive.map((value) => Number(value) || 0).slice(0, 3) : material.emissive,
    shaderType: override.shaderType || material.shaderType,
    style: override.style || material.style,
  };
}

function normalizeOverride(override) {
  return {
    baseColor: normalizeHex(override.baseColor),
    alpha: clampByte(override.alpha),
    roughness: clamp(Number(override.roughness), 0, 1),
    style: String(override.style || "generic"),
    shaderType: String(override.shaderType || "opaque"),
    emissive: parseEmissive(override.emissive),
  };
}

function overrideEqualsMaterial(override, material) {
  return (
    normalizeHex(override.baseColor) === rgbToHex(material.baseColor) &&
    clampByte(override.alpha) === (material.baseColor[3] ?? 255) &&
    Math.abs(clamp(Number(override.roughness), 0, 1) - (material.roughness ?? 1)) < 0.0001 &&
    String(override.style) === String(material.style) &&
    String(override.shaderType) === String(material.shaderType) &&
    JSON.stringify(parseEmissive(override.emissive)) === JSON.stringify(material.emissive ?? [0, 0, 0])
  );
}

function resetSelectedMaterial() {
  const material = selectedMaterial();
  if (!material) return;
  delete state.overrides[material.materialId];
  saveOverrides();
  bakeAndRender("Current material reset");
}

function resetAllOverrides() {
  state.overrides = {};
  saveOverrides();
  bakeAndRender("All local overrides cleared");
}

function exportOverrides() {
  const payload = {
    version: 1,
    seed: state.seed,
    tileSize: state.tileSize,
    generatedAt: new Date().toISOString(),
    overrides: state.overrides,
  };
  elements.overrideText.value = JSON.stringify(payload, null, 2);
  copyText(elements.overrideText.value).then((copied) => {
    setStatus(copied ? "Override JSON exported and copied" : "Override JSON exported to the text area");
  });
}

function importOverrides() {
  let parsed = null;
  try {
    parsed = JSON.parse(elements.overrideText.value || "{}");
  } catch (error) {
    setStatus(`Import failed: ${error.message}`);
    return;
  }
  const raw = parsed.overrides ?? parsed;
  const next = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const material = materials.find((entry) => String(entry.materialId) === String(key));
    if (!material || !value) continue;
    const override = normalizeOverride(value);
    if (!overrideEqualsMaterial(override, material)) next[material.materialId] = override;
  }
  state.overrides = next;
  saveOverrides();
  bakeAndRender(`Imported ${Object.keys(next).length} material overrides`);
}

function copySelectedSnippet() {
  const material = selectedMaterial();
  if (!material) return;
  const effective = state.tiles.get(material.materialId)?.effective ?? materialWithOverride(material);
  const name = materialIdNames[material.materialId] ?? material.materialId;
  const emissive = (effective.emissive ?? [0, 0, 0]).map((value) => trimNumber(value)).join(", ");
  const snippet = `[MATERIAL_ID.${name}]: material(MATERIAL_ID.${name}, ${effective.textureLayer}, [${effective.baseColor.map((value) => Math.round(value)).join(", ")}], ${trimNumber(effective.roughness)}, [${emissive}], "${effective.shaderType}", "${effective.style}"),`;
  elements.overrideText.value = snippet;
  copyText(snippet).then((copied) => setStatus(copied ? "Registry snippet copied" : "Registry snippet written to the text area"));
}

function drawTile(canvas, pixels, size) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), size, size), 0, 0);
}

function drawRepeat(canvas, pixels, size, repeat) {
  const tile = document.createElement("canvas");
  drawTile(tile, pixels, size);
  canvas.width = size * repeat;
  canvas.height = size * repeat;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < repeat; y += 1) {
    for (let x = 0; x < repeat; x += 1) ctx.drawImage(tile, x * size, y * size);
  }
}

function drawModelPreview(canvas, asset) {
  const width = 360;
  const height = 270;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;
  drawPreviewBackdrop(ctx, width, height);
  if (asset.vertexFormat === "sun-disc") {
    drawSunDiscPreview(ctx, width, height);
    return;
  }
  if (asset.vertexFormat === "water-shader") {
    drawWaterShaderPreview(ctx, width, height);
    return;
  }
  if (asset.vertexFormat === "horizon-fog") {
    drawHorizonFogPreview(ctx, width, height);
    return;
  }

  const vertices = collectModelVertices(asset);
  if (!vertices.length || !asset.indices?.length) return;
  const projected = vertices.map((vertex) => ({ ...vertex, s: isoProject(vertex.p) }));
  const bounds = boundsOfProjected(projected);
  const scale = Math.min((width - 42) / Math.max(0.001, bounds.maxX - bounds.minX), (height - 42) / Math.max(0.001, bounds.maxY - bounds.minY));
  const offsetX = width * 0.5 - ((bounds.minX + bounds.maxX) * 0.5) * scale;
  const offsetY = height * 0.54 - ((bounds.minY + bounds.maxY) * 0.5) * scale;
  const triangles = [];
  for (let i = 0; i + 2 < asset.indices.length; i += 3) {
    const a = projected[asset.indices[i]];
    const b = projected[asset.indices[i + 1]];
    const c = projected[asset.indices[i + 2]];
    if (!a || !b || !c) continue;
    const depth = (a.p[0] + b.p[0] + c.p[0]) * 0.30 + (a.p[2] + b.p[2] + c.p[2]) * 0.62 + (a.p[1] + b.p[1] + c.p[1]) * 0.12;
    triangles.push({ a, b, c, depth, color: averageColor(a.color, b.color, c.color), normal: averageNormal(a.n, b.n, c.n) });
  }
  triangles.sort((left, right) => left.depth - right.depth);
  for (const tri of triangles) {
    const light = lightForNormal(tri.normal);
    const color = tri.color;
    ctx.globalAlpha = clamp((color[3] ?? 255) / 255, 0.18, 1);
    ctx.fillStyle = `rgb(${clampByte(color[0] * light)}, ${clampByte(color[1] * light)}, ${clampByte(color[2] * light)})`;
    ctx.strokeStyle = "rgba(15, 20, 14, 0.16)";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(tri.a.s[0] * scale + offsetX, tri.a.s[1] * scale + offsetY);
    ctx.lineTo(tri.b.s[0] * scale + offsetX, tri.b.s[1] * scale + offsetY);
    ctx.lineTo(tri.c.s[0] * scale + offsetX, tri.c.s[1] * scale + offsetY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSunDiscPreview(ctx, width, height) {
  const cx = width * 0.54;
  const cy = height * 0.42;
  const halo = ctx.createRadialGradient(cx, cy, 4, cx, cy, width * 0.25);
  halo.addColorStop(0, "rgba(255, 248, 202, 0.95)");
  halo.addColorStop(0.22, "rgba(255, 226, 142, 0.62)");
  halo.addColorStop(1, "rgba(255, 212, 122, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, width * 0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 248, 205, 0.96)";
  ctx.beginPath();
  ctx.arc(cx, cy, width * 0.055, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx + width * 0.06, cy - height * 0.08);
  ctx.lineTo(cx + width * 0.22, cy - height * 0.24);
  ctx.stroke();
}

function drawWaterShaderPreview(ctx, width, height) {
  const water = ctx.createLinearGradient(0, height * 0.26, 0, height);
  water.addColorStop(0, "rgba(180, 232, 236, 0.82)");
  water.addColorStop(0.42, "rgba(87, 180, 212, 0.90)");
  water.addColorStop(1, "rgba(40, 106, 178, 0.96)");
  ctx.fillStyle = water;
  ctx.fillRect(0, height * 0.32, width, height * 0.68);
  ctx.strokeStyle = "rgba(255, 250, 205, 0.72)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 13; i += 1) {
    const y = height * (0.38 + i * 0.045);
    const start = (i % 3) * 18;
    ctx.beginPath();
    for (let x = -30; x <= width + 30; x += 18) {
      const py = y + Math.sin((x + i * 17) * 0.045) * (2 + i * 0.18);
      if (x === -30) ctx.moveTo(x + start, py);
      else ctx.lineTo(x + start, py);
    }
    ctx.globalAlpha = 0.18 + (i % 4) * 0.07;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const sunTrail = ctx.createRadialGradient(width * 0.66, height * 0.44, 2, width * 0.66, height * 0.54, width * 0.30);
  sunTrail.addColorStop(0, "rgba(255, 245, 184, 0.55)");
  sunTrail.addColorStop(1, "rgba(255, 245, 184, 0)");
  ctx.fillStyle = sunTrail;
  ctx.fillRect(0, height * 0.32, width, height * 0.68);
}

function drawHorizonFogPreview(ctx, width, height) {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#73c9f0");
  sky.addColorStop(0.48, "#dff8fb");
  sky.addColorStop(0.57, "#f1fbf8");
  sky.addColorStop(1, "#72b9b1");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.62)";
  ctx.fillRect(0, height * 0.50, width, height * 0.08);
  ctx.fillStyle = "rgba(74, 151, 182, 0.30)";
  ctx.fillRect(0, height * 0.58, width, height * 0.42);
  ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
  for (let i = 0; i < 7; i += 1) ctx.fillRect(i * 54 - 20, height * (0.47 + i * 0.006), 64, 2);
}

function collectModelVertices(asset) {
  if (asset.vertexFormat === "chunk-object") {
    return asset.vertices.map((vertex) => ({
      p: vertex.p,
      n: normalizePreviewNormal(vertex.n),
      color: colorForTextureLayer(vertex.layer, vertex.ao),
      layer: vertex.layer,
    }));
  }
  if (asset.vertexFormat === "float10-color") {
    const out = [];
    const stride = asset.stride || 10;
    for (let offset = 0; offset + 9 < asset.vertices.length; offset += stride) {
      out.push({
        p: [asset.vertices[offset], asset.vertices[offset + 1], asset.vertices[offset + 2]],
        n: [asset.vertices[offset + 3], asset.vertices[offset + 4], asset.vertices[offset + 5]],
        color: [
          clampByte(asset.vertices[offset + 6] * 255),
          clampByte(asset.vertices[offset + 7] * 255),
          clampByte(asset.vertices[offset + 8] * 255),
          clampByte(asset.vertices[offset + 9] * 255),
        ],
        layer: null,
      });
    }
    return out;
  }
  return [];
}

function isoProject(p) {
  const x = p[0] - p[2];
  const y = (p[0] + p[2]) * 0.42 - p[1] * 1.05;
  return [x, y];
}

function boundsOfProjected(vertices) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const vertex of vertices) {
    bounds.minX = Math.min(bounds.minX, vertex.s[0]);
    bounds.maxX = Math.max(bounds.maxX, vertex.s[0]);
    bounds.minY = Math.min(bounds.minY, vertex.s[1]);
    bounds.maxY = Math.max(bounds.maxY, vertex.s[1]);
  }
  return bounds;
}

function drawPreviewBackdrop(ctx, width, height) {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "rgba(143, 205, 238, 0.36)");
  sky.addColorStop(0.58, "rgba(170, 214, 178, 0.11)");
  sky.addColorStop(1, "rgba(20, 26, 15, 0.55)");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255, 255, 255, 0.055)";
  for (let x = -width; x < width * 2; x += 18) {
    ctx.fillRect(x, height * 0.78, width * 2, 1);
  }
}

function colorForTextureLayer(layer, ao = 240) {
  const material = materials.find((entry) => materialWithOverride(entry).textureLayer === layer);
  const data = material ? state.tiles.get(material.materialId) : null;
  const color = data?.effective?.baseColor ?? [180, 190, 180, 255];
  const shade = 0.72 + clamp((ao ?? 240) / 255, 0, 1) * 0.28;
  return [color[0] * shade, color[1] * shade, color[2] * shade, color[3] ?? 255];
}

function averageColor(a, b, c) {
  return [
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
    (a[3] + b[3] + c[3]) / 3,
  ];
}

function averageNormal(a, b, c) {
  return normalizePreviewNormal([
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
  ]);
}

function lightForNormal(normal) {
  return clamp(0.72 + Math.max(0, normal[0] * -0.25 + normal[1] * 0.68 + normal[2] * 0.32) * 0.34, 0.60, 1.14);
}

function normalizePreviewNormal(value) {
  const x = Number(value?.[0]) || 0;
  const y = Number(value?.[1]) || 0;
  const z = Number(value?.[2]) || 0;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function assetLayerText(asset) {
  if (!asset.layers?.length) return "-";
  return asset.layers.map((layer) => {
    const material = materials.find((entry) => materialWithOverride(entry).textureLayer === layer);
    return material ? `${layer}:${materialDisplayName(material)}` : String(layer);
  }).join(", ");
}

function renderMeta(container, entries) {
  container.replaceChildren(...entries.map(([key, value]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }));
}

function blockNamesForMaterial(materialId) {
  const names = blocksByMaterialId.get(materialId) ?? [];
  if (!names.length) return "-";
  if (names.length <= 4) return names.join(", ");
  return `${names.slice(0, 4).join(", ")} +${names.length - 4}`;
}

function resourceNamesForMaterial(materialId) {
  const names = resourcesByMaterialId.get(materialId) ?? [];
  if (!names.length) return "-";
  if (names.length <= 4) return names.join(", ");
  return `${names.slice(0, 4).join(", ")} +${names.length - 4}`;
}

function groupBlocksByMaterialId() {
  const map = new Map();
  for (const block of Object.values(blockDefs)) {
    if (!block || block.name === "air") continue;
    const list = map.get(block.materialId) ?? [];
    list.push(block.name);
    map.set(block.materialId, list);
  }
  return map;
}

function groupResourcesByMaterialId() {
  const map = new Map();
  for (const block of Object.values(blockDefs)) {
    if (!block || block.name === "air") continue;
    const resourceName = resourceIdNames[block.resourceId] ?? `resource_${block.resourceId}`;
    const list = map.get(block.materialId) ?? [];
    if (!list.includes(resourceName)) list.push(resourceName);
    map.set(block.materialId, list);
  }
  return map;
}

function selectedMaterial() {
  return materials.find((material) => material.materialId === state.selectedId) ?? null;
}

function materialDisplayName(material) {
  return materialIdNames[material.materialId] ?? `material_${material.materialId}`;
}

function loadOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed?.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {};
  } catch {
    return {};
  }
}

function saveOverrides() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, overrides: state.overrides }));
  } catch {
    // Storage can fail in private mode. The page still works for this session.
  }
}

function ensureStyleOption(style) {
  if (!style || [...elements.style.options].some((option) => option.value === style)) return;
  const option = document.createElement("option");
  option.value = style;
  option.textContent = style;
  elements.style.append(option);
}

function parseEmissive(value) {
  if (Array.isArray(value)) return [0, 1, 2].map((index) => Number(value[index]) || 0);
  return String(value ?? "0,0,0").split(",").slice(0, 3).map((part) => Number(part.trim()) || 0).concat([0, 0, 0]).slice(0, 3);
}

function normalizeHex(value) {
  const text = String(value || "#ffffff").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
  return "#ffffff";
}

function rgbToHex(color) {
  const [r, g, b] = color ?? [255, 255, 255];
  return `#${[r, g, b].map((value) => clampByte(value).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex) {
  const text = normalizeHex(hex).slice(1);
  return [0, 2, 4].map((offset) => parseInt(text.slice(offset, offset + 2), 16));
}

function rgbaText(color) {
  return `[${(color ?? []).map((value) => Math.round(value)).join(",")}]`;
}

function trimNumber(value) {
  return Number(value || 0).toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

async function copyText(text) {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function setStatus(message) {
  elements.status.textContent = message;
}
