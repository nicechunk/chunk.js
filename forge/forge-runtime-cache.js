import {
  FORGE_FIXED_SCALE,
  FORGE_RESOURCE_IDS,
  NCF1_MAX_RAW_BYTES,
  Ncf1ValidationError,
  canonicalizeForgeDesign,
  decodeNcf1,
  fnv1a32,
  forgeBytesToCode,
  forgeCodeToBytes,
  forgeDesignBoundsQ,
  forgeDesignMaterialSummary,
} from "./forge-core.js";
import { buildForgeDesignMesh } from "./forge-mesher.js";

export const FORGE_RUNTIME_CACHE_DEFAULT_ENTRIES = 24;
export const FORGE_RUNTIME_CACHE_DEFAULT_BYTES = 8 * 1024 * 1024;

// Component grips are encoded in component-local Q6 coordinates, while the
// renderer consumes one design-space grip. Keep this conversion centralized so
// previews, Play equipment and collision checks cannot disagree.
export function forgeRuntimeGripFromDesign(input) {
  const design = canonicalizeForgeDesign(input);
  if (design.appearance?.grip) return cloneRuntimeGrip(design.appearance.grip);
  const component = design.components?.find((candidate) => candidate.grip);
  if (!component?.grip) return null;
  return {
    ...cloneRuntimeGrip(component.grip),
    offsetQ: component.grip.offsetQ.map((value, axis) => value + component.offsetQ[axis]),
  };
}

// Creates an uncached runtime directly from an editable design. This is used by
// the forge's live avatar preview; immutable on-chain codes still use the LRU
// restore path below.
export function createForgeRuntimeAsset(input, { componentMaterialLayers = [] } = {}) {
  const design = canonicalizeForgeDesign(input);
  const mesh = buildForgeDesignMesh(design, { componentMaterialLayers });
  const mode = design.appearance ? "appearance" : "components";
  assertRuntimeConsistency(design, mesh, mode);
  const clothComponentIndexes = Object.freeze((design.components ?? [])
    .map((component, index) => component.resourceId === "cloth" ? index : -1)
    .filter((index) => index >= 0));
  const decodedByteLength = estimateDecodedBytes(design);
  return Object.freeze({
    kind: "ncf1-forge-runtime-preview-v1",
    code: "",
    bytes: null,
    rawByteLength: 0,
    designHash: fnv1a32(mesh.vertices),
    mode,
    design,
    appearance: design.appearance ?? null,
    components: design.components ?? Object.freeze([]),
    componentCount: design.components?.length ?? 0,
    clothComponentIndexes,
    clothComponentCount: clothComponentIndexes.length,
    appearanceQuadCount: design.appearance?.quads?.length ?? 0,
    grip: forgeRuntimeGripFromDesign(design),
    boundsQ: forgeDesignBoundsQ(design),
    materials: forgeDesignMaterialSummary(design),
    resourceIds: FORGE_RESOURCE_IDS,
    fixedScale: FORGE_FIXED_SCALE,
    mesh,
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.triangleCount,
    meshByteLength: mesh.byteLength,
    decodedByteLength,
    residentByteLength: decodedByteLength + mesh.byteLength,
  });
}

/**
 * Restores canonical NCF1 into the renderer's packed mesh once per distinct
 * code. Returned designs and typed arrays are shared read-only cache assets;
 * callers must not mutate them.
 */
export class ForgeRuntimeCache {
  constructor({
    maxEntries = FORGE_RUNTIME_CACHE_DEFAULT_ENTRIES,
    maxBytes = FORGE_RUNTIME_CACHE_DEFAULT_BYTES,
  } = {}) {
    this.maxEntries = positiveInteger(maxEntries, "forge runtime cache entries");
    this.maxBytes = positiveInteger(maxBytes, "forge runtime cache bytes");
    this.entries = new Map();
    this.residentBytes = 0;
    this.metrics = createMetrics();
  }

