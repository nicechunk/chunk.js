import assert from "node:assert/strict";
import test from "node:test";

import {
  activeForgeMaterialSurfaceSet,
  createForgeMaterialCatalog,
  createForgeMaterialTextureArray,
} from "../renderer/forge-material-surfaces.js";
import { ForgeWorkbenchRenderer } from "../renderer/forge-workbench-renderer.js";

const catalog = createForgeMaterialCatalog({
  ruleSet: "standalone-texture-test-v1",
  materials: [{
    id: "test_iron",
    class: "metal",
    composition: [["Fe", "100%"]],
  }],
});

test("forge texture arrays use the material manager default when no seed is supplied", () => {
  const gl = fakeTextureArrayGl();
  const textureArray = createForgeMaterialTextureArray(gl, {
    catalog,
    materialIds: ["test_iron"],
    tileSize: 8,
  });

  assert.equal(textureArray.layerCount, 1);
  assert.equal(gl.uploads, 1);
  textureArray.dispose();
  assert.equal(gl.deletedTextures, 1);
});

test("forge texture arrays preserve strict validation for an explicit empty seed", () => {
  assert.throws(
    () => createForgeMaterialTextureArray(fakeTextureArrayGl(), {
      catalog,
      materialIds: ["test_iron"],
      seed: "",
      tileSize: 8,
    }),
    /Seed text must not be empty/,
  );
});

test("forge texture array creation deletes its allocation when an upload fails", () => {
  const gl = fakeTextureArrayGl({ failStorage: true });

  assert.throws(
    () => createForgeMaterialTextureArray(gl, {
      catalog,
      materialIds: ["test_iron"],
      tileSize: 8,
    }),
    /fake texture storage failure/,
  );
  assert.equal(gl.createdTextures, 1);
  assert.equal(gl.deletedTextures, 1);
  assert.deepEqual(gl.events, ["create", "storage", "delete"]);
});

test("forge texture array rebuild keeps the live resource until its replacement succeeds", () => {
  const gl = fakeTextureArrayGl({ failStorage: true });
  const renderer = new ForgeWorkbenchRenderer(fakeCanvas(), {
    controls: false,
    toolVisuals: false,
    forgeMaterialCatalog: catalog,
    materialTextureTileSize: 8,
  });
  const previousTextureArray = {
    disposeCalls: 0,
    dispose() {
      this.disposeCalls += 1;
      gl.events.push("dispose-old");
    },
  };
  renderer.gl = gl;
  renderer.materialTextureArray = previousTextureArray;
  renderer.materialTextureSignature = "previous-signature";
  renderer.materialSurfaceSet = activeForgeMaterialSurfaceSet(["test_iron"], { catalog });

  assert.throws(() => renderer.rebuildMaterialTextureArray(), /fake texture storage failure/);
  assert.equal(renderer.materialTextureArray, previousTextureArray);
  assert.equal(renderer.materialTextureSignature, "previous-signature");
  assert.equal(previousTextureArray.disposeCalls, 0);
  assert.equal(gl.createdTextures, 1);
  assert.equal(gl.deletedTextures, 1, "the failed replacement must release only its own texture");

  gl.failStorage = false;
  assert.equal(renderer.rebuildMaterialTextureArray(), true);
  assert.notEqual(renderer.materialTextureArray, previousTextureArray);
  assert.equal(renderer.materialTextureSignature, renderer.materialSurfaceSet.signature);
  assert.equal(previousTextureArray.disposeCalls, 1);
  assert.ok(
    gl.events.indexOf("dispose-old") > gl.events.lastIndexOf("upload"),
    "the live texture must be disposed only after replacement upload completes",
  );

  renderer.dispose();
  assert.equal(gl.createdTextures, 2);
  assert.equal(gl.deletedTextures, 2);
});

function fakeCanvas() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
  };
}

function fakeTextureArrayGl({ failStorage = false } = {}) {
  return {
    TEXTURE_2D_ARRAY: 1,
    RGBA8: 2,
    RGBA: 3,
    UNSIGNED_BYTE: 4,
    TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6,
    TEXTURE_WRAP_S: 7,
    TEXTURE_WRAP_T: 8,
    NEAREST: 9,
    REPEAT: 10,
    uploads: 0,
    createdTextures: 0,
    deletedTextures: 0,
    events: [],
    failStorage,
    createTexture() {
      this.createdTextures += 1;
      this.events.push("create");
      return {};
    },
    bindTexture() {},
    texStorage3D() {
      this.events.push("storage");
      if (this.failStorage) throw new Error("fake texture storage failure");
    },
    texSubImage3D() {
      this.uploads += 1;
      this.events.push("upload");
    },
    texParameteri() {},
    deleteTexture() {
      this.deletedTextures += 1;
      this.events.push("delete");
    },
  };
}
