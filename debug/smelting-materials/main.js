import {
  SMELTING_MATERIAL_MODEL_IDS,
  createSmeltingMaterialPreviewMesh,
  smeltingMaterialModelDefinition,
} from "../../renderer/smelting-material-models.js";
import {
  createVoxelItemIconCanvas,
  renderVoxelItemIconYaw,
} from "../../renderer/item-preview.js";

const elements = {
  form: document.querySelector("#filterForm"),
  search: document.querySelector("#searchInput"),
  classFilter: document.querySelector("#classFilter"),
  heatFilter: document.querySelector("#heatFilter"),
  yaw: document.querySelector("#yawInput"),
  yawValue: document.querySelector("#yawValue"),
  parity: document.querySelector("#parityValue"),
  modelCount: document.querySelector("#modelCountValue"),
  triangleCount: document.querySelector("#triangleCountValue"),
  peak: document.querySelector("#peakValue"),
  bakeTime: document.querySelector("#bakeTimeValue"),
  resultMeta: document.querySelector("#resultMeta"),
  grid: document.querySelector("#materialGrid"),
  empty: document.querySelector("#emptyState"),
  status: document.querySelector("#statusText"),
  statusBar: document.querySelector(".status-bar"),
  template: document.querySelector("#materialCardTemplate"),
};

const state = {
  recipes: [],
  recipeById: new Map(),
  localizedItems: {},
  yaw: degreesToRadians(Number(elements.yaw?.value) || 35),
  canvases: new Set(),
};

boot().catch((error) => {
  console.error("smelting material bake preview failed", error);
  setStatus(`Preview failed: ${error?.message || error}`, true);
});

async function boot() {
  const start = performance.now();
  const [rules, locale] = await Promise.all([
    fetchJson("/rules/smelting-rules.json"),
    fetchJson("/play/locales/en.json").catch(() => ({})),
  ]);
  state.recipes = Array.isArray(rules?.materials) ? rules.materials : [];
  state.recipeById = new Map(state.recipes.map((recipe) => [recipe.id, recipe]));
  state.localizedItems = locale?.resourceAtlas?.material?.item ?? {};
  populateClassFilter();
  bindControls();
  const report = validateParity();
  render();
  const meshes = SMELTING_MATERIAL_MODEL_IDS.map((materialId) => createSmeltingMaterialPreviewMesh({ materialId }));
  const peak = meshes.reduce((best, mesh) => mesh.triangleCount > (best?.triangleCount ?? -1) ? mesh : best, null);
  elements.parity.textContent = report.ok ? `${report.modelCount}/${report.recipeCount} matched` : `${report.missing.length + report.extra.length} mismatch`;
  elements.modelCount.textContent = String(meshes.length);
  elements.triangleCount.textContent = meshes.reduce((sum, mesh) => sum + mesh.triangleCount, 0).toLocaleString("en-US");
  elements.peak.textContent = peak ? `${peak.name} · ${peak.triangleCount}` : "-";
  elements.bakeTime.textContent = `${(performance.now() - start).toFixed(1)} ms`;
  setStatus(report.ok
    ? `Validated ${report.modelCount} deterministic models against ${report.recipeCount} public recipes.`
    : `Recipe parity error. Missing: ${report.missing.join(", ") || "none"}; extra: ${report.extra.join(", ") || "none"}.`, !report.ok);
}

function bindControls() {
  elements.form?.addEventListener("submit", (event) => event.preventDefault());
  elements.search?.addEventListener("input", render);
  elements.classFilter?.addEventListener("change", render);
  elements.heatFilter?.addEventListener("change", render);
  elements.yaw?.addEventListener("input", () => {
    const degrees = Number(elements.yaw.value) || 0;
    state.yaw = degreesToRadians(degrees);
    elements.yawValue.textContent = `${degrees}°`;
    for (const canvas of state.canvases) renderVoxelItemIconYaw(canvas, state.yaw);
  });
}

function populateClassFilter() {
  const classes = [...new Set(state.recipes.map((recipe) => recipe.class).filter(Boolean))].sort();
  const fragment = document.createDocumentFragment();
  for (const className of classes) {
    const option = document.createElement("option");
    option.value = className;
    option.textContent = humanize(className);
    fragment.append(option);
  }
  elements.classFilter?.append(fragment);
}

