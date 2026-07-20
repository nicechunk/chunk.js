import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { smeltingRules } from "../../src/data/smeltingRules.js";
import { parseForgeMaterialProfile } from "../forge/forge-workbench.js";
import {
  SMELTING_MATERIAL_VISUAL_REVISION,
  smeltingMaterialSurfaceProfile,
} from "../renderer/smelting-material-models.js";
import {
  FORGE_MATERIAL_SURFACE_LAYER_NONE,
  FORGE_MATERIAL_SURFACE_TILE_SIZE,
  activeForgeMaterialSurfaceSet,
  bakeForgeMaterialSurfaceTile,
  bakeForgeMaterialSurfaceTiles,
  compositionRangeMidpoint,
  createForgeMaterialCatalog,
  createForgeMaterialTextureArray,
  elementColor,
  forgeMaterialBaseColor,
  forgeMaterialClassSurfaceProfile,
  forgeMaterialTextureMaterials,
  renderForgeMaterialSurfaceCanvas,
  resolveForgeMaterialRecipe,
} from "../renderer/forge-material-surfaces.js";

const catalog = createForgeMaterialCatalog(smeltingRules);
assert.equal(catalog.ruleSet, "nicechunk-smelting-v1");
assert.equal(catalog.materialIds.length, smeltingRules.materials.length);
assert.equal(resolveForgeMaterialRecipe("iron_bloom", catalog)?.class, "metal");
assert.equal(resolveForgeMaterialRecipe("iron", catalog), null, "unofficial aliases must not resolve as forge recipes");
assert.equal(resolveForgeMaterialRecipe("plant_fiber", catalog), null, "retired materials must not resolve as forge recipes");
assert.equal(smeltingMaterialSurfaceProfile("plant_fiber"), null, "retired materials must not expose baked forge surfaces");
assert.equal(resolveForgeMaterialRecipe("unknown", catalog), null);
for (const recipe of smeltingRules.materials) {
  const profile = parseForgeMaterialProfile({ materialId: recipe.id, material: recipe });
  assert.deepEqual(profile.attributes, recipe.attributes, `${recipe.id} must inherit the 12 official forge parameters`);
}

assert.equal(elementColor("Fe"), "#a66b5b");
assert.equal(elementColor("Unobtainium"), "#8eeeff");
assert.equal(compositionRangeMidpoint("0.2-2%"), 1.1);
assert.equal(compositionRangeMidpoint("48%"), 48);
assert.equal(compositionRangeMidpoint("none"), 0);

const weightedRecipe = {
  id: "weighted_test",
  class: "metal",
  composition: [["Fe", "60-80%"], ["C", "10-20%"]],
  color: "#00ff00",
};
assert.deepEqual(
  forgeMaterialBaseColor(weightedRecipe),
  [144, 96, 84, 255],
  "base color must use composition midpoint weights and ignore presentation colors",
);
assert.deepEqual(
  forgeMaterialBaseColor({ id: "fallback", class: "composite", composition: [] }),
  [142, 238, 255, 255],
);
assert.equal(forgeMaterialBaseColor("unknown", { catalog }), null);
assert.equal(forgeMaterialClassSurfaceProfile("alloy").surfaceStyle, "deepStone");
assert.equal(forgeMaterialClassSurfaceProfile("glass").surfaceStyle, "ice");
const ironVisualProfile = smeltingMaterialSurfaceProfile("iron_bloom");
assert.deepEqual(
  forgeMaterialBaseColor("iron_bloom", { catalog }),
  [...ironVisualProfile.baseColor.slice(0, 3), 255],
  "official forge materials must use the canonical Chunk.js model base color",
);

