export const NCF1_PREFIX = "NCF1.";
export const NCF1_LEGACY_VERSION = 14;
export const NCF1_VERSION = 15;
export const FORGE_FIXED_SCALE = 64;
export const FORGE_COMPONENT_GRID = Object.freeze({ x: 14, y: 10, z: 14 });
export const FORGE_APPEARANCE_GRID = Object.freeze({ x: 24, y: 24, z: 24 });
export const FORGE_CLOTH_RESOURCE_ID = "cloth";
export const FORGE_RESOURCE_IDS = Object.freeze(["iron", "copper", "tin", "coal", "handle", FORGE_CLOTH_RESOURCE_ID]);
export const FORGE_ATTRIBUTE_KEYS = Object.freeze([
  "hardness",
  "durability",
  "toughness",
  "ductility",
  "brittleness",
  "density",
  "heatResistance",
  "corrosionResistance",
  "conductivity",
  "thermalConductivity",
  "magnetism",
  "workability",
]);
export const FORGE_DESIGN_STATS_VECTOR_KEYS = Object.freeze([
  "mass5g",
  "volumeCm3",
  ...FORGE_ATTRIBUTE_KEYS,
]);
export const FORGE_DESIGN_STATS_VECTOR_SCHEMA = Object.freeze(FORGE_DESIGN_STATS_VECTOR_KEYS.map((key, index) => Object.freeze({
  index,
  key,
  unit: index === 0 ? "5g" : index === 1 ? "cm3" : "score6",
  authority: "display-only",
  integer: index < 2 ? "u16" : "u6",
})));
export const FORGE_MATERIAL_REQUIREMENT_KEYS = Object.freeze([
  "requiredVolumeMm3",
  "requiredEffectiveDurability",
]);
export const FORGE_MATERIAL_CAPACITY_KEYS = Object.freeze([
  "totalVolumeMm3",
  "totalEffectiveDurability",
]);
export const FORGE_MATERIAL_REQUIREMENT_SCHEMA = Object.freeze(FORGE_MATERIAL_REQUIREMENT_KEYS.map((key, index) => Object.freeze({
  index,
  key,
  capacityKey: FORGE_MATERIAL_CAPACITY_KEYS[index],
  unit: index === 0 ? "mm3" : "effective-durability",
  comparison: "capacity-gte-requirement",
  integer: "u64",
})));

// Compatibility aliases now refer only to the two authoritative requirement
// fields. The 12 equipment attributes are design/display statistics, never
// material capacities.
export const FORGE_MATERIAL_VECTOR_KEYS = FORGE_MATERIAL_REQUIREMENT_KEYS;
export const FORGE_MATERIAL_VECTOR_SCHEMA = FORGE_MATERIAL_REQUIREMENT_SCHEMA;

// Tag 8 carries decoded NCF1 bytes, and 640 bytes is the canonical ceiling that
// fits the transaction budget used by the on-chain verifier.
export const NCF1_MAX_RAW_BYTES = 640;
export const NCF1_CHAIN_MAX_RAW_BYTES = NCF1_MAX_RAW_BYTES;
export const NCF1_EQUIPMENT_HEADER_BITS = 108;

const NCF1_VOLUME_MANTISSA_BITS = 13;
const NCF1_VOLUME_MANTISSA_MAX = (1 << NCF1_VOLUME_MANTISSA_BITS) - 1;
const NCF1_VOLUME_EXPONENT_MAX = 7;
const NCF1_VOLUME_EXPONENT_BASE = 16;

const DEFAULT_RESOURCE_COLOR_RGB444 = Object.freeze(FORGE_RESOURCE_IDS.map((id) => colorToRgb444({
  iron: 0x9ca4a2,
  copper: 0xb96d45,
  tin: 0xc8cfbd,
  coal: 0x2d2b28,
  handle: 0x7b5438,
  cloth: 0xe8dfc8,
}[id])));
const COMPONENT_CELL_COUNT = FORGE_COMPONENT_GRID.x * FORGE_COMPONENT_GRID.y * FORGE_COMPONENT_GRID.z;
const ZERO_Q = Object.freeze([0, 0, 0]);
// Any non-empty finite voxel volume has at least one surface in each of the six
// axis directions. With the v14 appearance header and its best coordinate
// palette, those six quads require at least 36 raw bytes.
const NCF1_MIN_BAKED_APPEARANCE_BYTES = 36;

export class Ncf1ValidationError extends Error {
  constructor(message, code = "invalid-ncf1") {
    super(message);
    this.name = "Ncf1ValidationError";
    this.code = code;
  }
}

export function quantizeForgeValue(value, scale = FORGE_FIXED_SCALE) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Ncf1ValidationError("Forge values must be finite numbers.", "non-finite-value");
  return Math.round(numeric * scale);
}

export function dequantizeForgeValue(value, scale = FORGE_FIXED_SCALE) {
  return finiteInteger(value, "fixed-point value") / scale;
}

// NCF1 v15 retains the 16-bit equipment-volume footprint while changing its
// unit from whole cm3 to a deterministic base-16 mm3 float. The smallest
// exponent whose 13-bit mantissa can contain the input is selected, and the
// mantissa is always floored so a design can never claim more material than
// the selected backpack slots actually contain.
export function encodeForgeVolumeMm3(value) {
  const volumeMm3 = safeUnsignedInteger(value, "equipment volumeMm3");
  let exponent = 0;
  let scale = 1;
  while (volumeMm3 > NCF1_VOLUME_MANTISSA_MAX * scale && exponent < NCF1_VOLUME_EXPONENT_MAX) {
    exponent += 1;
    scale *= NCF1_VOLUME_EXPONENT_BASE;
  }
  if (volumeMm3 > NCF1_VOLUME_MANTISSA_MAX * scale) {
    throw new Ncf1ValidationError("Equipment volume exceeds the NCF1 v15 range.", "integer-out-of-range");
  }
  const mantissa = Math.floor(volumeMm3 / scale);
  return exponent * (1 << NCF1_VOLUME_MANTISSA_BITS) + mantissa;
}

export function decodeForgeVolumeMm3(value) {
  const packed = integerInRange(value, 0, 0xffff, "packed equipment volume");
  const exponent = packed >>> NCF1_VOLUME_MANTISSA_BITS;
  const mantissa = packed & NCF1_VOLUME_MANTISSA_MAX;
  return mantissa * NCF1_VOLUME_EXPONENT_BASE ** exponent;
}

export function forgeVoxelIndex(x, y, z, grid = FORGE_COMPONENT_GRID) {
  return finiteInteger(x, "voxel x") + grid.x * (finiteInteger(y, "voxel y") + grid.y * finiteInteger(z, "voxel z"));
}

export function createForgeComponent(options = {}) {
  const solid = options.solid == null
    ? new Uint8Array(COMPONENT_CELL_COUNT).fill(1)
    : normalizeSolid(options.solid, COMPONENT_CELL_COUNT);
  return normalizeComponent({
    resourceId: options.resourceId ?? "iron",
    color444: options.color444 ?? options.color,
    dimsQ: options.dimsQ ?? vectorToQ(options.dims ?? [1, 1, 1]),
    offsetQ: options.offsetQ ?? vectorToQ(options.offset ?? ZERO_Q),
    grip: options.grip ?? normalizeGripInput(options),
    solid,
    paintQuads: options.paintQuads ?? [],
  }, 0);
}

export function createForgeDesign(options = {}) {
  if (options.appearance) {
    return canonicalizeForgeDesign({
      version: options.version ?? NCF1_VERSION,
      equipment: options.equipment ?? options.equipmentStats,
      appearance: options.appearance,
    });
  }
  const components = options.components?.length ? options.components : [createForgeComponent(options.component)];
  return canonicalizeForgeDesign({
    version: options.version ?? NCF1_VERSION,
    equipment: options.equipment ?? options.equipmentStats,
    components,
  });
}

export function canonicalizeForgeDesign(input = {}) {
  const version = normalizeNcf1Version(input?.version);
  const design = {
    version,
    equipment: normalizeEquipment(input.equipment ?? input.equipmentStats, version),
  };
  if (input.appearance) {
    design.appearance = normalizeAppearance(input.appearance);
  } else {
    if (!Array.isArray(input.components) || input.components.length < 1 || input.components.length > 31) {
      throw new Ncf1ValidationError("Component designs require 1-31 components.", "invalid-component-count");
    }
    design.components = input.components.map(normalizeComponent);
  }
  return design;
}

export function encodeNcf1Bytes(input) {
  const design = canonicalizeForgeDesign(input);
  const bytes = encodeCanonicalNcf1Bytes(design);
  assertNcf1ByteLength(bytes);
  return bytes;
}

// Component state remains the editable source of truth. This selector is for
// the immutable mint/submission boundary, where an appearance-only surface can
// be cheaper to store and reconstruct. Equal-size candidates deliberately keep
// components so editing information is never discarded without a byte saving.
// Raw identity changes when surfaceBaked is true: hashes and material proofs
// must be derived from the returned bytes/code, not from the component input.
export function selectCompactNcf1Encoding(input) {
  const sourceDesign = canonicalizeForgeDesign(input);
  const sourceBytes = encodeCanonicalNcf1Bytes(sourceDesign);
  if (sourceDesign.appearance) {
    assertNcf1ByteLength(sourceBytes);
    return compactNcf1Selection(sourceDesign, sourceBytes, sourceBytes.length, null, "appearance", sourceBytes.length);
  }
  // Cloth motion is reconstructed from component identity and bounds at
  // runtime. An appearance-only bake intentionally drops that editable
  // component metadata, so deformable designs stay component encoded even
  // when a static surface bake would save a few bytes.
  if (forgeDesignHasCloth(sourceDesign)) {
    assertNcf1ByteLength(sourceBytes);
    return compactNcf1Selection(sourceDesign, sourceBytes, sourceBytes.length, null);
  }
  if (sourceBytes.length <= NCF1_MIN_BAKED_APPEARANCE_BYTES) {
    assertNcf1ByteLength(sourceBytes);
    return compactNcf1Selection(sourceDesign, sourceBytes, sourceBytes.length, null);
  }

  let appearanceDesign = null;
  let appearanceBytes = null;
  let appearanceError = null;
  try {
    appearanceDesign = bakeCanonicalForgeComponentsToAppearance(sourceDesign);
    appearanceBytes = encodeCanonicalNcf1Bytes(appearanceDesign);
  } catch (error) {
    if (!(error instanceof Ncf1ValidationError)) throw error;
    appearanceError = error;
  }

  const useAppearance = appearanceBytes != null && appearanceBytes.length < sourceBytes.length;
  const design = useAppearance ? appearanceDesign : sourceDesign;
  const bytes = useAppearance ? appearanceBytes : sourceBytes;
  assertNcf1ByteLength(bytes);
  return compactNcf1Selection(
    design,
    bytes,
    sourceBytes.length,
    appearanceError,
    "components",
    appearanceBytes?.length ?? null,
  );
}

export function isForgeClothResource(resourceId) {
  return String(resourceId ?? "").trim().toLowerCase() === FORGE_CLOTH_RESOURCE_ID;
}

export function forgeDesignHasCloth(input) {
  const components = input?.components;
  if (Array.isArray(components)) {
    return components.some((component) => isForgeClothResource(component?.resourceId));
  }
  return Array.isArray(input?.appearance?.quads)
    && input.appearance.quads.some((quad) => isForgeClothResource(quad?.resourceId));
}

export function encodeCompactNcf1Bytes(input) {
  return selectCompactNcf1Encoding(input).bytes;
}

export function encodeCompactNcf1(input) {
  return selectCompactNcf1Encoding(input).code;
}

// Deterministically rasterizes editable component surfaces into the existing
// v14+ 24^3 appearance grid. It is intentionally a surface bake: equipment
// statistics stay byte-identical while component edit history is omitted.
export function bakeForgeComponentsToAppearance(input) {
  const design = canonicalizeForgeDesign(input);
  if (design.appearance) return design;
  return bakeCanonicalForgeComponentsToAppearance(design);
}

