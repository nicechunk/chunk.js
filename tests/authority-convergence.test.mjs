import assert from "node:assert/strict";
import test from "node:test";
import { ChunkState } from "../chunk/chunk-state.js";

function fixture() {
  const chunk = new ChunkState({ chunkX: 0, chunkZ: 0, minY: -32, height: 353, baseBlockResolver: () => 1, baseBlocksReady: true });
  let clock = 1_000;
  chunk.authorityNow = () => clock;
  return { chunk, tick: (time) => { clock = time; } };
}
const air = { worldX: 1, worldY: -17, worldZ: 2, blockId: 0 };
const filled = { ...air, blockId: 7 };
const meta = (slot, readStartedAt, extras = {}) => ({ snapshotSlot: slot, source: "rpc", snapshotCommitment: "finalized", readStartedAt, ...extras });

test("dig immediately refilled converges without ever observing intermediate air", () => {
  const { chunk, tick } = fixture();
  chunk.applyPendingDelta([air], "tx");
  chunk.confirmPendingDelta("tx", { signature: "sig", executionSlot: 100, commitment: "confirmed" });
  let result = chunk.replaceChainDeltas([filled], meta(99, 1_010));
  assert.equal(result.retainedUnobserved, 1);
  assert.equal(chunk.getFinalBlock(1, -17, 2), 0);
  tick(1_100);
  result = chunk.replaceChainDeltas([filled], meta(100, 1_100));
  assert.equal(result.retainedUnobserved, 0, "a finalized same-slot bank may contain a later write, without account order metadata");
  assert.equal(chunk.getFinalBlock(1, -17, 2), 7);
  assert.equal(chunk.confirmedDeltaProtection.size, 0);
  assert.equal(chunk.replaceChainDeltas([air], meta(99, 2_000)).reason, "stale-chain-slot");
});

test("confirmed endpoint protection expires for a genuinely new read; persistent previews cannot clear it", () => {
  const { chunk, tick } = fixture();
  chunk.applyChainDelta([air], { confirmation: { executionSlot: 100, commitment: "confirmed" } });
  tick(50_000);
  for (const options of [
    meta(102, 50_000, { source: "persistent" }),
    meta(102, 1_001, { snapshotCommitment: "confirmed" }),
    meta(99, 50_000, { snapshotCommitment: "confirmed" }),
  ]) {
    chunk.replaceChainDeltas([filled], options);
    assert.equal(chunk.getFinalBlock(1, -17, 2), 0);
  }
  chunk.replaceChainDeltas([filled], meta(102, 50_000, { snapshotCommitment: "confirmed" }));
  assert.equal(chunk.getFinalBlock(1, -17, 2), 7);
});

test("a read begun before confirmation cannot overwrite a newly confirmed local edit", () => {
  const { chunk, tick } = fixture();
  tick(2_000);
  chunk.applyChainDelta([air], { confirmation: { executionSlot: 100, commitment: "confirmed" } });
  chunk.replaceChainDeltas([filled], meta(101, 1_999));
  assert.equal(chunk.getFinalBlock(1, -17, 2), 0);
  chunk.replaceChainDeltas([filled], meta(101, 2_001));
  assert.equal(chunk.getFinalBlock(1, -17, 2), 7);
});

test("unverified remote hints expire, never advance authority, and a complete RPC pair supersedes them", () => {
  const { chunk, tick } = fixture();
  chunk.replaceChainDeltas([filled], meta(10, 1_000));
  const revision = chunk.chainRevision;
  chunk.applyRemoteDelta([air]);
  assert.equal(chunk.getFinalBlock(1, -17, 2), 0);
  assert.equal(chunk.chainDeltas.values().next().value.blockId, 7);
  assert.equal(chunk.chainRevision, revision);
  assert.equal(chunk.chainSnapshotSlot, 10);
  tick(6_001);
  chunk.expireRemoteDeltas();
  assert.equal(chunk.getFinalBlock(1, -17, 2), 7);
  chunk.applyRemoteDelta([air]);
  chunk.replaceChainDeltas([filled], meta(11, 6_002));
  assert.equal(chunk.remoteDeltas.size, 0);
  assert.equal(chunk.getFinalBlock(1, -17, 2), 7);
});

