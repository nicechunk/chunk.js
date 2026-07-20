import assert from "node:assert/strict";
import {
  ForgeRuntimeCache,
  buildForgeDesignMesh,
  createAvatarMeshFromNcm,
  createAvatarToolCollisionResolver,
  createForgeComponent,
  createForgeDesign,
  decodeNcf1,
  encodeNcf1,
  forgeChainDesignHash,
  updateAvatarMeshVertices,
} from "../index.js";

const componentCode = encodeNcf1(createForgeDesign({
  equipment: { mass5g: 48, volumeCm3: 96, attributes6: new Uint8Array(12).fill(31) },
  components: [
    createForgeComponent({
      resourceId: "iron",
      color444: 0x9a8,
      dimsQ: [56, 108, 44],
      offsetQ: [0, 18, 0],
      grip: { offsetQ: [0, -24, 0], axis: 2, sign: 1, rotation: 1 },
    }),
    createForgeComponent({
      resourceId: "handle",
      color444: 0x753,
      dimsQ: [22, 84, 22],
      offsetQ: [0, -72, 0],
    }),
  ],
}));

const appearanceCode = encodeNcf1(createForgeDesign({
  equipment: { mass5g: 20, volumeCm3: 40, attributes6: new Uint8Array(12).fill(22) },
  appearance: {
    dimsQ: [96, 128, 64],
    grip: { offsetQ: [0, -48, 0], axis: 1, sign: -1, rotation: 2 },
    quads: [
      { axis: 2, side: 1, resourceId: "copper", plane: 24, u0: 0, u1: 24, v0: 0, v1: 24, color444: 0xb64 },
      { axis: 2, side: 0, resourceId: "handle", plane: 0, u0: 0, u1: 24, v0: 0, v1: 24, color444: 0x753 },
    ],
  },
}));

const cache = new ForgeRuntimeCache({ maxEntries: 2, maxBytes: 1_000_000 });
const componentHash = forgeChainDesignHash(componentCode);
const componentRuntime = cache.restore(componentCode, { expectedDesignHash: componentHash });
assert.equal(componentRuntime.mode, "components");
assert.equal(componentRuntime.componentCount, 2);
assert.equal(componentRuntime.appearance, null);
assert.equal(componentRuntime.mesh.pickBounds.length, componentRuntime.components.length);
assert.ok(componentRuntime.vertexCount > 0);
assert.ok(componentRuntime.triangleCount > 0);
assert.equal(componentRuntime.mesh.indexCount, componentRuntime.triangleCount * 3);
assert.equal(componentRuntime.designHash, componentHash);

const directComponentMesh = buildForgeDesignMesh(decodeNcf1(componentCode, { requireCanonical: true }));
assert.equal(componentRuntime.vertexCount, directComponentMesh.vertexCount);
assert.equal(componentRuntime.triangleCount, directComponentMesh.triangleCount);
assert.deepEqual(componentRuntime.mesh.vertices, directComponentMesh.vertices);
assert.deepEqual(componentRuntime.mesh.indices, directComponentMesh.indices);

const avatarMesh = createAvatarMeshFromNcm(undefined, {
  scale: (1.75 / 0.4) / 2.52,
  attachIronPickaxe: true,
  forgeRuntime: componentRuntime,
});
const restoredPart = avatarMesh.parts.find((part) => part.forgeDesignHash === componentHash);
assert.ok(restoredPart?.geometry, "the game avatar should embed the restored packed NCF1 mesh in its existing draw buffer");
assert.equal(restoredPart.geometry.vertexCount, componentRuntime.vertexCount);
assert.equal(restoredPart.geometry.triangleCount, componentRuntime.triangleCount);
assert.equal(
  avatarMesh.equipment.find((entry) => entry.id === "forged_pickaxe")?.triangleCount,
  componentRuntime.triangleCount,
  "game equipment statistics should report actual NCF1 geometry instead of a generic pickaxe",
);
assert.equal(avatarMesh.collisionParts.filter((part) => part.equipmentId === "forged_pickaxe").length, 2);
const unequippedAvatarMesh = createAvatarMeshFromNcm(undefined, {
  scale: (1.75 / 0.4) / 2.52,
  attachIronPickaxe: true,
  attachForgedPickaxe: false,
  forgeRuntime: componentRuntime,
});
assert.equal(unequippedAvatarMesh.parts.some((part) => part.equipmentId === "forged_pickaxe"), false);
assert.ok(
  unequippedAvatarMesh.vertexCount < avatarMesh.vertexCount,
  "unequipped avatars should not transform or upload hidden forged geometry every frame",
);
const posedVertices = updateAvatarMeshVertices(avatarMesh, {
  timeMs: 1000,
  miningProgress: 0.7,
  equipment: { rightHand: "pickaxe", equipmentId: "forged_pickaxe", forged: true, designHash: componentHash },
});
assert.equal(posedVertices.length, avatarMesh.vertices.length);
assert.ok(Array.from(posedVertices).every(Number.isFinite));
const collision = createAvatarToolCollisionResolver({
  getAvatarMesh: () => avatarMesh,
  getAvatar: () => ({ worldX: 0, worldY: 0, worldZ: 0, yaw: 0 }),
  getPlayer: () => ({ worldX: 0, worldY: 0, worldZ: 0, avatarYaw: 0 }),
  getPlayerWorldFloat: () => [0, 0, 0],
  getSelectedEquipment: () => ({ rightHand: "pickaxe", equipmentId: "forged_pickaxe", forged: true, designHash: componentHash }),
  playerBodyHeight: 4.375,
});
assert.equal(collision.toolCollisionFrame({ progress: 0.7 }).boxes.length, 2);
assert.ok(collision.toolReachSphere().radius > 0);