function render() {
  const query = String(elements.search?.value || "").trim().toLowerCase();
  const selectedClass = elements.classFilter?.value || "all";
  const selectedHeat = elements.heatFilter?.value || "all";
  const visible = state.recipes.filter((recipe) => {
    if (!SMELTING_MATERIAL_MODEL_IDS.includes(recipe.id)) return false;
    if (selectedClass !== "all" && recipe.class !== selectedClass) return false;
    if (selectedHeat !== "all" && String(recipe.requiredHeatTier) !== selectedHeat) return false;
    if (!query) return true;
    return searchText(recipe).includes(query);
  });
  const fragment = document.createDocumentFragment();
  state.canvases.clear();
  visible.forEach((recipe, index) => fragment.append(materialCard(recipe, index)));
  elements.grid?.replaceChildren(fragment);
  if (elements.empty) elements.empty.hidden = visible.length > 0;
  if (elements.resultMeta) elements.resultMeta.textContent = `${visible.length} of ${state.recipes.length} recipe outputs · cached Canvas2D voxel bake`;
}

function materialCard(recipe, index) {
  const card = elements.template.content.firstElementChild.cloneNode(true);
  const definition = smeltingMaterialModelDefinition(recipe.id);
  const mesh = createSmeltingMaterialPreviewMesh({ materialId: recipe.id });
  const localized = state.localizedItems[recipe.id] ?? {};
  card.dataset.materialId = recipe.id;
  card.querySelector(".model-index").textContent = `M${String(index + 1).padStart(2, "0")} · T${recipe.requiredHeatTier}`;
  card.querySelector("h3").textContent = localized.name || definition?.name || humanize(recipe.id);
  card.querySelector(".class-badge").textContent = recipe.class;
  card.querySelector(".material-description").textContent = localized.description || definition?.description || "";

  const canvas = createVoxelItemIconCanvas({
    kind: "smelted_material",
    materialId: recipe.id,
    label: localized.name || definition?.name,
  }, { size: 240, yaw: state.yaw });
  canvas.setAttribute("aria-label", `${localized.name || definition?.name || recipe.id} voxel model`);
  card.querySelector(".model-stage").append(canvas);
  state.canvases.add(canvas);

  const inputs = card.querySelector(".recipe-inputs");
  for (const input of recipeInputs(recipe)) {
    const chip = document.createElement("span");
    chip.className = `input-chip${input.material ? " material-input" : ""}`;
    const inputId = input.material ? String(input.key).slice("material:".length) : input.key;
    const localizedInput = input.material ? state.localizedItems[inputId]?.name : "";
    chip.innerHTML = `<b>${Math.max(1, Number(input.amount) || 1)}×</b> ${escapeHtml(localizedInput || humanize(inputId))}`;
    inputs.append(chip);
  }
  renderMeta(card.querySelector(".material-meta"), [
    ["shape", definition?.shape || "voxel material"],
    ["forge use", humanize(recipe.forgeUse || "material")],
    ["geometry", `${mesh.vertexCount} verts / ${mesh.triangleCount} tris`],
    ["surface", `R${Number(definition?.roughness ?? 1).toFixed(2)} · A${Math.round((1 - Number(definition?.translucency ?? 0)) * 100)}%`],
    ["yield", `×${Math.max(1, Number(recipe.yieldCount) || 1)}`],
    ["artisan", `Level ${Math.max(1, Number(recipe.artisanLevel) || 1)}`],
  ]);
  const composition = card.querySelector(".composition");
  for (const [element, range] of (recipe.composition ?? []).slice(0, 5)) {
    const chip = document.createElement("span");
    chip.textContent = `${element} ${range}`;
    composition.append(chip);
  }
  return card;
}

function renderMeta(element, entries) {
  const fragment = document.createDocumentFragment();
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    row.append(dt, dd);
    fragment.append(row);
  }
  element.replaceChildren(fragment);
}

function validateParity() {
  const recipeIds = new Set(state.recipes.map((recipe) => recipe.id));
  const modelIds = new Set(SMELTING_MATERIAL_MODEL_IDS);
  const missing = [...recipeIds].filter((id) => !modelIds.has(id));
  const extra = [...modelIds].filter((id) => !recipeIds.has(id));
  return {
    ok: missing.length === 0 && extra.length === 0 && recipeIds.size === modelIds.size,
    recipeCount: recipeIds.size,
    modelCount: modelIds.size,
    missing,
    extra,
  };
}

function searchText(recipe) {
  const localized = state.localizedItems[recipe.id] ?? {};
  return [
    recipe.id,
    recipe.class,
    recipe.forgeUse,
    localized.name,
    localized.description,
    ...recipeInputs(recipe).map((input) => input.key),
  ].join(" ").toLowerCase();
}

function recipeInputs(recipe) {
  return [
    ...(recipe.rawInputs ?? []).map((input) => ({ ...input, material: false })),
    ...(recipe.materialInputs ?? []).map((input) => ({ ...input, material: true })),
  ];
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function setStatus(message, error = false) {
  if (elements.status) elements.status.textContent = message;
  elements.statusBar?.classList.toggle("error", error);
}

function humanize(value) {
  return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}