const active = activeForgeMaterialSurfaceSet(
  ["iron_bloom", "copper_bloom", "iron_bloom", "unknown", "plant_fiber"],
  { catalog },
);
assert.deepEqual(active.materialIds, ["copper_bloom", "iron_bloom"]);
assert.deepEqual(active.componentLayers, [1, 0, 1, FORGE_MATERIAL_SURFACE_LAYER_NONE, FORGE_MATERIAL_SURFACE_LAYER_NONE]);
assert.equal(active.layerByMaterialId.get("copper_bloom"), 0);
assert.equal(active.layerByMaterialId.has("plant_fiber"), false);
assert.match(active.signature, /nicechunk-smelting-v1/);
assert.match(active.signature, /metal/);
assert.match(active.signature, /Fe/);
assert.match(active.signature, new RegExp(SMELTING_MATERIAL_VISUAL_REVISION));

const alternateRuleCatalog = createForgeMaterialCatalog({
  ...smeltingRules,
  ruleSet: "nicechunk-smelting-v2",
});
const alternateRuleActive = activeForgeMaterialSurfaceSet(["iron_bloom"], { catalog: alternateRuleCatalog });
assert.notEqual(alternateRuleActive.signature, activeForgeMaterialSurfaceSet(["iron_bloom"], { catalog }).signature);

const options = { catalog, tileSize: FORGE_MATERIAL_SURFACE_TILE_SIZE };
const allActive = activeForgeMaterialSurfaceSet(catalog.materialIds, { catalog });
const tiles = bakeForgeMaterialSurfaceTiles({ ...options, materialIds: catalog.materialIds });
assert.equal(tiles.length, smeltingRules.materials.length);
assert.equal(tiles.reduce((total, tile) => total + tile.byteLength, 0), smeltingRules.materials.length * 32 * 32 * 4);
const hashes = new Set();
for (let index = 0; index < tiles.length; index += 1) {
  const materialId = allActive.materialIds[index];
  const tile = tiles[index];
  assert.equal(tile.byteLength, 32 * 32 * 4);
  assert.strictEqual(
    bakeForgeMaterialSurfaceTile(materialId, options),
    tile,
    `${materialId} should reuse its authoritative recipe tile`,
  );
  for (let alpha = 3; alpha < tile.length; alpha += 4) assert.equal(tile[alpha], 255);
  hashes.add(createHash("sha256").update(tile).digest("hex"));
}
assert.equal(hashes.size, tiles.length, "the official material IDs should produce distinct seeded tiles");
assert.equal(bakeForgeMaterialSurfaceTile("unknown", options), null);
assert.notDeepEqual(
  bakeForgeMaterialSurfaceTile("iron_bloom", options),
  bakeForgeMaterialSurfaceTile("iron_bloom", { ...options, seed: "alternate" }),
  "an explicit seed salt should deterministically alter pattern detail",
);

const sameRuleRecipe = resolveForgeMaterialRecipe("iron_bloom", catalog);
const v1Tile = bakeForgeMaterialSurfaceTile(sameRuleRecipe, { ruleSet: "rules-v1" });
const v2Tile = bakeForgeMaterialSurfaceTile(sameRuleRecipe, { ruleSet: "rules-v2" });
assert.notStrictEqual(v1Tile, v2Tile, "ruleSet must participate in the tile cache key");
assert.deepEqual(v1Tile, v2Tile, "ruleSet versioning should not invent visual changes without recipe changes");

const sourceColorA = bakeForgeMaterialSurfaceTile(weightedRecipe);
const sourceColorB = bakeForgeMaterialSurfaceTile({ ...weightedRecipe, color: "#ff00ff" });
assert.strictEqual(sourceColorA, sourceColorB, "non-authoritative mesh or UI colors must not affect cache or pixels");
assert.notDeepEqual(
  sourceColorA,
  bakeForgeMaterialSurfaceTile({ ...weightedRecipe, class: "fiber" }),
  "the authoritative recipe class should select its restrained surface finish",
);
assert.notDeepEqual(
  sourceColorA,
  bakeForgeMaterialSurfaceTile({ ...weightedRecipe, composition: [["Cu", "100%"]] }),
  "the authoritative recipe composition should control the baked surface",
);