const cachedComponentRuntime = cache.restore(componentCode, { expectedDesignHash: componentHash });
assert.equal(cachedComponentRuntime, componentRuntime, "a cache hit must share the immutable runtime asset");
let metrics = cache.snapshot();
assert.equal(metrics.requests, 2);
assert.equal(metrics.hits, 1);
assert.equal(metrics.misses, 1);
assert.equal(metrics.decodeCount, 1, "the same NCF1 must decode only once");
assert.equal(metrics.meshBuildCount, 1, "the same NCF1 must mesh only once");
assert.equal(metrics.avoidedDecodeCount, 1);

assert.throws(
  () => cache.restore(componentCode, { expectedDesignHash: componentHash ^ 1 }),
  (error) => error?.code === "forge-design-hash-mismatch",
  "runtime restore must never associate code with a different chain identity",
);

const appearanceRuntime = cache.restore(appearanceCode);
assert.equal(appearanceRuntime.mode, "appearance");
assert.equal(appearanceRuntime.componentCount, 0);
assert.equal(appearanceRuntime.appearanceQuadCount, 2);
assert.equal(appearanceRuntime.components.length, 0);
assert.equal(appearanceRuntime.mesh.pickBounds.length, 1);
assert.equal(appearanceRuntime.mesh.pickBounds[0].id, "appearance");
assert.ok(appearanceRuntime.materials.copper > 0);
assert.ok(appearanceRuntime.materials.handle > 0);
const appearanceAvatar = createAvatarMeshFromNcm(undefined, {
  attachIronPickaxe: true,
  forgeRuntime: appearanceRuntime,
});
const appearancePart = appearanceAvatar.parts.find((part) => part.forgeDesignHash === appearanceRuntime.designHash);
assert.equal(appearancePart?.forgeMode, "appearance");
assert.equal(appearancePart?.geometry?.triangleCount, appearanceRuntime.triangleCount);
assert.equal(appearanceAvatar.collisionParts.filter((part) => part.equipmentId === "forged_pickaxe").length, 1);
metrics = cache.snapshot();
assert.equal(metrics.decodeCount, 2);
assert.equal(metrics.meshBuildCount, 2);
assert.equal(metrics.entries, 2);
assert.ok(metrics.residentBytes >= componentRuntime.meshByteLength + appearanceRuntime.meshByteLength);

const oneEntryCache = new ForgeRuntimeCache({ maxEntries: 1, maxBytes: 1_000_000 });
oneEntryCache.restore(componentCode);
oneEntryCache.restore(appearanceCode);
assert.equal(oneEntryCache.snapshot().entries, 1);
assert.equal(oneEntryCache.snapshot().evictions, 1);
assert.equal(oneEntryCache.has(componentCode), false);
assert.equal(oneEntryCache.has(appearanceCode), true);

const undersizedBudgetCache = new ForgeRuntimeCache({ maxEntries: 2, maxBytes: 1 });
const uncachedAsset = undersizedBudgetCache.restore(componentCode);
assert.equal(uncachedAsset.designHash, componentHash, "an asset larger than the cache budget should still restore for its caller");
assert.equal(undersizedBudgetCache.snapshot().entries, 0, "the byte budget must remain a hard resident-cache limit");
assert.equal(undersizedBudgetCache.snapshot().residentBytes, 0);
assert.equal(undersizedBudgetCache.snapshot().evictions, 1);
assert.notEqual(
  undersizedBudgetCache.restore(componentCode),
  uncachedAsset,
  "an over-budget asset must be decoded on demand instead of retained outside the configured cap",
);

assert.throws(
  () => cache.restore(new Uint8Array(641)),
  (error) => error?.code === "code-too-large",
  "runtime restoration must reject oversized byte payloads before hashing or meshing",
);
assert.throws(
  () => cache.restore(`NCF1.${"A".repeat(855)}`),
  (error) => error?.code === "code-too-large",
  "runtime restoration must reject oversized text envelopes before base64 decoding",
);

const fanoutCache = new ForgeRuntimeCache();
for (let index = 0; index < 128; index += 1) fanoutCache.restore(componentCode);
const fanoutMetrics = fanoutCache.snapshot();
assert.equal(fanoutMetrics.decodeCount, 1, "128 game consumers of one design should still perform one decode");
assert.equal(fanoutMetrics.meshBuildCount, 1, "128 game consumers of one design should still perform one mesh build");
assert.equal(fanoutMetrics.hits, 127);

console.log(JSON.stringify({
  component: {
    rawBytes: componentRuntime.rawByteLength,
    vertices: componentRuntime.vertexCount,
    triangles: componentRuntime.triangleCount,
    meshBytes: componentRuntime.meshByteLength,
  },
  appearance: {
    rawBytes: appearanceRuntime.rawByteLength,
    vertices: appearanceRuntime.vertexCount,
    triangles: appearanceRuntime.triangleCount,
    meshBytes: appearanceRuntime.meshByteLength,
  },
  cache: cache.snapshot(),
  fanout: fanoutMetrics,
}));
