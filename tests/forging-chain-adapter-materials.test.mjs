import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  forgeOnChain,
  isRetiredForgeMaterialItemCode,
  resolveSmeltingMaterialIdFromRules,
} from "../../forging/chain-adapter.js";

const publicRules = JSON.parse(await readFile(
  new URL("../../public/rules/smelting-rules.json", import.meta.url),
  "utf8",
));

assert.equal(resolveSmeltingMaterialIdFromRules(1003, publicRules), "");
assert.equal(resolveSmeltingMaterialIdFromRules(2003, publicRules), "");
assert.equal(resolveSmeltingMaterialIdFromRules(1004, publicRules), "resin_binder");
assert.equal(resolveSmeltingMaterialIdFromRules(1025, publicRules), "cotton_cloth");
assert.equal(resolveSmeltingMaterialIdFromRules(1030, publicRules), "pink_dye");
assert.equal(isRetiredForgeMaterialItemCode(1003), true);
assert.equal(isRetiredForgeMaterialItemCode("1003"), true);
assert.equal(isRetiredForgeMaterialItemCode(1002), false);
assert.equal(isRetiredForgeMaterialItemCode(2003), false);
assert.deepEqual(
  await forgeOnChain({
    code: "NCF1.retired-material-test",
    materialInputs: [{ slotIndex: 0, itemCode: 1003 }],
  }),
  {
    submitted: false,
    reason: "material-mismatch",
    verificationMode: "material-parameters-v1",
  },
);

const legacyRules = {
  materials: [
    { id: "charcoal" },
    { id: "biochar_compost" },
    { id: "legacy_third_material" },
    { id: "resin_binder" },
  ],
};
assert.equal(resolveSmeltingMaterialIdFromRules(1003, legacyRules), "legacy_third_material");
assert.equal(resolveSmeltingMaterialIdFromRules(1004, legacyRules), "resin_binder");

console.log("forging chain adapter material identity tests passed");