const materials = forgeMaterialTextureMaterials(["iron_bloom", "copper_bloom", "unknown"], { catalog });
assert.equal(materials.length, 2);
assert.deepEqual(materials.map((material) => material.textureLayer), [0, 1]);
assert.ok(materials.every((material) => material.shaderType === "opaque"));
assert.ok(materials.every((material) => material.baseColor[3] === 255));
assert.ok(materials.every((material) => material.visualRevision === SMELTING_MATERIAL_VISUAL_REVISION));
assert.ok(materials.every((material) => material.visualCacheSignature));
assert.equal(materials.find((material) => material.sourceMaterialId === "iron_bloom")?.roughness, ironVisualProfile.finish.roughness);

const gl = fakeTextureArrayGl();
const textureArray = createForgeMaterialTextureArray(gl, {
  catalog,
  materialIds: ["iron_bloom", "copper_bloom", "iron_bloom", "unknown"],
});
assert.equal(textureArray.layerCount, 2);
assert.deepEqual(textureArray.materialIds, ["copper_bloom", "iron_bloom"]);
assert.deepEqual(textureArray.componentLayers, [1, 0, 1, FORGE_MATERIAL_SURFACE_LAYER_NONE]);
assert.deepEqual(gl.storage, [gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 32, 32, 2]);
assert.equal(gl.uploads.length, 2);
assert.deepEqual(gl.uploads.map((upload) => upload[4]), [0, 1]);
assert.ok(gl.uploads.every((upload) => upload[10] instanceof Uint8Array));
for (const upload of gl.uploads) {
  const materialId = textureArray.materialIds[upload[4]];
  assert.deepEqual(upload[10], bakeForgeMaterialSurfaceTile(materialId, options));
}
textureArray.dispose();
assert.equal(gl.deletedTextures, 1);

const emptyGl = fakeTextureArrayGl();
const emptyTextureArray = createForgeMaterialTextureArray(emptyGl, {
  catalog,
  materialIds: ["unknown"],
});
assert.equal(emptyTextureArray.layerCount, 0);
assert.equal(emptyTextureArray.texture, null);
assert.equal(emptyGl.createdTextures, 0);

const canvas = fakeCanvas();
assert.equal(renderForgeMaterialSurfaceCanvas(canvas, "iron_bloom", options), true);
assert.equal(canvas.width, 32);
assert.equal(canvas.height, 32);
assert.equal(canvas.dataset.forgeMaterialSurface, "iron_bloom");
assert.deepEqual(
  canvas.pixels,
  new Uint8ClampedArray(bakeForgeMaterialSurfaceTile("iron_bloom", options)),
  "the Canvas preview and WebGL texture array must use identical canonical pixels",
);
assert.equal(renderForgeMaterialSurfaceCanvas(fakeCanvas(), "unknown", options), false);

const moduleSource = await readFile(new URL("../renderer/forge-material-surfaces.js", import.meta.url), "utf8");
assert.match(moduleSource, /from\s+["'][^"']*smelting-material-models/);
assert.doesNotMatch(moduleSource, /from\s+["']three["']/);
assert.doesNotMatch(moduleSource, /\bdocument\b/);

console.log(`forge material rule surface tests passed: ${tiles.length} layers, ${tiles.reduce((sum, tile) => sum + tile.byteLength, 0)} bytes`);

function fakeTextureArrayGl() {
  return {
    TEXTURE_2D_ARRAY: 0x8c1a,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    REPEAT: 0x2901,
    TEXTURE0: 0x84c0,
    storage: null,
    uploads: [],
    createdTextures: 0,
    deletedTextures: 0,
    createTexture() { this.createdTextures += 1; return {}; },
    bindTexture() {},
    texStorage3D(...args) { this.storage = args; },
    texSubImage3D(...args) { this.uploads.push(args); },
    texParameteri() {},
    activeTexture() {},
    deleteTexture() { this.deletedTextures += 1; },
  };
}

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    dataset: {},
    pixels: null,
    getContext() {
      return {
        createImageData(width, height) {
          return { data: new Uint8ClampedArray(width * height * 4) };
        },
        putImageData(image) { canvas.pixels = image.data; },
      };
    },
  };
  return canvas;
}
