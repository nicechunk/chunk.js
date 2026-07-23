import assert from "node:assert/strict";

import {
  NCF1_LEGACY_VERSION,
  NCF1_VERSION,
  compareForgeMaterialCapacity,
  decodeForgeVolumeMm3,
  decodeNcf1,
  decodeNcf1EquipmentHeader,
  encodeForgeVolumeMm3,
  encodeNcf1,
  encodeNcf1Bytes,
  forgeChainDesignHash,
  forgeMaterialRequirements,
  sumForgeMaterialCapacities,
} from "../forge/forge-core.js";
import {
  FORGE_WORKBENCH_SOLID_CELL_COUNT,
  createForgeWorkbenchComponent,
  createForgeWorkbenchDesign,
  forgeComponentSolidFraction,
  forgeWorkbenchStats,
} from "../forge/forge-workbench.js";

const legacyCopperToolCode = "NCF1.4ACQAFale2J0el73B1BKFIEBT7AAAwSYgAA";
const copperBloom = Object.freeze({
  id: "copper_bloom",
  itemCode: 1015,
  recipeId: 1015,
  recipeTableId: 221,
  class: "metal",
  forgeUse: "conductor",
  densityKgM3: 8_200,
  requiredHeatTier: 3,
  attributes: Object.freeze({
    hardness: 42,
    durability: 58,
    toughness: 48,
    ductility: 86,
    brittleness: 14,
    density: 82,
    heatResistance: 48,
    corrosionResistance: 58,
    conductivity: 94,
    thermalConductivity: 88,
    magnetism: 2,
    workability: 84,
  }),
});

assert.equal(NCF1_LEGACY_VERSION, 14, "v14 must remain the legacy cubic-centimetre codec");
assert.equal(NCF1_VERSION, 15, "new forge designs must use the fine-volume v15 codec");
assert.throws(
  () => decodeNcf1(Uint8Array.of(0xd0)),
  (error) => error?.code === "unsupported-version",
  "unknown NCF1 versions must be rejected before their payload is interpreted",
);

for (const fixture of [
  { input: 1, packed: 1, exponent: 0, mantissa: 1, decoded: 1 },
  { input: 310, packed: 310, exponent: 0, mantissa: 310, decoded: 310 },
  { input: 999, packed: 999, exponent: 0, mantissa: 999, decoded: 999 },
  { input: 1_000, packed: 1_000, exponent: 0, mantissa: 1_000, decoded: 1_000 },
  { input: 8_191, packed: 8_191, exponent: 0, mantissa: 8_191, decoded: 8_191 },
  { input: 8_192, packed: (1 << 13) | 512, exponent: 1, mantissa: 512, decoded: 8_192 },
  { input: 8_193, packed: (1 << 13) | 512, exponent: 1, mantissa: 512, decoded: 8_192 },
]) {
  const packed = encodeForgeVolumeMm3(fixture.input);
  assert.equal(packed, fixture.packed, `${fixture.input} mm3 should use the expected packed field`);
  assert.equal(packed >>> 13, fixture.exponent, `${fixture.input} mm3 should use the smallest fitting exponent`);
  assert.equal(packed & 0x1fff, fixture.mantissa, `${fixture.input} mm3 should use the expected mantissa`);
  assert.equal(decodeForgeVolumeMm3(packed), fixture.decoded, `${fixture.input} mm3 should decode deterministically`);
  assert.ok(fixture.decoded <= fixture.input, "quantized forge volume must never exceed real material capacity");
}

const legacyHeader = decodeNcf1EquipmentHeader(legacyCopperToolCode);
assert.equal(legacyHeader.version, NCF1_LEGACY_VERSION, "existing v14 codes must remain readable");
assert.equal(legacyHeader.volumeMm3, 5_000, "v14 raw volume units must still decode as cubic centimetres");
assert.equal(legacyHeader.volumeCm3, 5, "legacy display volume must remain unchanged");
assert.equal(forgeChainDesignHash(legacyCopperToolCode), 1_985_161_465, "legacy raw-byte hashes must remain stable");
assert.deepEqual(
  forgeMaterialRequirements(legacyCopperToolCode).vector,
  [5_000, 341],
  "legacy material requirements must not be reinterpreted as v15 millimetres cubed",
);
const legacyDesign = decodeNcf1(legacyCopperToolCode, { requireCanonical: true });
assert.equal(legacyDesign.version, NCF1_LEGACY_VERSION, "complete canonical v14 fixtures must still decode canonically");
assert.equal(encodeNcf1(legacyDesign), legacyCopperToolCode, "canonical v14 bytes must remain unchanged after decode and encode");

const liveCopperEntries = [1, 2].map((slotIndex, positionIndex) => createForgeWorkbenchComponent({
  key: `forge-slot:${slotIndex}:item:1015`,
  slotIndex,
  itemCode: 1015,
  itemId: "1015",
  materialId: "copper_bloom",
  volumeMm3: 155,
  quantity: 1,
  durabilityCurrent: 1,
  durabilityMax: 1,
  qualityBps: 8_790,
  material: copperBloom,
}, { positionIndex }));
const liveCopperComponents = liveCopperEntries.map((entry) => entry.component);
const liveCopperMaterials = liveCopperEntries.map((entry) => entry.material);
const liveCopperStats = forgeWorkbenchStats(liveCopperComponents, liveCopperMaterials);