  restore(input, { expectedDesignHash = null, requireCanonical = true } = {}) {
    this.metrics.requests += 1;
    const bytes = runtimeInputBytes(input);
    const designHash = fnv1a32(bytes);
    assertExpectedDesignHash(expectedDesignHash, designHash);
    const code = forgeBytesToCode(bytes);
    const cached = this.entries.get(code);
    if (cached) {
      this.metrics.hits += 1;
      this.entries.delete(code);
      this.entries.set(code, cached);
      return cached.asset;
    }

    this.metrics.misses += 1;
    this.metrics.decodeCount += 1;
    const design = decodeNcf1(bytes, { requireCanonical });
    this.metrics.meshBuildCount += 1;
    const mesh = buildForgeDesignMesh(design);
    const mode = design.appearance ? "appearance" : "components";
    const clothComponentIndexes = Object.freeze((design.components ?? [])
      .map((component, index) => component.resourceId === "cloth" ? index : -1)
      .filter((index) => index >= 0));
    assertRuntimeConsistency(design, mesh, mode);
    const decodedByteLength = estimateDecodedBytes(design);
    const residentByteLength = bytes.byteLength + decodedByteLength + mesh.byteLength;
    const asset = Object.freeze({
      kind: "ncf1-forge-runtime-v1",
      code,
      bytes,
      rawByteLength: bytes.byteLength,
      designHash,
      mode,
      design,
      appearance: design.appearance ?? null,
      components: design.components ?? Object.freeze([]),
      componentCount: design.components?.length ?? 0,
      clothComponentIndexes,
      clothComponentCount: clothComponentIndexes.length,
      appearanceQuadCount: design.appearance?.quads?.length ?? 0,
      grip: forgeRuntimeGripFromDesign(design),
      boundsQ: forgeDesignBoundsQ(design),
      materials: forgeDesignMaterialSummary(design),
      resourceIds: FORGE_RESOURCE_IDS,
      fixedScale: FORGE_FIXED_SCALE,
      mesh,
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
      meshByteLength: mesh.byteLength,
      decodedByteLength,
      residentByteLength,
    });
    this.entries.set(code, { asset, residentByteLength });
    this.residentBytes += residentByteLength;
    this.metrics.peakResidentBytes = Math.max(this.metrics.peakResidentBytes, this.residentBytes);
    this.evictToBudget();
    return asset;
  }

  peek(input, { expectedDesignHash = null } = {}) {
    const bytes = runtimeInputBytes(input);
    const designHash = fnv1a32(bytes);
    assertExpectedDesignHash(expectedDesignHash, designHash);
    const code = forgeBytesToCode(bytes);
    return this.entries.get(code)?.asset ?? null;
  }

  has(input, options = {}) {
    return this.peek(input, options) !== null;
  }

  clear({ resetMetrics = false } = {}) {
    this.entries.clear();
    this.residentBytes = 0;
    if (resetMetrics) this.metrics = createMetrics();
  }

  snapshot() {
    return Object.freeze({
      ...this.metrics,
      entries: this.entries.size,
      residentBytes: this.residentBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      hitRate: this.metrics.requests ? this.metrics.hits / this.metrics.requests : 0,
      avoidedDecodeCount: this.metrics.hits,
    });
  }

  evictToBudget() {
    while (this.entries.size > this.maxEntries || this.residentBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.residentBytes = Math.max(0, this.residentBytes - (oldest?.residentByteLength ?? 0));
      this.metrics.evictions += 1;
    }
  }
}

function runtimeInputBytes(input) {
  assertRuntimeInputEnvelope(input);
  const bytes = forgeCodeToBytes(input);
  if (bytes.length > NCF1_MAX_RAW_BYTES) {
    throw new Ncf1ValidationError("Forge code exceeds the supported runtime size.", "code-too-large");
  }
  return bytes;
}

