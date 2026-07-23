import assert from "node:assert/strict";
import test from "node:test";

import { MATERIALS, NCM_MATERIALS } from "../ncm/blueprint-codec.js";
import { materialDefs } from "../world/material-registry.js";

test("public NCM material transparency metadata follows renderer shader classes", () => {
  assert.equal(MATERIALS, NCM_MATERIALS, "the compatibility alias must preserve the same metadata table");

  for (const material of Object.values(NCM_MATERIALS)) {
    const definition = materialDefs[material.id];
    const expectedTransparent = definition.shaderType === "fluid" || definition.shaderType === "transparent";
    const expectedOpacity = expectedTransparent ? definition.baseColor[3] / 255 : 1;
    assert.equal(material.transparent, expectedTransparent, `${material.key} transparency must match ${definition.shaderType}`);
    assert.equal(material.opacity, expectedOpacity, `${material.key} opacity must match its render alpha`);
  }
});

test("glass, ice, and salt NCM metadata remains visibly transparent", () => {
  for (const key of ["ice", "clearGlassPanel", "iceBlueGlassPanel", "amberGlassPanel", "basaltReinforcedGlass", "saltCrystalBlock"]) {
    const material = Object.values(NCM_MATERIALS).find((entry) => entry.key === key);
    assert.ok(material, `${key} must remain available to NCM consumers`);
    assert.equal(material.transparent, true, `${key} must be classified as transparent`);
    assert.ok(material.opacity > 0 && material.opacity < 1, `${key} must expose its fractional alpha`);
  }
});
