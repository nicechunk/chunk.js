import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { analyzeForgeContainer, formatContainerCapacity } from "../forge/forge-container.js";
import { decodeNcf1, encodeNcf1Bytes, selectCompactNcf1Encoding } from "../forge/forge-core.js";

const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/water-containers.json", import.meta.url)));
for (const row of vectors) test(`water cavity: ${row.name}`, () => {
  const bytes = Uint8Array.from(Buffer.from(row.codeHex, "hex"));
  const result = analyzeForgeContainer(bytes);
  assert.equal(result.valid, row.valid);
  assert.equal(result.capacityMl, row.capacityMl);
  if (result.valid) {
    assert.equal(analyzeForgeContainer(bytes, { seedIndex: result.seedIndex }).volumeQ3, row.volumeQ3);
    assert.equal(result.seedIndex, row.seedIndex);
  }
});
test("container encoding preserves actual component solids and holes", () => {
  for (const name of ["cup-300ml", "side-hole", "bottom-hole", "nonplanar-notched-rim"]) {
    const source = vectors.find(row => row.name === name);
    const design = decodeNcf1(Buffer.from(source.codeHex, "hex"));
    const selection = selectCompactNcf1Encoding(design, { preferComponents: true });
    assert.equal(selection.surfaceBaked, false);
    assert.deepEqual(selection.bytes, encodeNcf1Bytes(design));
    assert.equal(analyzeForgeContainer(selection.bytes).valid, source.valid);
  }
  assert.equal(formatContainerCapacity(500), "500 mL");
  assert.equal(formatContainerCapacity(1500), "1.5 L");
});
