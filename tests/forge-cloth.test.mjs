import assert from "node:assert/strict";
import {
  FORGE_CLOTH_RESOURCE_ID,
  FORGE_MESH_VERTEX_STRIDE_BYTES,
  FORGE_RESOURCE_IDS,
  NCF1_VERSION,
  ForgeRuntimeCache,
  bakeForgeComponentsToAppearance,
  buildForgeDesignMesh,
  createAvatarMeshFromNcm,
  createForgeComponent,
  createForgeDesign,
  decodeNcf1,
  encodeNcf1Bytes,
  forgeDesignHasCloth,
  selectCompactNcf1Encoding,
  updateAvatarMeshVertices,
} from "../index.js";

const LEGACY_FORGE_RESOURCE_IDS = Object.freeze(["iron", "copper", "tin", "coal", "handle"]);
const equipment = Object.freeze({
  mass5g: 20,
  volumeCm3: 40,
  attributes6: new Uint8Array(12).fill(20),
});

assert.equal(NCF1_VERSION, 15, "cloth must remain available in the current NCF1 format");
assert.equal(FORGE_CLOTH_RESOURCE_ID, "cloth");
assert.deepEqual(
  FORGE_RESOURCE_IDS,
  [...LEGACY_FORGE_RESOURCE_IDS, "cloth"],
  "cloth must be appended after every deployed resource index",
);

for (let resource = 0; resource < FORGE_RESOURCE_IDS.length; resource += 1) {
  const resourceId = FORGE_RESOURCE_IDS[resource];
  const bytes = encodeNcf1Bytes(createForgeDesign({
    equipment,
    components: [createForgeComponent({ resourceId })],
  }));
  const decoded = decodeNcf1(bytes, { requireCanonical: true });
  assert.equal(decoded.components[0].resource, resource, `${resourceId} must retain numeric resource index ${resource}`);
  assert.equal(decoded.components[0].resourceId, resourceId, `${resourceId} must round-trip through the current NCF1 format`);
  assert.deepEqual(encodeNcf1Bytes(decoded), bytes, `${resourceId} must re-encode to identical canonical bytes`);
}

const paintedCloth = createForgeComponent({
  resourceId: "cloth",
  dimsQ: [80, 8, 80],
  grip: { offsetQ: [0, 0, 0], axis: 1, sign: 1, rotation: 0 },
  paintQuads: [
    { axis: 1, side: 1, plane: 10, u0: 2, u1: 6, v0: 3, v1: 8, color444: 0xe22 },
  ],
});
const paintedClothBytes = encodeNcf1Bytes(createForgeDesign({ equipment, components: [paintedCloth] }));
const decodedPaintedCloth = decodeNcf1(paintedClothBytes, { requireCanonical: true });
assert.equal(decodedPaintedCloth.components[0].resource, 5, "cloth must use the first unused NCF1 resource index");
assert.equal(decodedPaintedCloth.components[0].resourceId, "cloth");
assert.deepEqual(decodedPaintedCloth.components[0].paintQuads, paintedCloth.paintQuads, "cloth dye paint must survive NCF1 round-trip");
assert.deepEqual(encodeNcf1Bytes(decodedPaintedCloth), paintedClothBytes, "painted cloth must remain byte-canonical");

const compactableLineComponents = Array.from({ length: 8 }, (_, index) => createForgeComponent({
  resourceId: index < 4 ? "iron" : "copper",
  dimsQ: [32, 32, 32],
  offsetQ: [(index * 2 - 7) * 16, 0, 0],
}));
const compactableLine = createForgeDesign({ equipment, components: compactableLineComponents });
assert.equal(
  selectCompactNcf1Encoding(compactableLine).mode,
  "appearance",
  "the control design must be compact enough to exercise automatic appearance baking",
);
const clothLine = createForgeDesign({
  equipment,
  components: compactableLineComponents.map((component, index) => (
    index === 0 ? createForgeComponent({ ...component, resourceId: "cloth" }) : component
  )),
});
const clothLineSourceBytes = encodeNcf1Bytes(clothLine);
const clothLineAppearanceBytes = encodeNcf1Bytes(bakeForgeComponentsToAppearance(clothLine));
assert.ok(
  clothLineAppearanceBytes.byteLength < clothLineSourceBytes.byteLength,
  "the cloth fixture must offer a real static appearance byte saving",
);
const clothLineSelection = selectCompactNcf1Encoding(clothLine);
assert.equal(forgeDesignHasCloth(clothLineSelection.design), true);
assert.equal(clothLineSelection.mode, "components", "cloth identity and deformation bounds must not be appearance-baked away");
assert.equal(clothLineSelection.surfaceBaked, false, "cloth compaction must preserve editable component state");
assert.deepEqual(clothLineSelection.bytes, clothLineSourceBytes, "cloth compaction must preserve canonical source bytes");