function bakeCanonicalForgeComponentsToAppearance(design) {
  const { dimsQ, centerQ } = forgeAppearanceBakeFrame(design.components);
  const volume = new Array(24 * 24 * 24).fill(null);

  for (let componentIndex = 0; componentIndex < design.components.length; componentIndex += 1) {
    rasterizeComponentAppearanceVolume(volume, design.components[componentIndex], componentIndex, dimsQ, centerQ);
    // Canonical component priority makes all later geometry invisible once
    // every appearance cell center already has an exact owner.
    if (volume.every((owner) => owner?.contains)) break;
  }

  const quads = greedyAppearanceVolume(volume, design.components, dimsQ, centerQ);
  if (!quads.length) throw new Ncf1ValidationError("Forge appearance bake produced no surfaces.", "empty-appearance-bake");
  const grip = forgeAppearanceBakeGrip(design.components, centerQ);
  return canonicalizeForgeDesign({
    version: design.version,
    equipment: design.equipment,
    appearance: { dimsQ, grip, quads },
  });
}

function encodeCanonicalNcf1Bytes(design) {
  const writer = new BitWriter();
  writer.write(design.version, 4);
  writeEquipment(writer, design.equipment, design.version);
  writer.write(design.appearance ? 1 : 0, 1);
  if (design.appearance) writeAppearance(writer, design.appearance);
  else writeComponents(writer, design.components);
  return writer.bytes();
}

function assertNcf1ByteLength(bytes) {
  if (bytes.length > NCF1_MAX_RAW_BYTES) {
    throw new Ncf1ValidationError(`Forge code is ${bytes.length} bytes; the limit is ${NCF1_MAX_RAW_BYTES}.`, "code-too-large");
  }
}

function compactNcf1Selection(
  design,
  bytes,
  sourceByteLength,
  appearanceError,
  sourceMode = "components",
  appearanceByteLength = null,
) {
  const mode = design.appearance ? "appearance" : "components";
  return {
    design,
    bytes,
    code: forgeBytesToCode(bytes),
    mode,
    sourceMode,
    surfaceBaked: sourceMode === "components" && mode === "appearance",
    sourceByteLength,
    appearanceByteLength,
    byteLength: bytes.length,
    savedBytes: Math.max(0, sourceByteLength - bytes.length),
    savedBps: sourceByteLength > 0
      ? Math.floor(Math.max(0, sourceByteLength - bytes.length) * 10_000 / sourceByteLength)
      : 0,
    appearanceError,
  };
}

export function encodeNcf1(input) {
  return forgeBytesToCode(encodeNcf1Bytes(input));
}

export function decodeNcf1(input, { requireCanonical = false } = {}) {
  const bytes = forgeCodeToBytes(input);
  if (!bytes.length) throw new Ncf1ValidationError("Forge code is empty.", "empty-code");
  const reader = new BitReader(bytes);
  const version = reader.read(4, "version");
  normalizeNcf1Version(version);
  const equipment = readEquipment(reader, version);
  const appearanceMode = reader.read(1, "design mode") === 1;
  const design = appearanceMode
    ? { version, equipment, appearance: readAppearance(reader) }
    : { version, equipment, components: readComponents(reader) };
  reader.finish();
  const normalized = canonicalizeForgeDesign(design);
  if (requireCanonical && !equalBytes(bytes, encodeNcf1Bytes(normalized))) {
    throw new Ncf1ValidationError("Forge code is valid but not canonically encoded.", "non-canonical-code");
  }
  return normalized;
}

// Matches the on-chain verifier: parse only version + the 104-bit equipment
// header. Geometry is intentionally neither decoded nor trusted here.
export function decodeNcf1EquipmentHeader(input, { maxBytes = NCF1_CHAIN_MAX_RAW_BYTES } = {}) {
  const byteLimit = normalizeNcf1ByteLimit(maxBytes);
  const bytes = forgeInputToRawBytes(input, byteLimit);
  if (bytes.length < Math.ceil(NCF1_EQUIPMENT_HEADER_BITS / 8)) {
    throw new Ncf1ValidationError("Forge code is truncated before the equipment header ends.", "truncated-code");
  }
  const reader = new BitReader(bytes);
  const version = reader.read(4, "version");
  normalizeNcf1Version(version);
  const equipment = readEquipment(reader, version);
  const attributes = equipment.attributes6.map((value) => forgeCompactAttributeScore(value));
  return {
    version,
    mass5g: equipment.mass5g,
    massGrams: equipment.mass5g * 5,
    volumeMm3: equipment.volumeMm3,
    volumeCm3: equipment.volumeCm3,
    attributes6: equipment.attributes6,
    attributes,
    attributeScores: Object.fromEntries(FORGE_ATTRIBUTE_KEYS.map((key, index) => [key, attributes[index]])),
    rawByteLength: bytes.length,
  };
}

export function validateNcf1(input, options = {}) {
  try {
    const bytes = forgeCodeToBytes(input);
    const design = decodeNcf1(bytes, options);
    return { ok: true, design, bytes, code: forgeBytesToCode(bytes) };
  } catch (error) {
    return {
      ok: false,
      error,
      code: error?.code || "invalid-ncf1",
      message: error?.message || String(error),
    };
  }
}

export function forgeCodeToBytes(input, { maxBytes = NCF1_MAX_RAW_BYTES } = {}) {
  return forgeCodeToBytesWithinLimit(input, normalizeNcf1ByteLimit(maxBytes), new Set());
}

function forgeCodeToBytesWithinLimit(input, maxBytes, seen = new Set()) {
  if (input instanceof Uint8Array) {
    assertNcf1InputByteLength(input.byteLength, maxBytes);
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    assertNcf1InputByteLength(input.byteLength, maxBytes);
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
  }
  if (input instanceof ArrayBuffer) {
    assertNcf1InputByteLength(input.byteLength, maxBytes);
    return new Uint8Array(input.slice(0));
  }
  if (Array.isArray(input)) {
    const length = input.length;
    assertNcf1InputByteLength(length, maxBytes);
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = integerInRange(input[index], 0, 255, "forge code byte");
    }
    return bytes;
  }
  if (input && typeof input === "object") {
    if (seen.has(input)) throw new Ncf1ValidationError("Forge code wrapper contains a cycle.", "invalid-code-input");
    seen.add(input);
    const wrappedBytes = input.bytes;
    if (wrappedBytes != null) return forgeCodeToBytesWithinLimit(wrappedBytes, maxBytes, seen);
    const wrappedCode = input.code;
    if (typeof wrappedCode === "string") return forgeCodeToBytesWithinLimit(wrappedCode, maxBytes, seen);
  }
  if (typeof input !== "string") {
    throw new Ncf1ValidationError("Forge code input must be a string, byte array, BufferSource, or code wrapper.", "invalid-code-input");
  }
  const text = input.trim();
  const encoded = text.startsWith(NCF1_PREFIX) ? text.slice(NCF1_PREFIX.length) : text;
  if (encoded.length > maxNcf1Base64UrlLength(maxBytes)) {
    throw new Ncf1ValidationError("Forge code exceeds the supported size.", "code-too-large");
  }
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Ncf1ValidationError("Forge code must be unpadded base64url.", "invalid-base64url");
  }
  const bytes = base64UrlToBytes(encoded);
  assertNcf1InputByteLength(bytes.byteLength, maxBytes);
  if (bytesToBase64Url(bytes) !== encoded) {
    throw new Ncf1ValidationError("Forge code must use canonical unpadded base64url.", "invalid-base64url");
  }
  return bytes;
}

export function forgeBytesToCode(input) {
  const bytes = forgeCodeToBytes(input);
  return `${NCF1_PREFIX}${bytesToBase64Url(bytes)}`;
}

export function fnv1a32(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : forgeCodeToByteArray(input);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Tag 8 sends decoded NCF1 bytes, so the chain identity is FNV-1a over those
// exact bytes. Validation mirrors the program and reads only the 108-bit
// equipment header; geometry is part of the hash but not the requirement rule.
export function forgeChainDesignHash(input, { validate = true } = {}) {
  const bytes = forgeInputToRawBytes(input);
  if (validate) validateForgeRequirementHeader(decodeNcf1EquipmentHeader(bytes));
  return fnv1a32(bytes);
}

// Compatibility name for local caches that already used the raw-byte hash.
export function forgeRawDesignHash(input, { validate = true } = {}) {
  const bytes = forgeInputToRawBytes(input);
  if (validate) decodeNcf1(bytes);
  return fnv1a32(bytes);
}

export function forgeCompactAttributeScore(value) {
  const compact = integerInRange(value, 0, 63, "compact forge attribute");
  return Math.floor((compact * 100 + 31) / 63);
}

export function forgeMaterialScoreFromCompactAttributes(input) {
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== FORGE_ATTRIBUTE_KEYS.length) {
    throw new Ncf1ValidationError("Forge material scoring requires exactly 12 compact attributes.", "invalid-equipment-attributes");
  }
  const attributes = Array.from(input, (value) => forgeCompactAttributeScore(value));
  const brittlenessPenalty = Math.max(0, attributes[4] - 55) * 18;
  const weightedScore = Math.max(0,
    attributes[1] * 30
    + attributes[2] * 25
    + attributes[0] * 20
    + attributes[11] * 15
    + attributes[3] * 10
    - brittlenessPenalty);
  return Math.max(0, Math.min(100, Math.floor((weightedScore + 50) / 100)));
}

export function forgeDesignStatsVector(input) {
  const header = decodeNcf1EquipmentHeader(input, { maxBytes: NCF1_MAX_RAW_BYTES });
  return [header.mass5g, header.volumeCm3, ...header.attributes6];
}

// The only authoritative requirements are volume and effective durability.
// All arithmetic mirrors programs/nicechunk_backpack/src/state.rs and depends
// solely on the integer NCF1 equipment header. Geometry affects only the raw
// design hash and presentation.
export function forgeMaterialRequirements(input) {
  const bytes = forgeInputToRawBytes(input);
  const header = validateForgeRequirementHeader(decodeNcf1EquipmentHeader(bytes));
  const materialScore = forgeMaterialScoreFromCompactAttributes(header.attributes6);
  const requiredVolumeMm3 = header.volumeMm3;
  const massRequirement = Math.floor((header.massGrams * 3 + 19) / 20);
  const volumeRequirement = integerSquareRoot(Math.floor(header.volumeMm3 / 1_000)) * 18;
  const baseAttributeRequirement = Math.floor((materialScore * 126 + 24) / 25);
  const attributeRequirement = header.version === NCF1_LEGACY_VERSION
    ? baseAttributeRequirement
    : Math.floor(baseAttributeRequirement * Math.min(header.volumeMm3, 1_000_000) / 1_000_000);
  const requiredEffectiveDurability = Math.max(1, massRequirement + volumeRequirement + attributeRequirement);
  const vector = [requiredVolumeMm3, requiredEffectiveDurability];
  return {
    version: header.version,
    hashAlgorithm: "fnv1a32-ncf1-raw",
    designHash: fnv1a32(bytes),
    requiredVolumeMm3,
    requiredEffectiveDurability,
    materialScore,
    keys: FORGE_MATERIAL_REQUIREMENT_KEYS,
    vector,
  };
}

export function normalizeForgeMaterialCapacity(input = {}) {
  if (isForgeMaterialSlot(input)) return forgeMaterialSlotCapacity(input);
  const source = input?.vector ?? input;
  if ((Array.isArray(source) || ArrayBuffer.isView(source)) && source.length !== FORGE_MATERIAL_CAPACITY_KEYS.length) {
    throw new Ncf1ValidationError("Forge material capacity vectors require exactly two fields.", "invalid-material-capacity");
  }
  const totalVolumeMm3 = safeUnsignedInteger(
    Array.isArray(source) || ArrayBuffer.isView(source)
      ? source[0]
      : source?.totalVolumeMm3 ?? source?.requiredVolumeMm3 ?? 0,
    "total material volume",
  );
  const totalEffectiveDurability = safeUnsignedInteger(
    Array.isArray(source) || ArrayBuffer.isView(source)
      ? source[1]
      : source?.totalEffectiveDurability ?? source?.requiredEffectiveDurability ?? 0,
    "total effective durability",
  );
  return materialCapacityResult(totalVolumeMm3, totalEffectiveDurability);
}

