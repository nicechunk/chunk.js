import assert from "node:assert/strict";
import {
  FORGE_DYE_FALLBACK_COLORS,
  FORGE_DYE_MATERIAL_IDS,
  forgeDyeColor444,
  forgeDyePalette,
  forgePaintDyeUsage,
  resolveForgePaintDyeInventory,
} from "../forge/forge-dyes.js";

const expectedDyes = Object.freeze([
  Object.freeze({ id: "white_dye", color: "#f4f6ee", color444: 0xeee }),
  Object.freeze({ id: "yellow_dye", color: "#eec436", color444: 0xec3 }),
  Object.freeze({ id: "red_dye", color: "#cc4f46", color444: 0xc54 }),
  Object.freeze({ id: "blue_dye", color: "#5288da", color444: 0x58d }),
  Object.freeze({ id: "pink_dye", color: "#e287b2", color444: 0xd8a }),
]);

assert.deepEqual(FORGE_DYE_MATERIAL_IDS, expectedDyes.map((entry) => entry.id));
assert.deepEqual(
  FORGE_DYE_FALLBACK_COLORS,
  Object.fromEntries(expectedDyes.map((entry) => [entry.id, entry.color])),
  "the fallback catalog must match the five canonical forge dye colors",
);
assert.deepEqual(
  forgeDyePalette().map(({ id, color, color444, material }) => ({ id, color, color444, material })),
  expectedDyes.map((entry) => ({ ...entry, material: null })),
  "all five canonical #rrggbb colors must quantize to stable RGB444 paint values",
);
for (const entry of expectedDyes) {
  assert.equal(forgeDyeColor444(entry.color), entry.color444, `${entry.id} must map to RGB444 ${entry.color444.toString(16)}`);
}

const uppercaseCatalog = expectedDyes.map((entry) => ({
  id: entry.id,
  forgeUse: "dye",
  dyeColor: entry.color.toUpperCase(),
}));
const catalogPalette = forgeDyePalette({ materials: uppercaseCatalog });
assert.deepEqual(
  catalogPalette.map(({ id, color, color444 }) => ({ id, color, color444 })),
  expectedDyes,
  "catalog dye colors must normalize without changing their RGB444 identity",
);
assert.deepEqual(
  catalogPalette.map((entry) => entry.material),
  uppercaseCatalog,
  "palette entries must retain their authoritative catalog material",
);

const paintUsage = forgePaintDyeUsage({
  components: [
    {
      paintQuads: [
        { color444: 0xd8a },
        { color444: 0xeee },
        { color444: 0xc54 },
        { color444: 0xeee },
        { color444: 0x123 },
      ],
    },
    {
      paintQuads: [
        { color444: 0x58d },
        { color444: 0xc54 },
        { color444: 0x123 },
        { color444: 0x001 },
        { color444: -1 },
        { color444: 0x1_000 },
        { color444: 3.5 },
        { color444: "not-a-color" },
      ],
    },
  ],
}, uppercaseCatalog);
assert.deepEqual(
  paintUsage.dyeIds,
  ["white_dye", "red_dye", "blue_dye", "pink_dye"],
  "repeated paint colors must consume each supported dye once in canonical palette order",
);
assert.deepEqual(
  paintUsage.unsupportedColors,
  [0x001, 0x123],
  "unsupported valid RGB444 colors must be deduplicated and sorted",
);

const allFiveUsage = forgePaintDyeUsage(expectedDyes.flatMap((entry) => [
  { paintQuads: [{ color444: entry.color444 }] },
  { paintQuads: [{ color444: entry.color444 }] },
]));
assert.deepEqual(allFiveUsage.dyeIds, FORGE_DYE_MATERIAL_IDS, "all five colors must resolve once even when every paint color repeats");
assert.deepEqual(allFiveUsage.unsupportedColors, []);

const inventoryUsage = resolveForgePaintDyeInventory(
  { components: [{ paintQuads: [{ color444: 0xc54 }, { color444: 0xd8a }] }] },
  uppercaseCatalog,
  [{ materialId: "red_dye", slotIndex: 7 }],
);
assert.deepEqual(inventoryUsage.dyeIds, ["red_dye", "pink_dye"]);
assert.deepEqual(inventoryUsage.entries, [{ materialId: "red_dye", slotIndex: 7 }]);
assert.deepEqual(
  inventoryUsage.missingDyeIds,
  ["pink_dye"],
  "a painted color without a matching backpack entry must remain an explicit submission blocker",
);

assert.throws(
  () => forgeDyeColor444("#fff"),
  (error) => error instanceof TypeError && /#rrggbb/u.test(error.message),
  "dye conversion must reject non-canonical short hex paint colors",
);

console.log(JSON.stringify({
  dyes: expectedDyes.map((entry) => ({ id: entry.id, color444: entry.color444 })),
  deduplicatedUsage: paintUsage,
}));