const clothMeshDesign = createForgeDesign({
  equipment,
  components: [createForgeComponent({ resourceId: "cloth", dimsQ: [80, 8, 80] })],
});
const solidMeshDesign = createForgeDesign({
  equipment,
  components: [createForgeComponent({ resourceId: "iron", dimsQ: [80, 8, 80] })],
});
const clothMesh = buildForgeDesignMesh(clothMeshDesign);
const solidMesh = buildForgeDesignMesh(solidMeshDesign);
assert.ok(clothMesh.vertexCount > solidMesh.vertexCount, "cloth surfaces must retain enough subdivisions for visible wind deformation");
assert.ok(clothMesh.triangleCount > solidMesh.triangleCount, "cloth subdivisions must produce more triangles than a greedy solid cuboid");
assert.equal(clothMesh.vertexStrideBytes, FORGE_MESH_VERTEX_STRIDE_BYTES);
assert.equal(clothMesh.vertexStrideBytes, 16, "cloth must keep the existing 16-byte packed forge vertex format");
assert.equal(clothMesh.vertices.byteLength, clothMesh.vertexCount * 16);
assert.equal(clothMesh.indexCount, clothMesh.indices.length);
assert.equal(clothMesh.triangleCount, clothMesh.indexCount / 3);
assert.equal(clothMesh.pickBounds.length, 1, "one cloth component must remain one mesh/pick entry");
assert.ok(clothMesh.vertices instanceof Uint8Array, "cloth must use one packed vertex stream");
assert.ok(clothMesh.indices instanceof Uint16Array || clothMesh.indices instanceof Uint32Array, "cloth must use one packed index stream");

const deployedDesign = createForgeDesign({
  equipment,
  components: [
    createForgeComponent({
      resourceId: "cloth",
      dimsQ: [80, 8, 80],
      offsetQ: [0, 20, 0],
      grip: { offsetQ: [0, 0, 0], axis: 1, sign: 1, rotation: 0 },
    }),
    createForgeComponent({ resourceId: "iron", dimsQ: [16, 64, 16], offsetQ: [0, -20, 0] }),
  ],
});
const deployedRuntime = new ForgeRuntimeCache().restore(encodeNcf1Bytes(deployedDesign));
assert.deepEqual(deployedRuntime.clothComponentIndexes, [0]);
assert.equal(deployedRuntime.clothComponentCount, 1);
assert.equal(deployedRuntime.mesh.pickBounds.length, 2);
assert.ok(deployedRuntime.mesh.vertices instanceof Uint8Array, "mixed cloth and rigid parts must share one forge vertex stream");
assert.ok(
  deployedRuntime.mesh.indices instanceof Uint16Array || deployedRuntime.mesh.indices instanceof Uint32Array,
  "mixed cloth and rigid parts must share one forge index stream",
);

const avatarMesh = createAvatarMeshFromNcm(undefined, {
  attachIronPickaxe: true,
  forgeRuntime: deployedRuntime,
});
const deployedPartIndex = avatarMesh.parts.findIndex((part) => part.forgeDesignHash === deployedRuntime.designHash);
assert.ok(deployedPartIndex >= 0, "the deployed avatar must restore the canonical cloth forge mesh");
const deployedPart = avatarMesh.parts[deployedPartIndex];
assert.ok(deployedPart.geometry?.clothVertexComponents, "the deployed mesh must retain per-vertex cloth component identity");
assert.deepEqual(
  [...new Set(deployedPart.geometry.clothVertexComponents)],
  [0, 255],
  "one deployed draw stream must distinguish deformable cloth from rigid vertices",
);

