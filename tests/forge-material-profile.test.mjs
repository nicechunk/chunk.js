import assert from "node:assert/strict";
import test from "node:test";

import {
  FORGE_MATERIAL_ARCHETYPES,
  parseForgeMaterialProfile,
} from "../forge/forge-workbench.js";

test("forge density follows the v1 explicit, attribute, physical, and archetype priority", () => {
  const cases = [
    {
      name: "an explicit score wins every fallback",
      input: {
        materialId: "charcoal",
        densityScore: 91,
        densityKgM3: 250,
        material: { attributes: { density: 25 } },
        materialProperties: { attributes: { density: 77 } },
      },
      expected: 91,
      expectedPhysical: 250,
    },
    {
      name: "particular-smelt attributes win recipe and physical density",
      input: {
        materialId: "charcoal",
        densityKgM3: 250,
        material: { attributes: { density: 25 } },
        materialProperties: { attributes: { density: 77 } },
      },
      expected: 77,
      expectedPhysical: 250,
    },
    {
      name: "recipe attributes win physical density",
      input: {
        materialId: "charcoal",
        densityKgM3: 250,
        material: { attributes: { density: 25 } },
      },
      expected: 25,
      expectedPhysical: 250,
    },
    {
      name: "kilograms per cubic metre remain a physical-only fallback",
      input: { materialId: "charcoal", densityKgM3: 250 },
      expected: 3,
      expectedPhysical: 250,
    },
    {
      name: "grams per cubic centimetre remain a physical-only fallback",
      input: { materialId: "charcoal", densityGcm3: 2.5 },
      expected: 25,
      expectedPhysical: 2_500,
    },
    {
      name: "the material archetype is the final fallback",
      input: { materialId: "charcoal" },
      expected: FORGE_MATERIAL_ARCHETYPES.coal.attributes.density,
      expectedPhysical: FORGE_MATERIAL_ARCHETYPES.coal.densityKgM3,
    },
  ];

  for (const fixture of cases) {
    const profile = parseForgeMaterialProfile(fixture.input);
    assert.equal(profile.densityScore, fixture.expected, fixture.name);
    assert.equal(profile.attributes.density, fixture.expected, `${fixture.name}: inherited attribute`);
    assert.equal(profile.densityKgM3, fixture.expectedPhysical, `${fixture.name}: physical density`);
  }
});