function assertRuntimeInputEnvelope(input) {
  if (typeof input === "string") {
    const text = input.trim();
    const encoded = text.startsWith("NCF1.") ? text.slice(5) : text;
    if (encoded.length > Math.ceil(NCF1_MAX_RAW_BYTES * 4 / 3)) {
      throw new Ncf1ValidationError("Forge code exceeds the supported runtime size.", "code-too-large");
    }
    return;
  }
  if (input instanceof ArrayBuffer) {
    assertRuntimeByteLength(input.byteLength);
    return;
  }
  if (ArrayBuffer.isView(input)) {
    assertRuntimeByteLength(input.byteLength);
    return;
  }
  if (Array.isArray(input)) {
    assertRuntimeByteLength(input.length);
    return;
  }
  if (input?.bytes != null) assertRuntimeInputEnvelope(input.bytes);
  else if (typeof input?.code === "string") assertRuntimeInputEnvelope(input.code);
}

function assertRuntimeByteLength(length) {
  if (length > NCF1_MAX_RAW_BYTES) {
    throw new Ncf1ValidationError("Forge code exceeds the supported runtime size.", "code-too-large");
  }
}

const sharedForgeRuntimeCache = new ForgeRuntimeCache();

export function restoreForgeRuntime(input, options = {}) {
  return sharedForgeRuntimeCache.restore(input, options);
}

export function peekForgeRuntime(input, options = {}) {
  return sharedForgeRuntimeCache.peek(input, options);
}

export function forgeRuntimeCacheStats() {
  return sharedForgeRuntimeCache.snapshot();
}

export function clearForgeRuntimeCache(options = {}) {
  sharedForgeRuntimeCache.clear(options);
}

function assertRuntimeConsistency(design, mesh, mode) {
  if (!mesh?.vertices || !mesh?.indices || mesh.vertexCount <= 0 || mesh.triangleCount <= 0) {
    throw new Error("Canonical NCF1 restored an empty runtime mesh.");
  }
  if (mode === "appearance") {
    if (!design.appearance || design.components != null || mesh.pickBounds.length !== 1 || mesh.pickBounds[0]?.id !== "appearance") {
      throw new Error("NCF1 appearance and runtime mesh metadata disagree.");
    }
    return;
  }
  if (!Array.isArray(design.components)
    || design.appearance != null
    || mesh.pickBounds.length !== design.components.length) {
    throw new Error("NCF1 components and runtime mesh metadata disagree.");
  }
  for (let index = 0; index < design.components.length; index += 1) {
    if (mesh.pickBounds[index]?.userData?.resourceId !== design.components[index].resourceId) {
      throw new Error(`NCF1 component ${index} material and runtime mesh metadata disagree.`);
    }
  }
}

function estimateDecodedBytes(design) {
  if (design.appearance) return design.appearance.quads.length * 36 + 96;
  let bytes = 96;
  for (const component of design.components ?? []) {
    bytes += component.solid?.byteLength ?? 0;
    bytes += (component.paintQuads?.length ?? 0) * 32 + 96;
  }
  return bytes;
}

function assertExpectedDesignHash(expected, actual) {
  if (expected == null || expected === "") return;
  const normalized = Number(expected);
  if (!Number.isFinite(normalized) || (Math.trunc(normalized) >>> 0) !== actual) {
    const error = new Error("NCF1 code does not match the expected design hash.");
    error.code = "forge-design-hash-mismatch";
    throw error;
  }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new RangeError(`${label} must be a positive integer.`);
  return number;
}

function createMetrics() {
  return {
    requests: 0,
    hits: 0,
    misses: 0,
    decodeCount: 0,
    meshBuildCount: 0,
    evictions: 0,
    peakResidentBytes: 0,
  };
}

function cloneRuntimeGrip(grip) {
  return {
    offsetQ: [...grip.offsetQ],
    axis: grip.axis,
    sign: grip.sign,
    rotation: grip.rotation,
  };
}