const deployedPartFirstVertex = avatarMesh.parts
  .slice(0, deployedPartIndex)
  .reduce((sum, part) => sum + (part.geometry?.vertexCount ?? 24), 0);
const selectedEquipment = Object.freeze({
  rightHand: "pickaxe",
  equipmentId: "forged_pickaxe",
  forged: true,
  designHash: deployedRuntime.designHash,
});
const earlyVertices = avatarVerticesAt({ timeMs: 0, clothMotionScale: 1 });
const laterVertices = avatarVerticesAt({ timeMs: 731, clothMotionScale: 1 });
const animatedClothDelta = maxDeployedPositionDelta(earlyVertices, laterVertices, (component) => component !== 255);
const animatedRigidDelta = maxDeployedPositionDelta(earlyVertices, laterVertices, (component) => component === 255);
assert.ok(animatedClothDelta > 1e-4, "deployed cloth vertices must move between wind animation times");
assert.equal(animatedRigidDelta, 0, "wind animation must not move rigid vertices in the same deployed draw stream");

const originalMatchMedia = globalThis.matchMedia;
let stillVertices;
let normalMotionVertices;
let reducedMotionVertices;
try {
  stillVertices = avatarVerticesAt({ timeMs: 1_375, clothMotionScale: 0 });
  globalThis.matchMedia = () => ({ matches: false });
  normalMotionVertices = avatarVerticesAt({ timeMs: 1_375 });
  globalThis.matchMedia = () => ({ matches: true });
  reducedMotionVertices = avatarVerticesAt({ timeMs: 1_375 });
} finally {
  if (originalMatchMedia === undefined) delete globalThis.matchMedia;
  else globalThis.matchMedia = originalMatchMedia;
}
const normalMotionAmplitude = maxDeployedPositionDelta(stillVertices, normalMotionVertices, (component) => component !== 255);
const reducedMotionAmplitude = maxDeployedPositionDelta(stillVertices, reducedMotionVertices, (component) => component !== 255);
assert.ok(normalMotionAmplitude > 1e-4);
assert.ok(reducedMotionAmplitude > 0, "reduced-motion cloth may retain a restrained ambient ripple");
assert.ok(
  reducedMotionAmplitude < normalMotionAmplitude * 0.35,
  "prefers-reduced-motion must substantially reduce deployed cloth amplitude",
);
assert.equal(
  maxDeployedPositionDelta(stillVertices, reducedMotionVertices, (component) => component === 255),
  0,
  "reduced cloth motion must still leave rigid deployed vertices untouched",
);

console.log(JSON.stringify({
  clothNcf1Bytes: paintedClothBytes.byteLength,
  compactableCloth: {
    componentBytes: clothLineSourceBytes.byteLength,
    staticAppearanceBytes: clothLineAppearanceBytes.byteLength,
    selectedMode: clothLineSelection.mode,
  },
  clothMesh: {
    vertexStrideBytes: clothMesh.vertexStrideBytes,
    vertices: clothMesh.vertexCount,
    triangles: clothMesh.triangleCount,
  },
  deployedWind: {
    animatedClothDelta,
    animatedRigidDelta,
    normalMotionAmplitude,
    reducedMotionAmplitude,
  },
}));

function avatarVerticesAt(animation) {
  return updateAvatarMeshVertices(avatarMesh, {
    ...animation,
    equipment: selectedEquipment,
  }).slice();
}

function maxDeployedPositionDelta(left, right, includeComponent) {
  let maximum = 0;
  for (let vertex = 0; vertex < deployedPart.geometry.vertexCount; vertex += 1) {
    const component = deployedPart.geometry.clothVertexComponents[vertex];
    if (!includeComponent(component)) continue;
    const offset = (deployedPartFirstVertex + vertex) * 10;
    const dx = left[offset] - right[offset];
    const dy = left[offset + 1] - right[offset + 1];
    const dz = left[offset + 2] - right[offset + 2];
    maximum = Math.max(maximum, Math.hypot(dx, dy, dz));
  }
  return maximum;
}