export function forgeMaterialSlotCapacity(input = {}) {
  const slot = normalizeForgeMaterialSlot(input);
  return materialCapacityResult(slot.volumeMm3, Math.floor(slot.cappedDurability * slot.qualityBps / 10_000));
}

function normalizeForgeMaterialSlot(input = {}) {
  const volumeMm3 = unsigned32(input?.volumeMm3 ?? 0, "material slot volume");
  const durabilityCurrent = unsigned32(input?.durabilityCurrent ?? 0, "material slot current durability");
  const durabilityMax = Math.max(1, unsigned32(input?.durabilityMax ?? 0, "material slot maximum durability"));
  const qualityBps = Math.max(1, Math.min(10_000, finiteInteger(input?.qualityBps ?? 1, "material slot quality")));
  const cappedDurability = Math.min(durabilityCurrent, durabilityMax);
  return { volumeMm3, cappedDurability, qualityBps };
}

export function sumForgeMaterialCapacities(inputs = []) {
  let totalVolumeMm3 = 0;
  let totalEffectiveDurability = 0;
  let slotEffectiveDurabilityNumerator = 0;
  for (const input of inputs ?? []) {
    if (isForgeMaterialSlot(input)) {
      const slot = normalizeForgeMaterialSlot(input);
      totalVolumeMm3 = checkedSafeAdd(totalVolumeMm3, slot.volumeMm3, "total material volume");
      slotEffectiveDurabilityNumerator = checkedSafeAdd(
        slotEffectiveDurabilityNumerator,
        slot.cappedDurability * slot.qualityBps,
        "total effective durability numerator",
      );
    } else {
      const capacity = normalizeForgeMaterialCapacity(input);
      totalVolumeMm3 = checkedSafeAdd(totalVolumeMm3, capacity.totalVolumeMm3, "total material volume");
      totalEffectiveDurability = checkedSafeAdd(totalEffectiveDurability, capacity.totalEffectiveDurability, "total effective durability");
    }
  }
  totalEffectiveDurability = checkedSafeAdd(
    totalEffectiveDurability,
    Math.floor(slotEffectiveDurabilityNumerator / 10_000),
    "total effective durability",
  );
  return materialCapacityResult(totalVolumeMm3, totalEffectiveDurability);
}

export function compareForgeMaterialCapacity(requirementsInput, capacityInput) {
  const requirements = isForgeRequirementLike(requirementsInput)
    ? normalizeForgeMaterialRequirementsVector(requirementsInput)
    : forgeMaterialRequirements(requirementsInput).vector;
  const capacity = normalizeForgeMaterialCapacity(capacityInput);
  const deficit = new Array(requirements.length);
  let ok = true;
  const fields = [];
  for (let index = 0; index < requirements.length; index += 1) {
    deficit[index] = Math.max(0, requirements[index] - capacity.vector[index]);
    if (deficit[index]) ok = false;
    fields.push({
      key: FORGE_MATERIAL_REQUIREMENT_KEYS[index],
      capacityKey: FORGE_MATERIAL_CAPACITY_KEYS[index],
      required: requirements[index],
      capacity: capacity.vector[index],
      deficit: deficit[index],
      ok: deficit[index] === 0,
    });
  }
  return { ok, requirements, capacity: capacity.vector, capacityTotals: capacity, deficit, fields };
}

export function createForgeMaterialProof(input) {
  const requirements = forgeMaterialRequirements(input);
  return {
    version: requirements.version,
    hashAlgorithm: requirements.hashAlgorithm,
    designHash: requirements.designHash,
    materialRequirements: Array.from(requirements.vector),
  };
}

export function verifyForgeMaterialProof(input, proof, capacityInput = null) {
  try {
    const expected = forgeMaterialRequirements(input);
    const supplied = normalizeForgeMaterialRequirementsVector(proof?.materialRequirements ?? []);
    if (proof?.version !== expected.version
      || proof?.hashAlgorithm !== expected.hashAlgorithm
      || unsigned32(proof?.designHash, "proof design hash") !== expected.designHash
      || !equalIntegerArrays(supplied, expected.vector)) {
      return { ok: false, reason: "proof-mismatch", expected };
    }
    if (capacityInput == null) return { ok: true, expected };
    const comparison = compareForgeMaterialCapacity(expected, capacityInput);
    return comparison.ok
      ? { ok: true, expected, comparison }
      : { ok: false, reason: "insufficient-material-capacity", expected, comparison };
  } catch (error) {
    return { ok: false, reason: error?.code || "invalid-proof", error };
  }
}

export function forgeDesignBoundsQ(input) {
  const design = canonicalizeForgeDesign(input);
  if (design.appearance) {
    const dims = design.appearance.dimsQ;
    return {
      minQ2: dims.map((value) => -value),
      maxQ2: dims.map((value) => value),
      sizeQ: [...dims],
      centerQ2: [0, 0, 0],
    };
  }
  const minQ2 = [Infinity, Infinity, Infinity];
  const maxQ2 = [-Infinity, -Infinity, -Infinity];
  for (const component of design.components) {
    for (let axis = 0; axis < 3; axis += 1) {
      minQ2[axis] = Math.min(minQ2[axis], component.offsetQ[axis] * 2 - component.dimsQ[axis]);
      maxQ2[axis] = Math.max(maxQ2[axis], component.offsetQ[axis] * 2 + component.dimsQ[axis]);
    }
  }
  return {
    minQ2,
    maxQ2,
    sizeQ: minQ2.map((value, axis) => Math.round((maxQ2[axis] - value) / 2)),
    centerQ2: minQ2.map((value, axis) => value + Math.round((maxQ2[axis] - value) / 2)),
  };
}

export function forgeDesignMaterialSummary(input) {
  const design = canonicalizeForgeDesign(input);
  const counts = Object.fromEntries(FORGE_RESOURCE_IDS.map((id) => [id, 0]));
  if (design.appearance) {
    for (const quad of design.appearance.quads) counts[FORGE_RESOURCE_IDS[quad.resource] ?? "iron"] += rectangleArea(quad);
  } else {
    for (const component of design.components) {
      let solidCells = 0;
      for (const value of component.solid) solidCells += value;
      counts[FORGE_RESOURCE_IDS[component.resource] ?? "iron"] += solidCells;
    }
  }
  return counts;
}

function normalizeEquipment(input = {}, version = NCF1_VERSION) {
  const mass5g = input?.mass5g != null
    ? integerInRange(input.mass5g, 0, 0xffff, "equipment mass5g")
    : integerInRange(Math.round((Number(input?.massGrams) || 0) / 5), 0, 0xffff, "equipment mass");
  let volumeMm3;
  let volumeCm3;
  if (version === NCF1_LEGACY_VERSION) {
    volumeCm3 = input?.volumeCm3 != null
      ? integerInRange(input.volumeCm3, 0, 0xffff, "equipment volume")
      : integerInRange(Math.floor(safeUnsignedInteger(input?.volumeMm3 ?? 0, "equipment volumeMm3") / 1_000), 0, 0xffff, "equipment volume");
    volumeMm3 = volumeCm3 * 1_000;
  } else {
    const requestedVolumeMm3 = input?.volumeMm3 != null
      ? safeUnsignedInteger(input.volumeMm3, "equipment volumeMm3")
      : safeUnsignedInteger((Number(input?.volumeCm3) || 0) * 1_000, "equipment volumeMm3");
    volumeMm3 = decodeForgeVolumeMm3(encodeForgeVolumeMm3(requestedVolumeMm3));
    volumeCm3 = volumeMm3 / 1_000;
  }
  const source = input?.attributes6 ?? input?.attributes ?? {};
  const attributes6 = new Uint8Array(FORGE_ATTRIBUTE_KEYS.length);
  for (let index = 0; index < attributes6.length; index += 1) {
    const key = FORGE_ATTRIBUTE_KEYS[index];
    const raw = Array.isArray(source) || ArrayBuffer.isView(source) ? source[index] : source?.[key];
    attributes6[index] = input?.attributes6 != null
      ? integerInRange(raw ?? 0, 0, 63, `equipment attribute ${key}`)
      : integerInRange(Math.round(clampInteger(raw ?? 0, 0, 100) * 63 / 100), 0, 63, `equipment attribute ${key}`);
  }
  return { mass5g, volumeMm3, volumeCm3, attributes6 };
}

function normalizeComponent(component, index = 0) {
  const resource = normalizeResource(component?.resource ?? component?.resourceId, `component ${index} resource`);
  const color444 = normalizeColor444(component?.color444 ?? component?.color, DEFAULT_RESOURCE_COLOR_RGB444[resource]);
  const dimsQ = normalizeVectorQ(component?.dimsQ ?? vectorToQ(component?.dims), 1, 0xff, `component ${index} dimensions`);
  const offsetQ = normalizeVectorQ(component?.offsetQ ?? vectorToQ(component?.offset), -512, 511, `component ${index} offset`);
  const solid = normalizeSolid(component?.solid, COMPONENT_CELL_COUNT);
  if (!solid.some(Boolean)) throw new Ncf1ValidationError(`Component ${index} cannot be empty.`, "empty-component");
  const grip = normalizeGrip(component?.grip ?? normalizeGripInput(component), 10, `component ${index} grip`);
  const paintSource = component?.paintQuads ?? paintRecordsToQuads(component?.paint ?? [], solid);
  const paintQuads = normalizePaintQuads(paintSource, solid, index);
  return { resource, resourceId: FORGE_RESOURCE_IDS[resource], color444, dimsQ, offsetQ, grip, solid, paintQuads };
}

function normalizeAppearance(appearance) {
  let dimsQ = appearance?.dimsQ ?? vectorToQ(appearance?.dims);
  dimsQ = normalizeVectorQ(dimsQ, 2, 0x1ff * 2, "appearance dimensions");
  for (const value of dimsQ) {
    if (value % 2 !== 0) throw new Ncf1ValidationError("Appearance dimensions must align to 1/32 units.", "invalid-appearance-dimensions");
  }
  const grip = normalizeGrip(appearance?.grip ?? normalizeGripInput(appearance), 11, "appearance grip");
  if (!Array.isArray(appearance?.quads) || appearance.quads.length < 1 || appearance.quads.length > 4095) {
    throw new Ncf1ValidationError("Appearance designs require 1-4095 quads.", "invalid-appearance-quad-count");
  }
  const quads = appearance.quads.map((quad, index) => normalizeAppearanceQuad(quad, index));
  quads.sort(compareQuad);
  rejectOverlappingQuads(quads, "appearance");
  return { dimsQ, grip, quads };
}

function normalizeAppearanceQuad(quad, index) {
  const axis = integerInRange(quad?.axis, 0, 2, `appearance quad ${index} axis`);
  const side = integerInRange(quad?.side, 0, 1, `appearance quad ${index} side`);
  const resource = normalizeResource(quad?.resource ?? quad?.resourceId, `appearance quad ${index} resource`);
  const plane = integerInRange(quad?.plane, 0, 24, `appearance quad ${index} plane`);
  const u0 = integerInRange(quad?.u0, 0, 24, `appearance quad ${index} u0`);
  const u1 = integerInRange(quad?.u1, 0, 24, `appearance quad ${index} u1`);
  const v0 = integerInRange(quad?.v0, 0, 24, `appearance quad ${index} v0`);
  const v1 = integerInRange(quad?.v1, 0, 24, `appearance quad ${index} v1`);
  if (u1 <= u0 || v1 <= v0) throw new Ncf1ValidationError(`Appearance quad ${index} has an empty range.`, "invalid-quad-range");
  const color444 = normalizeColor444(quad?.color444 ?? quad?.color, DEFAULT_RESOURCE_COLOR_RGB444[resource]);
  return { axis, side, resource, resourceId: FORGE_RESOURCE_IDS[resource], plane, u0, u1, v0, v1, color444 };
}

