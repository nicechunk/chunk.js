import test from "node:test";
import assert from "node:assert/strict";
import { createForgeDesign, decodeNcf1, encodeNcf1Bytes } from "../forge/forge-core.js";
import {
  cloneForgeComponent, createForgeWorkbenchComponent, forgeSolidCellCount,
  forgeWorkbenchStats, hammerForgeComponent, paintForgeComponent,
  restoreForgeMachiningState, serializeForgeMachiningState, sawForgeComponent,
  normalizeForgeComponent, rotateForgeComponent,
} from "../forge/forge-workbench.js";
import { buildForgeDesignMesh } from "../forge/forge-mesher.js";
import { createForgeRuntimeAsset, ForgeRuntimeCache } from "../forge/forge-runtime-cache.js";

const geometricVolume = (c) => c.dimsQ.reduce((a, b) => a * b, 1) * forgeSolidCellCount(c);
const bounds = (c) => buildForgeDesignMesh(createForgeDesign({ components: [c] }), { positionScale: 2048 }).pickBounds[0];

test("fresh physical-size materials can be hammered from every face without losing material", () => {
  for (const materialId of ["iron", "copper_bloom", "tin", "coal", "handle", "cloth"]) {
    for (const volumeMm3 of [155, 1860, 8192, 120000]) {
      const { component, material } = createForgeWorkbenchComponent({ materialId, volumeMm3 });
      const before = forgeWorkbenchStats([component], [material]);
      for (const axis of [0, 1, 2]) for (const side of [0, 1]) {
        const next = hammerForgeComponent(component, { axis, side });
        assert.notEqual(next, component, `${materialId} ${volumeMm3} mm3 axis ${axis} side ${side} must process a first strike`);
        assert.ok(bounds(next).max[axis] - bounds(next).min[axis] < bounds(component).max[axis] - bounds(component).min[axis]);
        assert.equal(geometricVolume(next), geometricVolume(component));
        const after = forgeWorkbenchStats([next], [material]);
        assert.equal(after.usedVolumeMm3, before.usedVolumeMm3);
        assert.deepEqual(after.equipment, before.equipment);
        assert.equal(next.color444, component.color444);
      }
    }
  }
});

test("sub-Q hammering preserves anchored faces, paint, draft mass, and canonical runtime shape", () => {
  const { component, material } = createForgeWorkbenchComponent({ materialId: "copper_bloom", volumeMm3: 1860 });
  const painted = paintForgeComponent(component, { axis: 1, side: 1, color444: 0xf24 });
  for (const side of [0, 1]) {
    let next = hammerForgeComponent(painted, { axis: 1, side });
    assert.notEqual(next, painted);
    const opposite = side ? "min" : "max";
    assert.equal(bounds(next)[opposite][1], bounds(painted)[opposite][1]);
    assert.ok(next.paintQuads.some((quad) => quad.color444 === 0xf24));
    assert.equal(geometricVolume(next), geometricVolume(painted));
    const originalStats = forgeWorkbenchStats([next], [material]);
    const state = JSON.parse(JSON.stringify(serializeForgeMachiningState(next)));
    const decoded = decodeNcf1(encodeNcf1Bytes(createForgeDesign({ components: [next], equipment: originalStats.equipment })), { requireCanonical: true });
    assert.deepEqual(bounds(decoded.components[0]), bounds(next));
    next = restoreForgeMachiningState(decoded.components[0], state);
    assert.deepEqual(forgeWorkbenchStats([next], [material]).equipment, originalStats.equipment);
    assert.deepEqual(serializeForgeMachiningState(cloneForgeComponent(next)), state);
    const cut = sawForgeComponent(next, { axis: 0, layers: 1 });
    const cutStats = forgeWorkbenchStats([cut], [material]);
    assert.ok(cutStats.usedVolumeMm3 < originalStats.usedVolumeMm3);
    assert.ok(cutStats.usedVolumeMm3 > 0);
    assert.deepEqual(forgeWorkbenchStats([restoreForgeMachiningState(cut,
      JSON.parse(JSON.stringify(serializeForgeMachiningState(cut))))], [material]).equipment, cutStats.equipment);
  }
});

test("small stock can take repeated strikes until the occupied grid thickness reaches one cell", () => {
  const { component, material } = createForgeWorkbenchComponent({ materialId: "copper_bloom", volumeMm3: 155 });
  let current = component;
  let strikes = 0;
  for (; strikes < 20; strikes++) {
    const next = hammerForgeComponent(current, { axis: 1, side: 1 });
    if (next === current) break;
    assert.equal(geometricVolume(next), geometricVolume(component));
    assert.equal(forgeWorkbenchStats([next], [material]).usedVolumeMm3, material.volumeMm3);
    current = next;
  }
  assert.ok(strikes >= 3 && strikes < 20);
  assert.equal(hammerForgeComponent(current, { axis: 1, side: 1 }), current);
  assert.notEqual(hammerForgeComponent(current, { axis: 0, side: 1 }), current, "another face remains workable");
  assert.equal(hammerForgeComponent(component, { axis: 1, compressionBps: 10000 }), component, "zero compression must not deform material");
  const design = createForgeDesign({ components: [current], equipment: forgeWorkbenchStats([current], [material]).equipment });
  const mesh = buildForgeDesignMesh(design, { positionScale: 2048 });
  assert.deepEqual(createForgeRuntimeAsset(design).mesh.vertices, mesh.vertices);
  const restored = new ForgeRuntimeCache().restore(encodeNcf1Bytes(design));
  assert.deepEqual(restored.mesh.vertices, mesh.vertices, "gameplay retains the thin shape seen at the workbench");
  assert.deepEqual(restored.mesh.pickBounds, mesh.pickBounds);
  for (const next of [normalizeForgeComponent(current), rotateForgeComponent(current)]) {
    assert.equal(forgeWorkbenchStats([next], [material]).usedVolumeMm3, material.volumeMm3);
    assert.equal(geometricVolume(next), geometricVolume(component));
  }
});

test("legacy drafts remain readable and malformed cell scales fail validation", () => {
  const { component } = createForgeWorkbenchComponent({ materialId: "copper_bloom", volumeMm3: 155 });
  const legacy = serializeForgeMachiningState(component);
  assert.equal(Object.hasOwn(legacy, "materialCellScale"), false);
  assert.deepEqual(serializeForgeMachiningState(restoreForgeMachiningState(component, legacy)), legacy);
  for (const scale of [null, [], [0, 1], [1.5, 1], [1, -1], [1, 255 ** 3 + 1], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    assert.throws(() => restoreForgeMachiningState(component, { ...legacy, materialCellScale: scale }), { code: "invalid-machining-state" });
  }
});

test("sub-Q strikes keep a material's physical weight relative to neighboring materials", () => {
  const first = createForgeWorkbenchComponent({ materialId: "copper_bloom", volumeMm3: 1860 });
  const second = createForgeWorkbenchComponent({ materialId: "copper_bloom", volumeMm3: 1860 }, { offsetQ: [20, 0, 0] });
  const deformed = hammerForgeComponent(first.component, { axis: 1, side: 1 });
  const stats = forgeWorkbenchStats([deformed, second.component], [first.material, second.material]);
  assert.equal(stats.physicsAdvisory.centerOfMassQ[0], 10, "the compressed material still has half of the combined mass");
  assert.equal(stats.componentBreakdown[0].massWeight, stats.componentBreakdown[1].massWeight);
});
