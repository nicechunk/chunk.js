import test from "node:test";
import assert from "node:assert/strict";
import { createForgeComponent, createForgeDesign, encodeNcf1Bytes, decodeNcf1, forgeVoxelIndex } from "../forge/forge-core.js";
import { buildForgeDesignMesh } from "../forge/forge-mesher.js";
import { hammerForgeComponent, normalizeForgeComponent, snapForgeWorkbenchComponentTranslation } from "../forge/forge-workbench.js";

const make = (dimsQ, offsetQ = [0, 8, 0], extra = {}) => createForgeComponent({ dimsQ, offsetQ, ...extra });

test("native hammer and normalize preserve geometric material volume on tiny and large stock", () => {
  const volume = (component) => component.dimsQ.reduce((a, b) => a * b, 1)
    * component.solid.reduce((a, b) => a + b, 0);
  for (const dims of [[1, 1, 1], [4, 2, 4], [8, 5, 7], [18, 11, 16], [32, 4, 8], [144, 144, 144], [255, 9, 11]]) {
    const original = make(dims);
    assert.equal(volume(normalizeForgeComponent(original)), volume(original));
    for (const axis of [0, 1, 2]) for (const side of [0, 1]) {
      let component = original;
      for (let strike = 0; strike < 3; strike++) {
        component = hammerForgeComponent(component, { axis, side, center: [7, 5, 7] });
        assert.equal(volume(component), volume(original));
      }
    }
  }
});

test("hammered small stock joins on every axis and reconstructs the same joint from NCF1", () => {
  const hammered = hammerForgeComponent(make([4, 2, 4]), { axis: 1, side: 1 });
  assert.equal(hammered.dimsQ[1], 1);
  for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
    const position = [...hammered.offsetQ]; position[axis] += sign * 10;
    const neighbor = make([4, 2, 4], position);
    const snapped = snapForgeWorkbenchComponentTranslation([hammered, neighbor], 1, [0, 0, 0], { automatic: false, snapDistanceQ: 16 });
    assert.ok(snapped.contact);
    const design = createForgeDesign({ components: [hammered, { ...neighbor, offsetQ: snapped.constrainedOffsetQ }] });
    const before = encodeNcf1Bytes(design);
    const mesh = buildForgeDesignMesh(design, { positionScale: 2048 });
    const restored = buildForgeDesignMesh(decodeNcf1(before, { requireCanonical: true }), { positionScale: 2048 });
    assert.deepEqual(restored.vertices, mesh.vertices);
    assert.deepEqual(restored.indices, mesh.indices);
    assert.deepEqual(encodeNcf1Bytes(design), before, "joints leave the code and material masks unchanged");
    const left = sign > 0 ? mesh.pickBounds[0] : mesh.pickBounds[1];
    const right = sign > 0 ? mesh.pickBounds[1] : mesh.pickBounds[0];
    assert.equal(left.max[axis], right.min[axis], `axis ${axis}, side ${sign} must have no rendered seam`);
  }
});

test("joints use the same shape at editor and gameplay position precision", () => {
  const design = createForgeDesign({ components: [make([3, 4, 4]), make([2, 4, 4], [3, 8, 0])] });
  for (const positionScale of [128, 2048]) {
    const raw = buildForgeDesignMesh(design, { positionScale, stitchContacts: false });
    const joined = buildForgeDesignMesh(design, { positionScale });
    assert.ok(raw.pickBounds[1].min[0] > raw.pickBounds[0].max[0]);
    assert.equal(joined.pickBounds[0].max[0], joined.pickBounds[1].min[0]);
    assert.equal(joined.contactJoints.length, 1);
    assert.ok(joined.vertexCount > raw.vertexCount);
  }
});

test("real gaps, corner proximity, and drilled openings stay empty", () => {
  for (const offset of [[4, 8, 0], [3, 12, 4]]) {
    const mesh = buildForgeDesignMesh(createForgeDesign({ components: [make([3, 4, 4]), make([2, 4, 4], offset)] }));
    assert.equal(mesh.contactJoints.length, 0);
  }
  const solid = new Uint8Array(1960).fill(1);
  for (let x = 0; x < 14; x++) for (let y = 3; y < 7; y++) for (let z = 4; z < 10; z++) solid[forgeVoxelIndex(x, y, z)] = 0;
  const ring = make([3, 10, 14], [0, 8, 0], { solid });
  const peer = make([2, 10, 14], [3, 8, 0]);
  const mesh = buildForgeDesignMesh(createForgeDesign({ components: [ring, peer] }), { positionScale: 2048 });
  assert.ok(mesh.contactJoints.length);
  const holeY = 8 / 64, holeZ = 0;
  assert.ok(mesh.contactJoints.every((joint) => !(holeY > joint.min[1] && holeY < joint.max[1]
    && holeZ > joint.min[2] && holeZ < joint.max[2])), "joints do not occupy the drilled opening");
});