function normalizeGrip(grip, bits, label) {
  if (!grip) return null;
  const limit = 1 << (bits - 1);
  const offsetQ = normalizeVectorQ(grip.offsetQ ?? vectorToQ(grip.offset), -limit, limit - 1, `${label} offset`);
  let axis = grip.axis;
  let sign = grip.sign;
  if (axis == null && grip.normal != null) {
    const normal = vectorValues(grip.normal);
    const absolute = normal.map(Math.abs);
    axis = absolute.indexOf(Math.max(...absolute));
    sign = normal[axis] >= 0 ? 1 : -1;
  }
  axis = integerInRange(axis ?? 1, 0, 2, `${label} normal axis`);
  sign = Number(sign) >= 0 ? 1 : -1;
  const rotation = integerInRange(grip.rotation ?? grip.angleStep ?? Math.round((Number(grip.angle) || 0) / (Math.PI / 2)), 0, 3, `${label} rotation`);
  return { offsetQ, axis, sign, rotation };
}

function normalizeGripInput(input = {}) {
  const offset = input?.gripOffsetQ ?? input?.gripOffset;
  if (offset == null) return null;
  return {
    offsetQ: input?.gripOffsetQ ?? vectorToQ(input?.gripOffset),
    normal: input?.gripNormal,
    axis: input?.gripAxis,
    sign: input?.gripSign,
    rotation: input?.gripRotation,
    angle: input?.gripAngle,
  };
}

function normalizePaintQuads(quads, solid, componentIndex) {
  if (!Array.isArray(quads) || quads.length > 2047) throw new Ncf1ValidationError("Component paint exceeds 2,047 quads.", "paint-too-complex");
  const result = quads.map((quad, index) => {
    const axis = integerInRange(quad?.axis, 0, 2, `component ${componentIndex} paint ${index} axis`);
    const side = integerInRange(quad?.side, 0, 1, `component ${componentIndex} paint ${index} side`);
    const axes = tangentAxes(axis);
    const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
    const plane = integerInRange(quad?.plane, 0, sizes[axis], `component ${componentIndex} paint ${index} plane`);
    const u0 = integerInRange(quad?.u0, 0, sizes[axes[0]], `component ${componentIndex} paint ${index} u0`);
    const u1 = integerInRange(quad?.u1, 0, sizes[axes[0]], `component ${componentIndex} paint ${index} u1`);
    const v0 = integerInRange(quad?.v0, 0, sizes[axes[1]], `component ${componentIndex} paint ${index} v0`);
    const v1 = integerInRange(quad?.v1, 0, sizes[axes[1]], `component ${componentIndex} paint ${index} v1`);
    if (u1 <= u0 || v1 <= v0) throw new Ncf1ValidationError("Paint quads must have non-empty ranges.", "invalid-paint-range");
    const color444 = normalizeColor444(quad?.color444 ?? quad?.color, 0xfff);
    validatePaintSurface({ axis, side, plane, u0, u1, v0, v1 }, solid, `component ${componentIndex} paint ${index}`);
    return { axis, side, plane, u0, u1, v0, v1, color444 };
  });
  result.sort(compareQuad);
  rejectOverlappingQuads(result, `component ${componentIndex} paint`);
  return result;
}

function validatePaintSurface(quad, solid, label) {
  const axes = tangentAxes(quad.axis);
  const axisCell = quad.side ? quad.plane - 1 : quad.plane;
  const neighbor = quad.side ? axisCell + 1 : axisCell - 1;
  const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
  if (axisCell < 0 || axisCell >= sizes[quad.axis]) throw new Ncf1ValidationError(`${label} is outside the component.`, "paint-off-surface");
  for (let v = quad.v0; v < quad.v1; v += 1) {
    for (let u = quad.u0; u < quad.u1; u += 1) {
      const cell = [0, 0, 0];
      cell[quad.axis] = axisCell;
      cell[axes[0]] = u;
      cell[axes[1]] = v;
      if (!solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) throw new Ncf1ValidationError(`${label} covers an empty cell.`, "paint-off-surface");
      cell[quad.axis] = neighbor;
      if (neighbor >= 0 && neighbor < sizes[quad.axis] && solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) {
        throw new Ncf1ValidationError(`${label} covers an internal face.`, "paint-internal-face");
      }
    }
  }
}

function forgeAppearanceBakeFrame(components) {
  const minP = [Infinity, Infinity, Infinity];
  const maxP = [-Infinity, -Infinity, -Infinity];
  for (const component of components) {
    for (let axis = 0; axis < 3; axis += 1) {
      minP[axis] = Math.min(minP[axis], component.offsetQ[axis] * 2 - component.dimsQ[axis]);
      maxP[axis] = Math.max(maxP[axis], component.offsetQ[axis] * 2 + component.dimsQ[axis]);
    }
  }
  // Appearance geometry is centered by format. Shift geometry and grip by the
  // same integer Q6 center so their frame stays aligned while the 24^3 grid
  // spends resolution on occupied bounds. The v14 even-extent rule can expand
  // an odd packed bound by at most one position unit.
  const centerQ = minP.map((value, axis) => Math.round((value + maxP[axis]) / 4));
  const dimsQ = minP.map((value, axis) => {
    const centerP = centerQ[axis] * 2;
    const halfExtentP = Math.max(Math.abs(value - centerP), Math.abs(maxP[axis] - centerP));
    const dimension = Math.max(2, Math.ceil(halfExtentP / 2) * 2);
    if (dimension > 0x1ff * 2) {
      throw new Ncf1ValidationError(
        "Component bounds exceed the v14 appearance coordinate range.",
        "appearance-bake-out-of-range",
      );
    }
    return dimension;
  });
  return { dimsQ, centerQ };
}

function rasterizeComponentAppearanceVolume(volume, component, componentIndex, dimsQ, centerQ) {
  const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
  if (component.solid.every((value) => value === 1)) {
    rasterizeFullComponentAppearanceVolume(volume, component, componentIndex, dimsQ, centerQ, sizes);
    return;
  }
  let sourceOrder = 0;
  for (let z = 0; z < sizes[2]; z += 1) {
    for (let y = 0; y < sizes[1]; y += 1) {
      for (let x = 0; x < sizes[0]; x += 1) {
        if (!component.solid[forgeVoxelIndex(x, y, z)]) continue;
        const sourceCell = [x, y, z];
        const minP = sourceCell.map((coordinate, axis) => (
          forgeComponentBoundaryP(component, axis, coordinate, sizes[axis]) - centerQ[axis] * 2
        ));
        const maxP = sourceCell.map((coordinate, axis) => (
          forgeComponentBoundaryP(component, axis, coordinate + 1, sizes[axis]) - centerQ[axis] * 2
        ));
        const ranges = minP.map((value, axis) => (
          quantizeAppearanceCoverage(value, maxP[axis], dimsQ[axis])
        ));
        for (let targetZ = ranges[2][0]; targetZ < ranges[2][1]; targetZ += 1) {
          for (let targetY = ranges[1][0]; targetY < ranges[1][1]; targetY += 1) {
            for (let targetX = ranges[0][0]; targetX < ranges[0][1]; targetX += 1) {
              const targetIndex = forgeAppearanceVoxelIndex(targetX, targetY, targetZ);
              const current = volume[targetIndex];
              // Components and source voxels are visited in canonical priority
              // order. Once a target center is truly contained, no later
              // conservative-coverage candidate can improve its ownership.
              if (current?.contains) continue;
              const centerP = [
                appearanceCellCenterP(targetX, dimsQ[0]),
                appearanceCellCenterP(targetY, dimsQ[1]),
                appearanceCellCenterP(targetZ, dimsQ[2]),
              ];
              const contains = centerP.every((value, axis) => value >= minP[axis] && value < maxP[axis]);
              const distance = contains ? 0 : distanceToBoxSquared(centerP, minP, maxP);
              if (appearanceCandidateValuesWin(contains, distance, componentIndex, sourceOrder, current)) {
                volume[targetIndex] = { componentIndex, sourceCell, sourceOrder, contains, distance };
              }
            }
          }
        }
        sourceOrder += 1;
      }
    }
  }
}

function rasterizeFullComponentAppearanceVolume(volume, component, componentIndex, dimsQ, centerQ, sizes) {
  const minP = [0, 1, 2].map((axis) => (
    component.offsetQ[axis] * 2 - component.dimsQ[axis] - centerQ[axis] * 2
  ));
  const maxP = [0, 1, 2].map((axis) => (
    component.offsetQ[axis] * 2 + component.dimsQ[axis] - centerQ[axis] * 2
  ));
  const ranges = minP.map((value, axis) => quantizeAppearanceCoverage(value, maxP[axis], dimsQ[axis]));
  const centers = dimsQ.map((dimension) => Array.from(
    { length: 24 },
    (_, coordinate) => appearanceCellCenterP(coordinate, dimension),
  ));
  for (let targetZ = ranges[2][0]; targetZ < ranges[2][1]; targetZ += 1) {
    for (let targetY = ranges[1][0]; targetY < ranges[1][1]; targetY += 1) {
      for (let targetX = ranges[0][0]; targetX < ranges[0][1]; targetX += 1) {
        const targetIndex = forgeAppearanceVoxelIndex(targetX, targetY, targetZ);
        const current = volume[targetIndex];
        if (current?.contains) continue;
        const centerP = [centers[0][targetX], centers[1][targetY], centers[2][targetZ]];
        const contains = centerP.every((value, axis) => value >= minP[axis] && value < maxP[axis]);
        const distance = contains ? 0 : distanceToBoxSquared(centerP, minP, maxP);
        const sourceCell = centerP.map((value, axis) => clampInteger(
          Math.floor((value - minP[axis]) * sizes[axis] / (maxP[axis] - minP[axis])),
          0,
          sizes[axis] - 1,
        ));
        const sourceOrder = forgeVoxelIndex(sourceCell[0], sourceCell[1], sourceCell[2]);
        if (appearanceCandidateValuesWin(contains, distance, componentIndex, sourceOrder, current)) {
          volume[targetIndex] = { componentIndex, sourceCell, sourceOrder, contains, distance };
        }
      }
    }
  }
}

function appearanceSurfaceOwner(component, owner, axis, side, centerQ) {
  const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
  const sourcePlane = owner.sourceCell[axis] + (side ? 1 : 0);
  return {
    componentIndex: owner.componentIndex,
    sourceCell: owner.sourceCell,
    sourceOrder: owner.sourceOrder,
    boundaryP: forgeComponentBoundaryP(
      component,
      axis,
      sourcePlane,
      sizes[axis],
    ) - centerQ[axis] * 2,
    exposed: forgeComponentSourceFaceExposed(component, owner.sourceCell, axis, side, sizes),
    // This is only a topology fallback. The source-surface pass below has the
    // actual target-face center and replaces it with a spatially ranked owner.
    containsTangential: false,
    tangentDistance: Infinity,
  };
}

function rasterizeComponentAppearanceSurfaceOwners(planes, component, componentIndex, dimsQ, centerQ) {
  const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
  const centers = dimsQ.map((dimension) => Array.from(
    { length: 24 },
    (_, coordinate) => appearanceCellCenterP(coordinate, dimension),
  ));
  if (component.solid.every((value) => value === 1)) {
    rasterizeFullComponentAppearanceSurfaceOwners(
      planes,
      component,
      componentIndex,
      dimsQ,
      centerQ,
      sizes,
      centers,
    );
    return;
  }
  for (let z = 0; z < sizes[2]; z += 1) {
    for (let y = 0; y < sizes[1]; y += 1) {
      for (let x = 0; x < sizes[0]; x += 1) {
        if (!component.solid[forgeVoxelIndex(x, y, z)]) continue;
        const sourceCell = [x, y, z];
        const minP = sourceCell.map((coordinate, axis) => (
          forgeComponentBoundaryP(component, axis, coordinate, sizes[axis]) - centerQ[axis] * 2
        ));
        const maxP = sourceCell.map((coordinate, axis) => (
          forgeComponentBoundaryP(component, axis, coordinate + 1, sizes[axis]) - centerQ[axis] * 2
        ));
        const ranges = minP.map((value, axis) => (
          quantizeAppearanceCoverage(value, maxP[axis], dimsQ[axis])
        ));
        const sourceOrder = forgeVoxelIndex(x, y, z);
        for (let axis = 0; axis < 3; axis += 1) {
          for (const side of [0, 1]) {
            const neighbor = [...sourceCell];
            neighbor[axis] += side ? 1 : -1;
            if (forgeCellInsideGrid(neighbor, sizes)
              && component.solid[forgeVoxelIndex(neighbor[0], neighbor[1], neighbor[2])]) continue;
            rasterizeAppearanceSurfaceOwnerFace({
              planes,
              componentIndex,
              sourceCell,
              sourceOrder,
              axis,
              side,
              minP,
              maxP,
              ranges,
              centers,
            });
          }
        }
      }
    }
  }
}

