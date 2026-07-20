export const EQUIPMENT_MODEL_ID = Object.freeze({
  basicPickaxe: "basic_iron_pickaxe",
  forgedPickaxe: "forged_pickaxe",
  backpack: "backpack",
  blueprint: "blueprint_tool",
});

const PICKAXE_PART_DEFS = Object.freeze([
  part("toolHandle", [0, 0, -0.46], [0.14, 0.14, 1.16], "handle"),
  part("toolGrip", [0, 0, 0.12], [0.18, 0.18, 0.28], "grip"),
  part("toolNeck", [0, 0, -0.86], [0.18, 0.18, 0.34], "metal", true),
  part("toolHead", [0, 0, -1.08], [0.24, 0.86, 0.24], "metal", true),
  part("toolTipTop", [0, 0.55, -1.08], [0.18, 0.18, 0.18], "highlight", true),
  part("toolTipBottom", [0, -0.55, -1.08], [0.18, 0.18, 0.18], "highlight", true),
]);

const FORGED_PICKAXE_EXTRA_DEFS = Object.freeze([
  part("toolRune", [0, 0, -0.68], [0.22, 0.08, 0.12], "highlight", true),
  part("toolCounterweight", [0, 0, 0.38], [0.22, 0.22, 0.18], "metal"),
]);

const BACKPACK_PART_DEFS = Object.freeze([
  part("packBody", [0, 0, 0], [0.88, 1.05, 0.38], "body"),
  part("packTop", [0, 0.43, 0.04], [0.76, 0.30, 0.42], "top"),
  part("packFlap", [0, 0.27, 0.25], [0.78, 0.36, 0.12], "flap"),
  part("packFlapHighlight", [0, 0.40, 0.33], [0.60, 0.07, 0.05], "highlight"),
  part("packPocket", [0, -0.28, 0.28], [0.62, 0.34, 0.20], "pocket"),
  part("packPocketFlap", [0, -0.14, 0.40], [0.58, 0.12, 0.08], "flap"),
  part("packCenterStrap", [0, 0.02, 0.40], [0.10, 0.72, 0.08], "strap"),
  part("packBuckle", [0, -0.14, 0.47], [0.18, 0.18, 0.07], "metal"),
  part("packSideLeft", [-0.52, -0.06, 0.05], [0.20, 0.50, 0.30], "shadow"),
  part("packSideRight", [0.52, -0.06, 0.05], [0.20, 0.50, 0.30], "shadow"),
  part("packHandleLeft", [-0.20, 0.67, -0.02], [0.10, 0.28, 0.10], "strap"),
  part("packHandleRight", [0.20, 0.67, -0.02], [0.10, 0.28, 0.10], "strap"),
  part("packHandleTop", [0, 0.79, -0.02], [0.50, 0.10, 0.10], "strap"),
  part("packShoulderLeft", [-0.27, 0, -0.25], [0.10, 0.88, 0.08], "backStrap"),
  part("packShoulderRight", [0.27, 0, -0.25], [0.10, 0.88, 0.08], "backStrap"),
]);

const BLUEPRINT_PART_DEFS = Object.freeze([
  part("blueprintBoard", [0, 0, -0.22], [0.92, 0.66, 0.08], "frame"),
  part("blueprintSheet", [0, 0, -0.275], [0.82, 0.56, 0.035], "sheet"),
  part("blueprintGlowTop", [0, 0.22, -0.305], [0.68, 0.035, 0.025], "glow"),
  part("blueprintGlowBottom", [0, -0.22, -0.305], [0.68, 0.035, 0.025], "glow"),
  part("blueprintGridV1", [-0.22, 0, -0.307], [0.025, 0.42, 0.025], "line"),
  part("blueprintGridV2", [0.08, 0, -0.307], [0.025, 0.42, 0.025], "line"),
  part("blueprintGridH1", [0, -0.08, -0.309], [0.62, 0.025, 0.025], "line"),
  part("blueprintGridH2", [0, 0.10, -0.309], [0.62, 0.025, 0.025], "line"),
  part("blueprintCorner", [0.29, 0.16, -0.312], [0.14, 0.11, 0.025], "accent"),
  part("blueprintGrip", [0, -0.39, -0.16], [0.32, 0.18, 0.16], "grip"),
]);

const BASIC_PICKAXE_PALETTE = palette({
  handle: [109, 74, 45],
  grip: [77, 52, 36],
  metal: [158, 166, 168],
  highlight: [230, 236, 235],
});

const BACKPACK_PALETTE = palette({
  body: [142, 70, 14],
  top: [182, 94, 18],
  flap: [215, 132, 32],
  highlight: [242, 177, 67],
  pocket: [166, 81, 13],
  strap: [101, 49, 8],
  metal: [207, 218, 215],
  shadow: [78, 37, 7],
  backStrap: [86, 47, 15],
});

const BLUEPRINT_PALETTE = palette({
  frame: [20, 88, 176],
  sheet: [35, 132, 238],
  glow: [183, 244, 255],
  line: [92, 207, 255],
  accent: [226, 253, 255],
  grip: [14, 55, 116],
});

