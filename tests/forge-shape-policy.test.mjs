import test from "node:test";
import assert from "node:assert/strict";
import {
  compareForgeMaterialCapacity,
  createForgeComponent,
  createForgeDesign,
  createForgeMaterialProof,
  verifyForgeMaterialProof,
} from "../forge/forge-core.js";

test("material capacity is advisory for every otherwise valid shape", () => {
  for (const requirements of [[1, 1, 1], [1_000_000, 65_535, 300_000]]) {
    const fit = compareForgeMaterialCapacity(requirements, [1, 1, 1]);
    assert.equal(fit.ok, true);
    assert.equal(fit.enforced, false);
    assert.equal(fit.withinCapacity, requirements.every((value) => value <= 1));
  }
});

test("low material capacity cannot reject a valid shape proof, but tampering still fails", () => {
  const design = createForgeDesign({
    components: [createForgeComponent({ dimsQ: [200, 4, 200] })],
    equipment: { mass5g: 200, volumeMm3: 1_000_000, attributes6: new Uint8Array(12).fill(63) },
  });
  const proof = createForgeMaterialProof(design);
  const valid = verifyForgeMaterialProof(design, proof, [1, 1, 1]);
  assert.equal(valid.ok, true);
  assert.equal(valid.comparison.withinCapacity, false);
  assert.equal(verifyForgeMaterialProof(design, { ...proof, designHash: proof.designHash ^ 1 }, [1, 1, 1]).ok, false);
});