function rasterizeFullComponentAppearanceSurfaceOwners(
  planes,
  component,
  componentIndex,
  dimsQ,
  centerQ,
  sizes,
  centers,
) {
  for (let axis = 0; axis < 3; axis += 1) {
    const axes = tangentAxes(axis);
    for (const side of [0, 1]) {
      for (let v = 0; v < sizes[axes[1]]; v += 1) {
        for (let u = 0; u < sizes[axes[0]]; u += 1) {
          const sourceCell = [0, 0, 0];
          sourceCell[axis] = side ? sizes[axis] - 1 : 0;
          sourceCell[axes[0]] = u;
          sourceCell[axes[1]] = v;
          const minP = sourceCell.map((coordinate, candidateAxis) => (
            forgeComponentBoundaryP(component, candidateAxis, coordinate, sizes[candidateAxis])
              - centerQ[candidateAxis] * 2
          ));
          const maxP = sourceCell.map((coordinate, candidateAxis) => (
            forgeComponentBoundaryP(component, candidateAxis, coordinate + 1, sizes[candidateAxis])
              - centerQ[candidateAxis] * 2
          ));
          const ranges = minP.map((value, candidateAxis) => (
            quantizeAppearanceCoverage(value, maxP[candidateAxis], dimsQ[candidateAxis])
          ));
          rasterizeAppearanceSurfaceOwnerFace({
            planes,
            componentIndex,
            sourceCell,
            sourceOrder: forgeVoxelIndex(sourceCell[0], sourceCell[1], sourceCell[2]),
            axis,
            side,
            minP,
            maxP,
            ranges,
            centers,
          });
        }
      }
    }
  }
}

function rasterizeAppearanceSurfaceOwnerFace({
  planes,
  componentIndex,
  sourceCell,
  sourceOrder,
  axis,
  side,
  minP,
  maxP,
  ranges,
  centers,
}) {
  const plane = side ? ranges[axis][1] : ranges[axis][0];
  const target = planes.get(`${axis}:${side}:${plane}`);
  if (!target) return;
  const axes = tangentAxes(axis);
  const boundaryP = side ? maxP[axis] : minP[axis];
  for (let targetV = ranges[axes[1]][0]; targetV < ranges[axes[1]][1]; targetV += 1) {
    const centerV = centers[axes[1]][targetV];
    for (let targetU = ranges[axes[0]][0]; targetU < ranges[axes[0]][1]; targetU += 1) {
      const centerU = centers[axes[0]][targetU];
      const containsTangential = centerU >= minP[axes[0]] && centerU < maxP[axes[0]]
        && centerV >= minP[axes[1]] && centerV < maxP[axes[1]];
      const tangentDistance = distanceToRectangleSquared(
        centerU,
        centerV,
        minP[axes[0]],
        maxP[axes[0]],
        minP[axes[1]],
        maxP[axes[1]],
      );
      const targetIndex = targetU + 24 * targetV;
      const candidate = {
        componentIndex,
        sourceCell,
        sourceOrder,
        boundaryP,
        exposed: true,
        containsTangential,
        tangentDistance,
      };
      if (appearanceSurfaceCandidateWins(candidate, target.cells[targetIndex], side)) {
        target.cells[targetIndex] = candidate;
      }
    }
  }
}

function greedyAppearanceVolume(volume, components, dimsQ, centerQ) {
  const planes = new Map();
  for (let z = 0; z < 24; z += 1) {
    for (let y = 0; y < 24; y += 1) {
      for (let x = 0; x < 24; x += 1) {
        const owner = volume[forgeAppearanceVoxelIndex(x, y, z)];
        if (!owner) continue;
        const cell = [x, y, z];
        const component = components[owner.componentIndex];
        for (let axis = 0; axis < 3; axis += 1) {
          const axes = tangentAxes(axis);
          for (const side of [0, 1]) {
            const neighbor = [...cell];
            neighbor[axis] += side ? 1 : -1;
            if (forgeCellInsideGrid(neighbor, [24, 24, 24])
              && volume[forgeAppearanceVoxelIndex(neighbor[0], neighbor[1], neighbor[2])]) continue;
            const plane = cell[axis] + (side ? 1 : 0);
            const key = `${axis}:${side}:${plane}`;
            let target = planes.get(key);
            if (!target) {
              target = { axis, side, plane, cells: new Array(24 * 24).fill(null) };
              planes.set(key, target);
            }
            target.cells[cell[axes[0]] + 24 * cell[axes[1]]] = appearanceSurfaceOwner(
              component,
              owner,
              axis,
              side,
              centerQ,
            );
          }
        }
      }
    }
  }

  // Volume ownership determines topology, but each final face needs its own
  // material owner. A sub-cell protrusion can extend the union boundary without
  // containing the target-cell center; choosing the physically outermost
  // source face preserves that visible material and any paint on it.
  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    rasterizeComponentAppearanceSurfaceOwners(
      planes,
      components[componentIndex],
      componentIndex,
      dimsQ,
      centerQ,
    );
  }

  const paint = components.map((component) => componentPaintCellLookup(component.paintQuads));
  const quads = [];
  const ordered = [...planes.values()].sort((a, b) => (
    a.axis - b.axis || a.side - b.side || a.plane - b.plane
  ));
  for (const entry of ordered) {
    const mask = Uint32Array.from(entry.cells, (owner) => {
      if (!owner) return 0;
      const component = components[owner.componentIndex];
      const axes = tangentAxes(entry.axis);
      const sourcePlane = owner.sourceCell[entry.axis] + (entry.side ? 1 : 0);
      const sourceU = owner.sourceCell[axes[0]];
      const sourceV = owner.sourceCell[axes[1]];
      const color444 = paint[owner.componentIndex].get(
        faceCellKey(entry.axis, entry.side, sourcePlane, sourceU, sourceV),
      ) ?? component.color444;
      return 1 + (component.resource << 12) + color444;
    });
    greedyAppearanceMask(mask, 24, 24, (u0, v0, u1, v1, value) => {
      const packed = value - 1;
      const resource = packed >> 12;
      quads.push({
        axis: entry.axis,
        side: entry.side,
        resource,
        resourceId: FORGE_RESOURCE_IDS[resource],
        plane: entry.plane,
        u0,
        u1,
        v0,
        v1,
        color444: packed & 0xfff,
      });
    });
  }
  return quads;
}

function greedyAppearanceMask(mask, width, height, append) {
  for (let v = 0; v < height; v += 1) {
    for (let u = 0; u < width; u += 1) {
      const value = mask[u + width * v];
      if (!value) continue;
      let runWidth = 1;
      while (u + runWidth < width && mask[u + runWidth + width * v] === value) runWidth += 1;
      let runHeight = 1;
      scan: while (v + runHeight < height) {
        for (let x = 0; x < runWidth; x += 1) {
          if (mask[u + x + width * (v + runHeight)] !== value) break scan;
        }
        runHeight += 1;
      }
      for (let y = 0; y < runHeight; y += 1) {
        for (let x = 0; x < runWidth; x += 1) mask[u + x + width * (v + y)] = 0;
      }
      append(u, v, u + runWidth, v + runHeight, value);
    }
  }
}

function forgeAppearanceBakeGrip(components, centerQ) {
  const component = components.find((candidate) => candidate.grip);
  if (!component) return null;
  const grip = component.grip;
  const offsetQ = grip.offsetQ.map((value, axis) => value + component.offsetQ[axis] - centerQ[axis]);
  for (const value of offsetQ) {
    if (value < -1024 || value > 1023) {
      throw new Ncf1ValidationError(
        "Component grip exceeds the v14 appearance coordinate range.",
        "appearance-grip-out-of-range",
      );
    }
  }
  return { offsetQ, axis: grip.axis, sign: grip.sign, rotation: grip.rotation };
}

function componentPaintCellLookup(quads) {
  const lookup = new Map();
  for (const quad of quads) {
    for (let v = quad.v0; v < quad.v1; v += 1) {
      for (let u = quad.u0; u < quad.u1; u += 1) {
        lookup.set(faceCellKey(quad.axis, quad.side, quad.plane, u, v), quad.color444);
      }
    }
  }
  return lookup;
}

function faceCellKey(axis, side, plane, u, v) {
  return `${axis}:${side}:${plane}:${u}:${v}`;
}

function forgeComponentBoundaryP(component, axis, coordinate, cells) {
  return component.offsetQ[axis] * 2 - component.dimsQ[axis]
    + Math.round(coordinate * component.dimsQ[axis] * 2 / cells);
}

function quantizeAppearanceCoverage(minP, maxP, halfExtentP) {
  const start = clampInteger(Math.floor((minP + halfExtentP) * 24 / (halfExtentP * 2)), 0, 23);
  const end = clampInteger(Math.ceil((maxP + halfExtentP) * 24 / (halfExtentP * 2)), 1, 24);
  return end > start ? [start, end] : [start, Math.min(24, start + 1)];
}

function appearanceCellCenterP(coordinate, halfExtentP) {
  return -halfExtentP + (coordinate * 2 + 1) * halfExtentP / 24;
}

function forgeAppearanceVoxelIndex(x, y, z) {
  return x + 24 * (y + 24 * z);
}

function distanceToBoxSquared(point, min, max) {
  let distance = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const delta = point[axis] < min[axis]
      ? min[axis] - point[axis]
      : point[axis] > max[axis] ? point[axis] - max[axis] : 0;
    distance += delta * delta;
  }
  return distance;
}

function distanceToRectangleSquared(u, v, u0, u1, v0, v1) {
  const du = u < u0 ? u0 - u : u > u1 ? u - u1 : 0;
  const dv = v < v0 ? v0 - v : v > v1 ? v - v1 : 0;
  return du * du + dv * dv;
}

function appearanceSurfaceCandidateWins(candidate, current, side) {
  if (!current) return true;
  if (candidate.boundaryP !== current.boundaryP) {
    return side ? candidate.boundaryP > current.boundaryP : candidate.boundaryP < current.boundaryP;
  }
  if (candidate.exposed !== current.exposed) return candidate.exposed;
  if (candidate.containsTangential !== current.containsTangential) return candidate.containsTangential;
  if (candidate.tangentDistance !== current.tangentDistance) {
    return candidate.tangentDistance < current.tangentDistance;
  }
  if (candidate.componentIndex !== current.componentIndex) return candidate.componentIndex < current.componentIndex;
  if (candidate.sourceOrder !== current.sourceOrder) return candidate.sourceOrder < current.sourceOrder;
  return false;
}

function forgeComponentSourceFaceExposed(component, sourceCell, axis, side, sizes) {
  const neighbor = [...sourceCell];
  neighbor[axis] += side ? 1 : -1;
  return !forgeCellInsideGrid(neighbor, sizes)
    || !component.solid[forgeVoxelIndex(neighbor[0], neighbor[1], neighbor[2])];
}

function appearanceCandidateValuesWin(contains, distance, componentIndex, sourceOrder, current) {
  if (!current) return true;
  if (contains !== current.contains) return contains;
  if (distance !== current.distance) return distance < current.distance;
  if (componentIndex !== current.componentIndex) return componentIndex < current.componentIndex;
  if (sourceOrder !== current.sourceOrder) return sourceOrder < current.sourceOrder;
  return false;
}

