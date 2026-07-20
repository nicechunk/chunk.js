export const FORGE_DYE_MATERIAL_IDS = Object.freeze([
  "white_dye",
  "yellow_dye",
  "red_dye",
  "blue_dye",
  "pink_dye",
]);

export const FORGE_DYE_FALLBACK_COLORS = Object.freeze({
  white_dye: "#f4f6ee",
  yellow_dye: "#eec436",
  red_dye: "#cc4f46",
  blue_dye: "#5288da",
  pink_dye: "#e287b2",
});

export function forgeDyeColor444(color) {
  const value = String(color ?? "").trim();
  if (!/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new TypeError("Forge dye colors must use #rrggbb.");
  }
  const rgb = Number.parseInt(value.slice(1), 16);
  const red = Math.round(((rgb >> 16) & 0xff) * 15 / 255);
  const green = Math.round(((rgb >> 8) & 0xff) * 15 / 255);
  const blue = Math.round((rgb & 0xff) * 15 / 255);
  return (red << 8) | (green << 4) | blue;
}

export function forgeDyePalette(catalog = []) {
  const materials = Array.isArray(catalog) ? catalog : catalog?.materials;
  const materialById = new Map((Array.isArray(materials) ? materials : [])
    .filter((material) => material && typeof material === "object")
    .map((material) => [String(material.id ?? ""), material]));
  return FORGE_DYE_MATERIAL_IDS.map((id) => {
    const material = materialById.get(id) ?? null;
    const candidate = String(material?.dyeColor ?? "").trim();
    const color = /^#[0-9a-f]{6}$/iu.test(candidate)
      ? candidate.toLowerCase()
      : FORGE_DYE_FALLBACK_COLORS[id];
    return Object.freeze({ id, color, color444: forgeDyeColor444(color), material });
  });
}

export function forgePaintDyeUsage(input, catalog = []) {
  const components = Array.isArray(input)
    ? input
    : Array.isArray(input?.components)
      ? input.components
      : [];
  const palette = forgeDyePalette(catalog);
  const dyeByColor = new Map(palette.map((entry) => [entry.color444, entry.id]));
  const dyeIds = new Set();
  const unsupportedColors = new Set();
  for (const component of components) {
    for (const quad of component?.paintQuads ?? []) {
      const color444 = Number(quad?.color444);
      if (!Number.isInteger(color444) || color444 < 0 || color444 > 0xfff) continue;
      const dyeId = dyeByColor.get(color444);
      if (dyeId) dyeIds.add(dyeId);
      else unsupportedColors.add(color444);
    }
  }
  return Object.freeze({
    dyeIds: Object.freeze(palette.map((entry) => entry.id).filter((id) => dyeIds.has(id))),
    unsupportedColors: Object.freeze([...unsupportedColors].sort((left, right) => left - right)),
  });
}

export function resolveForgePaintDyeInventory(input, catalog = [], inventory = []) {
  const usage = forgePaintDyeUsage(input, catalog);
  const entriesById = new Map();
  for (const entry of Array.isArray(inventory) ? inventory : []) {
    const id = forgeDyeMaterialId(entry);
    if (FORGE_DYE_MATERIAL_IDS.includes(id) && !entriesById.has(id)) entriesById.set(id, entry);
  }
  const entries = [];
  const missingDyeIds = [];
  for (const id of usage.dyeIds) {
    const entry = entriesById.get(id);
    if (entry) entries.push(entry);
    else missingDyeIds.push(id);
  }
  return Object.freeze({
    ...usage,
    entries: Object.freeze(entries),
    missingDyeIds: Object.freeze(missingDyeIds),
  });
}

export function forgeDyeMaterialId(entry) {
  return String(
    entry?.materialId
      ?? entry?.id
      ?? entry?.material?.id
      ?? entry?.transactionInput?.materialId
      ?? "",
  ).trim();
}