const basicPickaxeParts = buildParts(PICKAXE_PART_DEFS, BASIC_PICKAXE_PALETTE);
const backpackParts = buildParts(BACKPACK_PART_DEFS, BACKPACK_PALETTE);
const blueprintParts = buildParts(BLUEPRINT_PART_DEFS, BLUEPRINT_PALETTE);
const forgedPartsCache = new Map();

export function equipmentModelIdForItem(item = {}) {
  if (item.kind === "forged" || item.itemId === "forged_item") return EQUIPMENT_MODEL_ID.forgedPickaxe;
  if (item.kind === "tool" || item.itemId === "iron_pickaxe") return EQUIPMENT_MODEL_ID.basicPickaxe;
  if (item.kind === "backpack" || item.kind === "container" || item.itemId === "backpack") return EQUIPMENT_MODEL_ID.backpack;
  if (item.kind === "blueprint" || item.itemId === "blueprint_tool") return EQUIPMENT_MODEL_ID.blueprint;
  return "";
}

export function createEquipmentModelParts(modelId, { designHash = 0 } = {}) {
  if (modelId === EQUIPMENT_MODEL_ID.basicPickaxe) return basicPickaxeParts;
  if (modelId === EQUIPMENT_MODEL_ID.backpack) return backpackParts;
  if (modelId === EQUIPMENT_MODEL_ID.blueprint) return blueprintParts;
  if (modelId !== EQUIPMENT_MODEL_ID.forgedPickaxe) return Object.freeze([]);
  const hash = normalizeDesignHash(designHash);
  const cached = forgedPartsCache.get(hash);
  if (cached) return cached;
  const defs = PICKAXE_PART_DEFS.map((entry) => {
    if (entry.name === "toolHead") return Object.freeze({ ...entry, size: Object.freeze([0.28, 0.96, 0.24]) });
    if (entry.name === "toolTipTop" || entry.name === "toolTipBottom") {
      return Object.freeze({ ...entry, size: Object.freeze([0.24, 0.20, 0.20]) });
    }
    return entry;
  }).concat(FORGED_PICKAXE_EXTRA_DEFS);
  const parts = buildParts(defs, forgedPickaxePalette(hash));
  forgedPartsCache.set(hash, parts);
  if (forgedPartsCache.size > 64) forgedPartsCache.delete(forgedPartsCache.keys().next().value);
  return parts;
}

export function forgedPickaxePalette(designHash = 0) {
  const hash = normalizeDesignHash(designHash);
  const warm = hash & 1;
  const metalBase = warm ? [0.72, 0.43, 0.25] : [0.56, 0.62, 0.66];
  const accentBase = warm ? [1.0, 0.76, 0.36] : [0.50, 0.88, 1.0];
  const shift = (((hash >>> 3) & 31) - 15) / 255;
  return Object.freeze({
    handle: rgba([0.38 + shift * 0.5, 0.23, 0.14]),
    grip: rgba([0.16, 0.12, 0.10]),
    metal: rgba(metalBase.map((value, index) => value + shift * (index === 1 ? 0.8 : 1))),
    highlight: rgba(accentBase.map((value, index) => value + shift * (index === 2 ? 0.6 : 1.2))),
  });
}

export function equipmentModelBounds(parts = []) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const entry of parts) {
    bounds.minX = Math.min(bounds.minX, entry.center[0] - entry.size[0] * 0.5);
    bounds.maxX = Math.max(bounds.maxX, entry.center[0] + entry.size[0] * 0.5);
    bounds.minY = Math.min(bounds.minY, entry.center[1] - entry.size[1] * 0.5);
    bounds.maxY = Math.max(bounds.maxY, entry.center[1] + entry.size[1] * 0.5);
    bounds.minZ = Math.min(bounds.minZ, entry.center[2] - entry.size[2] * 0.5);
    bounds.maxZ = Math.max(bounds.maxZ, entry.center[2] + entry.size[2] * 0.5);
  }
  return Number.isFinite(bounds.minX) ? bounds : Object.freeze({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
}

function part(name, center, size, colorRole, miningHitPart = false) {
  return Object.freeze({
    name,
    center: Object.freeze(center),
    size: Object.freeze(size),
    colorRole,
    miningHitPart,
  });
}

function palette(entries) {
  return Object.freeze(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, rgba(value.map((channel) => channel / 255))])));
}

function buildParts(defs, colors) {
  return Object.freeze(defs.map((entry) => Object.freeze({
    ...entry,
    color: colors[entry.colorRole] ?? Object.freeze([1, 1, 1, 1]),
  })));
}

function rgba(values) {
  return Object.freeze([
    Math.max(0, Math.min(1, Number(values[0]) || 0)),
    Math.max(0, Math.min(1, Number(values[1]) || 0)),
    Math.max(0, Math.min(1, Number(values[2]) || 0)),
    1,
  ]);
}

function normalizeDesignHash(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) >>> 0 : 0;
}