function forgeCellInsideGrid(cell, sizes) {
  return cell[0] >= 0 && cell[1] >= 0 && cell[2] >= 0
    && cell[0] < sizes[0] && cell[1] < sizes[1] && cell[2] < sizes[2];
}

function writeEquipment(writer, equipment, version) {
  writer.write(equipment.mass5g, 16);
  writer.write(version === NCF1_LEGACY_VERSION
    ? equipment.volumeCm3
    : encodeForgeVolumeMm3(equipment.volumeMm3), 16);
  for (const value of equipment.attributes6) writer.write(value, 6);
}

function readEquipment(reader, version) {
  const mass5g = reader.read(16, "equipment mass");
  const packedVolume = reader.read(16, "equipment volume");
  const volumeMm3 = version === NCF1_LEGACY_VERSION
    ? packedVolume * 1_000
    : decodeForgeVolumeMm3(packedVolume);
  const volumeCm3 = volumeMm3 / 1_000;
  const attributes6 = new Uint8Array(FORGE_ATTRIBUTE_KEYS.length);
  for (let index = 0; index < attributes6.length; index += 1) attributes6[index] = reader.read(6, `equipment attribute ${index}`);
  return { mass5g, volumeMm3, volumeCm3, attributes6 };
}

function writeComponents(writer, components) {
  writer.write(components.length, 5);
  for (const component of components) {
    writer.write(component.resource, 3);
    const defaultColor = component.color444 === DEFAULT_RESOURCE_COLOR_RGB444[component.resource];
    writer.write(defaultColor ? 1 : 0, 1);
    if (!defaultColor) writer.write(component.color444, 12);
    for (const value of component.dimsQ) writer.write(value, 8);
    const zeroOffset = component.offsetQ.every((value) => value === 0);
    writer.write(zeroOffset ? 1 : 0, 1);
    if (!zeroOffset) for (const value of component.offsetQ) writer.writeSigned(value, 10);
    writer.write(component.grip ? 1 : 0, 1);
    if (component.grip) writeGrip(writer, component.grip, 10);
    writeSolid(writer, component.solid);
    writer.write(component.paintQuads.length, 11);
    for (const quad of component.paintQuads) writePaintQuad(writer, quad);
  }
}

function readComponents(reader) {
  const count = reader.read(5, "component count");
  if (count < 1 || count > 31) throw new Ncf1ValidationError("Component count must be 1-31.", "invalid-component-count");
  const components = [];
  for (let index = 0; index < count; index += 1) {
    const resource = readResource(reader, `component ${index} resource`);
    const color444 = reader.read(1, `component ${index} default color`)
      ? DEFAULT_RESOURCE_COLOR_RGB444[resource]
      : reader.read(12, `component ${index} color`);
    const dimsQ = [0, 1, 2].map((axis) => reader.read(8, `component ${index} dimension ${axis}`));
    const offsetQ = reader.read(1, `component ${index} zero offset`)
      ? [0, 0, 0]
      : [0, 1, 2].map((axis) => reader.readSigned(10, `component ${index} offset ${axis}`));
    const grip = reader.read(1, `component ${index} grip flag`) ? readGrip(reader, 10, `component ${index} grip`) : null;
    const solid = readSolid(reader);
    const paintCount = reader.read(11, `component ${index} paint count`);
    const paintQuads = [];
    for (let paintIndex = 0; paintIndex < paintCount; paintIndex += 1) paintQuads.push(readPaintQuad(reader, index, paintIndex));
    components.push({ resource, resourceId: FORGE_RESOURCE_IDS[resource], color444, dimsQ, offsetQ, grip, solid, paintQuads });
  }
  return components;
}

function writeGrip(writer, grip, bits) {
  for (const value of grip.offsetQ) writer.writeSigned(value, bits);
  writer.write((grip.axis << 1) | (grip.sign > 0 ? 1 : 0), 3);
  writer.write(grip.rotation, 2);
}

function readGrip(reader, bits, label) {
  const offsetQ = [0, 1, 2].map((axis) => reader.readSigned(bits, `${label} offset ${axis}`));
  const packed = reader.read(3, `${label} normal`);
  const axis = packed >> 1;
  if (axis > 2) throw new Ncf1ValidationError(`${label} has an invalid normal axis.`, "invalid-normal");
  return { offsetQ, axis, sign: packed & 1 ? 1 : -1, rotation: reader.read(2, `${label} rotation`) };
}

function writePaintQuad(writer, quad) {
  writer.write(quad.axis, 2);
  writer.write(quad.side, 1);
  writer.write(quad.plane, 4);
  writer.write(quad.u0, 4);
  writer.write(quad.u1, 4);
  writer.write(quad.v0, 4);
  writer.write(quad.v1, 4);
  writer.write(quad.color444, 12);
}

function readPaintQuad(reader, componentIndex, paintIndex) {
  const label = `component ${componentIndex} paint ${paintIndex}`;
  const axis = reader.read(2, `${label} axis`);
  if (axis > 2) throw new Ncf1ValidationError(`${label} has an invalid axis.`, "invalid-axis");
  return {
    axis,
    side: reader.read(1, `${label} side`),
    plane: reader.read(4, `${label} plane`),
    u0: reader.read(4, `${label} u0`),
    u1: reader.read(4, `${label} u1`),
    v0: reader.read(4, `${label} v0`),
    v1: reader.read(4, `${label} v1`),
    color444: reader.read(12, `${label} color`),
  };
}

function writeAppearance(writer, appearance) {
  for (const value of appearance.dimsQ) writer.write(value / 2, 9);
  writer.write(appearance.grip ? 1 : 0, 1);
  if (appearance.grip) writeGrip(writer, appearance.grip, 11);
  writer.write(appearance.quads.length, 12);
  const palette = coordinatePalette(appearance.quads);
  const directBits = 1 + appearance.quads.reduce((sum, quad) => sum + compressedQuadBits(quad, 5), 0);
  const paletteBits = 1 + 5 + palette.length * 5 + appearance.quads.reduce((sum, quad) => sum + compressedQuadBits(quad, paletteBitWidth(palette)), 0);
  const usePalette = palette.length > 0 && paletteBits < directBits;
  writer.write(usePalette ? 1 : 0, 1);
  if (usePalette) {
    writer.write(palette.length, 5);
    for (const value of palette) writer.write(value, 5);
  }
  for (const quad of appearance.quads) writeCompressedAppearanceQuad(writer, quad, usePalette ? palette : null);
}

function readAppearance(reader) {
  const dimsQ = [0, 1, 2].map((axis) => reader.read(9, `appearance dimension ${axis}`) * 2);
  const grip = reader.read(1, "appearance grip flag") ? readGrip(reader, 11, "appearance grip") : null;
  const count = reader.read(12, "appearance quad count");
  if (count < 1) throw new Ncf1ValidationError("Appearance must contain at least one quad.", "invalid-appearance-quad-count");
  let palette = null;
  if (reader.read(1, "appearance coordinate palette flag")) {
    const paletteCount = reader.read(5, "appearance coordinate palette count");
    if (paletteCount < 1) throw new Ncf1ValidationError("Coordinate palettes cannot be empty.", "invalid-coordinate-palette");
    palette = [];
    for (let index = 0; index < paletteCount; index += 1) {
      const value = reader.read(5, `appearance coordinate palette ${index}`);
      if (index && value <= palette[index - 1]) throw new Ncf1ValidationError("Coordinate palettes must be strictly sorted.", "invalid-coordinate-palette");
      palette.push(value);
    }
  }
  const quads = [];
  for (let index = 0; index < count; index += 1) quads.push(readCompressedAppearanceQuad(reader, palette, index));
  return { dimsQ, grip, quads };
}

function writeCompressedAppearanceQuad(writer, quad, palette) {
  const fullU = quad.u0 === 0 && quad.u1 === FORGE_APPEARANCE_GRID.x;
  const fullV = quad.v0 === 0 && quad.v1 === FORGE_APPEARANCE_GRID.y;
  if (fullU && fullV) {
    writer.write(0, 1);
    writeAppearanceQuadHeader(writer, quad, palette);
  } else if (fullU || fullV) {
    writer.write(2, 2);
    writeAppearanceQuadHeader(writer, quad, palette);
    writer.write(fullU ? 1 : 0, 1);
    writeAppearanceCoord(writer, fullU ? quad.v0 : quad.u0, palette);
    writeAppearanceCoord(writer, fullU ? quad.v1 : quad.u1, palette);
  } else {
    writer.write(3, 2);
    writeAppearanceQuadHeader(writer, quad, palette);
    writeAppearanceCoord(writer, quad.u0, palette);
    writeAppearanceCoord(writer, quad.u1, palette);
    writeAppearanceCoord(writer, quad.v0, palette);
    writeAppearanceCoord(writer, quad.v1, palette);
  }
}

function readCompressedAppearanceQuad(reader, palette, index) {
  const first = reader.read(1, `appearance quad ${index} compression`);
  if (!first) {
    return { ...readAppearanceQuadHeader(reader, palette, index), u0: 0, u1: 24, v0: 0, v1: 24 };
  }
  const general = reader.read(1, `appearance quad ${index} compression mode`);
  const header = readAppearanceQuadHeader(reader, palette, index);
  if (general) {
    return {
      ...header,
      u0: readAppearanceCoord(reader, palette, index),
      u1: readAppearanceCoord(reader, palette, index),
      v0: readAppearanceCoord(reader, palette, index),
      v1: readAppearanceCoord(reader, palette, index),
    };
  }
  const rangeIsV = reader.read(1, `appearance quad ${index} range axis`);
  const start = readAppearanceCoord(reader, palette, index);
  const end = readAppearanceCoord(reader, palette, index);
  return {
    ...header,
    u0: rangeIsV ? 0 : start,
    u1: rangeIsV ? 24 : end,
    v0: rangeIsV ? start : 0,
    v1: rangeIsV ? end : 24,
  };
}

function writeAppearanceQuadHeader(writer, quad, palette) {
  writer.write(quad.axis, 2);
  writer.write(quad.side, 1);
  writer.write(quad.resource, 3);
  writeAppearanceCoord(writer, quad.plane, palette);
  writer.write(quad.color444, 12);
}

function readAppearanceQuadHeader(reader, palette, index) {
  const axis = reader.read(2, `appearance quad ${index} axis`);
  if (axis > 2) throw new Ncf1ValidationError(`Appearance quad ${index} has an invalid axis.`, "invalid-axis");
  const side = reader.read(1, `appearance quad ${index} side`);
  const resource = readResource(reader, `appearance quad ${index} resource`);
  return {
    axis,
    side,
    resource,
    resourceId: FORGE_RESOURCE_IDS[resource],
    plane: readAppearanceCoord(reader, palette, index),
    color444: reader.read(12, `appearance quad ${index} color`),
  };
}

function writeAppearanceCoord(writer, value, palette) {
  if (!palette) writer.write(value, 5);
  else writer.write(palette.indexOf(value), paletteBitWidth(palette));
}

function readAppearanceCoord(reader, palette, index) {
  if (!palette) return reader.read(5, `appearance quad ${index} coordinate`);
  const paletteIndex = reader.read(paletteBitWidth(palette), `appearance quad ${index} palette index`);
  if (paletteIndex >= palette.length) throw new Ncf1ValidationError("Appearance quad uses a missing palette coordinate.", "invalid-coordinate-palette-index");
  return palette[paletteIndex];
}

function coordinatePalette(quads) {
  const values = new Set();
  for (const quad of quads) for (const key of ["plane", "u0", "u1", "v0", "v1"]) values.add(quad[key]);
  return [...values].sort((a, b) => a - b).slice(0, 31);
}

function paletteBitWidth(palette) {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, palette.length))));
}

function compressedQuadBits(quad, coordinateBits) {
  const fullU = quad.u0 === 0 && quad.u1 === 24;
  const fullV = quad.v0 === 0 && quad.v1 === 24;
  const header = 2 + 1 + 3 + coordinateBits + 12;
  if (fullU && fullV) return 1 + header;
  if (fullU || fullV) return 2 + header + 1 + coordinateBits * 2;
  return 2 + header + coordinateBits * 4;
}

