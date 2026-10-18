import assert from "node:assert/strict";
import test from "node:test";
import { decodeNcf1, encodeNcf1Bytes } from "../forge/forge-core.js";
import { createForgeWorkbenchComponent, createForgeWorkbenchDesign } from "../forge/forge-workbench.js";
import { restoreForgeRuntime } from "../forge/forge-runtime-cache.js";
import { createForgeMaterialCatalog, forgeMaterialBaseColor, forgeMaterialBaseColor444 } from "../renderer/forge-material-surfaces.js";
import { AVATAR_VERTEX_STRIDE_FLOATS, DEFAULT_PEASANT_GUY_NCM, createAvatarMeshFromNcm } from "../renderer/avatar-mesh.js";
import { createForgedWorldItemMesh } from "../renderer/forged-world-mesh.js";

const catalog = createForgeMaterialCatalog({materials: [
  {id: "copper_bloom", class: "metal", composition: [["Cu", "100%"]]},
  {id: "test_sulfur", class: "chemical", composition: [["S", "100%"]]},
  {id: "test_carbon", class: "carbon", composition: [["C", "100%"]]},
]});

test("recipe colors survive NCF1 encoding and both held and placed equipment restoration", () => {
  const restoredColors = [];
  for (const materialId of catalog.materialIds) {
    const rgb = forgeMaterialBaseColor(materialId, {catalog});
    const color444 = forgeMaterialBaseColor444(materialId, {catalog});
    const expected = rgb.slice(0, 3).map(channel => Math.round(channel / 17) / 15);
    const built = createForgeWorkbenchComponent({materialId, volumeMm3: 120000}, {
      color444, grip: {offsetQ: [0, 0, 0], axis: 1, sign: 1, rotation: 0},
    });
    const code = encodeNcf1Bytes(createForgeWorkbenchDesign([built]));
    assert.equal(decodeNcf1(code, {requireCanonical: true}).components[0].color444, color444);
    const runtime = restoreForgeRuntime(code);
    const avatar = createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM, {
      attachIronPickaxe: true, attachForgedPickaxe: true, forgeRuntime: runtime,
    });
    const part = avatar.parts.find(part => part.geometry && part.forgeDesignHash === runtime.designHash);
    assert.ok(part);
    assert.equal(part.geometry.vertices.length % AVATAR_VERTEX_STRIDE_FLOATS, 0);
    const world = createForgedWorldItemMesh(runtime);
    for (const vertices of [part.geometry.vertices, world.vertices]) {
      for (let channel = 0; channel < 3; channel += 1) {
        assert.ok(Math.abs(vertices[6 + channel] - expected[channel]) < 1e-6, materialId);
      }
    }
    restoredColors.push(color444);
  }
  assert.equal(new Set(restoredColors).size, catalog.materialIds.length);
  assert.equal(forgeMaterialBaseColor444("missing", {catalog}), null);
});

test("explicit painted faces retain their color over the persisted material base", () => {
  const built = createForgeWorkbenchComponent({materialId: "copper_bloom", volumeMm3: 120000}, {
    color444: forgeMaterialBaseColor444("copper_bloom", {catalog}),
    paintQuads: [{axis: 0, side: 1, plane: 14, u0: 0, u1: 10, v0: 0, v1: 14, color444: 0x24f}],
  });
  const runtime = restoreForgeRuntime(encodeNcf1Bytes(createForgeWorkbenchDesign([built])));
  const view = new DataView(runtime.mesh.vertices.buffer);
  let painted = 0;
  for (let offset = 0; offset < runtime.mesh.vertices.length; offset += 16) {
    if (view.getInt8(offset + 6) !== 127) continue;
    assert.deepEqual([...runtime.mesh.vertices.subarray(offset + 10, offset + 13)], [34, 68, 255]);
    painted += 1;
  }
  assert.ok(painted > 0);
});