assert.deepEqual(
  liveCopperComponents.map((component) => forgeComponentSolidFraction(component).solidCells),
  [FORGE_WORKBENCH_SOLID_CELL_COUNT, FORGE_WORKBENCH_SOLID_CELL_COUNT],
  "the production regression fixture must start with two completely occupied workpieces",
);
assert.deepEqual(liveCopperStats.componentVolumesMm3, [155, 155], "each component must retain its exact live backpack-slot volume");
assert.equal(liveCopperStats.inputVolumeMm3, 310, "two live copper-bloom slots must contribute 310 mm3 in total");
assert.equal(liveCopperStats.usedVolumeMm3, 310, "full occupied masks must not lose fine-grained material volume");
assert.equal(liveCopperStats.equipment.volumeMm3, 310, "v15 equipment must preserve sub-centimetre aggregate volume");
assert.equal(liveCopperStats.equipment.volumeCm3, 0.31, "display volume may remain fractional without changing the encoded unit");
assert.deepEqual(
  Array.from(liveCopperStats.equipment.attributes6),
  [26, 37, 30, 54, 9, 52, 30, 37, 59, 55, 1, 53],
  "the live copper fixture must retain its compact equipment attributes",
);
assert.ok(liveCopperStats.equipment.mass5g > 0, "the live fixture must retain a non-zero encoded mass");
assert.equal(liveCopperStats.chainReady, true, "two non-empty 155 mm3 materials must be eligible for v15 code generation");

const liveCopperDesign = createForgeWorkbenchDesign(liveCopperComponents, liveCopperMaterials);
const liveCopperBytes = encodeNcf1Bytes(liveCopperDesign);
assert.equal(readBits(liveCopperBytes, 0, 4), NCF1_VERSION, "new workbench output must encode v15");
assert.equal(readBits(liveCopperBytes, 20, 16), 310, "the v15 equipment header must encode the exact 310 mm3 field");
const liveCopperDecoded = decodeNcf1(liveCopperBytes, { requireCanonical: true });
assert.equal(liveCopperDecoded.equipment.volumeMm3, 310, "v15 round trips must preserve the live fine-volume fixture");
const liveCopperRequirements = forgeMaterialRequirements(liveCopperBytes);
assert.equal(liveCopperRequirements.version, NCF1_VERSION, "v15 requirements must report their decoded codec version");
assert.equal(liveCopperRequirements.requiredVolumeMm3, 310, "chain requirements must never round 310 mm3 up to 1 cm3");
assert.equal(liveCopperRequirements.requiredEffectiveDurability, 1, "v15 must scale attribute durability to the fine-grained physical volume");

const liveCopperCapacity = sumForgeMaterialCapacities(liveCopperMaterials.map((material) => ({
  volumeMm3: material.volumeMm3,
  durabilityCurrent: 1,
  durabilityMax: 1,
  qualityBps: 8_790,
})));
assert.equal(liveCopperCapacity.totalVolumeMm3, 310, "capacity must aggregate exact live slot volume");
assert.equal(liveCopperCapacity.totalEffectiveDurability, 1, "fractional per-slot durability must be aggregated before integer quantization");
const liveCopperFit = compareForgeMaterialCapacity(liveCopperRequirements, liveCopperCapacity);
assert.equal(liveCopperFit.fields[0].ok, true, "the live fixture must satisfy its fine-volume requirement exactly");
assert.equal(liveCopperFit.fields[1].ok, true, "aggregated live durability must satisfy the volume-scaled v15 requirement");
assert.equal(liveCopperFit.ok, true, "the exact two-slot production regression fixture must pass both material requirements");

for (const volumeMm3 of [1, 999, 1_000, 8_191, 8_192, 8_193]) {
  const entry = createForgeWorkbenchComponent({
    key: `volume-boundary-${volumeMm3}`,
    slotIndex: 0,
    materialId: "copper_bloom",
    volumeMm3,
    densityKgM3: 8_200,
    material: copperBloom,
  });
  const stats = forgeWorkbenchStats([entry.component], [entry.material]);
  const expectedVolumeMm3 = decodeForgeVolumeMm3(encodeForgeVolumeMm3(volumeMm3));
  assert.equal(stats.usedVolumeMm3, volumeMm3, `${volumeMm3} mm3 full masks must preserve exact physical input volume`);
  assert.equal(stats.equipment.volumeMm3, expectedVolumeMm3, `${volumeMm3} mm3 workbench volume must use canonical v15 quantization`);
  assert.equal(stats.requiredVolumeMm3, expectedVolumeMm3, `${volumeMm3} mm3 requirements must use the same canonical volume`);
  assert.ok(stats.requiredVolumeMm3 <= stats.inputVolumeMm3, "encoded workbench requirements must not exceed slot capacity");
  assert.equal(stats.chainReady, true, `${volumeMm3} mm3 must remain code-generatable when mass is non-zero`);
}

console.log("forge fine-volume codec tests passed");

function readBits(bytes, bitOffset, bitCount) {
  let value = 0;
  for (let index = 0; index < bitCount; index += 1) {
    const offset = bitOffset + index;
    value = value * 2 + ((bytes[Math.floor(offset / 8)] >> (7 - (offset % 8))) & 1);
  }
  return value;
}