function writeSolid(writer, solid) {
  const best = bestSolidEncoding(solid);
  if (best.mode === "full") {
    writer.write(1, 2);
  } else if (best.mode === "boxes") {
    writer.write(2, 2);
    writer.write(best.boxes.length, 5);
    for (const box of best.boxes) for (const key of ["x", "y", "z", "sx", "sy", "sz"]) writer.write(box[key], 4);
  } else if (best.mode === "extruded") {
    writer.write(3, 2);
    writer.write(best.axis, 2);
    writeRuns(writer, best.mask, 8);
  } else {
    writer.write(0, 2);
    writeRuns(writer, solid, 11);
  }
}

function readSolid(reader) {
  const mode = reader.read(2, "solid encoding mode");
  if (mode === 1) return new Uint8Array(COMPONENT_CELL_COUNT).fill(1);
  if (mode === 2) return readCutBoxes(reader);
  if (mode === 3) return readExtrudedMask(reader);
  return readRuns(reader, COMPONENT_CELL_COUNT, 11, "solid voxel runs");
}

function bestSolidEncoding(solid) {
  if (solid.every((value) => value === 1)) return { mode: "full", bits: 2 };
  let best = { mode: "rle", bits: 2 + runBitLength(solid, 11) };
  const boxes = cutBoxes(solid);
  if (boxes?.length) {
    const bits = 2 + 5 + boxes.length * 24;
    if (bits < best.bits) best = { mode: "boxes", boxes, bits };
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const mask = extrudedMask(solid, axis);
    if (!mask) continue;
    const bits = 2 + 2 + runBitLength(mask, 8);
    if (bits < best.bits) best = { mode: "extruded", axis, mask, bits };
  }
  return best;
}

function writeRuns(writer, values, lengthBits) {
  const max = (1 << lengthBits) - 1;
  const runs = collectRuns(values, max);
  writer.write(values[0] ?? 0, 1);
  writer.write(runs.length, lengthBits);
  for (const length of runs) writer.write(length, lengthBits);
}

function readRuns(reader, total, lengthBits, label) {
  const out = new Uint8Array(total);
  let value = reader.read(1, `${label} initial value`);
  const count = reader.read(lengthBits, `${label} count`);
  if (!count) throw new Ncf1ValidationError(`${label} cannot be empty.`, "invalid-runs");
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const length = reader.read(lengthBits, `${label} length ${index}`);
    if (!length || cursor + length > total) throw new Ncf1ValidationError(`${label} do not match their target size.`, "invalid-runs");
    out.fill(value, cursor, cursor + length);
    cursor += length;
    value ^= 1;
  }
  if (cursor !== total) throw new Ncf1ValidationError(`${label} are truncated.`, "invalid-runs");
  return out;
}

function collectRuns(values, max) {
  const runs = [];
  let current = values[0] ?? 0;
  let length = 0;
  for (const value of values) {
    if (value === current && length < max) length += 1;
    else {
      runs.push(length);
      current = value;
      length = 1;
    }
  }
  runs.push(length);
  return runs;
}

function runBitLength(values, lengthBits) {
  return 1 + lengthBits + collectRuns(values, (1 << lengthBits) - 1).length * lengthBits;
}

function readCutBoxes(reader) {
  const count = reader.read(5, "cut box count");
  if (!count) throw new Ncf1ValidationError("Cut-box encoding requires at least one box.", "invalid-cut-boxes");
  const solid = new Uint8Array(COMPONENT_CELL_COUNT).fill(1);
  const removed = new Uint8Array(COMPONENT_CELL_COUNT);
  for (let index = 0; index < count; index += 1) {
    const box = {};
    for (const key of ["x", "y", "z", "sx", "sy", "sz"]) box[key] = reader.read(4, `cut box ${index} ${key}`);
    if (!box.sx || !box.sy || !box.sz || box.x + box.sx > 14 || box.y + box.sy > 10 || box.z + box.sz > 14) {
      throw new Ncf1ValidationError(`Cut box ${index} is outside the component grid.`, "invalid-cut-box");
    }
    for (let z = box.z; z < box.z + box.sz; z += 1) {
      for (let y = box.y; y < box.y + box.sy; y += 1) {
        for (let x = box.x; x < box.x + box.sx; x += 1) {
          const cell = forgeVoxelIndex(x, y, z);
          if (removed[cell]) throw new Ncf1ValidationError("Cut boxes cannot overlap.", "overlapping-cut-boxes");
          removed[cell] = 1;
          solid[cell] = 0;
        }
      }
    }
  }
  return solid;
}

function readExtrudedMask(reader) {
  const axis = reader.read(2, "extruded solid axis");
  if (axis > 2) throw new Ncf1ValidationError("Extruded solid axis must be 0-2.", "invalid-axis");
  const sizes = [14, 10, 14];
  const axes = tangentAxes(axis);
  const mask = readRuns(reader, sizes[axes[0]] * sizes[axes[1]], 8, "extruded solid mask runs");
  const solid = new Uint8Array(COMPONENT_CELL_COUNT);
  for (let layer = 0; layer < sizes[axis]; layer += 1) {
    for (let v = 0; v < sizes[axes[1]]; v += 1) {
      for (let u = 0; u < sizes[axes[0]]; u += 1) {
        const cell = [0, 0, 0];
        cell[axis] = layer;
        cell[axes[0]] = u;
        cell[axes[1]] = v;
        solid[forgeVoxelIndex(cell[0], cell[1], cell[2])] = mask[u + sizes[axes[0]] * v];
      }
    }
  }
  return solid;
}

function extrudedMask(solid, axis) {
  const sizes = [14, 10, 14];
  const axes = tangentAxes(axis);
  const mask = new Uint8Array(sizes[axes[0]] * sizes[axes[1]]);
  for (let v = 0; v < sizes[axes[1]]; v += 1) {
    for (let u = 0; u < sizes[axes[0]]; u += 1) {
      const cell = [0, 0, 0];
      cell[axes[0]] = u;
      cell[axes[1]] = v;
      mask[u + sizes[axes[0]] * v] = solid[forgeVoxelIndex(cell[0], cell[1], cell[2])];
    }
  }
  for (let layer = 1; layer < sizes[axis]; layer += 1) {
    for (let v = 0; v < sizes[axes[1]]; v += 1) {
      for (let u = 0; u < sizes[axes[0]]; u += 1) {
        const cell = [0, 0, 0];
        cell[axis] = layer;
        cell[axes[0]] = u;
        cell[axes[1]] = v;
        if (solid[forgeVoxelIndex(cell[0], cell[1], cell[2])] !== mask[u + sizes[axes[0]] * v]) return null;
      }
    }
  }
  return mask;
}

function cutBoxes(solid) {
  const covered = new Uint8Array(COMPONENT_CELL_COUNT);
  const boxes = [];
  while (true) {
    let start = null;
    for (let z = 0; z < 14 && !start; z += 1) {
      for (let y = 0; y < 10 && !start; y += 1) {
        for (let x = 0; x < 14; x += 1) {
          const cell = forgeVoxelIndex(x, y, z);
          if (!solid[cell] && !covered[cell]) { start = { x, y, z }; break; }
        }
      }
    }
    if (!start) return boxes;
    if (boxes.length >= 31) return null;
    let sx = 1;
    while (start.x + sx < 14 && emptyAvailable(start.x + sx, start.y, start.z, solid, covered)) sx += 1;
    let sy = 1;
    growY: while (start.y + sy < 10) {
      for (let x = start.x; x < start.x + sx; x += 1) if (!emptyAvailable(x, start.y + sy, start.z, solid, covered)) break growY;
      sy += 1;
    }
    let sz = 1;
    growZ: while (start.z + sz < 14) {
      for (let y = start.y; y < start.y + sy; y += 1) {
        for (let x = start.x; x < start.x + sx; x += 1) if (!emptyAvailable(x, y, start.z + sz, solid, covered)) break growZ;
      }
      sz += 1;
    }
    const box = { ...start, sx, sy, sz };
    boxes.push(box);
    for (let z = box.z; z < box.z + sz; z += 1) {
      for (let y = box.y; y < box.y + sy; y += 1) {
        for (let x = box.x; x < box.x + sx; x += 1) covered[forgeVoxelIndex(x, y, z)] = 1;
      }
    }
  }
}

function emptyAvailable(x, y, z, solid, covered) {
  const cell = forgeVoxelIndex(x, y, z);
  return !solid[cell] && !covered[cell];
}

function normalizeSolid(input, total) {
  if (input == null) return new Uint8Array(total).fill(1);
  if (!Array.isArray(input) && !ArrayBuffer.isView(input)) throw new Ncf1ValidationError("Solid voxels must be an array or typed array.", "invalid-solid");
  if (input.length !== total) throw new Ncf1ValidationError(`Solid voxel array must contain ${total} cells.`, "invalid-solid-length");
  const solid = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    if (input[index] !== 0 && input[index] !== 1) throw new Ncf1ValidationError("Solid voxels must contain only 0 or 1.", "invalid-solid-value");
    solid[index] = input[index];
  }
  return solid;
}

function normalizeVectorQ(input, min, max, label) {
  const values = vectorValues(input);
  return values.map((value, axis) => integerInRange(value, min, max, `${label} axis ${axis}`));
}

function vectorToQ(input) {
  if (input == null) return [0, 0, 0];
  return vectorValues(input).map((value) => quantizeForgeValue(value));
}

function vectorValues(input) {
  const values = Array.isArray(input) || ArrayBuffer.isView(input) ? Array.from(input).slice(0, 3) : [input?.x, input?.y, input?.z];
  if (values.length !== 3 || values.some((value) => !Number.isFinite(Number(value)))) {
    throw new Ncf1ValidationError("Forge vectors require three finite values.", "invalid-vector");
  }
  return values.map(Number);
}

function normalizeResource(value, label) {
  const index = typeof value === "string" ? FORGE_RESOURCE_IDS.indexOf(value) : Number(value ?? 0);
  return integerInRange(index, 0, FORGE_RESOURCE_IDS.length - 1, label);
}

function readResource(reader, label) {
  const resource = reader.read(3, label);
  if (resource >= FORGE_RESOURCE_IDS.length) throw new Ncf1ValidationError(`${label} is unknown.`, "invalid-resource");
  return resource;
}

function normalizeColor444(value, fallback) {
  if (value == null) return fallback;
  if (Number.isInteger(value) && value >= 0 && value <= 0xfff) return value;
  return colorToRgb444(value);
}

function colorToRgb444(value) {
  let rgb;
  if (typeof value === "string") {
    if (!/^#[0-9a-f]{6}$/iu.test(value)) throw new Ncf1ValidationError("Colors must use #rrggbb.", "invalid-color");
    rgb = Number.parseInt(value.slice(1), 16);
  } else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const channels = Array.from(value).slice(0, 3).map((channel) => Number(channel));
    if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) throw new Ncf1ValidationError("Colors require three channels.", "invalid-color");
    const normalized = channels.every((channel) => channel >= 0 && channel <= 1);
    const bytes = channels.map((channel) => Math.round(clampNumber(channel, 0, normalized ? 1 : 255) * (normalized ? 255 : 1)));
    rgb = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  } else if (value && typeof value === "object" && [value.r, value.g, value.b].every(Number.isFinite)) {
    const channels = [value.r, value.g, value.b].map(Number);
    const normalized = channels.every((channel) => channel >= 0 && channel <= 1);
    const bytes = channels.map((channel) => Math.round(clampNumber(channel, 0, normalized ? 1 : 255) * (normalized ? 255 : 1)));
    rgb = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  } else {
    rgb = integerInRange(value, 0, 0xffffff, "color");
  }
  const r = Math.round(((rgb >> 16) & 255) * 15 / 255);
  const g = Math.round(((rgb >> 8) & 255) * 15 / 255);
  const b = Math.round((rgb & 255) * 15 / 255);
  return (r << 8) | (g << 4) | b;
}

