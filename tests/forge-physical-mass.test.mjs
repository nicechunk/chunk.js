import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeNcf1,
  encodeNcf1Bytes,
} from "../forge/forge-core.js";
import {
  FORGE_MATERIAL_ARCHETYPES,
  createForgeWorkbenchComponent,
  createForgeWorkbenchDesign,
  forgeWorkbenchEquipment,
  forgeWorkbenchStats,
  parseForgeMaterialProfile,
  translateForgeComponent,
} from "../forge/forge-workbench.js";

test("forge profiles keep gameplay and physical density independent", () => {
  const profile = parseForgeMaterialProfile({
    materialId: "charcoal",
    densityKgM3: 250,
    attributes: { density: 25 },
  });

  assert.equal(profile.densityScore, 25);
  assert.equal(profile.attributes.density, 25);
  assert.equal(profile.densityKgM3, 250);
  assert.equal(profile.densityKgM3Source, "material-input");
  assert.equal(profile.physicalDensityFallback, false);

  const fallback = parseForgeMaterialProfile({ materialId: "charcoal" });
  assert.equal(fallback.densityScore, FORGE_MATERIAL_ARCHETYPES.coal.attributes.density);
  assert.equal(fallback.densityKgM3, FORGE_MATERIAL_ARCHETYPES.coal.densityKgM3);
  assert.equal(fallback.densityKgM3Source, "archetype-fallback");
  assert.equal(fallback.physicalDensityFallback, true);
  assert.equal(
    parseForgeMaterialProfile(JSON.parse(JSON.stringify(fallback))).densityKgM3Source,
    "archetype-fallback",
    "serialized profiles must retain conservative fallback provenance",
  );

  const particularSmelt = parseForgeMaterialProfile({
    materialId: "iron_bloom",
    material: { densityKgM3: 7_000, attributes: { density: 70 } },
    materialProperties: { densityGcm3: 7.4, attributes: { density: 74 } },
  });
  assert.equal(particularSmelt.densityScore, 74);
  assert.equal(particularSmelt.densityKgM3, 7_400);

  const gramsPerCubicCentimetre = parseForgeMaterialProfile({
    materialId: "ceramic",
    densityGcm3: 2.5,
  });
  assert.equal(gramsPerCubicCentimetre.densityKgM3, 2_500);
  assert.equal(gramsPerCubicCentimetre.densityScore, 25);
});

test("explicit invalid physical densities fail closed", () => {
  for (const densityKgM3 of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, true, [], 50_001]) {
    assert.throws(
      () => parseForgeMaterialProfile({ materialId: "iron", densityKgM3 }),
      (error) => error?.code === "invalid-material-density",
      `density ${String(densityKgM3)} must be rejected`,
    );
  }
  assert.throws(
    () => parseForgeMaterialProfile({ materialId: "iron", densityGcm3: "not-a-density" }),
    (error) => error?.code === "invalid-material-density",
  );
});

test("NCF1 mass5g and workbench mass outputs use physical density", () => {
  const charcoal = createForgeWorkbenchComponent({
    materialId: "charcoal",
    volumeMm3: 750_000,
    densityKgM3: 250,
    attributes: { density: 25 },
  });
  const stats = forgeWorkbenchStats([charcoal.component], [charcoal.material]);

  assert.equal(stats.massWeightUnit, "microgram");
  assert.equal(stats.massWeight, 187_500_000);
  assert.equal(stats.massMicrograms, 187_500_000);
  assert.equal(stats.massMilligrams, 187_500);
  assert.equal(stats.equipment.mass5g, 38);
  assert.equal(stats.massGrams, 190, "the public gram value mirrors the 5 g-quantized NCF1 header");
  assert.equal(stats.densityScore, 25);
  assert.equal(stats.densityKgM3, 250);
  assert.equal(stats.physicalDensityFallback, false);
  assert.equal(stats.componentBreakdown[0].densityScore, 25);
  assert.equal(stats.componentBreakdown[0].densityKgM3, 250);
  assert.equal(stats.componentBreakdown[0].massMilligrams, 187_500);

  const design = createForgeWorkbenchDesign([charcoal.component], [charcoal.material]);
  const decoded = decodeNcf1(encodeNcf1Bytes(design));
  assert.equal(decoded.equipment.mass5g, 38, "the existing NCF1 v14 field must contain units of 5 g");
});

test("attribute inheritance and physical advisories are weighted by physical mass", () => {
  const light = createForgeWorkbenchComponent({
    materialId: "test_light",
    volumeMm3: 100_000,
    densityKgM3: 1_000,
    attributes: { hardness: 0, density: 100 },
  });
  const heavy = createForgeWorkbenchComponent({
    materialId: "test_heavy",
    volumeMm3: 100_000,
    densityKgM3: 9_000,
    attributes: { hardness: 100, density: 10 },
  });
  const placeAt = (component, offsetQ) => translateForgeComponent(
    component,
    offsetQ.map((value, axis) => value - component.offsetQ[axis]),
  );
  const components = [
    placeAt(light.component, [-100, 0, 0]),
    placeAt(heavy.component, [100, 0, 0]),
  ];
  const stats = forgeWorkbenchStats(components, [light.material, heavy.material]);

  assert.equal(stats.massWeight, 1_000_000_000);
  assert.equal(stats.massMilligrams, 1_000_000);
  assert.equal(stats.equipment.mass5g, 200);
  assert.equal(stats.attributes.hardness, 90);
  assert.equal(stats.attributes.density, 19, "the gameplay score remains an inherited attribute, not a kg/m3 alias");
  assert.equal(stats.densityKgM3, 5_000);
  assert.equal(stats.physicsAdvisory.centerOfMassQ[0], 80);
  assert.equal(stats.physicsAdvisory.physicalDensityFallback, false);
});

test("the public density ceiling keeps the maximum workbench mass exact", () => {
  const entry = createForgeWorkbenchComponent({
    materialId: "maximum_density",
    volumeMm3: 0xffff_ffff,
    densityKgM3: 50_000,
    attributes: { density: 100 },
  });
  const components = new Array(24).fill(entry.component);
  const materials = new Array(24).fill(entry.material);

  const equipment = forgeWorkbenchEquipment(components, materials);
  assert.equal(equipment.mass5g, 0xffff);
  assert.equal(equipment.volumeCm3, 0xffff);
  assert.equal(equipment.attributes6[5], 63);
});