test("unknown context slots stay null and cannot lower an established watermark", () => {
  const { chunk } = fixture();
  assert.equal(chunk.chainSnapshotSlot, null);
  chunk.replaceChainDeltas([filled], { snapshotSlot: null });
  assert.equal(chunk.chainSnapshotSlot, null);
  chunk.replaceChainDeltas([filled], meta(10, 1_001));
  assert.equal(chunk.replaceChainDeltas([air], { snapshotSlot: null }).reason, "stale-chain-slot");
  assert.equal(chunk.chainSnapshotSlot, 10);
});

test("large snapshots prepare in 64-entry slices and only publish a complete atomic state", () => {
  const { chunk } = fixture();
  const deltas = Array.from({ length: 8192 }, (_, index) => ({ worldX: index % 16, worldY: -32 + Math.floor(index / 256), worldZ: Math.floor(index / 16) % 16, blockId: index % 2 ? 0 : 7 }));
  const staged = chunk.prepareChainSnapshot(deltas, meta(100, 1_100));
  let steps = 0;
  while (!staged.done) {
    const result = staged.step({ maxEntries: 64, budgetMs: Infinity });
    assert.ok(result.processed <= 64);
    assert.equal(chunk.chainDeltas.size, 0);
    steps++;
  }
  assert.ok(steps > 128);
  const result = chunk.commitPreparedChainSnapshot(staged);
  assert.equal(result.applied, true);
  assert.equal(chunk.chainDeltas.size, 8192);
});

test("prepared snapshots reject a local confirmation or authority epoch change while preserving pending edits", () => {
  const { chunk } = fixture();
  const prep = chunk.prepareChainSnapshot([filled], meta(100, 1_100));
  while (!prep.done) prep.step({ maxEntries: 1, budgetMs: Infinity });
  chunk.applyPendingDelta([air], "tx");
  assert.equal(chunk.commitPreparedChainSnapshot(prep).reason, "stale-world-revision");
  const retry = chunk.prepareChainSnapshot([filled], meta(100, 1_101));
  while (!retry.done) retry.step({ maxEntries: 64, budgetMs: Infinity });
  assert.equal(chunk.commitPreparedChainSnapshot(retry).applied, true);
  assert.equal(chunk.getFinalBlock(1, -17, 2), 0);
  const older = chunk.prepareChainSnapshot([filled], meta(101, 1_200));
  while (!older.done) older.step({ maxEntries: 64, budgetMs: Infinity });
  chunk.confirmPendingDelta("tx", { executionSlot: 101, commitment: "confirmed" });
  assert.equal(chunk.commitPreparedChainSnapshot(older).reason, "stale-chain-revision");
  const other = chunk.prepareChainSnapshot([filled], meta(102, 1_300));
  while (!other.done) other.step({ maxEntries: 64, budgetMs: Infinity });
  chunk.resetChainSnapshotAuthority();
  assert.equal(chunk.commitPreparedChainSnapshot(other).applied, false);
});


test("legacy confirmations without execution metadata retain a bounded grace before a fresh finalized correction", () => {
  const { chunk, tick } = fixture();
  chunk.applyChainDelta([air]);
  chunk.replaceChainDeltas([filled], meta(100, 1_001));
  assert.equal(chunk.getFinalBlock(1, -17, 2), 0);
  tick(31_001);
  chunk.replaceChainDeltas([filled], meta(101, 31_001));
  assert.equal(chunk.getFinalBlock(1, -17, 2), 7);
  assert.equal(chunk.confirmedDeltaProtection.size, 0);
});