function paintRecordsToQuads(records, solid) {
  if (!Array.isArray(records) || !records.length) return [];
  const sizes = [FORGE_COMPONENT_GRID.x, FORGE_COMPONENT_GRID.y, FORGE_COMPONENT_GRID.z];
  const planes = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const axis = integerInRange(record?.axis, 0, 2, `paint record ${index} axis`);
    const side = integerInRange(record?.side, 0, 1, `paint record ${index} side`);
    const cell = [
      integerInRange(record?.x, 0, sizes[0] - 1, `paint record ${index} x`),
      integerInRange(record?.y, 0, sizes[1] - 1, `paint record ${index} y`),
      integerInRange(record?.z, 0, sizes[2] - 1, `paint record ${index} z`),
    ];
    if (!solid[forgeVoxelIndex(cell[0], cell[1], cell[2])]) throw new Ncf1ValidationError(`Paint record ${index} covers an empty cell.`, "paint-off-surface");
    const neighbor = [...cell];
    neighbor[axis] += side ? 1 : -1;
    if (neighbor[axis] >= 0 && neighbor[axis] < sizes[axis] && solid[forgeVoxelIndex(neighbor[0], neighbor[1], neighbor[2])]) {
      throw new Ncf1ValidationError(`Paint record ${index} covers an internal face.`, "paint-internal-face");
    }
    const axes = tangentAxes(axis);
    const plane = cell[axis] + (side ? 1 : 0);
    const key = `${axis}:${side}:${plane}`;
    let entry = planes.get(key);
    if (!entry) {
      entry = { axis, side, plane, width: sizes[axes[0]], height: sizes[axes[1]], mask: new Uint16Array(sizes[axes[0]] * sizes[axes[1]]) };
      planes.set(key, entry);
    }
    const maskIndex = cell[axes[0]] + entry.width * cell[axes[1]];
    if (entry.mask[maskIndex]) throw new Ncf1ValidationError("Paint records cannot duplicate a face.", "overlapping-quads");
    entry.mask[maskIndex] = normalizeColor444(record?.color444 ?? record?.color, 0xfff) + 1;
  }
  const quads = [];
  for (const entry of planes.values()) {
    for (let v = 0; v < entry.height; v += 1) {
      for (let u = 0; u < entry.width; u += 1) {
        const value = entry.mask[u + entry.width * v];
        if (!value) continue;
        let width = 1;
        while (u + width < entry.width && entry.mask[u + width + entry.width * v] === value) width += 1;
        let height = 1;
        scan: while (v + height < entry.height) {
          for (let x = 0; x < width; x += 1) if (entry.mask[u + x + entry.width * (v + height)] !== value) break scan;
          height += 1;
        }
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) entry.mask[u + x + entry.width * (v + y)] = 0;
        }
        quads.push({ axis: entry.axis, side: entry.side, plane: entry.plane, u0: u, u1: u + width, v0: v, v1: v + height, color444: value - 1 });
      }
    }
  }
  return quads;
}

function compareQuad(a, b) {
  for (const key of ["axis", "side", "plane", "u0", "u1", "v0", "v1", "resource", "color444"]) {
    const delta = (a[key] ?? 0) - (b[key] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

function rejectOverlappingQuads(quads, label) {
  for (let index = 0; index < quads.length; index += 1) {
    const a = quads[index];
    for (let next = index + 1; next < quads.length; next += 1) {
      const b = quads[next];
      if (b.axis !== a.axis || b.side !== a.side || b.plane !== a.plane) break;
      if (a.u0 < b.u1 && a.u1 > b.u0 && a.v0 < b.v1 && a.v1 > b.v0) {
        throw new Ncf1ValidationError(`${label} quads cannot overlap.`, "overlapping-quads");
      }
    }
  }
}

function tangentAxes(axis) {
  return [0, 1, 2].filter((value) => value !== axis);
}

function rectangleArea(quad) {
  return (quad.u1 - quad.u0) * (quad.v1 - quad.v0);
}

function normalizeNcf1Version(value = NCF1_VERSION) {
  const version = finiteInteger(value ?? NCF1_VERSION, "version");
  if (version !== NCF1_LEGACY_VERSION && version !== NCF1_VERSION) {
    throw new Ncf1ValidationError(`Unsupported forge code version: ${version}`, "unsupported-version");
  }
  return version;
}

function finiteInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) throw new Ncf1ValidationError(`${label} must be an integer.`, "invalid-integer");
  return numeric;
}

function integerInRange(value, min, max, label) {
  const numeric = finiteInteger(Number(value), label);
  if (numeric < min || numeric > max) throw new Ncf1ValidationError(`${label} must be between ${min} and ${max}.`, "integer-out-of-range");
  return numeric;
}

function clampInteger(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function integerSquareRoot(value) {
  const numeric = safeUnsignedInteger(value, "integer square root input");
  if (numeric < 2) return numeric;
  let low = 1;
  let high = Math.min(numeric, 94_906_265) + 1;
  while (low + 1 < high) {
    const midpoint = Math.floor((low + high) / 2);
    if (midpoint <= Math.floor(numeric / midpoint)) low = midpoint;
    else high = midpoint;
  }
  return low;
}

function safeUnsignedInteger(value, label) {
  const numeric = finiteInteger(Number(value), label);
  if (numeric < 0 || !Number.isSafeInteger(numeric)) {
    throw new Ncf1ValidationError(`${label} must be a non-negative safe integer.`, "integer-out-of-range");
  }
  return numeric;
}

function checkedSafeAdd(left, right, label) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Ncf1ValidationError(`${label} exceeds the JavaScript safe-integer range.`, "integer-out-of-range");
  return total;
}

function materialCapacityResult(totalVolumeMm3, totalEffectiveDurability) {
  return {
    totalVolumeMm3,
    totalEffectiveDurability,
    keys: FORGE_MATERIAL_CAPACITY_KEYS,
    vector: [totalVolumeMm3, totalEffectiveDurability],
  };
}

function isForgeMaterialSlot(input) {
  return Boolean(input && typeof input === "object" && (
    "volumeMm3" in input
    || "durabilityCurrent" in input
    || "durabilityMax" in input
    || "qualityBps" in input
  ));
}

function isForgeRequirementLike(input) {
  return Array.isArray(input)
    || ArrayBuffer.isView(input)
    || Boolean(input && typeof input === "object" && (
      input.vector != null
      || input.materialRequirements != null
      || input.requiredVolumeMm3 != null
      || input.requiredEffectiveDurability != null
    ));
}

function normalizeForgeMaterialRequirementsVector(input) {
  const source = input?.materialRequirements ?? input?.vector ?? input;
  let result;
  if (Array.isArray(source) || ArrayBuffer.isView(source)) {
    if (source.length !== FORGE_MATERIAL_REQUIREMENT_KEYS.length) {
      throw new Ncf1ValidationError("Forge material requirement vectors require exactly two fields.", "invalid-material-requirements");
    }
    result = Array.from(source, (value, index) => safeUnsignedInteger(value, FORGE_MATERIAL_REQUIREMENT_KEYS[index]));
  } else {
    if (source?.requiredVolumeMm3 == null || source?.requiredEffectiveDurability == null) {
      throw new Ncf1ValidationError("Both forge material requirements are required.", "invalid-material-requirements");
    }
    result = [
      safeUnsignedInteger(source.requiredVolumeMm3, FORGE_MATERIAL_REQUIREMENT_KEYS[0]),
      safeUnsignedInteger(source.requiredEffectiveDurability, FORGE_MATERIAL_REQUIREMENT_KEYS[1]),
    ];
  }
  if (result.some((value) => value === 0)) {
    throw new Ncf1ValidationError("Forge material requirements must be non-zero.", "invalid-material-requirements");
  }
  return result;
}

function forgeInputToRawBytes(input, maxBytes = NCF1_MAX_RAW_BYTES) {
  const byteLimit = normalizeNcf1ByteLimit(maxBytes);
  if (!isForgeDesignObject(input)) return forgeCodeToBytesWithinLimit(input, byteLimit);
  const bytes = encodeNcf1Bytes(input);
  assertNcf1InputByteLength(bytes.byteLength, byteLimit);
  return bytes;
}

function validateForgeRequirementHeader(header) {
  if (header.massGrams === 0 || header.volumeMm3 === 0) {
    throw new Ncf1ValidationError("Forge material requirements need non-zero mass and volume.", "invalid-material-requirements");
  }
  return header;
}

function forgeCodeToByteArray(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  return forgeCodeToBytes(input);
}

function normalizeNcf1ByteLimit(value) {
  return integerInRange(value, 1, NCF1_MAX_RAW_BYTES, "forge code byte limit");
}

function maxNcf1Base64UrlLength(maxBytes) {
  return Math.ceil(maxBytes * 4 / 3);
}

function assertNcf1InputByteLength(byteLength, maxBytes) {
  if (byteLength > maxBytes) {
    throw new Ncf1ValidationError(`Forge code is ${byteLength} bytes; the limit is ${maxBytes}.`, "code-too-large");
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function"
    ? btoa(binary)
    : globalThis.Buffer?.from(bytes)?.toString("base64");
  if (!base64) throw new Ncf1ValidationError("Base64 encoding is unavailable.", "base64-unavailable");
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    if (typeof atob === "function") {
      const binary = atob(padded);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
    if (globalThis.Buffer) return Uint8Array.from(globalThis.Buffer.from(padded, "base64"));
  } catch (error) {
    throw new Ncf1ValidationError(`Invalid base64url forge code: ${error?.message || error}`, "invalid-base64url");
  }
  throw new Ncf1ValidationError("Base64 decoding is unavailable.", "base64-unavailable");
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function equalIntegerArrays(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function unsigned32(value, label) {
  const numeric = finiteInteger(Number(value), label);
  if (numeric < 0 || numeric > 0xffffffff) throw new Ncf1ValidationError(`${label} must fit u32.`, "integer-out-of-range");
  return numeric;
}

function isForgeDesignObject(value) {
  return Boolean(value && typeof value === "object" && (value.appearance || value.components));
}

class BitWriter {
  constructor() {
    this.buffer = [];
    this.current = 0;
    this.bitCount = 0;
  }

  write(value, bits) {
    const numeric = integerInRange(value, 0, (2 ** bits) - 1, "bit field");
    for (let index = bits - 1; index >= 0; index -= 1) {
      this.current = (this.current << 1) | (Math.floor(numeric / (2 ** index)) & 1);
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.buffer.push(this.current);
        this.current = 0;
        this.bitCount = 0;
      }
    }
  }

  writeSigned(value, bits) {
    const limit = 2 ** (bits - 1);
    const numeric = integerInRange(value, -limit, limit - 1, "signed bit field");
    this.write(numeric < 0 ? 2 ** bits + numeric : numeric, bits);
  }

  bytes() {
    const buffer = [...this.buffer];
    if (this.bitCount) buffer.push(this.current << (8 - this.bitCount));
    return Uint8Array.from(buffer);
  }
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bitOffset = 0;
  }

  read(bits, label = "field") {
    if (!Number.isInteger(bits) || bits < 0 || this.bitOffset + bits > this.bytes.length * 8) {
      throw new Ncf1ValidationError(`Forge code is truncated while reading ${label}.`, "truncated-code");
    }
    let value = 0;
    for (let index = 0; index < bits; index += 1) {
      const byte = this.bytes[Math.floor(this.bitOffset / 8)];
      const bit = (byte >> (7 - (this.bitOffset % 8))) & 1;
      value = value * 2 + bit;
      this.bitOffset += 1;
    }
    return value;
  }

  readSigned(bits, label) {
    const value = this.read(bits, label);
    const sign = 2 ** (bits - 1);
    return value >= sign ? value - 2 ** bits : value;
  }

  finish() {
    const remaining = this.bytes.length * 8 - this.bitOffset;
    if (remaining > 7) throw new Ncf1ValidationError("Forge code contains trailing data.", "trailing-data");
    if (remaining && this.read(remaining, "padding") !== 0) throw new Ncf1ValidationError("Forge code padding must be zero.", "nonzero-padding");
  }
}
